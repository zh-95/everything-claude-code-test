const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {
  // Window
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close:    () => ipcRenderer.invoke('window-close'),

  // API key (Claude)
  hasApiKey: () => ipcRenderer.invoke('has-api-key'),
  getApiKey: () => ipcRenderer.invoke('get-api-key'),
  setApiKey: (k) => ipcRenderer.invoke('set-api-key', k),

  // Local models
  getLocalModels: () => ipcRenderer.invoke('get-local-models'),

  // Messaging
  sendMessage: (d) => ipcRenderer.invoke('send-message', d),

  // Streaming
  onStreamChunk:         (cb) => ipcRenderer.on('stream-chunk', (_, t) => cb(t)),
  removeStreamListeners: ()   => ipcRenderer.removeAllListeners('stream-chunk'),
});
