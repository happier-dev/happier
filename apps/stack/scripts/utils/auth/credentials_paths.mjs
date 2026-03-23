import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileHasContent } from '../fs/file_has_content.mjs';

const SERVER_ID_SAFE_RE = /^[A-Za-z0-9._-]{1,64}$/;

function normalizeServerUrl(url) {
  return String(url ?? '').trim().replace(/\/+$/, '');
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

function resolveActiveServerIdOverride(env = process.env) {
  const raw = String(env?.HAPPIER_ACTIVE_SERVER_ID ?? '').trim();
  if (!raw) return '';
  return sanitizeServerIdForFilesystem(raw, '');
}

function hasExplicitServerContext({ serverUrl = '', env = process.env }) {
  return normalizeServerUrl(serverUrl) !== '' || resolveActiveServerIdOverride(env) !== '';
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
  const overrideServerId = resolveActiveServerIdOverride(env);
  const activeServerId = overrideServerId || urlHashServerId;
  const serverScopedPath = join(home, 'servers', activeServerId, 'access.key');
  const urlHashServerScopedPath =
    urlHashServerId && urlHashServerId !== activeServerId
      ? join(home, 'servers', urlHashServerId, 'access.key')
      : '';
  const hostPortServerScopedPath =
    hostPortServerId && hostPortServerId !== activeServerId && hostPortServerId !== urlHashServerId
      ? join(home, 'servers', hostPortServerId, 'access.key')
      : '';
  const paths = [serverScopedPath, urlHashServerScopedPath, hostPortServerScopedPath, legacyPath].filter(Boolean);
  return {
    activeServerId,
    urlHashServerId,
    hostPortServerId,
    legacyPath,
    serverScopedPath,
    urlHashServerScopedPath,
    hostPortServerScopedPath,
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
  const hostPortServerScopedStatePath =
    hostPortServerId && hostPortServerId !== activeServerId && hostPortServerId !== urlHashServerId
      ? join(home, 'servers', hostPortServerId, 'daemon.state.json')
      : '';
  const hostPortServerScopedLockPath =
    hostPortServerId && hostPortServerId !== activeServerId && hostPortServerId !== urlHashServerId
      ? join(home, 'servers', hostPortServerId, 'daemon.state.json.lock')
      : '';

  return {
    activeServerId,
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
    pairs: [
      { statePath: serverScopedStatePath, lockPath: serverScopedLockPath },
      ...(hostPortServerScopedStatePath
        ? [{ statePath: hostPortServerScopedStatePath, lockPath: hostPortServerScopedLockPath }]
        : []),
      ...(urlHashServerScopedStatePath
        ? [{ statePath: urlHashServerScopedStatePath, lockPath: urlHashServerScopedLockPath }]
        : []),
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
