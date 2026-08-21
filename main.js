const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

let mainWindow = null;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

function createWindow () {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 1000,
        minWidth: 1280,
        minHeight: 1000,
        title: "YT to MP3 — Advanced Converter Pro V1.2",
        icon: path.join(__dirname, 'yt2mp3.ico'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    
    mainWindow.setMenu(null);

    mainWindow.loadFile('YT2MP3.html');

    mainWindow.on('page-title-updated', (e) => {
        e.preventDefault();
    });

    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.control && input.key.toLowerCase() === 'r' && !input.shift) {
            event.preventDefault(); 
        }
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http')) {
            shell.openExternal(url);
            return { action: 'deny' };
        }
        return { action: 'allow' };
    });

    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (url.startsWith('http') && url !== mainWindow.webContents.getURL()) {
            event.preventDefault();
            shell.openExternal(url);
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

if (gotSingleInstanceLock) {
    app.whenReady().then(() => {
        createWindow();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
}