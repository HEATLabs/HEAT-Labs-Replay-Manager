const {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    shell
} = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const {
    spawn,
    execFileSync
} = require('child_process');

let mainWindow;

// Development flag
const isDevelopment = false;

// Constants
const LAUNCHER_NAME = 'engine_launcher.exe';
const LAUNCHER_NAME_ALT = 'coldwar.exe';
const BUILD_META_NAME = 'build_meta.json';
const WGC_HELPER = 'wgc_api.exe';

const UNINSTALL_ROOTS = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

const SWEEP_ROOTS = ['C:\\Games', 'D:\\Games', 'C:\\', 'D:\\'];
const LEGACY_BIN_DIRS = ['C:\\Games\\HEAT\\bin', 'D:\\Games\\HEAT\\bin'];

const ARCHIVE_SUBDIR_NAME = 'archived';
const DISPLAY_NAMES_FILE = 'display_names.json';
const MAX_DISPLAY_NAME_LENGTH = 20;

// Map Data Cache
const MAPS_JSON_URL = 'https://cdn1.heatlabs.net/maps.json';
const MAPS_CACHE_FILE = 'maps_cache.json';
const MAPS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

let mapsDataCache = null;
let mapsDataCacheTime = 0;

// Settings
function defaultAppDataDir() {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

function getSettingsPath() {
    return path.join(defaultAppDataDir(), 'HEAT Replay Manager', 'settings.json');
}

function getMapsCachePath() {
    return path.join(defaultAppDataDir(), 'HEAT Replay Manager', MAPS_CACHE_FILE);
}

function readSettings() {
    const file = getSettingsPath();
    if (!fsSync.existsSync(file)) return {};
    try {
        const data = JSON.parse(fsSync.readFileSync(file, 'utf8'));
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (e) {
        return {};
    }
}

function writeSettings(partial) {
    const file = getSettingsPath();
    const dir = path.dirname(file);
    fsSync.mkdirSync(dir, {
        recursive: true
    });
    const merged = {
        ...readSettings(),
        ...(partial || {})
    };
    for (const [key, value] of Object.entries(partial || {})) {
        if (value === null) delete merged[key];
    }
    fsSync.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
    return merged;
}

// Maps Data Fetching
function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        const req = protocol.get(url, { timeout: 10000 }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                // Follow redirect
                fetchUrl(res.headers.location).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve(data));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
    });
}

async function loadMapsData() {
    const now = Date.now();

    // Return memory cache if fresh
    if (mapsDataCache && (now - mapsDataCacheTime) < MAPS_CACHE_MAX_AGE_MS) {
        return mapsDataCache;
    }

    // Try disk cache
    const cachePath = getMapsCachePath();
    try {
        if (fsSync.existsSync(cachePath)) {
            const stat = fsSync.statSync(cachePath);
            if ((now - stat.mtimeMs) < MAPS_CACHE_MAX_AGE_MS) {
                const cached = JSON.parse(fsSync.readFileSync(cachePath, 'utf8'));
                if (cached && cached.maps) {
                    mapsDataCache = cached;
                    mapsDataCacheTime = now;
                    return cached;
                }
            }
        }
    } catch (e) {
        // Ignore cache read errors
    }

    // Fetch from network
    try {
        const raw = await fetchUrl(MAPS_JSON_URL);
        const data = JSON.parse(raw);
        if (data && data.maps) {
            mapsDataCache = data;
            mapsDataCacheTime = now;
            // Write to disk cache
            try {
                const dir = path.dirname(cachePath);
                fsSync.mkdirSync(dir, { recursive: true });
                fsSync.writeFileSync(cachePath, JSON.stringify(data, null, 2));
            } catch (e) {
                // Ignore cache write errors
            }
            return data;
        }
    } catch (e) {
        console.error('Failed to fetch maps data:', e.message);
    }

    // Fall back to stale disk cache if available
    try {
        if (fsSync.existsSync(cachePath)) {
            const cached = JSON.parse(fsSync.readFileSync(cachePath, 'utf8'));
            if (cached && cached.maps) {
                mapsDataCache = cached;
                mapsDataCacheTime = now;
                return cached;
            }
        }
    } catch (e) {
        // Ignore
    }

    return { maps: [] };
}

function findMapByName(mapName) {
    if (!mapName || !mapsDataCache || !mapsDataCache.maps) return null;
    const normalized = mapName.toLowerCase().trim();
    return mapsDataCache.maps.find(m => {
        if (!m.name) return false;
        const mName = m.name.toLowerCase().trim();
        // Exact match or match ignoring "One" suffix
        return mName === normalized ||
               mName.replace(/\s*one$/i, '') === normalized.replace(/\s*one$/i, '');
    }) || null;
}

// Install Discovery

function isInstallBinDir(binDir) {
    if (typeof binDir !== 'string' || binDir.length === 0) return false;
    try {
        const full = path.join(binDir, LAUNCHER_NAME);
        const fullAlt = path.join(binDir, LAUNCHER_NAME_ALT);
        return (
            (fsSync.existsSync(full) && fsSync.statSync(full).isFile()) ||
            (fsSync.existsSync(fullAlt) && fsSync.statSync(fullAlt).isFile())
        );
    } catch (e) {
        return false;
    }
}

function readBuildMeta(binDir) {
    try {
        const raw = fsSync.readFileSync(path.join(binDir, BUILD_META_NAME), 'utf8');
        const meta = JSON.parse(raw);
        if (!meta || typeof meta !== 'object') return null;
        return {
            branch: typeof meta.branch === 'string' ? meta.branch : null,
            hash: typeof meta.hash === 'string' ? meta.hash : null,
            isLocalBuild: meta.is_local_build === true,
        };
    } catch (e) {
        return null;
    }
}

function defaultRegistryQuery(root) {
    try {
        return execFileSync('reg', ['query', root, '/s', '/f', WGC_HELPER, '/d'], {
            encoding: 'utf8',
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
        });
    } catch (e) {
        return '';
    }
}

function parseInstallRootsFromRegistry(output) {
    const roots = [];
    const re = new RegExp(`"?([A-Za-z]:\\\\[^"\\r\\n]*?)\\\\${WGC_HELPER}"?`, 'gi');
    let m;
    while ((m = re.exec(output || '')) !== null) {
        roots.push(m[1]);
    }
    return roots;
}

function sweepChildren(root) {
    const found = [];
    let names;
    try {
        names = fsSync.readdirSync(root, {
            withFileTypes: true
        });
    } catch (e) {
        return found;
    }
    for (const dirent of names) {
        if (!dirent.isDirectory()) continue;
        found.push(path.join(root, dirent.name));
    }
    return found;
}

function normalizeKey(binDir) {
    return path.resolve(binDir).toLowerCase();
}

function labelFor(installRoot) {
    return path.basename(installRoot) || installRoot;
}

function launcherMtimeMs(binDir) {
    try {
        return fsSync.statSync(path.join(binDir, LAUNCHER_NAME)).mtimeMs;
    } catch (e) {
        try {
            return fsSync.statSync(path.join(binDir, LAUNCHER_NAME_ALT)).mtimeMs;
        } catch (e2) {
            return 0;
        }
    }
}

function makeInstall(binDir, source) {
    const root = path.dirname(binDir);
    return {
        binDir,
        root,
        label: labelFor(root),
        source,
        build: readBuildMeta(binDir),
        launcherMtimeMs: launcherMtimeMs(binDir),
    };
}

function byRecency(a, b) {
    if (b.launcherMtimeMs !== a.launcherMtimeMs) return b.launcherMtimeMs - a.launcherMtimeMs;
    return a.label.localeCompare(b.label);
}

function pickDefaultInstall(installs) {
    const list = Array.isArray(installs) ? installs.slice() : [];
    if (list.length === 0) return null;
    const configured = list.find((i) => i.source === 'configured');
    if (configured) return configured;
    return list.sort(byRecency)[0];
}

function discoverInstalls() {
    const settings = readSettings();
    const configuredBinDir = settings.installBinDir || null;
    const preferredClient = settings.preferredClient || null;

    const byKey = new Map();
    const add = (binDir, source) => {
        if (!isInstallBinDir(binDir)) return;
        const key = normalizeKey(binDir);
        if (byKey.has(key)) return;
        byKey.set(key, makeInstall(path.resolve(binDir), source));
    };

    // 1. Configured / preferred install
    if (configuredBinDir) add(configuredBinDir, 'configured');
    if (preferredClient && preferredClient !== configuredBinDir) add(preferredClient, 'configured');

    // 2. Registry discovery via Uninstall keys
    const registryRootsFound = [];
    for (const hive of UNINSTALL_ROOTS) {
        let out = '';
        try {
            out = defaultRegistryQuery(hive) || '';
        } catch (e) {
            out = '';
        }
        for (const installRoot of parseInstallRootsFromRegistry(out)) {
            registryRootsFound.push(installRoot);
            add(path.join(installRoot, 'bin'), 'registry');
        }
    }

    // 3. Sweep one level under conventional parents + registry parents
    const parents = new Set(SWEEP_ROOTS);
    for (const installRoot of registryRootsFound) parents.add(path.dirname(installRoot));
    for (const install of byKey.values()) parents.add(path.dirname(install.root));
    for (const parent of parents) {
        for (const child of sweepChildren(parent)) {
            add(path.join(child, 'bin'), 'sweep');
        }
    }

    // 4. Legacy hardcoded paths
    for (const dir of LEGACY_BIN_DIRS) add(dir, 'legacy');

    return Array.from(byKey.values()).sort((a, b) => a.label.localeCompare(b.label));
}

// Replay Directory Resolution

function localAppDataReplayDir() {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, '.broengine', 'coldwar', 'replays');
}

function installReplayDir(installBinDir) {
    const installRoot = path.dirname(installBinDir);
    return path.join(installRoot, 'resources', '.broengine', 'coldwar', 'replays');
}

function resolveReplayDirs(options = {}) {
    const installBinDir = options.installBinDir || null;
    const dirs = [];

    // Primary: player-install replay folder in LOCALAPPDATA
    dirs.push({
        dir: localAppDataReplayDir(),
        origin: 'local-appdata'
    });

    // Secondary: build-install replay folder under <install>/resources/...
    if (installBinDir) {
        dirs.push({
            dir: installReplayDir(installBinDir),
            origin: 'install'
        });
    }

    return dirs.map((d) => ({
        ...d,
        exists: fsSync.existsSync(d.dir)
    }));
}

/**
 * Get the default archive directory - placed inside the first found replay folder
 * as a subfolder called "archived".
 */
function getDefaultArchiveDir() {
    const installs = discoverInstalls();
    const defaultInstall = pickDefaultInstall(installs);
    const binDir = defaultInstall ? defaultInstall.binDir : null;
    const gameDirs = resolveReplayDirs({
        installBinDir: binDir
    });
    const existingDir = gameDirs.find((d) => d.exists);
    if (existingDir) {
        return path.join(existingDir.dir, ARCHIVE_SUBDIR_NAME);
    }
    // Fallback: use the first game dir location even if it doesn't exist yet
    if (gameDirs.length > 0) {
        return path.join(gameDirs[0].dir, ARCHIVE_SUBDIR_NAME);
    }
    // Final fallback: user's Documents
    const docs = path.join(os.homedir(), 'Documents');
    return path.join(docs, 'HEAT Replay Manager', ARCHIVE_SUBDIR_NAME);
}

function getArchiveDir(settings) {
    if (settings && settings.archiveDir && settings.archiveDir.trim()) {
        return settings.archiveDir;
    }
    return getDefaultArchiveDir();
}

// Display Names Storage
// Stored in a JSON file next to the replays folder so it persists and
// doesn't rely on app memory / settings.

function getDisplayNamesPath() {
    const installs = discoverInstalls();
    const defaultInstall = pickDefaultInstall(installs);
    const binDir = defaultInstall ? defaultInstall.binDir : null;
    const gameDirs = resolveReplayDirs({
        installBinDir: binDir
    });
    const existingDir = gameDirs.find((d) => d.exists);
    const baseDir = existingDir ?
        existingDir.dir :
        (gameDirs[0] ? gameDirs[0].dir : path.join(os.homedir(), 'Documents', 'HEAT Replay Manager'));
    return path.join(baseDir, DISPLAY_NAMES_FILE);
}

function readDisplayNames() {
    const file = getDisplayNamesPath();
    if (!fsSync.existsSync(file)) return {};
    try {
        const data = JSON.parse(fsSync.readFileSync(file, 'utf8'));
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (e) {
        return {};
    }
}

function writeDisplayNames(map) {
    const file = getDisplayNamesPath();
    try {
        fsSync.mkdirSync(path.dirname(file), {
            recursive: true
        });
        fsSync.writeFileSync(file, JSON.stringify(map || {}, null, 2) + '\n');
        return true;
    } catch (e) {
        console.error('Failed to write display names:', e);
        return false;
    }
}

function sanitizeDisplayName(name) {
    if (typeof name !== 'string') return '';
    const trimmed = name.trim().replace(/\s+/g, ' ');
    return trimmed.slice(0, MAX_DISPLAY_NAME_LENGTH);
}

function setDisplayName(filename, displayName) {
    const map = readDisplayNames();
    const clean = sanitizeDisplayName(displayName);
    if (!clean) {
        delete map[filename];
    } else {
        map[filename] = clean;
    }
    const ok = writeDisplayNames(map);
    return {
        ok,
        displayName: clean || null,
        map
    };
}

function clearDisplayName(filename) {
    const map = readDisplayNames();
    delete map[filename];
    const ok = writeDisplayNames(map);
    return {
        ok,
        map
    };
}

// Replay Parsing

const MAP_INDEX = {
    '01': {
        name: 'Scarred City',
        token: 'beirut'
    },
    '02': {
        name: 'Blossom Crash',
        token: 'vietnam'
    },
    '03': {
        name: 'Sunstroke',
        token: 'sunstroke'
    },
    '04': {
        name: 'Nord Oko',
        token: 'nordoko'
    },
    '05': {
        name: 'Nexus Dam',
        token: 'friendshipdam'
    },
    '06': {
        name: 'Aircraft Carrier',
        token: 'aircraft_carrier'
    },
    '07': {
        name: 'Project Phoenix',
        token: 'projectphoenix'
    },
    '08': {
        name: 'Inferno One',
        token: 'inferno'
    },
    '09': {
        name: 'Moonshot',
        token: 'moonshot'
    },
    '10': {
        name: 'Eden',
        token: 'eden'
    },
    '11': {
        name: 'Railgun',
        token: 'railgun'
    },
    '252': {
        name: 'Utopia',
        token: 'utopia'
    },
};

const FILENAME_RE = /^(\d+)_(.+?)_(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_([0-9a-f]{6,8})(?:\s*(?:\(\d+\)|-\s*Copy(?:\s*\(\d+\))?))?\.replay$/i;

const BUILD_RE = /build:\s*'([^']*)',\s*branch:\s*'([^']*)',\s*commit:\s*'([0-9a-fA-F]{40})'/;
const TANK_RE = /\/vehicles\/([a-z0-9_]+)\/([a-z0-9_]+)\//g;
const NATION_PREFIX_RE = /^[a-z]\d{2}_/;
const PLAYER_RE = /\b[\w]{3,20}#[0-9]{3,6}\b/g;

const ENDGAME_NEEDLE = Buffer.from('m_endGameType');
const BRACE_WINDOW = 5000;
const EXPECTED_EVENT_TYPE = 'cw::BattleResultReplayEvent_ver1';

const RESULT_DISPLAY = {
    Win: 'Victory',
    Lose: 'Defeat',
    Loose: 'Defeat',
    Draw: 'Draw',
};
const RESULT_FALLBACK = 'Result: not recorded';
const TANKS_FALLBACK = 'tanks: none detected';

function parseReplayFilename(filename) {
    const result = {
        filename,
        parsed: false,
        mapIndex: null,
        mapName: null,
        mapRawRemainder: null,
        mode: null,
        dateTime: null,
        hash: null,
        verified: false,
    };

    const m = FILENAME_RE.exec(filename);
    if (!m) return result;

    const [, index, middle, yyyy, mo, dd, hh, mi, ss, hash] = m;
    result.dateTime = `${yyyy}-${mo}-${dd} ${hh}:${mi}:${ss}`;
    result.hash = hash;
    result.mapIndex = index;
    result.parsed = true;

    const entry = MAP_INDEX[index];
    if (entry && (middle === entry.token || middle.startsWith(entry.token + '_'))) {
        result.mapName = entry.name;
        result.mode = middle === entry.token ? '' : middle.slice(entry.token.length + 1);
        result.verified = true;
    } else {
        const single = middle.match(/^([a-z0-9]+)_(.+)$/i);
        result.mapRawRemainder = middle;
        result.mode = single ? single[2] : null;
        result.verified = false;
    }

    return result;
}

function statEntry(fullPath) {
    const st = fsSync.statSync(fullPath);
    return {
        sizeBytes: st.size,
        sizeMB: Number((st.size / 1e6).toFixed(1)),
        mtime: st.mtime,
    };
}

function mtimeAsDateTime(mtime) {
    return mtime.toISOString().slice(0, 19).replace('T', ' ');
}

function extractBuildCommit(buf) {
    const text = buf.toString('latin1');
    const m = BUILD_RE.exec(text);
    if (!m) return {
        config: null,
        branch: null,
        commit: null,
        display: 'commit: unknown'
    };
    return {
        config: m[1],
        branch: m[2],
        commit: m[3],
        display: 'commit: ' + m[3]
    };
}

function extractTanks(buf) {
    const text = buf.toString('latin1');
    const seenPaths = new Set();
    const displayNames = [];
    const seenDisplay = new Set();
    let m;
    TANK_RE.lastIndex = 0;
    while ((m = TANK_RE.exec(text)) !== null) {
        const nation = m[1];
        const prefabId = m[2];
        const pathKey = nation + '/' + prefabId;
        if (seenPaths.has(pathKey)) continue;
        seenPaths.add(pathKey);
        if (!NATION_PREFIX_RE.test(prefabId)) continue;
        const withoutPrefix = prefabId.replace(NATION_PREFIX_RE, '');
        const display = withoutPrefix.replace(/_/g, ' ').toUpperCase();
        if (!seenDisplay.has(display)) {
            seenDisplay.add(display);
            displayNames.push(display);
        }
    }
    return displayNames;
}

function decodeBattleResult(buf) {
    let idx = buf.indexOf(ENDGAME_NEEDLE);
    while (idx !== -1) {
        const searchStart = Math.max(0, idx - BRACE_WINDOW);
        let braceStart = -1;
        for (let i = idx; i >= searchStart; i--) {
            if (buf[i] === 0x7b) {
                braceStart = i;
                break;
            }
        }
        if (braceStart !== -1) {
            const searchEnd = Math.min(buf.length, braceStart + BRACE_WINDOW);
            for (let j = idx; j < searchEnd; j++) {
                if (buf[j] === 0x7d) {
                    const slice = buf.slice(braceStart, j + 1).toString('utf8');
                    try {
                        const obj = JSON.parse(slice);
                        if (
                            obj &&
                            obj.__type__ === EXPECTED_EVENT_TYPE &&
                            Object.prototype.hasOwnProperty.call(obj, 'm_endGameType')
                        ) {
                            return {
                                decoded: true,
                                rawValue: obj.m_endGameType
                            };
                        }
                    } catch (e) {
                        /* try next */
                    }
                }
            }
        }
        idx = buf.indexOf(ENDGAME_NEEDLE, idx + 1);
    }
    return {
        decoded: false,
        rawValue: null
    };
}

function extractPlayerHandles(buf) {
    const text = buf.toString('latin1');
    return [...new Set(text.match(PLAYER_RE) || [])];
}

function parseBinary(filePath) {
    try {
        const buf = fsSync.readFileSync(filePath);
        const tanks = extractTanks(buf);
        const {
            decoded,
            rawValue
        } = decodeBattleResult(buf);
        const battleResult = decoded ?
            (RESULT_DISPLAY[rawValue] || RESULT_FALLBACK) :
            RESULT_FALLBACK;
        return {
            buildCommit: extractBuildCommit(buf),
            tanks,
            tanksDisplay: tanks.length === 0 ? TANKS_FALLBACK : tanks.join(', '),
            battleResult,
            playerHandles: extractPlayerHandles(buf),
        };
    } catch (e) {
        return {
            buildCommit: {
                config: null,
                branch: null,
                commit: null,
                display: 'commit: unknown'
            },
            tanks: [],
            tanksDisplay: TANKS_FALLBACK,
            battleResult: RESULT_FALLBACK,
            playerHandles: [],
        };
    }
}

function buildEntry(filename, dir, origin, archived, displayNamesMap) {
    const fullPath = path.join(dir, filename);
    const stat = statEntry(fullPath);
    const nameFields = parseReplayFilename(filename);
    const binary = parseBinary(fullPath);

    const entry = {
        filename,
        dir,
        fullPath,
        origin,
        archived,
        displayName: (displayNamesMap && displayNamesMap[filename]) || null,
        sizeBytes: stat.sizeBytes,
        sizeMB: stat.sizeMB,
        mtime: stat.mtime,
        mapIndex: nameFields.mapIndex,
        mapName: nameFields.mapName,
        mapRawRemainder: nameFields.mapRawRemainder,
        mode: nameFields.mode,
        hash: nameFields.hash,
        verified: nameFields.verified,
        parsed: nameFields.parsed,
        buildCommit: binary.buildCommit,
        tanks: binary.tanks,
        tanksDisplay: binary.tanksDisplay,
        battleResult: binary.battleResult,
        playerHandles: binary.playerHandles,
    };

    // Add map image from cache
    if (nameFields.mapName) {
        const mapInfo = findMapByName(nameFields.mapName);
        if (mapInfo && mapInfo.image) {
            entry.mapImage = mapInfo.image;
        }
    }

    if (nameFields.dateTime) {
        entry.dateTime = nameFields.dateTime;
        entry.dateTimeSource = 'filename';
    } else {
        entry.dateTime = mtimeAsDateTime(stat.mtime);
        entry.dateTimeSource = 'mtime-fallback';
    }

    return entry;
}

// Replay Listing
function listArchiveDir(archiveDir) {
    if (!fsSync.existsSync(archiveDir)) return {
        exists: false,
        entries: []
    };
    try {
        const entries = fsSync
            .readdirSync(archiveDir)
            .filter((f) => f.toLowerCase().endsWith('.replay'))
            .map((f) => {
                const full = path.join(archiveDir, f);
                const st = fsSync.statSync(full);
                return {
                    name: f,
                    fullPath: full,
                    sizeBytes: st.size,
                    mtime: st.mtime
                };
            });
        return {
            exists: true,
            entries
        };
    } catch (e) {
        return {
            exists: false,
            entries: []
        };
    }
}

function listReplays(options = {}) {
    const settings = readSettings();
    const installs = discoverInstalls();
    const defaultInstall = pickDefaultInstall(installs);
    const installBinDir = options.installBinDir || (defaultInstall ? defaultInstall.binDir : null);

    const gameDirs = resolveReplayDirs({
        installBinDir
    });
    const archiveDir = options.archiveDir || getArchiveDir(settings);

    const displayNamesMap = readDisplayNames();

    const existingGameDirs = gameDirs.filter((d) => d.exists);
    const seenFilenames = new Set();
    const entries = [];

    for (const gd of existingGameDirs) {
        let files = [];
        try {
            files = fsSync
                .readdirSync(gd.dir)
                .filter((f) => f.toLowerCase().endsWith('.replay'))
                .sort();
        } catch (e) {
            continue;
        }
        for (const f of files) {
            if (seenFilenames.has(f)) continue;
            seenFilenames.add(f);
            try {
                entries.push(buildEntry(f, gd.dir, gd.origin, false, displayNamesMap));
            } catch (e) {
                console.error('Failed to build entry for', f, e);
            }
        }
    }

    let status;
    if (existingGameDirs.length === 0) {
        status = 'folder-missing';
    } else if (entries.length === 0) {
        status = 'empty';
    } else {
        status = 'ok';
    }

    const archiveListing = listArchiveDir(archiveDir);
    if (archiveListing.exists) {
        const archiveFiles = archiveListing.entries.map((e) => e.name).sort();
        for (const f of archiveFiles) {
            try {
                entries.push(buildEntry(f, archiveDir, 'archive', true, displayNamesMap));
            } catch (e) {
                console.error('Failed to build archive entry for', f, e);
            }
        }
    }

    return {
        status,
        gameDirs,
        archiveDir,
        archiveExists: archiveListing.exists,
        entries,
        installs,
        activeBinDir: installBinDir,
        displayNames: displayNamesMap,
    };
}

// Per-Replay Install Match
function matchInstallsForReplay(replay, installs) {
    const commit = replay && replay.buildCommit && replay.buildCommit.commit;
    const list = Array.isArray(installs) ? installs : [];
    const withHash = list.filter((i) => i.build && i.build.hash);
    if (!commit || withHash.length === 0) {
        return {
            status: 'unknown',
            matches: [],
            commit: commit || null
        };
    }
    const matches = withHash.filter((i) => i.build.hash === commit);
    return {
        status: matches.length > 0 ? 'exact' : 'none',
        matches,
        commit,
    };
}

// Archive (copy-verify-delete)
function sha256File(filePath) {
    const buf = fsSync.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function nextAvailableName(dir, filename) {
    const ext = path.extname(filename);
    const base = filename.slice(0, filename.length - ext.length);
    let n = 2;
    let candidate;
    do {
        candidate = `${base}_${n}${ext}`;
        n++;
    } while (fsSync.existsSync(path.join(dir, candidate)));
    return candidate;
}

function sameContent(pathA, pathB) {
    const sizeA = fsSync.statSync(pathA).size;
    const sizeB = fsSync.statSync(pathB).size;
    if (sizeA !== sizeB) return false;
    return sha256File(pathA) === sha256File(pathB);
}

function archiveReplay(sourcePath, archiveDir) {
    if (!fsSync.existsSync(sourcePath)) {
        return {
            status: 'source-gone',
            message: 'Source file no longer exists.'
        };
    }

    try {
        fsSync.mkdirSync(archiveDir, {
            recursive: true
        });
        const filename = path.basename(sourcePath);
        let destPath = path.join(archiveDir, filename);

        if (fsSync.existsSync(destPath)) {
            if (sameContent(sourcePath, destPath)) {
                fsSync.unlinkSync(sourcePath);
                return {
                    status: 'already-archived',
                    message: 'This replay was already archived.'
                };
            }
            const altName = nextAvailableName(archiveDir, filename);
            destPath = path.join(archiveDir, altName);
        }

        fsSync.copyFileSync(sourcePath, destPath);

        const sourceSize = fsSync.statSync(sourcePath).size;
        const destSize = fsSync.statSync(destPath).size;
        const sizeOK = sourceSize === destSize;
        const hashOK = sizeOK && sha256File(sourcePath) === sha256File(destPath);

        if (!sizeOK || !hashOK) {
            if (fsSync.existsSync(destPath)) {
                try {
                    fsSync.unlinkSync(destPath);
                } catch (e) {}
            }
            return {
                status: 'verify-failed',
                message: 'Verification failed after copy.'
            };
        }

        fsSync.unlinkSync(sourcePath);
        return {
            status: 'archived',
            message: 'Replay archived successfully.',
            destPath
        };
    } catch (e) {
        let message = 'Failed to archive replay.';
        if (e.code === 'ENOSPC') message = 'Not enough disk space to archive this replay.';
        else if (e.code === 'EPERM' || e.code === 'EACCES') message = 'Permission denied. Please check your archive folder permissions.';
        return {
            status: 'error',
            message,
            code: e.code || null
        };
    }
}

function unarchiveReplay(sourcePath, gameDir) {
    if (!fsSync.existsSync(sourcePath)) {
        return {
            status: 'source-gone',
            message: 'Source file no longer exists in the archive.'
        };
    }

    try {
        fsSync.mkdirSync(gameDir, {
            recursive: true
        });
        const filename = path.basename(sourcePath);
        let destPath = path.join(gameDir, filename);

        if (fsSync.existsSync(destPath)) {
            if (sameContent(sourcePath, destPath)) {
                fsSync.unlinkSync(sourcePath);
                return {
                    status: 'already-unarchived',
                    message: 'This replay was already in the game folder.'
                };
            }
            const altName = nextAvailableName(gameDir, filename);
            destPath = path.join(gameDir, altName);
        }

        fsSync.copyFileSync(sourcePath, destPath);

        const sourceSize = fsSync.statSync(sourcePath).size;
        const destSize = fsSync.statSync(destPath).size;
        const sizeOK = sourceSize === destSize;
        const hashOK = sizeOK && sha256File(sourcePath) === sha256File(destPath);

        if (!sizeOK || !hashOK) {
            if (fsSync.existsSync(destPath)) {
                try {
                    fsSync.unlinkSync(destPath);
                } catch (e) {}
            }
            return {
                status: 'verify-failed',
                message: 'Verification failed after copy.'
            };
        }

        fsSync.unlinkSync(sourcePath);
        return {
            status: 'unarchived',
            message: 'Replay restored to game folder.',
            destPath
        };
    } catch (e) {
        let message = 'Failed to unarchive replay.';
        if (e.code === 'ENOSPC') message = 'Not enough disk space to restore this replay.';
        else if (e.code === 'EPERM' || e.code === 'EACCES') message = 'Permission denied. Please check your game folder permissions.';
        return {
            status: 'error',
            message,
            code: e.code || null
        };
    }
}

// Launch Args
function buildLaunchArgs(replayRef) {
    const target = replayRef.archived ? replayRef.fullPath : replayRef.filename;
    return [
        '--project',
        '../coldwar.project',
        '--mode',
        'client',
        '--world',
        '/plugins/replay/worlds/replay_loading.world',
        '--replay-playback',
        target,
    ];
}

// Window Creation
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1300,
        height: 860,
        minWidth: 1300,
        minHeight: 860,
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
    });
}

// Window Controls
ipcMain.handle('window-minimize', () => {
    if (mainWindow) mainWindow.minimize();
});
ipcMain.handle('window-maximize', () => {
    if (mainWindow) {
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
    }
});
ipcMain.handle('window-close', () => {
    if (mainWindow) mainWindow.close();
});
ipcMain.handle('window-is-maximized', () => mainWindow ? mainWindow.isMaximized() : false);

// Settings IPC
ipcMain.handle('get-settings', async () => {
    return readSettings();
});

ipcMain.handle('set-settings', async (event, partial) => {
    try {
        const current = readSettings();
        const updated = {
            ...current,
            ...partial
        };

        if (partial.installBinDir !== undefined && partial.installBinDir !== '' && partial.installBinDir !== null) {
            if (!isInstallBinDir(partial.installBinDir)) {
                return {
                    status: 'invalid-install-dir',
                    message: 'The selected folder does not contain the game launcher.'
                };
            }
        }

        if (partial.archiveDir !== undefined && partial.archiveDir !== '' && partial.archiveDir !== null) {
            try {
                fsSync.mkdirSync(partial.archiveDir, {
                    recursive: true
                });
            } catch (e) {
                return {
                    status: 'invalid-archive-dir',
                    message: 'The archive folder could not be created or accessed.'
                };
            }
        }

        writeSettings(updated);
        return {
            status: 'ok'
        };
    } catch (error) {
        console.error('Error saving settings:', error);
        return {
            status: 'error',
            message: 'Failed to save settings.'
        };
    }
});

// Maps Data IPC
ipcMain.handle('get-maps-data', async () => {
    try {
        const data = await loadMapsData();
        return {
            status: 'ok',
            maps: data.maps || []
        };
    } catch (error) {
        console.error('Error getting maps data:', error);
        return {
            status: 'error',
            maps: [],
            message: 'Failed to load map data.'
        };
    }
});

// Display Names IPC
ipcMain.handle('get-display-names', async () => {
    return readDisplayNames();
});

ipcMain.handle('set-display-name', async (event, filename, displayName) => {
    try {
        if (!filename) return {
            status: 'error',
            message: 'Missing filename.'
        };
        const result = setDisplayName(filename, displayName);
        if (!result.ok) return {
            status: 'error',
            message: 'Failed to save display name.'
        };
        return {
            status: 'ok',
            displayName: result.displayName
        };
    } catch (error) {
        console.error('Error setting display name:', error);
        return {
            status: 'error',
            message: 'Failed to save display name.'
        };
    }
});

ipcMain.handle('clear-display-name', async (event, filename) => {
    try {
        if (!filename) return {
            status: 'error',
            message: 'Missing filename.'
        };
        const result = clearDisplayName(filename);
        if (!result.ok) return {
            status: 'error',
            message: 'Failed to clear display name.'
        };
        return {
            status: 'ok'
        };
    } catch (error) {
        console.error('Error clearing display name:', error);
        return {
            status: 'error',
            message: 'Failed to clear display name.'
        };
    }
});

// List Replays IPC
ipcMain.handle('list-replays', async () => {
    try {
        // Ensure maps data is loaded before listing
        await loadMapsData();
        return listReplays();
    } catch (error) {
        console.error('Error listing replays:', error);
        return {
            status: 'error',
            entries: [],
            message: 'Failed to list replays.'
        };
    }
});

// List Installs IPC
ipcMain.handle('list-installs', async () => {
    try {
        const settings = readSettings();
        const installs = discoverInstalls();
        const preferred = settings.preferredClient || null;
        const defaultInstall = pickDefaultInstall(installs);

        return {
            installs,
            activeBinDir: preferred || (defaultInstall ? defaultInstall.binDir : null),
            configuredBinDir: preferred,
        };
    } catch (error) {
        console.error('Error listing installs:', error);
        return {
            installs: [],
            activeBinDir: null,
            configuredBinDir: null
        };
    }
});

// Auto-Detect Install IPC
ipcMain.handle('auto-detect-install', async () => {
    try {
        const installs = discoverInstalls();
        const defaultInstall = pickDefaultInstall(installs);

        const settings = readSettings();
        if (!settings.installBinDir && defaultInstall) {
            writeSettings({
                installBinDir: defaultInstall.binDir
            });
        }

        return {
            status: 'ok',
            installs,
            defaultBinDir: defaultInstall ? defaultInstall.binDir : null,
            found: installs.length > 0,
        };
    } catch (error) {
        console.error('Error auto-detecting install:', error);
        return {
            status: 'error',
            installs: [],
            found: false
        };
    }
});

// Launch Replay IPC
ipcMain.handle('launch-replay', async (event, replayRef) => {
    try {
        const settings = readSettings();
        const installs = discoverInstalls();
        const defaultInstall = pickDefaultInstall(installs);

        let chosenBinDir = settings.preferredClient || (defaultInstall ? defaultInstall.binDir : null);

        if (!chosenBinDir) {
            return {
                status: 'launcher-missing',
                message: 'No game installation found. Please configure the install directory in Options.'
            };
        }

        const launcherPath = path.join(chosenBinDir, LAUNCHER_NAME);
        const launcherAlt = path.join(chosenBinDir, LAUNCHER_NAME_ALT);
        const exePath = fsSync.existsSync(launcherPath) ?
            launcherPath :
            (fsSync.existsSync(launcherAlt) ? launcherAlt : null);

        if (!exePath) {
            return {
                status: 'launcher-missing',
                message: 'Game launcher not found in the selected install folder.'
            };
        }

        const statPath = replayRef.archived ?
            replayRef.fullPath :
            path.join(replayRef.dir, replayRef.filename);

        if (!fsSync.existsSync(statPath)) {
            return {
                status: 'file-gone',
                message: 'The replay file no longer exists. It may have been deleted by the game\'s replay rotation.'
            };
        }

        const args = buildLaunchArgs(replayRef);

        const child = spawn(exePath, args, {
            cwd: chosenBinDir,
            stdio: 'ignore',
            detached: true,
        });
        if (typeof child.unref === 'function') child.unref();

        const usedInstall = installs.find((i) => normalizeKey(i.binDir) === normalizeKey(chosenBinDir));
        const usedLabel = usedInstall ? usedInstall.label : path.basename(chosenBinDir);

        return {
            status: 'ok',
            message: `Replay launched in ${usedLabel}.`,
            install: {
                usedLabel,
                matchStatus: 'exact',
            }
        };
    } catch (error) {
        console.error('Error launching replay:', error);
        if (error.code === 'ENOENT') {
            return {
                status: 'file-gone',
                message: 'The replay or launcher file no longer exists.'
            };
        }
        return {
            status: 'error',
            message: 'Failed to launch replay: ' + error.message
        };
    }
});

// Archive Replay IPC
ipcMain.handle('archive-replay', async (event, replayRef) => {
    try {
        const settings = readSettings();
        const archiveDir = getArchiveDir(settings);

        const sourcePath = replayRef.archived ?
            replayRef.fullPath :
            path.join(replayRef.dir, replayRef.filename);

        return archiveReplay(sourcePath, archiveDir);
    } catch (error) {
        console.error('Error archiving replay:', error);
        return {
            status: 'error',
            message: 'Failed to archive replay.'
        };
    }
});

// Unarchive Replay IPC
ipcMain.handle('unarchive-replay', async (event, replayRef) => {
    try {
        const settings = readSettings();
        const installs = discoverInstalls();
        const defaultInstall = pickDefaultInstall(installs);
        const binDir = settings.preferredClient || (defaultInstall ? defaultInstall.binDir : null);
        const gameDirs = resolveReplayDirs({
            installBinDir: binDir
        });
        const existingGameDir = gameDirs.find((d) => d.exists);

        if (!existingGameDir) {
            return {
                status: 'error',
                message: 'No game replay folder found. Please configure your install directory first.'
            };
        }

        const sourcePath = replayRef.fullPath;
        return unarchiveReplay(sourcePath, existingGameDir.dir);
    } catch (error) {
        console.error('Error unarchiving replay:', error);
        return {
            status: 'error',
            message: 'Failed to unarchive replay.'
        };
    }
});

// Delete Replay IPC
ipcMain.handle('delete-replay', async (event, replayRef) => {
    try {
        const filePath = replayRef.archived ?
            replayRef.fullPath :
            path.join(replayRef.dir, replayRef.filename);

        if (!fsSync.existsSync(filePath)) {
            return {
                status: 'file-gone',
                message: 'The replay file no longer exists.'
            };
        }

        fsSync.unlinkSync(filePath);

        // Clean up any display name associated with this file
        try {
            const map = readDisplayNames();
            if (map && Object.prototype.hasOwnProperty.call(map, replayRef.filename)) {
                delete map[replayRef.filename];
                writeDisplayNames(map);
            }
        } catch (e) {
            // Non-fatal
        }

        return {
            status: 'ok',
            message: 'Replay deleted successfully.'
        };
    } catch (error) {
        console.error('Error deleting replay:', error);
        return {
            status: 'error',
            message: 'Failed to delete replay: ' + error.message
        };
    }
});

// Rename Replay IPC (updates display name only)
ipcMain.handle('rename-replay', async (event, replayRef, newName) => {
    try {
        if (!replayRef || !replayRef.filename) {
            return {
                status: 'error',
                message: 'Missing replay reference.'
            };
        }
        const result = setDisplayName(replayRef.filename, newName);
        if (!result.ok) {
            return {
                status: 'error',
                message: 'Failed to save display name.'
            };
        }
        const msg = result.displayName ?
            `Renamed to "${result.displayName}".` :
            `Display name cleared.`;
        return {
            status: 'ok',
            message: msg,
            displayName: result.displayName
        };
    } catch (error) {
        console.error('Error renaming replay:', error);
        return {
            status: 'error',
            message: 'Failed to rename replay: ' + error.message
        };
    }
});

// Revert Replay Name IPC
ipcMain.handle('revert-replay-name', async (event, replayRef) => {
    try {
        if (!replayRef || !replayRef.filename) {
            return {
                status: 'error',
                message: 'Missing replay reference.'
            };
        }
        const result = clearDisplayName(replayRef.filename);
        if (!result.ok) {
            return {
                status: 'error',
                message: 'Failed to clear display name.'
            };
        }
        return {
            status: 'ok',
            message: 'Display name reverted.'
        };
    } catch (error) {
        console.error('Error reverting replay name:', error);
        return {
            status: 'error',
            message: 'Failed to revert display name.'
        };
    }
});

// Open Folder IPC
ipcMain.handle('open-folder', async (event, folderType) => {
    try {
        const settings = readSettings();
        let folderPath;

        if (folderType === 'game') {
            const installs = discoverInstalls();
            const defaultInstall = pickDefaultInstall(installs);
            const binDir = settings.preferredClient || (defaultInstall ? defaultInstall.binDir : null);
            const dirs = resolveReplayDirs({
                installBinDir: binDir
            });
            const existing = dirs.find((d) => d.exists);
            folderPath = existing ? existing.dir : dirs[0]?.dir;
        } else if (folderType === 'archive') {
            folderPath = getArchiveDir(settings);
            fsSync.mkdirSync(folderPath, {
                recursive: true
            });
        }

        if (folderPath && fsSync.existsSync(folderPath)) {
            await shell.openPath(folderPath);
            return {
                status: 'ok'
            };
        }

        return {
            status: 'error',
            message: 'Folder does not exist.'
        };
    } catch (error) {
        console.error('Error opening folder:', error);
        return {
            status: 'error',
            message: 'Failed to open folder.'
        };
    }
});

// Browse Folder IPC
ipcMain.handle('browse-folder', async (event, title) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: title || 'Select Folder'
    });

    if (result.canceled || result.filePaths.length === 0) {
        return {
            status: 'cancelled'
        };
    }

    return {
        status: 'ok',
        path: result.filePaths[0]
    };
});

// App Lifecycle
app.whenReady().then(() => {
    createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});