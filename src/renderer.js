const { ipcRenderer } = require('electron');

// DOM Elements
const minimizeBtn = document.getElementById('minimizeBtn');
const maximizeBtn = document.getElementById('maximizeBtn');
const closeBtn = document.getElementById('closeBtn');

// ========== Window Controls ==========
minimizeBtn.addEventListener('click', () => ipcRenderer.invoke('window-minimize'));
maximizeBtn.addEventListener('click', async () => {
    await ipcRenderer.invoke('window-maximize');
    updateMaximizeButton();
});
closeBtn.addEventListener('click', () => ipcRenderer.invoke('window-close'));

async function updateMaximizeButton() {
    const isMaximized = await ipcRenderer.invoke('window-is-maximized');
    const maximizeIcon = maximizeBtn.querySelector('svg');
    if (isMaximized) {
        maximizeIcon.innerHTML = '<path d="M3 3h6v6H3zM7 7h6v6H7z" fill="none" stroke="currentColor" />';
    } else {
        maximizeIcon.innerHTML = '<path d="M1 1h10v10H1z" fill="none" stroke="currentColor" />';
    }
}

// Splash Screen
setTimeout(() => {
    const splash = document.getElementById('splash-screen');
    const main = document.getElementById('main-app');
    if (splash && main) {
        splash.style.opacity = '0';
        setTimeout(() => {
            splash.style.display = 'none';
            main.style.opacity = '1';
        }, 500);
    }
}, 3500);

// Keyboard Shortcuts
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        // Close any modals if needed
    }
});

// Drag and Drop
document.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
});

document.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
});