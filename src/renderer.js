const {
    ipcRenderer
} = require('electron');

// Model (pure transforms)
const ReplayHelperModel = (function() {
    'use strict';

    const BADGE_OLDER_VERSION = 'recorded on an older game version';
    const ROTATION_REMOVED_NOTE = "deleted by the game's 10-replay rotation";
    const BADGE_NO_MATCHING_CLIENT = 'incompatible';
    const RESULT_NOT_RECORDED = 'Result: not recorded';
    const TABLE_RESULT_UNKNOWN = 'Unknown';

    function displayMap(row) {
        if (row.mapName) return row.mapName;
        if (row.mapRawRemainder) return row.mapRawRemainder;
        if (row.mapIndex) return `index ${row.mapIndex}`;
        return '';
    }

    function displayMode(row) {
        const mode = row && row.mode;
        if (!mode) return '';
        return mode.charAt(0).toUpperCase() + mode.slice(1);
    }

    function tableResult(row) {
        const r = row && row.battleResult;
        if (!r || r === RESULT_NOT_RECORDED) return TABLE_RESULT_UNKNOWN;
        return r;
    }

    function mergeListing(entries) {
        const byName = new Map();
        for (const e of entries || []) {
            const existing = byName.get(e.filename);
            if (!existing) {
                byName.set(e.filename, {
                    ...e,
                    starred: e.archived === true
                });
                continue;
            }
            const starred = existing.starred || e.archived === true;
            const canonical = e.archived ? e : existing;
            byName.set(e.filename, {
                ...canonical,
                starred
            });
        }
        return Array.from(byName.values());
    }

    function filterRows(rows, query) {
        const q = (query || '').trim().toLowerCase();
        if (!q) return rows.slice();
        return rows.filter((r) => {
            const haystack = [r.filename, r.displayName, displayMap(r), r.mode, r.dateTime, r.battleResult]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
            return haystack.includes(q);
        });
    }

    const SORT_FIELDS = {
        date: (r) => r.dateTime || '',
        map: (r) => displayMap(r).toLowerCase(),
        mode: (r) => (r.mode || '').toLowerCase(),
        size: (r) => r.sizeBytes || 0,
        filename: (r) => r.filename || '',
    };

    function sortRows(rows, sortBy, direction) {
        const key = SORT_FIELDS[sortBy] || SORT_FIELDS.date;
        const dir = direction === 'asc' ? 1 : -1;
        return rows.slice().sort((a, b) => {
            const av = key(a);
            const bv = key(b);
            if (av < bv) return -1 * dir;
            if (av > bv) return 1 * dir;
            return 0;
        });
    }

    function diskUsageSummary(rows) {
        let gameBytes = 0;
        let archiveBytes = 0;
        for (const r of rows || []) {
            if (r.archived) archiveBytes += r.sizeBytes || 0;
            else gameBytes += r.sizeBytes || 0;
        }
        const toMB = (b) => Number((b / 1e6).toFixed(1));
        return {
            gameBytes,
            archiveBytes,
            totalBytes: gameBytes + archiveBytes,
            gameMB: toMB(gameBytes),
            archiveMB: toMB(archiveBytes),
            totalMB: toMB(gameBytes + archiveBytes),
        };
    }

    function computeBadges(rows) {
        const withCommit = (rows || []).filter((r) => r.buildCommit && r.buildCommit.commit);
        if (withCommit.length === 0) {
            return (rows || []).map((r) => ({
                ...r,
                badge: null
            }));
        }
        let newest = withCommit[0];
        for (const r of withCommit) {
            if ((r.dateTime || '') > (newest.dateTime || '')) newest = r;
        }
        const newestCommit = newest.buildCommit.commit;
        return (rows || []).map((r) => {
            if (!r.buildCommit || !r.buildCommit.commit) return {
                ...r,
                badge: null
            };
            return {
                ...r,
                badge: r.buildCommit.commit !== newestCommit ? BADGE_OLDER_VERSION : null
            };
        });
    }

    function applyInstallBadges(rows) {
        return (rows || []).map((r) => {
            if (!r.installMatch) return r;
            if (r.installMatch.status === 'none') return {
                ...r,
                badge: BADGE_NO_MATCHING_CLIENT
            };
            return {
                ...r,
                badge: null
            };
        });
    }

    function annotateRotationRemovals(previousRows, freshEntries, excludedFilenames) {
        const freshNames = new Set((freshEntries || []).map((e) => e.filename));
        const excluded = excludedFilenames || new Set();
        return (previousRows || [])
            .filter((r) => !r.archived && !freshNames.has(r.filename) && !excluded.has(r.filename))
            .map((r) => ({
                ...r,
                removed: true,
                removedNote: ROTATION_REMOVED_NOTE
            }));
    }

    return {
        displayMap,
        displayMode,
        tableResult,
        mergeListing,
        filterRows,
        sortRows,
        diskUsageSummary,
        computeBadges,
        applyInstallBadges,
        annotateRotationRemovals,
        BADGE_OLDER_VERSION,
        BADGE_NO_MATCHING_CLIENT,
        ROTATION_REMOVED_NOTE,
        RESULT_NOT_RECORDED,
        TABLE_RESULT_UNKNOWN,
    };
})();

// Status Messages
const ReplayHelperMessages = (function() {
    'use strict';

    const ARCHIVE_MESSAGES = {
        archived: 'Replay archived successfully.',
        unarchived: 'Replay restored to game folder.',
        'already-archived': 'This replay is already in your archive.',
        'already-unarchived': 'This replay is already in the game folder.',
        'verify-failed': 'Failed to verify the archived copy.',
        'source-gone': 'The source replay file no longer exists.',
        error: 'Failed to archive replay.',
        stale: 'This replay is no longer available. Refreshing...',
        'invalid-archive-dir': 'Invalid archive directory.',
    };

    const LAUNCH_MESSAGES = {
        ok: 'Replay launched successfully.',
        'file-gone': 'The replay file no longer exists.',
        error: 'Failed to launch replay.',
        stale: 'This replay is no longer available. Refreshing...',
        'launcher-missing': 'Game launcher not found. Please check your installation.',
    };

    const SETTINGS_MESSAGES = {
        'invalid-install-dir': 'The selected folder does not contain the game launcher.',
        'invalid-archive-dir': 'The archive folder could not be created or accessed.',
    };

    const LIST_STATUS_MESSAGES = {
        'folder-missing': 'Game installation folder not found. Please configure it in Options.',
        empty: 'No replays found in the game folder.',
    };

    const CODE_PHRASES = {
        ENOSPC: 'Not enough disk space.',
        EPERM: 'Permission denied.',
        EACCES: 'Permission denied.',
        EBUSY: 'File is busy.',
        ENOENT: 'File not found.',
    };

    function codePhrase(code) {
        return (code && CODE_PHRASES[code]) || null;
    }

    function archiveMessage(status, code) {
        const base = ARCHIVE_MESSAGES[status] || ARCHIVE_MESSAGES.error;
        const phrase = status === 'error' ? codePhrase(code) : null;
        return phrase ? `${base} ${phrase}` : base;
    }

    function launchMessage(status, code) {
        const base = LAUNCH_MESSAGES[status] || LAUNCH_MESSAGES.error;
        const phrase = status === 'error' ? codePhrase(code) : null;
        return phrase ? `${base} ${phrase}` : base;
    }

    function settingsMessage(status) {
        return SETTINGS_MESSAGES[status] || 'Failed to save settings.';
    }

    function listStatusMessage(status) {
        return LIST_STATUS_MESSAGES[status] || null;
    }

    return {
        ARCHIVE_MESSAGES,
        LAUNCH_MESSAGES,
        SETTINGS_MESSAGES,
        LIST_STATUS_MESSAGES,
        CODE_PHRASES,
        codePhrase,
        archiveMessage,
        launchMessage,
        settingsMessage,
        listStatusMessage,
    };
})();

// App State
const state = {
    rawEntries: [],
    sortField: 'date',
    sortDirection: 'desc',
    filterQuery: '',
    selectedFilename: null,
    listStatus: 'ok',
    removedNotes: [],
    installs: [],
    activeBinDir: null,
    configuredBinDir: null,
    detailPaneOpen: false,
    archiveEntries: [],
    archiveStatus: 'ok',
    busyReplays: new Set(),
    hasCustomNames: false,
    hasArchiveCustomNames: false,
    displayNames: {},
    bannerTimer: null,
    archiveBannerTimer: null,
    loadingCounter: 0,
    deletedFilenames: new Set(),
    mapsData: null,
};

// DOM Elements
const els = {
    rows: document.getElementById('replayRows'),
    archiveRows: document.getElementById('archiveRows'),
    archiveBanner: document.getElementById('archiveBanner'),
    archiveDiskUsage: document.getElementById('archiveDiskUsage'),
    filterInput: document.getElementById('filterInput'),
    sortField: document.getElementById('sortField'),
    sortDirection: document.getElementById('sortDirection'),
    detailPane: document.getElementById('detailPane'),
    statusBanner: document.getElementById('statusBanner'),
    diskUsage: document.getElementById('diskUsage'),
    openGameFolder: document.getElementById('openGameFolder'),
    openArchiveFolder: document.getElementById('openArchiveFolder'),
    installDirInput: document.getElementById('installDirInput'),
    archiveDirInput: document.getElementById('archiveDirInput'),
    saveSettingsBtn: document.getElementById('saveSettingsBtn'),
    welcomeOverlay: document.getElementById('welcomeOverlay'),
    welcomeDismissBtn: document.getElementById('welcomeDismissBtn'),
    welcomeBody3: document.getElementById('welcomeBody3'),
    clientSelect: document.getElementById('clientSelect'),
    clientsFound: document.getElementById('clientsFound'),
    activeClient: document.getElementById('activeClient'),
    detectedClientsCount: document.getElementById('detectedClientsCount'),
    controlsOverlay: document.getElementById('controlsOverlay'),
    controlsDismissBtn: document.getElementById('controlsDismissBtn'),
    refreshReplays: document.getElementById('refreshReplays'),
    browseInstallDir: document.getElementById('browseInstallDir'),
    clearInstallDir: document.getElementById('clearInstallDir'),
    browseArchiveDir: document.getElementById('browseArchiveDir'),
    clearArchiveDir: document.getElementById('clearArchiveDir'),
    replaysListHeader: document.getElementById('replaysListHeader'),
    archiveListHeader: document.getElementById('archiveListHeader'),
    loadingOverlay: document.getElementById('loadingOverlay'),
    loadingText: document.getElementById('loadingText'),
};

// Tab Info Data
const tabInfoData = {
    replays: {
        title: 'Replays',
        description: 'Browse and manage your World of Tanks: HEAT replay files. Click on a replay to see details and actions.',
        details: [
            'View all replays from your game folder and archive',
            'Click a replay to see detailed information and available actions',
            'Use the search bar to filter replays by map, mode, date, or result',
            'Play replays directly from the app',
            'Archive replays to preserve them beyond the game\'s 10-replay rotation'
        ]
    },
    archive: {
        title: 'Archive',
        description: 'Your archived replays. Archived replays are copied to a separate folder so they are not deleted by the game\'s replay rotation.',
        details: [
            'Archived replays are stored in a separate folder',
            'The game\'s 10-replay rotation only affects the game folder, not the archive',
            'You can play archived replays just like regular replays',
            'Use the Unarchive button to move a replay back to the game folder'
        ]
    },
    options: {
        title: 'Options',
        description: 'Configure the Replay Manager application settings. Clients are auto-detected on startup.',
        details: [
            'Game Install Directory: Auto-detected on startup, can be overridden manually',
            'Archive Directory: Where archived replays are stored (defaults to replays/archived folder)',
            'Preferred Client: Choose which installed client to use when launching replays',
            'Settings are saved automatically when you click Save Settings'
        ]
    }
};

// Info Modal
const infoModal = document.getElementById('infoModal');
const infoModalTitle = document.getElementById('infoModalTitle');
const infoModalDescription = document.getElementById('infoModalDescription');
const infoModalDetails = document.getElementById('infoModalDetails');
const infoModalClose = document.getElementById('infoModalClose');
const infoModalOk = document.getElementById('infoModalOk');

// Loading Overlay
function showLoading(text) {
    state.loadingCounter++;
    if (els.loadingOverlay) {
        els.loadingOverlay.hidden = false;
        if (els.loadingText) {
            els.loadingText.textContent = text || 'Loading...';
        }
    }
}

function hideLoading() {
    state.loadingCounter = Math.max(0, state.loadingCounter - 1);
    if (state.loadingCounter === 0 && els.loadingOverlay) {
        els.loadingOverlay.hidden = true;
    }
}

async function withLoading(text, fn) {
    showLoading(text);
    try {
        return await fn();
    } finally {
        hideLoading();
    }
}

// Load maps data
async function loadMapsData() {
    try {
        const result = await ipcRenderer.invoke('get-maps-data');
        if (result.status === 'ok' && result.maps) {
            state.mapsData = result.maps;
        }
    } catch (e) {
        console.error('Failed to load maps data:', e);
    }
}

function findMapImage(mapName) {
    if (!mapName || !state.mapsData) return null;
    const normalized = mapName.toLowerCase().trim();
    const map = state.mapsData.find(m => {
        if (!m.name) return false;
        const mName = m.name.toLowerCase().trim();
        return mName === normalized ||
               mName.replace(/\s*one$/i, '') === normalized.replace(/\s*one$/i, '');
    });
    return map ? map.image : null;
}

// Boot
document.addEventListener('DOMContentLoaded', async () => {
    await initializeApp();
    initInfoModal();
    initTabInfoButtons();
    initWelcomeOverlay();
    initControlsOverlay();
    initDetailPaneDismiss();
    initRenameModal();
});

async function initializeApp() {
    // Window controls
    document.getElementById('minimizeBtn').addEventListener('click', () => ipcRenderer.invoke('window-minimize'));
    document.getElementById('maximizeBtn').addEventListener('click', async () => {
        await ipcRenderer.invoke('window-maximize');
        updateMaximizeButton();
    });
    document.getElementById('closeBtn').addEventListener('click', () => ipcRenderer.invoke('window-close'));

    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Replay controls
    if (els.filterInput) {
        els.filterInput.addEventListener('input', (e) => {
            state.filterQuery = e.target.value;
            renderRows();
        });
    }

    if (els.sortField) {
        els.sortField.addEventListener('change', (e) => {
            state.sortField = e.target.value;
            renderRows();
            renderArchiveRows();
        });
    }

    if (els.sortDirection) {
        els.sortDirection.addEventListener('click', () => {
            state.sortDirection = state.sortDirection === 'desc' ? 'asc' : 'desc';
            els.sortDirection.textContent = state.sortDirection === 'desc' ? 'Newest First' : 'Oldest First';
            renderRows();
            renderArchiveRows();
        });
    }

    if (els.refreshReplays) {
        els.refreshReplays.addEventListener('click', () => refreshList(true));
    }

    // Folder buttons
    if (els.openGameFolder) {
        els.openGameFolder.addEventListener('click', () => ipcRenderer.invoke('open-folder', 'game'));
    }
    if (els.openArchiveFolder) {
        els.openArchiveFolder.addEventListener('click', () => ipcRenderer.invoke('open-folder', 'archive'));
    }

    // Settings
    if (els.saveSettingsBtn) {
        els.saveSettingsBtn.addEventListener('click', saveSettings);
    }
    if (els.browseInstallDir) {
        els.browseInstallDir.addEventListener('click', () => browseFolder('install'));
    }
    if (els.clearInstallDir) {
        els.clearInstallDir.addEventListener('click', () => clearInstallDir());
    }
    if (els.browseArchiveDir) {
        els.browseArchiveDir.addEventListener('click', () => browseFolder('archive'));
    }
    if (els.clearArchiveDir) {
        els.clearArchiveDir.addEventListener('click', () => clearArchiveDir());
    }

    // Client selector
    if (els.clientSelect) {
        els.clientSelect.addEventListener('change', async (e) => {
            const chosen = e.target.value || null;
            const result = await ipcRenderer.invoke('set-settings', {
                preferredClient: chosen
            });
            if (result.status !== 'ok') {
                showBanner('warning', result.message);
            }
            await refreshInstalls();
        });
    }

    // Drag and drop
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
        e.preventDefault();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'r') {
            e.preventDefault();
            refreshList(true);
        }
        if (e.key === 'Escape') {
            const modal = document.getElementById('confirmationModal');
            if (modal && modal.classList.contains('show')) modal.classList.remove('show');
            const renameModal = document.getElementById('renameModal');
            if (renameModal && renameModal.classList.contains('show')) renameModal.classList.remove('show');
            if (infoModal && infoModal.classList.contains('show')) closeInfoModal();
            closeDetailPane();
        }
    });

    updateMaximizeButton();

    // Load maps data
    await loadMapsData();

    // AUTO-DETECT INSTALL ON STARTUP
    await autoDetectAndLoad();

    // Load initial data
    await loadSettings();
    await refreshInstalls();
    await refreshList();
    maybeShowWelcome();
}

async function autoDetectAndLoad() {
    try {
        const result = await ipcRenderer.invoke('auto-detect-install');

        if (result && result.found) {
            console.log(`Auto-detected ${result.installs.length} HEAT install(s)`);
            if (result.defaultBinDir && els.installDirInput && !els.installDirInput.value) {
                els.installDirInput.value = result.defaultBinDir;
            }
        } else {
            console.warn('No HEAT installs detected on this machine.');
        }
    } catch (error) {
        console.error('Auto-detect failed:', error);
    }
}

function updateMaximizeButton() {
    ipcRenderer.invoke('window-is-maximized').then(isMaximized => {
        const maximizeIcon = document.querySelector('#maximizeBtn svg');
        if (maximizeIcon) {
            if (isMaximized) {
                maximizeIcon.innerHTML = '<path d="M3 3h6v6H3zM7 7h6v6H7z" fill="none" stroke="currentColor" />';
            } else {
                maximizeIcon.innerHTML = '<path d="M1 1h10v10H1z" fill="none" stroke="currentColor" />';
            }
        }
    });
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    const targetBtn = document.querySelector(`[data-tab="${tabId}"]`);
    if (targetBtn) targetBtn.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    const targetTab = document.getElementById(`${tabId}-tab`);
    if (targetTab) targetTab.classList.add('active');
    closeDetailPane();

    if (tabId === 'archive') {
        renderArchiveRows();
    }
}

// Info Modal
function initInfoModal() {
    if (infoModalClose) infoModalClose.addEventListener('click', closeInfoModal);
    if (infoModalOk) infoModalOk.addEventListener('click', closeInfoModal);
    if (infoModal) {
        infoModal.addEventListener('click', (e) => {
            if (e.target === infoModal) closeInfoModal();
        });
    }
}

function initTabInfoButtons() {
    document.querySelectorAll('.tab-info-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const tabId = btn.dataset.tab;
            if (tabId && tabInfoData[tabId]) {
                showTabInfo(tabId);
            }
        });
    });
}

function showTabInfo(tabId) {
    const info = tabInfoData[tabId];
    if (!info || !infoModal) return;

    infoModalTitle.textContent = info.title;
    infoModalDescription.textContent = info.description;

    infoModalDetails.innerHTML = '';
    if (info.details && info.details.length > 0) {
        const ul = document.createElement('ul');
        info.details.forEach(detail => {
            const li = document.createElement('li');
            li.textContent = detail;
            ul.appendChild(li);
        });
        infoModalDetails.appendChild(ul);
    }

    infoModal.classList.add('show');
}

function closeInfoModal() {
    if (infoModal) infoModal.classList.remove('show');
}

// Welcome Overlay
function initWelcomeOverlay() {
    if (els.welcomeDismissBtn) {
        els.welcomeDismissBtn.addEventListener('click', async () => {
            els.welcomeOverlay.hidden = true;
            await ipcRenderer.invoke('set-settings', {
                welcomeSeen: true
            });
        });
    }
}

async function maybeShowWelcome() {
    const settings = await ipcRenderer.invoke('get-settings');
    if (!settings.welcomeSeen && els.welcomeOverlay) {
        els.welcomeOverlay.hidden = false;
    }
}

// Controls Overlay
function initControlsOverlay() {
    if (els.controlsDismissBtn) {
        els.controlsDismissBtn.addEventListener('click', () => {
            els.controlsOverlay.hidden = true;
        });
    }
}

// Detail Pane Dismiss
function initDetailPaneDismiss() {
    document.addEventListener('mousedown', (e) => {
        if (!state.detailPaneOpen) return;

        const detailPane = els.detailPane;
        if (!detailPane || !detailPane.classList.contains('detail-pane--open')) return;

        // Ignore clicks inside the detail pane
        if (detailPane.contains(e.target)) return;

        // Ignore clicks on a replay row (the row click handler will manage selection)
        const replayRow = e.target.closest('.replay-row');
        if (replayRow && !replayRow.classList.contains('replay-row--removed')) return;

        // Ignore clicks on modal elements
        if (e.target.closest('.modal')) return;

        closeDetailPane();
    });
}

function closeDetailPane() {
    state.selectedFilename = null;
    state.detailPaneOpen = false;
    if (els.detailPane) {
        els.detailPane.classList.remove('detail-pane--open');
        // Wait for the transition to finish before hiding
        setTimeout(() => {
            if (!els.detailPane.classList.contains('detail-pane--open')) {
                els.detailPane.hidden = true;
                els.detailPane.innerHTML = '';
            }
        }, 300);
    }
    renderRows();
    renderArchiveRows();
}

// Banner
const BANNER_AUTO_DISMISS_MS = 5000;

function showBanner(kind, message) {
    // Do not show info (blue) banners at all
    if (kind === 'info') return;
    if (!els.statusBanner) return;
    if (state.bannerTimer) {
        clearTimeout(state.bannerTimer);
        state.bannerTimer = null;
    }
    els.statusBanner.hidden = false;
    // Force reflow so the transition works when re-showing
    void els.statusBanner.offsetHeight;
    els.statusBanner.textContent = message;
    els.statusBanner.className = 'banner banner--' + kind;
    els.statusBanner.style.opacity = '1';
    els.statusBanner.style.transform = 'translateX(0)';
    state.bannerTimer = setTimeout(() => {
        hideBanner();
        state.bannerTimer = null;
    }, BANNER_AUTO_DISMISS_MS);
}

function hideBanner() {
    if (state.bannerTimer) {
        clearTimeout(state.bannerTimer);
        state.bannerTimer = null;
    }
    if (els.statusBanner && !els.statusBanner.hidden) {
        els.statusBanner.style.opacity = '0';
        els.statusBanner.style.transform = 'translateX(20px)';
        setTimeout(() => {
            if (els.statusBanner.style.opacity === '0') {
                els.statusBanner.hidden = true;
                els.statusBanner.style.opacity = '';
                els.statusBanner.style.transform = '';
            }
        }, 300);
    }
}

function showArchiveBanner(kind, message) {
    // Do not show info (blue) banners at all
    if (kind === 'info') return;
    if (!els.archiveBanner) return;
    if (state.archiveBannerTimer) {
        clearTimeout(state.archiveBannerTimer);
        state.archiveBannerTimer = null;
    }
    els.archiveBanner.hidden = false;
    void els.archiveBanner.offsetHeight;
    els.archiveBanner.textContent = message;
    els.archiveBanner.className = 'banner banner--' + kind;
    els.archiveBanner.style.opacity = '1';
    els.archiveBanner.style.transform = 'translateX(0)';
    state.archiveBannerTimer = setTimeout(() => {
        hideArchiveBanner();
        state.archiveBannerTimer = null;
    }, BANNER_AUTO_DISMISS_MS);
}

function hideArchiveBanner() {
    if (state.archiveBannerTimer) {
        clearTimeout(state.archiveBannerTimer);
        state.archiveBannerTimer = null;
    }
    if (els.archiveBanner && !els.archiveBanner.hidden) {
        els.archiveBanner.style.opacity = '0';
        els.archiveBanner.style.transform = 'translateX(20px)';
        setTimeout(() => {
            if (els.archiveBanner.style.opacity === '0') {
                els.archiveBanner.hidden = true;
                els.archiveBanner.style.opacity = '';
                els.archiveBanner.style.transform = '';
            }
        }, 300);
    }
}

// Rendering
function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
}

function displayBadgeText(badge) {
    if (badge === ReplayHelperModel.BADGE_OLDER_VERSION) return 'Recorded on an older game version';
    if (badge === ReplayHelperModel.BADGE_NO_MATCHING_CLIENT) return 'Incompatible';
    return badge;
}

function computeDisplayRows() {
    const merged = ReplayHelperModel.mergeListing(state.rawEntries);

    const withMatch = merged.map((row) => {
        const commit = row.buildCommit && row.buildCommit.commit;
        if (!commit) {
            return {
                ...row,
                installMatch: {
                    status: 'unknown',
                    matches: [],
                    willUseLabel: null
                }
            };
        }
        const matches = state.installs.filter((i) => i.build && i.build.hash === commit);
        if (matches.length === 0) {
            return {
                ...row,
                installMatch: {
                    status: 'none',
                    matches: [],
                    willUseLabel: null
                }
            };
        }
        return {
            ...row,
            installMatch: {
                status: 'exact',
                matches,
                matchLabels: matches.map((m) => m.label),
                willUseLabel: matches[0].label,
            },
        };
    });

    const badged = ReplayHelperModel.applyInstallBadges(ReplayHelperModel.computeBadges(withMatch));
    const filtered = ReplayHelperModel.filterRows(badged, state.filterQuery);
    return ReplayHelperModel.sortRows(filtered, state.sortField, state.sortDirection);
}

function hasCustomNames(rows) {
    return (rows || []).some(r => r.displayName);
}

function updateListHeaders() {
    // Replays tab header
    const replaysHasNames = state.hasCustomNames;
    if (els.replaysListHeader) {
        const nameCol = els.replaysListHeader.querySelector('.col-name');
        if (nameCol) nameCol.hidden = !replaysHasNames;
        els.replaysListHeader.classList.toggle('name-visible', replaysHasNames);
    }
    if (els.rows) els.rows.classList.toggle('name-visible', replaysHasNames);

    // Archive tab header - uses separate flag
    const archiveHasNames = state.hasArchiveCustomNames;
    if (els.archiveListHeader) {
        const nameCol = els.archiveListHeader.querySelector('.col-name');
        if (nameCol) nameCol.hidden = !archiveHasNames;
        els.archiveListHeader.classList.toggle('name-visible', archiveHasNames);
    }
    if (els.archiveRows) els.archiveRows.classList.toggle('name-visible', archiveHasNames);
}

function renderRows() {
    if (!els.rows) return;

    if (state.listStatus === 'folder-missing') {
        renderPickerPrompt();
        return;
    }

    const rows = computeDisplayRows();
    const ghosts = state.removedNotes || [];

    state.hasCustomNames = hasCustomNames(rows);
    updateListHeaders();

    if (state.listStatus === 'empty' && rows.length === 0 && ghosts.length === 0) {
        renderEmptyExplainer();
        return;
    }

    els.rows.innerHTML = '';

    for (const ghost of ghosts) {
        els.rows.appendChild(buildGhostRowEl(ghost));
    }

    for (const row of rows) {
        const rowEl = buildReplayRowEl(row, state.hasCustomNames, false);
        els.rows.appendChild(rowEl);
    }

    renderDiskUsage();
}

function buildReplayRowEl(row, showName, isArchiveTab) {
    const rowEl = document.createElement('button');
    rowEl.type = 'button';
    const isBusy = state.busyReplays.has(row.filename);
    rowEl.className = 'replay-row' +
        (row.filename === state.selectedFilename ? ' replay-row--selected' : '') +
        (isBusy ? ' replay-row--busy' : '') +
        (isArchiveTab ? ' replay-row--archive' : '');
    rowEl.dataset.filename = row.filename;

    // Star column: only shown on Replays tab
    const starMarkup = isArchiveTab ?
        '' :
        (row.starred ?
            `<span class="replay-row__star" title="Archived">&#9733;</span>` :
            '<span class="replay-row__star replay-row__star--empty">&#9733;</span>');

    let badgeMarkup = '<span class="badge-label"></span>';
    if (row.badge === ReplayHelperModel.BADGE_NO_MATCHING_CLIENT) {
        badgeMarkup = `<span class="badge-label badge-label--incompatible">Incompatible</span>`;
    } else if (row.badge) {
        badgeMarkup = `<span class="badge-label badge-label--warning">${escapeHtml(displayBadgeText(row.badge))}</span>`;
    }

    const nameMarkup = showName ?
        `<span class="replay-row__name" title="${escapeHtml(row.displayName || '')}">${escapeHtml(row.displayName || '')}</span>` :
        '';

    const busyOverlay = isBusy ?
        `<span class="replay-row__busy">${escapeHtml(row._busyText || 'Working...')}</span>` :
        '';

    rowEl.innerHTML = `
        ${starMarkup}
        ${nameMarkup}
        <span class="replay-row__map">${escapeHtml(ReplayHelperModel.displayMap(row))}</span>
        <span class="replay-row__mode">${escapeHtml(ReplayHelperModel.displayMode(row) || 'Unknown')}</span>
        <span class="replay-row__date">${escapeHtml(row.dateTime || 'Unknown')}</span>
        <span class="replay-row__size">${row.sizeMB} MB</span>
        <span class="replay-row__result">${escapeHtml(ReplayHelperModel.tableResult(row))}</span>
        ${badgeMarkup}
        ${busyOverlay}
    `;

    rowEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.busyReplays.has(row.filename)) return;
        selectRow(row.filename);
    });

    return rowEl;
}

function renderArchiveRows() {
    if (!els.archiveRows) return;

    const archiveEntries = state.rawEntries.filter(r => r.archived);

    // Compute hasCustomNames specifically for archive entries
    state.hasArchiveCustomNames = hasCustomNames(archiveEntries);
    updateListHeaders();

    if (archiveEntries.length === 0) {
        els.archiveRows.innerHTML = `
            <div class="empty-state">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5">
                    <path d="M21 8v13H3V8" />
                    <path d="M1 3h22v5H1z" />
                    <path d="M10 12h4" />
                </svg>
                <h3>Archive is empty</h3>
                <p class="muted">Your archived replays will appear here. Use the Archive button on a replay to save it beyond the game's rotation.</p>
            </div>
        `;
        if (els.archiveDiskUsage) {
            els.archiveDiskUsage.textContent = 'Archive: 0 MB';
        }
        return;
    }

    const sorted = ReplayHelperModel.sortRows(archiveEntries, state.sortField, state.sortDirection);
    els.archiveRows.innerHTML = '';

    for (const row of sorted) {
        const rowEl = buildReplayRowEl(row, state.hasArchiveCustomNames, true);
        els.archiveRows.appendChild(rowEl);
    }

    if (els.archiveDiskUsage) {
        const usage = ReplayHelperModel.diskUsageSummary(archiveEntries);
        els.archiveDiskUsage.textContent = `Archive: ${usage.archiveMB} MB`;
    }
}

function buildGhostRowEl(row) {
    const el = document.createElement('div');
    el.className = 'replay-row replay-row--removed';
    el.innerHTML = `
        <span></span>
        <span class="replay-row__map">${escapeHtml(ReplayHelperModel.displayMap(row))}</span>
        <span class="replay-row__mode">${escapeHtml(ReplayHelperModel.displayMode(row))}</span>
        <span class="replay-row__date">${escapeHtml(row.dateTime || '')}</span>
        <span class="replay-row__size">${row.sizeMB} MB</span>
        <span class="replay-row__result">${escapeHtml(row.removedNote || '')}</span>
        <span></span>
    `;
    return el;
}

function renderPickerPrompt() {
    els.rows.innerHTML = `
        <div class="empty-state">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <p class="muted">${escapeHtml(ReplayHelperMessages.listStatusMessage('folder-missing'))}</p>
            <button id="pickInstallFolderBtn" class="btn-primary" type="button">Locate Game Folder</button>
        </div>
    `;
    const btn = document.getElementById('pickInstallFolderBtn');
    if (btn) btn.addEventListener('click', () => browseFolder('install'));
    renderDiskUsage();
}

function renderEmptyExplainer() {
    els.rows.innerHTML = `
        <div class="empty-state">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5">
                <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            <p class="muted">${escapeHtml(ReplayHelperMessages.listStatusMessage('empty'))}</p>
        </div>
    `;
    renderDiskUsage();
}

function renderDiskUsage() {
    if (!els.diskUsage) return;
    const usage = ReplayHelperModel.diskUsageSummary(ReplayHelperModel.mergeListing(state.rawEntries));
    els.diskUsage.textContent = `Game: ${usage.gameMB} MB | Archive: ${usage.archiveMB} MB | Total: ${usage.totalMB} MB`;
}

function findRow(filename) {
    return computeDisplayRows().find((r) => r.filename === filename);
}

function selectRow(filename) {
    state.selectedFilename = filename;
    state.detailPaneOpen = true;
    renderRows();
    renderArchiveRows();
    renderDetail();
}

function renderDetail() {
    const row = findRow(state.selectedFilename);
    if (!row) {
        if (els.detailPane) {
            els.detailPane.classList.remove('detail-pane--open');
            setTimeout(() => {
                if (!els.detailPane.classList.contains('detail-pane--open')) {
                    els.detailPane.hidden = true;
                    els.detailPane.innerHTML = '';
                }
            }, 300);
        }
        state.detailPaneOpen = false;
        return;
    }

    if (!els.detailPane) return;
    els.detailPane.hidden = false;
    // Force reflow so the transition works when re-opening
    void els.detailPane.offsetHeight;
    els.detailPane.classList.add('detail-pane--open');
    state.detailPaneOpen = true;

    const tanks = row.tanksDisplay || 'Not detected';
    const isBusy = state.busyReplays.has(row.filename);
    const busyText = row._busyText || '';
    const isIncompatible = row.installMatch && row.installMatch.status === 'none';

    // Get map image
    const mapImage = row.mapImage || findMapImage(row.mapName);

    let buildBlock = '';
    const match = row.installMatch;
    if (row.buildCommit && row.buildCommit.branch) {
        buildBlock += `<p class="muted">Recorded on ${escapeHtml(row.buildCommit.branch)} (${escapeHtml((row.buildCommit.commit || '').slice(0, 10))})</p>`;
    }

    let incompatWarning = '';
    if (isIncompatible) {
        incompatWarning = `
            <div class="detail-pane__warning detail-pane__warning--centered">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <p><strong>Incompatible</strong></p>
                <p class="muted">The current client is a newer version than the version this replay was recorded on.</p>
            </div>
        `;
    } else if (match && match.status === 'exact' && match.matchLabels && match.matchLabels.length > 0) {
        buildBlock += `<p class="muted">Plays in: ${escapeHtml(match.matchLabels.join(', '))}</p>`;
    }

    const archiveBtnHtml = row.starred ?
        `<button id="unarchiveBtn" class="btn-primary" type="button" ${isBusy ? 'disabled' : ''}>${isBusy && busyText === 'Unarchiving...' ? 'Unarchiving...' : 'Unarchive'}</button>` :
        `<button id="saveBtn" class="btn-secondary" type="button" ${isBusy ? 'disabled' : ''}>${isBusy && busyText === 'Archiving...' ? 'Archiving...' : 'Archive'}</button>`;

    const nameLine = row.displayName ?
        `<p class="detail-pane__custom-name">Name: <strong>${escapeHtml(row.displayName)}</strong></p>` :
        '';

    const playBtnDisabled = isBusy || isIncompatible;

    // Build map image HTML
    const mapImageHtml = mapImage ? `
        <div class="detail-pane__map-image">
            <img src="${escapeHtml(mapImage)}" alt="${escapeHtml(ReplayHelperModel.displayMap(row) || 'Map')}" loading="lazy">
        </div>
    ` : '';

    els.detailPane.innerHTML = `
        <button class="detail-pane__close" id="detailPaneClose" title="Close panel">×</button>
        ${mapImageHtml}
        ${incompatWarning}
        <div class="detail-pane__body">
            <h3>${escapeHtml(ReplayHelperModel.displayMap(row) || 'Unknown Map')} · ${escapeHtml(ReplayHelperModel.displayMode(row) || 'Unknown Mode')}</h3>
            ${nameLine}
            <p class="muted">${escapeHtml(row.dateTime || 'Unknown Date')}</p>
            <p>${escapeHtml(row.battleResult || 'Unknown Result')}</p>
            <p class="muted">${escapeHtml(tanks)}</p>
            <p class="muted">${row.sizeMB} MB</p>
            ${buildBlock}
            <div class="detail-pane__actions">
                <button id="playBtn" class="btn-primary btn-play" type="button" ${playBtnDisabled ? 'disabled' : ''}>Play</button>
                <div class="detail-pane__actions-row">
                    ${archiveBtnHtml}
                    <button id="renameBtn" class="btn-secondary" type="button" ${isBusy ? 'disabled' : ''}>Rename</button>
                    <button id="deleteBtn" class="btn-danger" type="button" ${isBusy ? 'disabled' : ''}>Delete</button>
                </div>
            </div>
        </div>
    `;

    const closeBtn = document.getElementById('detailPaneClose');
    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeDetailPane();
        });
    }

    const playBtn = document.getElementById('playBtn');
    if (playBtn) {
        playBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            onPlay(row);
        });
    }

    const saveBtn = document.getElementById('saveBtn');
    if (saveBtn) {
        saveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            onSave(row);
        });
    }

    const unarchiveBtn = document.getElementById('unarchiveBtn');
    if (unarchiveBtn) {
        unarchiveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            onUnarchive(row);
        });
    }

    const renameBtn = document.getElementById('renameBtn');
    if (renameBtn) {
        renameBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            onRename(row);
        });
    }

    const deleteBtn = document.getElementById('deleteBtn');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            onDelete(row);
        });
    }
}

// Actions
function toEntryRef(row) {
    return {
        filename: row.filename,
        archived: row.archived,
        fullPath: row.fullPath,
        dir: row.dir
    };
}

function setBusy(filename, text) {
    state.busyReplays.add(filename);
    const row = state.rawEntries.find(r => r.filename === filename);
    if (row) row._busyText = text;
    renderRows();
    renderArchiveRows();
    renderDetail();
}

function clearBusy(filename) {
    state.busyReplays.delete(filename);
    const row = state.rawEntries.find(r => r.filename === filename);
    if (row) delete row._busyText;
}

// Internal refresh
async function refreshListInternal() {
    hideBanner();
    hideArchiveBanner();

    const previousRows = computeDisplayRows();
    const result = await ipcRenderer.invoke('list-replays');
    const freshEntries = result.entries || [];
    state.removedNotes = ReplayHelperModel.annotateRotationRemovals(previousRows, freshEntries, state.deletedFilenames);
    state.rawEntries = freshEntries;
    state.displayNames = result.displayNames || {};

    // Preserve _busyText on fresh entries where applicable
    for (const e of state.rawEntries) {
        if (state.busyReplays.has(e.filename)) {
            const old = previousRows.find(p => p.filename === e.filename);
            if (old && old._busyText) e._busyText = old._busyText;
        }
    }

    state.listStatus = result.status || 'ok';
    renderRows();
    renderArchiveRows();
    renderDetail();
}

async function refreshList(showLoader = false) {
    if (showLoader) {
        await withLoading('Refreshing replays...', async () => {
            await refreshListInternal();
        });
    } else {
        await refreshListInternal();
    }
}

async function onPlay(row) {
    // Do not launch incompatible replays
    if (row.installMatch && row.installMatch.status === 'none') {
        return;
    }

    hideBanner();
    const result = await ipcRenderer.invoke('launch-replay', toEntryRef(row));

    if (result.status === 'stale') {
        showBanner('urgent', result.message);
        await refreshList();
        return;
    }

    if (result.status === 'launcher-missing') {
        showBanner('warning', result.message);
        return;
    }

    if (result.status !== 'ok') {
        showBanner('urgent', result.message);
        return;
    }

    const info = result.install;
    if (info && info.usedLabel) {
        return;
    }
}

async function onSave(row) {
    hideBanner();
    setBusy(row.filename, 'Archiving...');

    try {
        const result = await withLoading('Archiving replay...', async () => {
            await new Promise(r => setTimeout(r, 50));
            const res = await ipcRenderer.invoke('archive-replay', toEntryRef(row));
            await refreshListInternal();
            return res;
        });
        clearBusy(row.filename);
        renderRows();
        renderArchiveRows();
        renderDetail();

        let kind = 'urgent';
        if (result.status === 'archived' || result.status === 'already-archived') kind = 'info';
        else if (result.status === 'invalid-archive-dir') kind = 'warning';
        showBanner(kind, result.message);
    } catch (err) {
        clearBusy(row.filename);
        showBanner('urgent', 'Failed to archive replay.');
        renderRows();
        renderArchiveRows();
        renderDetail();
    }
}

async function onUnarchive(row) {
    hideBanner();
    setBusy(row.filename, 'Unarchiving...');

    try {
        const result = await withLoading('Restoring replay...', async () => {
            await new Promise(r => setTimeout(r, 50));
            const res = await ipcRenderer.invoke('unarchive-replay', toEntryRef(row));
            await refreshListInternal();
            return res;
        });
        clearBusy(row.filename);
        renderRows();
        renderArchiveRows();
        renderDetail();

        let kind = 'urgent';
        if (result.status === 'unarchived' || result.status === 'already-unarchived') kind = 'info';
        showBanner(kind, result.message);
    } catch (err) {
        clearBusy(row.filename);
        showBanner('urgent', 'Failed to unarchive replay.');
        renderRows();
        renderArchiveRows();
        renderDetail();
    }
}

async function onRename(row) {
    const currentName = row.displayName || '';
    const renameModal = document.getElementById('renameModal');
    const renameInput = document.getElementById('renameInput');
    const renameConfirm = document.getElementById('renameConfirm');
    const renameCancel = document.getElementById('renameCancel');
    const renameRevert = document.getElementById('renameRevert');
    const renameCharCount = document.getElementById('renameCharCount');

    if (!renameModal || !renameInput) return;

    renameInput.value = currentName;
    updateRenameCharCount(renameInput, renameCharCount);
    renameModal.classList.add('show');
    renameInput.focus();
    renameInput.select();

    renameModal.dataset.rowFilename = row.filename;

    // Remove old listeners by cloning
    const newConfirm = renameConfirm.cloneNode(true);
    const newCancel = renameCancel.cloneNode(true);
    const newRevert = renameRevert.cloneNode(true);
    renameConfirm.parentNode.replaceChild(newConfirm, renameConfirm);
    renameCancel.parentNode.replaceChild(newCancel, renameCancel);
    renameRevert.parentNode.replaceChild(newRevert, renameRevert);

    // Disable Revert when there is no custom name to revert
    newRevert.disabled = !currentName;

    // Update char count live
    renameInput.oninput = () => updateRenameCharCount(renameInput, renameCharCount);

    const doRename = async () => {
        const newName = renameInput.value.trim();
        if (!newName) {
            // Empty = clear
            renameModal.classList.remove('show');
            await withLoading('Removing name...', async () => {
                await ipcRenderer.invoke('revert-replay-name', toEntryRef(row));
                await refreshListInternal();
            });
            showBanner('info', 'Display name reverted.');
            return;
        }
        if (newName === currentName) {
            renameModal.classList.remove('show');
            return;
        }

        renameModal.classList.remove('show');
        hideBanner();

        const result = await withLoading('Renaming replay...', async () => {
            const res = await ipcRenderer.invoke('rename-replay', toEntryRef(row), newName);
            await refreshListInternal();
            return res;
        });

        if (result.status === 'ok') {
            showBanner('info', result.message);
        } else {
            showBanner('urgent', result.message);
        }
    };

    const doRevert = async () => {
        renameModal.classList.remove('show');
        hideBanner();
        const result = await withLoading('Removing name...', async () => {
            const res = await ipcRenderer.invoke('revert-replay-name', toEntryRef(row));
            await refreshListInternal();
            return res;
        });
        if (result.status === 'ok') {
            showBanner('info', 'Display name reverted to default.');
        } else {
            showBanner('urgent', result.message);
        }
    };

    const doCancel = () => {
        renameModal.classList.remove('show');
    };

    newConfirm.addEventListener('click', doRename);
    newCancel.addEventListener('click', doCancel);
    newRevert.addEventListener('click', doRevert);

    renameInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            doRename();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            doCancel();
        }
    };
}

function updateRenameCharCount(input, counterEl) {
    if (!input || !counterEl) return;
    const len = (input.value || '').length;
    counterEl.textContent = `${len} / 20`;
}

function initRenameModal() {
    const renameModal = document.getElementById('renameModal');
    if (renameModal) {
        renameModal.addEventListener('click', (e) => {
            if (e.target === renameModal) {
                renameModal.classList.remove('show');
            }
        });
    }
}

async function onDelete(row) {
    const confirmed = await showConfirmation(
        'Delete Replay',
        `Are you sure you want to delete "${row.filename}"? This cannot be undone.`
    );

    if (!confirmed) return;

    hideBanner();
    setBusy(row.filename, 'Deleting...');

    try {
        const result = await withLoading('Deleting replay...', async () => {
            await new Promise(r => setTimeout(r, 50));
            const res = await ipcRenderer.invoke('delete-replay', toEntryRef(row));
            state.selectedFilename = null;
            state.detailPaneOpen = false;
            state.deletedFilenames.add(row.filename);
            await refreshListInternal();
            return res;
        });
        clearBusy(row.filename);

        if (result.status === 'ok') {
            showBanner('info', result.message);
        } else {
            showBanner('urgent', result.message);
            renderRows();
            renderArchiveRows();
            renderDetail();
        }
    } catch (err) {
        clearBusy(row.filename);
        showBanner('urgent', 'Failed to delete replay.');
        renderRows();
        renderArchiveRows();
        renderDetail();
    }
}

// Confirmation Modal
function showConfirmation(title, message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirmationModal');
        const modalTitle = document.getElementById('modalTitle');
        const modalMessage = document.getElementById('modalMessage');
        const modalCancel = document.getElementById('modalCancel');
        const modalConfirm = document.getElementById('modalConfirm');

        if (!modal) return resolve(false);

        modalTitle.textContent = title;
        modalMessage.textContent = message;
        modal.classList.add('show');

        const handleConfirm = () => {
            modal.classList.remove('show');
            modalConfirm.removeEventListener('click', handleConfirm);
            modalCancel.removeEventListener('click', handleCancel);
            resolve(true);
        };

        const handleCancel = () => {
            modal.classList.remove('show');
            modalConfirm.removeEventListener('click', handleConfirm);
            modalCancel.removeEventListener('click', handleCancel);
            resolve(false);
        };

        modalConfirm.addEventListener('click', handleConfirm);
        modalCancel.addEventListener('click', handleCancel);
    });
}

// Settings
async function loadSettings() {
    const settings = await ipcRenderer.invoke('get-settings');
    if (settings.installBinDir && els.installDirInput) {
        els.installDirInput.value = settings.installBinDir;
    }
    if (settings.archiveDir && els.archiveDirInput) {
        els.archiveDirInput.value = settings.archiveDir;
    }
}

async function saveSettings() {
    const partial = {};

    if (els.installDirInput && els.installDirInput.value.trim()) {
        partial.installBinDir = els.installDirInput.value.trim();
    }
    if (els.archiveDirInput && els.archiveDirInput.value.trim()) {
        partial.archiveDir = els.archiveDirInput.value.trim();
    }

    const result = await withLoading('Saving settings...', async () => {
        const res = await ipcRenderer.invoke('set-settings', partial);
        await refreshListInternal();
        return res;
    });

    if (result.status === 'ok') {
        showBanner('info', 'Settings saved successfully.');
    } else {
        showBanner('warning', result.message);
    }
}

async function browseFolder(type) {
    const title = type === 'install' ?
        'Select Game Installation Folder' :
        'Select Archive Folder';

    const result = await ipcRenderer.invoke('browse-folder', title);
    if (result.status === 'cancelled') return;

    if (type === 'install') {
        if (els.installDirInput) els.installDirInput.value = result.path;
        const saveResult = await withLoading('Saving install directory...', async () => {
            const res = await ipcRenderer.invoke('set-settings', {
                installBinDir: result.path
            });
            await refreshInstalls();
            await refreshListInternal();
            return res;
        });
        if (saveResult.status !== 'ok') {
            showBanner('warning', saveResult.message);
        }
    } else {
        if (els.archiveDirInput) els.archiveDirInput.value = result.path;
        await withLoading('Saving archive directory...', async () => {
            await ipcRenderer.invoke('set-settings', {
                archiveDir: result.path
            });
            await refreshListInternal();
        });
    }
}

async function clearInstallDir() {
    if (els.installDirInput) els.installDirInput.value = '';
    await withLoading('Clearing install directory...', async () => {
        await ipcRenderer.invoke('set-settings', {
            installBinDir: null
        });
        await refreshInstalls();
        await refreshListInternal();
    });
}

async function clearArchiveDir() {
    if (els.archiveDirInput) els.archiveDirInput.value = '';
    await withLoading('Clearing archive directory...', async () => {
        await ipcRenderer.invoke('set-settings', {
            archiveDir: null
        });
        await refreshListInternal();
    });
}

// Installs
async function refreshInstalls() {
    const result = await ipcRenderer.invoke('list-installs');
    state.installs = (result && result.installs) || [];
    state.activeBinDir = (result && result.activeBinDir) || null;
    state.configuredBinDir = (result && result.configuredBinDir) || null;
    renderClientSelector();
    renderActiveClient();
    renderDetectedClientsCount();
}

function renderClientSelector() {
    if (!els.clientSelect) return;
    els.clientSelect.innerHTML = '';

    if (state.installs.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No clients found';
        els.clientSelect.appendChild(opt);
        els.clientSelect.disabled = true;
        return;
    }

    els.clientSelect.disabled = false;
    const autoOpt = document.createElement('option');
    autoOpt.value = '';
    autoOpt.textContent = 'Automatic';
    els.clientSelect.appendChild(autoOpt);

    for (const install of state.installs) {
        const opt = document.createElement('option');
        opt.value = install.binDir;
        opt.textContent = install.build && install.build.branch ?
            `${install.label} (${install.build.branch})` :
            install.label;
        els.clientSelect.appendChild(opt);
    }

    els.clientSelect.value = state.configuredBinDir || '';
}

function renderActiveClient() {
    if (!els.activeClient) return;
    const active = state.installs.find((i) => i.binDir === state.activeBinDir);
    els.activeClient.textContent = active ?
        `Active: ${active.label}` :
        'No active client';
}

function renderDetectedClientsCount() {
    if (!els.detectedClientsCount) return;
    if (state.installs.length === 0) {
        els.detectedClientsCount.textContent = 'No clients found';
    } else {
        els.detectedClientsCount.textContent = `${state.installs.length} client(s) found`;
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