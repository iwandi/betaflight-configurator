import { contextBridge, ipcRenderer } from "electron";

/**
 * Exposes a safe subset of Electron IPC to the renderer process.
 * The renderer accesses these methods via `window.electronAPI`.
 */
contextBridge.exposeInMainWorld("electronAPI", {
    // List available serial ports
    listPorts: () => ipcRenderer.invoke("serial:list"),

    // Open a serial port
    openPort: (path, baudRate) => ipcRenderer.invoke("serial:open", { path, baudRate }),

    // Write data to an open port
    writePort: (connectionId, data) => ipcRenderer.invoke("serial:write", { connectionId, data }),

    // Close an open port
    closePort: (connectionId) => ipcRenderer.invoke("serial:close", { connectionId }),

    // Register a callback for incoming serial data
    onData: (callback) => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on("serial:data", listener);
        // Return a cleanup function
        return () => ipcRenderer.off("serial:data", listener);
    },

    // Register a callback for port-closed notifications
    onClosed: (callback) => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on("serial:closed", listener);
        return () => ipcRenderer.off("serial:closed", listener);
    },

    // Register a callback for port error notifications
    onError: (callback) => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on("serial:error", listener);
        return () => ipcRenderer.off("serial:error", listener);
    },
});
