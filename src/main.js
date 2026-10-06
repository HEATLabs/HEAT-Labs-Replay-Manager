const {
    app,
    BrowserWindow,
    ipcMain
} = require('electron');
const path = require('path');
const DiscordRichPresence = require('./discord-rpc');

let mainWindow;
let discordRPC = null;

// Discord Application Client ID
const DISCORD_CLIENT_ID = '1557140897240715505';

// Development flag
const isDevelopment = false;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        minWidth: 1280,
        minHeight: 720,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true,
            devTools: isDevelopment
        },
        frame: false,
        titleBarStyle: 'hidden',
        backgroundColor: '#141312',
        show: false,
        icon: path.join(__dirname, '../assets/icon.png')
    });

    mainWindow.loadFile('src/index.html');

    // Block dev tools in production
    if (!isDevelopment) {
        mainWindow.webContents.on('devtools-opened', () => {
            mainWindow.webContents.closeDevTools();
        });

        mainWindow.webContents.on('before-input-event', (event, input) => {
            if (input.key === 'F12' ||
                (input.control && input.shift && input.key.toLowerCase() === 'i') ||
                (input.control && input.shift && input.key.toLowerCase() === 'c')) {
                event.preventDefault();
            }
        });
    }

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
        if (discordRPC) {
            discordRPC.disconnect();
        }
    });
}

// Initialize Discord Rich Presence
function initializeDiscordRPC() {
    if (DISCORD_CLIENT_ID && DISCORD_CLIENT_ID !== 'CLIENT_ID_HERE') {
        discordRPC = new DiscordRichPresence(DISCORD_CLIENT_ID);
        discordRPC.initialize().then(success => {
            if (success) {
                console.log('Discord Rich Presence initialized successfully');
            }
        });
    } else {
        console.warn('Discord Client ID not configured.');
    }
}

// Window controls
ipcMain.handle('window-minimize', () => {
    if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('window-maximize', () => {
    if (mainWindow) {
        if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
        } else {
            mainWindow.maximize();
        }
    }
});

ipcMain.handle('window-close', () => {
    if (mainWindow) mainWindow.close();
});

ipcMain.handle('window-is-maximized', () => {
    return mainWindow ? mainWindow.isMaximized() : false;
});

app.whenReady().then(() => {
    createWindow();
    setTimeout(() => {
        initializeDiscordRPC();
    }, 2000);
});

app.on('window-all-closed', () => {
    if (discordRPC) discordRPC.disconnect();
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
    if (discordRPC) discordRPC.disconnect();
});