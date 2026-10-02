'use strict';
const { app, BrowserWindow, Menu, ipcMain, dialog, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const isMac = process.platform === 'darwin';
let mainWindow = null;

function dataPath() {
  return path.join(app.getPath('userData'), 'teamshuffle-data.json');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 860,
    minHeight: 600,
    title: '팀 랜덤 추첨기',
    backgroundColor: '#eef0ea',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, 'app', 'index.html'));

  // Links never open inside the app window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.on('closed', () => { mainWindow = null; });
}

function buildMenu() {
  if (isMac) {
    // macOS needs an Edit menu for copy/paste shortcuts inside text fields
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' }
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }
}

ipcMain.handle('data:load', async () => {
  try {
    return fs.existsSync(dataPath()) ? fs.readFileSync(dataPath(), 'utf-8') : null;
  } catch (err) {
    return null;
  }
});

ipcMain.handle('data:save', async (_event, json) => {
  if (typeof json !== 'string') return false;
  const file = dataPath();
  const tmp = file + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
    fs.writeFileSync(tmp, json, 'utf-8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    return false;
  }
});

ipcMain.handle('file:save', async (_event, defaultName, content) => {
  if (!mainWindow || typeof content !== 'string') return { ok: false };
  const ext = path.extname(defaultName).replace('.', '') || 'txt';
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('documents'), defaultName),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(result.filePath, content, 'utf-8');
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('clipboard:write', async (_event, text) => {
  if (typeof text !== 'string') return false;
  clipboard.writeText(text);
  return true;
});

// One running copy at a time, so two windows never overwrite each other's data
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
