import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SERVER_ID_SAFE_RE = /^[A-Za-z0-9._-]{1,64}$/;

function normalizeServerUrl(url) {
  return String(url ?? '').trim().replace(/\/+$/, '');
}

function sanitizeServerIdForFilesystem(raw, fallback = 'official') {
  const value = String(raw ?? '').trim();
  if (!value) return String(fallback ?? '').trim() || 'official';
  if (value === '.' || value === '..') return String(fallback ?? '').trim() || 'official';
  if (value.includes('/') || value.includes('\\')) return String(fallback ?? '').trim() || 'official';
  if (!SERVER_ID_SAFE_RE.test(value)) return String(fallback ?? '').trim() || 'official';
  return value;
}

function resolveActiveServerIdOverride(env = process.env) {
  const raw = String(env?.HAPPIER_ACTIVE_SERVER_ID ?? '').trim();
  if (!raw) return '';
  return sanitizeServerIdForFilesystem(raw, '');
}

function deriveServerIdFromUrl(url) {
  const normalized = normalizeServerUrl(url);
  let h = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `env_${(h >>> 0).toString(16)}`;
}

function fileHasContent(path) {
  try {
    if (!existsSync(path)) return false;
    return readFileSync(path, 'utf-8').trim().length > 0;
  } catch {
    return false;
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
    normalizedServerUrl ? deriveServerIdFromUrl(normalizedServerUrl) : 'official',
    'official'
  );
  const overrideServerId = resolveActiveServerIdOverride(env);
  const activeServerId = overrideServerId || urlHashServerId;
  const serverScopedPath = join(home, 'servers', activeServerId, 'access.key');
  const urlHashServerScopedPath =
    urlHashServerId && urlHashServerId !== activeServerId
      ? join(home, 'servers', urlHashServerId, 'access.key')
      : '';
  const paths = [serverScopedPath, urlHashServerScopedPath, legacyPath].filter(Boolean);
  return {
    activeServerId,
    urlHashServerId,
    legacyPath,
    serverScopedPath,
    urlHashServerScopedPath,
    paths,
  };
}

export function resolveStackDaemonStatePaths({ cliHomeDir, serverUrl = '', env = process.env }) {
  const home = requireCliHomeDir(cliHomeDir);
  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  const urlHashServerId = sanitizeServerIdForFilesystem(
    normalizedServerUrl ? deriveServerIdFromUrl(normalizedServerUrl) : 'official',
    'official'
  );
  const overrideServerId = resolveActiveServerIdOverride(env);
  const activeServerId = overrideServerId || urlHashServerId;

  const legacyStatePath = join(home, 'daemon.state.json');
  const legacyLockPath = join(home, 'daemon.state.json.lock');
  const serverScopedStatePath = join(home, 'servers', activeServerId, 'daemon.state.json');
  const serverScopedLockPath = join(home, 'servers', activeServerId, 'daemon.state.json.lock');
  const urlHashServerScopedStatePath =
    urlHashServerId && urlHashServerId !== activeServerId
      ? join(home, 'servers', urlHashServerId, 'daemon.state.json')
      : '';
  const urlHashServerScopedLockPath =
    urlHashServerId && urlHashServerId !== activeServerId
      ? join(home, 'servers', urlHashServerId, 'daemon.state.json.lock')
      : '';

  return {
    activeServerId,
    urlHashServerId,
    legacyStatePath,
    legacyLockPath,
    serverScopedStatePath,
    serverScopedLockPath,
    urlHashServerScopedStatePath,
    urlHashServerScopedLockPath,
    pairs: [
      { statePath: serverScopedStatePath, lockPath: serverScopedLockPath },
      ...(urlHashServerScopedStatePath
        ? [{ statePath: urlHashServerScopedStatePath, lockPath: urlHashServerScopedLockPath }]
        : []),
      { statePath: legacyStatePath, lockPath: legacyLockPath },
    ],
  };
}

export function resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl = '', env = process.env }) {
  const resolved = resolveStackDaemonStatePaths({ cliHomeDir, serverUrl, env });
  const serverScopedExists =
    fileHasContent(resolved.serverScopedStatePath) || existsSync(resolved.serverScopedLockPath);
  if (serverScopedExists) {
    return { statePath: resolved.serverScopedStatePath, lockPath: resolved.serverScopedLockPath };
  }

  if (resolved.urlHashServerScopedStatePath) {
    const urlHashExists =
      fileHasContent(resolved.urlHashServerScopedStatePath) || existsSync(resolved.urlHashServerScopedLockPath);
    if (urlHashExists) {
      return { statePath: resolved.urlHashServerScopedStatePath, lockPath: resolved.urlHashServerScopedLockPath };
    }
  }

  const legacyExists = fileHasContent(resolved.legacyStatePath) || existsSync(resolved.legacyLockPath);
  if (legacyExists) {
    return { statePath: resolved.legacyStatePath, lockPath: resolved.legacyLockPath };
  }

  return { statePath: resolved.serverScopedStatePath, lockPath: resolved.serverScopedLockPath };
}

export function findExistingStackCredentialPath({ cliHomeDir, serverUrl = '', env = process.env }) {
  const resolved = resolveStackCredentialPaths({ cliHomeDir, serverUrl, env });
  if (fileHasContent(resolved.serverScopedPath)) return resolved.serverScopedPath;
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
