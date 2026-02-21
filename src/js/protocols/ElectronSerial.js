const logHead = "[ELECTRONSERIAL]";

/**
 * ElectronSerial – serial protocol implementation for the Electron host.
 *
 * Communication with the native serial port happens through the IPC bridge
 * that is exposed by `electron/preload.js` as `window.electronAPI`.
 */
class ElectronSerial extends EventTarget {
    constructor() {
        super();

        this.connected = false;
        this.openRequested = false;
        this.closeRequested = false;
        this.transmitting = false;
        this.connectionInfo = null;
        this.connectionId = null;

        this.bitrate = 0;
        this.bytesSent = 0;
        this.bytesReceived = 0;
        this.failed = 0;

        this.ports = [];
        this._removeDataListener = null;
        this._removeClosedListener = null;
        this._removeErrorListener = null;

        if (!window.electronAPI) {
            console.error(`${logHead} window.electronAPI is not available – preload script may not have loaded`);
            throw new Error("ElectronSerial requires window.electronAPI (Electron preload script not loaded)");
        }

        // Listen for incoming serial data forwarded from the main process
        this._removeDataListener = window.electronAPI.onData((payload) => {
            if (payload.connectionId !== this.connectionId) return;
            const data = new Uint8Array(payload.data);
            this.bytesReceived += data.byteLength;
            this.dispatchEvent(new CustomEvent("receive", { detail: data }));
        });

        // Listen for port-closed notifications (e.g. device unplugged)
        this._removeClosedListener = window.electronAPI.onClosed((payload) => {
            if (payload.connectionId !== this.connectionId) return;
            if (this.connected) {
                console.log(`${logHead} Port closed externally: ${payload.connectionId}`);
                this._handleExternalClose();
            }
        });

        // Listen for port error notifications
        this._removeErrorListener = window.electronAPI.onError((payload) => {
            if (payload.connectionId !== this.connectionId) return;
            console.error(`${logHead} Port error: ${payload.error}`);
        });

        this.loadDevices();
    }

    async loadDevices() {
        try {
            const result = await window.electronAPI.listPorts();
            if (result.success) {
                this.ports = result.ports.map((p) => this._createPort(p));
            }
        } catch (error) {
            console.error(`${logHead} Error loading devices:`, error);
        }
    }

    _createPort(portInfo) {
        return {
            path: portInfo.path,
            displayName: portInfo.friendlyName || portInfo.manufacturer || portInfo.path,
            vendorId: portInfo.vendorId,
            productId: portInfo.productId,
        };
    }

    async getDevices() {
        await this.loadDevices();
        return this.ports;
    }

    async requestPermissionDevice() {
        // Electron has direct OS-level access; no permission request needed.
        // Refresh and return the first available port as a convenience.
        await this.loadDevices();
        return this.ports[0] ?? null;
    }

    getConnectedPort() {
        return this.ports.find((p) => p.path === this.connectionId) ?? null;
    }

    async connect(path, options = { baudRate: 115200 }) {
        if (this.connected) {
            console.log(`${logHead} Already connected`);
            return true;
        }

        this.openRequested = true;
        this.closeRequested = false;

        try {
            const result = await window.electronAPI.openPort(path, options.baudRate ?? 115200);
            if (!result.success) {
                console.error(`${logHead} Failed to open port: ${result.error}`);
                this.openRequested = false;
                this.dispatchEvent(new CustomEvent("connect", { detail: false }));
                return false;
            }

            this.connected = true;
            this.connectionId = result.connectionId;
            this.bitrate = options.baudRate ?? 115200;
            this.bytesReceived = 0;
            this.bytesSent = 0;
            this.failed = 0;
            this.openRequested = false;
            this.connectionInfo = { path };

            console.log(`${logHead} Connection opened: ${this.connectionId}, Baud: ${this.bitrate}`);
            this.dispatchEvent(new CustomEvent("connect", { detail: this.connectionInfo }));
            return true;
        } catch (error) {
            console.error(`${logHead} Error connecting:`, error);
            this.openRequested = false;
            this.dispatchEvent(new CustomEvent("connect", { detail: false }));
            return false;
        }
    }

    async disconnect() {
        if (!this.connected) {
            return true;
        }

        if (this.closeRequested) {
            return true;
        }

        this.closeRequested = true;
        this.connected = false;

        try {
            await window.electronAPI.closePort(this.connectionId);
            console.log(
                `${logHead} Connection closed: ${this.connectionId}, Sent: ${this.bytesSent} bytes, Received: ${this.bytesReceived} bytes`,
            );
        } catch (error) {
            console.error(`${logHead} Error closing port:`, error);
        }

        this._resetState();
        this.dispatchEvent(new CustomEvent("disconnect", { detail: true }));
        return true;
    }

    async send(data, callback) {
        if (!this.connected || !this.connectionId) {
            console.error(`${logHead} Cannot send – port not open`);
            if (callback) callback({ bytesSent: 0 });
            return { bytesSent: 0 };
        }

        try {
            const result = await window.electronAPI.writePort(this.connectionId, Array.from(new Uint8Array(data)));
            if (!result.success) {
                throw new Error(result.error);
            }
            this.bytesSent += result.bytesSent;
            const ret = { bytesSent: result.bytesSent };
            if (callback) callback(ret);
            return ret;
        } catch (error) {
            console.error(`${logHead} Error sending data:`, error);
            if (callback) callback({ bytesSent: 0 });
            return { bytesSent: 0 };
        }
    }

    _handleExternalClose() {
        this.connected = false;
        this._resetState();
        this.dispatchEvent(new CustomEvent("disconnect", { detail: true }));
    }

    _resetState() {
        this.connectionId = null;
        this.bitrate = 0;
        this.connectionInfo = null;
        this.closeRequested = false;
        this.transmitting = false;
    }
}

export default ElectronSerial;
