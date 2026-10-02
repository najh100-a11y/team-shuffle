'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (json) => ipcRenderer.invoke('data:save', json),
  saveFile: (name, content) => ipcRenderer.invoke('file:save', name, content),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text)
});
