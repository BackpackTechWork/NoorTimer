const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("prayerTimer", {
    getState: () => ipcRenderer.invoke("state:get"),
    saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
    refresh: () => ipcRenderer.invoke("prayers:refresh"),
    requestNotifications: () => ipcRenderer.invoke("notifications:request"),
    testSound: () => ipcRenderer.invoke("sound:test"),
    reverseGeocode: (coords) => ipcRenderer.invoke("location:reverse", coords),
    openApiDocs: () => ipcRenderer.invoke("app:openApi"),
    quit: () => ipcRenderer.invoke("app:quit"),
    onState: (callback) => {
        ipcRenderer.on("state:updated", (_event, state) => callback(state));
    },
    onRequestPermissions: (callback) => {
        ipcRenderer.on("permissions:request", () => callback());
    },
});
