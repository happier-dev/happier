import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileHasContent } from '../fs/file_has_content.mjs';

const SERVER_ID_SAFE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const require = createRequire(import.meta.url);

let protocolComparableKeyFactory;
function getProtocolComparableKeyFactory() {
  if (protocolComparableKeyFactory !== undefined) return protocolComparableKeyFactory;
  try {
    const protocol = require('@happier-dev/protocol');
    protocolComparableKeyFactory =
      typeof protocol?.createServerUrlComparableKey === 'function' ? protocol.createServerUrlComparableKey : null;
  } catch {
    protocolComparableKeyFactory = null;
  }
  return protocolComparableKeyFactory;
}

function normalizeServerUrl(url) {
  return String(url ?? '').trim().replace(/\/+$/, '');
}

function safeCreateComparableServerUrlKey(url) {
  const normalized = normalizeServerUrl(url);
  if (!normalized) return '';
  const protocolFactory = getProtocolComparableKeyFactory();
  if (protocolFactory) {
    try {
      return protocolFactory(normalized);
    } catch {
      // fall through to local normalization
    }
  }
  try {
    const parsed = new URL(normalized);
    const protocol = parsed.protocol.toLowerCase();
    const host = parsed.hostname.toLowerCase();
    const port = parsed.port ? `:${parsed.port}` : '';
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${protocol}//${host}${port}${pathname}`;
  } catch {
    return '';
  }
}

function normalizeLoopbackHost(rawHost) {
  const host = String(rawHost ?? '').trim().toLowerCase();
  if (host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === '0.0.0.0') return 'localhost';
  return host;
}

function sanitizeServerIdForFilesystem(raw, fallback = 'default') {
  const value = String(raw ?? '').trim();
  if (!value) return String(fallback ?? '').trim() || 'default';
  if (value === '.' || value === '..') return String(fallback ?? '').trim() || 'default';
  if (value.includes('/') || value.includes('\\')) return String(fallback ?? '').trim() || 'default';
  if (!SERVER_ID_SAFE_RE.test(value)) return String(fallback ?? '').trim() || 'default';
  return value;
}

function readStackCliSettingsSnapshot({ cliHomeDir }) {
  const home = String(cliHomeDir ?? '').trim();
  if (!home) return null;
  const settingsPath = join(home, 'settings.json');
  if (!existsSync(settingsPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const servers = parsed.servers && typeof parsed.servers === 'object' ? parsed.servers : null;
    return {
      activeServerId: typeof parsed.activeServerId === 'string' ? parsed.activeServerId.trim() : '',
      servers,
    };
  } catch {
    return null;
  }
}

function profileMatchesServerUrl(profile, serverUrl) {
  const target = normalizeServerUrl(serverUrl);
  if (!target || !profile || typeof profile !== 'object') return false;
  const targetComparable = safeCreateComparableServerUrlKey(target);

  const values = [
    profile.serverUrl,
    profile.publicServerUrl,
    profile.localServerUrl,
  ]
    .map((value) => normalizeServerUrl(value))
    .filter(Boolean);

  return values.some((value) => {
    if (value === target) return true;
    const comparable = safeCreateComparableServerUrlKey(value);
    if (!comparable || !targetComparable) return false;
    return comparable === targetComparable;
  });
}

export function resolvePreferredStackServerIdFromCliSettings({ cliHomeDir, serverUrl = '', env = process.env } = {}) {
  const settings = readStackCliSettingsSnapshot({ cliHomeDir });
  if (!settings) return '';

  const entries = Object.entries(settings.servers ?? {});
  if (!entries.length) return '';

  const explicitServerId = resolveActiveServerIdOverride(env);
  const explicitProfile = explicitServerId ? settings.servers?.[explicitServerId] : null;
  if (explicitServerId && profileMatchesServerUrl(explicitProfile, serverUrl)) {
    return explicitServerId;
  }

  const activeServerId = sanitizeServerIdForFilesystem(settings.activeServerId, '');
  const activeProfile = activeServerId ? settings.servers?.[activeServerId] : null;
  if (activeServerId && profileMatchesServerUrl(activeProfile, serverUrl)) {
    return activeServerId;
  }

  const matches = entries
    .filter(([, profile]) => profileMatchesServerUrl(profile, serverUrl))
    .map(([id]) => sanitizeServerIdForFilesystem(id, ''))
    .filter(Boolean);

  if (!matches.length) return '';
  if (matches.length === 1) return matches[0];

  if (activeServerId && matches.includes(activeServerId)) {
    return activeServerId;
  }

  const preferred = [...matches].sort((a, b) => {
    const aStable = a.includes('__id_') ? 1 : 0;
    const bStable = b.includes('__id_') ? 1 : 0;
    if (aStable !== bStable) return aStable - bStable;
    return a.localeCompare(b);
  });
  return preferred[0] || '';
}

function resolveActiveServerIdOverride(env = process.env) {
  const raw = String(env?.HAPPIER_ACTIVE_SERVER_ID ?? '').trim();
  if (!raw) return '';
  return sanitizeServerIdForFilesystem(raw, '');
}

function hasExplicitServerContext({ serverUrl = '', env = process.env }) {
  return normalizeServerUrl(serverUrl) !== '' || resolveActiveServerIdOverride(env) !== '';
}

function deriveServerIdFromUrl(url) {
  const normalized = safeCreateComparableServerUrlKey(url) || normalizeServerUrl(url);
  let h = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `env_${(h >>> 0).toString(16)}`;
}

function deriveLoopbackHostPortServerId(url) {
  const normalized = normalizeServerUrl(url);
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    const host = normalizeLoopbackHost(parsed.hostname);
    if (host !== 'localhost') return '';
    const port = String(parsed.port ?? '').trim();
    if (!port) return '';
    return sanitizeServerIdForFilesystem(`${host}-${port}`, '');
  } catch {
    return '';
  }
}

function requireCliHomeDir(cliHomeDir) {
  const home = String(cliHomeDir ?? '').trim();
  if (!home) {
    throw new Error('cliHomeDir is required');
  }
  return home;
}

export function resolveStackCredentialPaths({ cliHomeDir, serverUrl = '', env = process.env }) {
  const home = requireCliHomeDir(cliHomeDir);
  const legacyPath = join(home, 'access.key');
  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  const urlHashServerId = sanitizeServerIdForFilesystem(
    normalizedServerUrl ? deriveServerIdFromUrl(normalizedServerUrl) : 'default',
    'default'
  );
  const hostPortServerId = deriveLoopbackHostPortServerId(normalizedServerUrl);
  const stableScopeServerId = resolveActiveServerIdOverride(env);
  const settingsServerId = resolvePreferredStackServerIdFromCliSettings({ cliHomeDir: home, serverUrl: normalizedServerUrl, env });
  const activeServerId = settingsServerId || stableScopeServerId || urlHashServerId;
  const serverScopedPath = join(home, 'servers', activeServerId, 'access.key');
  const aliasServerIds = [
    stableScopeServerId && stableScopeServerId !== activeServerId ? stableScopeServerId : null,
    urlHashServerId && urlHashServerId !== activeServerId ? urlHashServerId : null,
    hostPortServerId && hostPortServerId !== activeServerId && hostPortServerId !== urlHashServerId ? hostPortServerId : null,
  ]
    .filter(Boolean);
  const uniqueAliasServerIds = [...new Set(aliasServerIds)];
  const aliasServerScopedPaths = uniqueAliasServerIds.map((id) => join(home, 'servers', id, 'access.key'));
  const urlHashServerScopedPath = aliasServerScopedPaths.find((path) => path.includes(`/servers/${urlHashServerId}/`)) || '';
  const hostPortServerScopedPath =
    aliasServerScopedPaths.find((path) => path.includes(`/servers/${hostPortServerId}/`)) || '';
  const paths = [serverScopedPath, ...aliasServerScopedPaths, legacyPath].filter(Boolean);
  return {
    activeServerId,
    settingsServerId,
    stableScopeServerId,
    urlHashServerId,
    hostPortServerId,
    legacyPath,
    serverScopedPath,
    urlHashServerScopedPath,
    hostPortServerScopedPath,
    aliasServerScopedPaths,
    paths,
  };
}

export function resolveStackDaemonStatePaths({ cliHomeDir, serverUrl = '', env = process.env }) {
  const home = requireCliHomeDir(cliHomeDir);
  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  const urlHashServerId = sanitizeServerIdForFilesystem(
    normalizedServerUrl ? deriveServerIdFromUrl(normalizedServerUrl) : 'default',
    'default'
  );
  const hostPortServerId = deriveLoopbackHostPortServerId(normalizedServerUrl);
  const stableScopeServerId = resolveActiveServerIdOverride(env);
  const settingsServerId = resolvePreferredStackServerIdFromCliSettings({ cliHomeDir: home, serverUrl: normalizedServerUrl, env });
  const activeServerId = settingsServerId || stableScopeServerId || urlHashServerId;

  const legacyStatePath = join(home, 'daemon.state.json');
  const legacyLockPath = join(home, 'daemon.state.json.lock');
  const serverScopedStatePath = join(home, 'servers', activeServerId, 'daemon.state.json');
  const serverScopedLockPath = join(home, 'servers', activeServerId, 'daemon.state.json.lock');
  const aliasServerIds = [
    stableScopeServerId && stableScopeServerId !== activeServerId ? stableScopeServerId : null,
    urlHashServerId && urlHashServerId !== activeServerId ? urlHashServerId : null,
    hostPortServerId && hostPortServerId !== activeServerId && hostPortServerId !== urlHashServerId ? hostPortServerId : null,
  ]
    .filter(Boolean);
  const uniqueAliasServerIds = [...new Set(aliasServerIds)];
  const aliasStatePaths = uniqueAliasServerIds.map((id) => ({
    statePath: join(home, 'servers', id, 'daemon.state.json'),
    lockPath: join(home, 'servers', id, 'daemon.state.json.lock'),
  }));
  const urlHashServerScopedStatePath = aliasStatePaths.find((pair) => pair.statePath.includes(`/servers/${urlHashServerId}/`))?.statePath || '';
  const urlHashServerScopedLockPath = aliasStatePaths.find((pair) => pair.lockPath.includes(`/servers/${urlHashServerId}/`))?.lockPath || '';
  const hostPortServerScopedStatePath = aliasStatePaths.find((pair) => pair.statePath.includes(`/servers/${hostPortServerId}/`))?.statePath || '';
  const hostPortServerScopedLockPath = aliasStatePaths.find((pair) => pair.lockPath.includes(`/servers/${hostPortServerId}/`))?.lockPath || '';

  return {
    activeServerId,
    settingsServerId,
    stableScopeServerId,
    urlHashServerId,
    hostPortServerId,
    legacyStatePath,
    legacyLockPath,
    serverScopedStatePath,
    serverScopedLockPath,
    urlHashServerScopedStatePath,
    urlHashServerScopedLockPath,
    hostPortServerScopedStatePath,
    hostPortServerScopedLockPath,
    aliasStatePaths,
    pairs: [
      { statePath: serverScopedStatePath, lockPath: serverScopedLockPath },
      ...aliasStatePaths,
      { statePath: legacyStatePath, lockPath: legacyLockPath },
    ],
  };
}

export function resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl = '', env = process.env }) {
  const home = requireCliHomeDir(cliHomeDir);
  const resolved = resolveStackDaemonStatePaths({ cliHomeDir, serverUrl, env });
  const allowAnyServerScopedFallback = !hasExplicitServerContext({ serverUrl, env });
  const serverScopedExists =
    fileHasContent(resolved.serverScopedStatePath) || existsSync(resolved.serverScopedLockPath);
  if (serverScopedExists) {
    return { statePath: resolved.serverScopedStatePath, lockPath: resolved.serverScopedLockPath };
  }

  if (resolved.hostPortServerScopedStatePath) {
    const hostPortExists =
      fileHasContent(resolved.hostPortServerScopedStatePath) || existsSync(resolved.hostPortServerScopedLockPath);
    if (hostPortExists) {
      return { statePath: resolved.hostPortServerScopedStatePath, lockPath: resolved.hostPortServerScopedLockPath };
    }
  }

  if (resolved.urlHashServerScopedStatePath) {
    const urlHashExists =
      fileHasContent(resolved.urlHashServerScopedStatePath) || existsSync(resolved.urlHashServerScopedLockPath);
    if (urlHashExists) {
      return { statePath: resolved.urlHashServerScopedStatePath, lockPath: resolved.urlHashServerScopedLockPath };
    }
  }

  if (allowAnyServerScopedFallback) {
    const anyServerScoped = findAnyDaemonStatePairInCliHome({ cliHomeDir: home });
    if (anyServerScoped) {
      return anyServerScoped;
    }
  }

  const legacyExists = fileHasContent(resolved.legacyStatePath) || existsSync(resolved.legacyLockPath);
  if (legacyExists) {
    return { statePath: resolved.legacyStatePath, lockPath: resolved.legacyLockPath };
  }

  return { statePath: resolved.serverScopedStatePath, lockPath: resolved.serverScopedLockPath };
}

export function findAnyDaemonStatePairInCliHome({ cliHomeDir }) {
  const home = requireCliHomeDir(cliHomeDir);

  const serversDir = join(home, 'servers');
  try {
    const entries = readdirSync(serversDir, { withFileTypes: true })
      .filter((ent) => ent.isDirectory())
      .map((ent) => ent.name)
      .sort();
    let best = null;
    let bestMtimeMs = -1;
    for (const id of entries) {
      const statePath = join(serversDir, id, 'daemon.state.json');
      const lockPath = join(serversDir, id, 'daemon.state.json.lock');
      const stateExists = fileHasContent(statePath);
      const lockExists = existsSync(lockPath);
      if (!stateExists && !lockExists) continue;

      let mtimeMs = 0;
      try {
        if (stateExists) {
          mtimeMs = Math.max(mtimeMs, Number(statSync(statePath).mtimeMs) || 0);
        }
      } catch {
        // ignore
      }
      try {
        if (lockExists) {
          mtimeMs = Math.max(mtimeMs, Number(statSync(lockPath).mtimeMs) || 0);
        }
      } catch {
        // ignore
      }
      if (mtimeMs >= bestMtimeMs) {
        bestMtimeMs = mtimeMs;
        best = { statePath, lockPath };
      }
    }
    if (best) return best;
  } catch {
    // ignore
  }

  const legacyStatePath = join(home, 'daemon.state.json');
  const legacyLockPath = join(home, 'daemon.state.json.lock');
  const legacyExists = fileHasContent(legacyStatePath) || existsSync(legacyLockPath);
  return legacyExists ? { statePath: legacyStatePath, lockPath: legacyLockPath } : null;
}

export function findExistingStackCredentialPath({ cliHomeDir, serverUrl = '', env = process.env }) {
  const resolved = resolveStackCredentialPaths({ cliHomeDir, serverUrl, env });
  if (fileHasContent(resolved.serverScopedPath)) return resolved.serverScopedPath;
  if (resolved.hostPortServerScopedPath && fileHasContent(resolved.hostPortServerScopedPath)) {
    return resolved.hostPortServerScopedPath;
  }
  if (resolved.urlHashServerScopedPath && fileHasContent(resolved.urlHashServerScopedPath)) {
    return resolved.urlHashServerScopedPath;
  }
  if (fileHasContent(resolved.legacyPath)) return resolved.legacyPath;
  return null;
}

export function findAnyCredentialPathInCliHome({ cliHomeDir }) {
  const home = String(cliHomeDir ?? '').trim();
  if (!home) return null;

  const serversDir = join(home, 'servers');
  try {
    const entries = readdirSync(serversDir, { withFileTypes: true })
      .filter((ent) => ent.isDirectory())
      .map((ent) => ent.name)
      .sort();
    let best = null;
    let bestMtimeMs = -1;
    for (const id of entries) {
      const candidate = join(serversDir, id, 'access.key');
      if (!fileHasContent(candidate)) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = Number(statSync(candidate).mtimeMs) || 0;
      } catch {
        mtimeMs = 0;
      }
      if (!best || mtimeMs >= bestMtimeMs) {
        best = candidate;
        bestMtimeMs = mtimeMs;
      }
    }
    if (best) return best;
  } catch {
    // ignore
  }

  const legacy = join(home, 'access.key');
  if (fileHasContent(legacy)) return legacy;

  return null;
}
