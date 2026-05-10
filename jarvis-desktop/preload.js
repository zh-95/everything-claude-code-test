const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {
  // Window controls
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close:    () => ipcRenderer.invoke('window-close'),

  // API key
  getApiKey: () => ipcRenderer.invoke('get-api-key'),
  setApiKey: (key) => ipcRenderer.invoke('set-api-key', key),
  hasApiKey: () => ipcRenderer.invoke('has-api-key'),

  // Messaging
  sendMessage: (data) => ipcRenderer.invoke('send-message', data),

  // Stream events
  onStreamChunk: (cb) => ipcRenderer.on('stream-chunk', (_e, text) => cb(text)),
  removeStreamListeners: () => ipcRenderer.removeAllListeners('stream-chunk'),
});
