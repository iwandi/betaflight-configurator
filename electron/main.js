import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SerialPort } from "serialport";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Track open serial ports keyed by connectionId
const openPorts = new Map();

function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 1024,
        minHeight: 550,
        title: "Betaflight",
        icon: path.join(__dirname, "../src/images/bf_icon_128.png"),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    // In production load the compiled app; in development use the Vite dev server.
    const devServerUrl = process.env.ELECTRON_DEV_SERVER_URL;
    if (devServerUrl) {
        win.loadURL(devServerUrl);
        win.webContents.openDevTools();
    } else {
        win.loadFile(path.join(__dirname, "../src/dist/index.html"));
    }
}

app.whenReady().then(() => {
    registerSerialHandlers();
    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

// SerialPort's native bindings keep libuv handles alive and prevent the
// process from exiting naturally after app.quit(). Destroy every open port
// then, after a short grace period for native cleanup, force-exit so the
// console returns to the prompt immediately.
//
// 100 ms is enough for the @serialport/bindings-cpp thread-pool workers to
// finish their current work without being perceptible to the user.
const NATIVE_CLEANUP_DELAY_MS = 100;

app.on("will-quit", (event) => {
    event.preventDefault();
    for (const port of openPorts.values()) {
        try {
            port.destroy();
        } catch (_) {
            // ignore – port may already be closed
        }
    }
    openPorts.clear();
    // Give native bindings a moment to release resources before forcing exit.
    const exitTimer = setTimeout(() => process.exit(0), NATIVE_CLEANUP_DELAY_MS);
    // Unref the timer so it does not itself keep the event loop alive if
    // the process manages to exit naturally before the delay elapses.
    exitTimer.unref();
});

// ---------------------------------------------------------------------------
// IPC handlers – serial port passthrough
// ---------------------------------------------------------------------------

function registerSerialHandlers() {
    // List available serial ports
    ipcMain.handle("serial:list", async () => {
        try {
            const ports = await SerialPort.list();
            return { success: true, ports };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Open a serial port
    ipcMain.handle("serial:open", async (event, { path: portPath, baudRate = 115200 }) => {
        try {
            if (openPorts.has(portPath)) {
                return { success: true, connectionId: portPath };
            }

            const port = new SerialPort({ path: portPath, baudRate, autoOpen: false });

            await new Promise((resolve, reject) => {
                port.open((err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            openPorts.set(portPath, port);

            // Forward incoming data to the renderer
            port.on("data", (chunk) => {
                const senderWebContents = event.sender;
                if (!senderWebContents.isDestroyed()) {
                    senderWebContents.send("serial:data", { connectionId: portPath, data: Array.from(chunk) });
                }
            });

            port.on("close", () => {
                openPorts.delete(portPath);
                const senderWebContents = event.sender;
                if (!senderWebContents.isDestroyed()) {
                    senderWebContents.send("serial:closed", { connectionId: portPath });
                }
            });

            port.on("error", (err) => {
                console.error(`[ELECTRON-SERIAL] Port error on ${portPath}:`, err.message);
                const senderWebContents = event.sender;
                if (!senderWebContents.isDestroyed()) {
                    senderWebContents.send("serial:error", { connectionId: portPath, error: err.message });
                }
            });

            return { success: true, connectionId: portPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Write data to a serial port
    ipcMain.handle("serial:write", async (_event, { connectionId, data }) => {
        const port = openPorts.get(connectionId);
        if (!port) {
            return { success: false, error: "Port not open" };
        }
        try {
            const buffer = Buffer.from(data);
            await new Promise((resolve, reject) => {
                port.write(buffer, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            return { success: true, bytesSent: buffer.length };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Close a serial port
    ipcMain.handle("serial:close", async (_event, { connectionId }) => {
        const port = openPorts.get(connectionId);
        if (!port) {
            return { success: true }; // Already closed
        }
        try {
            await new Promise((resolve, reject) => {
                port.close((err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            openPorts.delete(connectionId);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
}
