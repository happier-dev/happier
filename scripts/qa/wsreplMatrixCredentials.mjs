// @ts-check

import crypto from 'node:crypto';

function sha256Base64Url(value) {
  const hash = crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest();
  return hash.toString('base64url');
}

function sanitizeTokenStorageKey(raw) {
  // Match the TokenStorage key sanitization expectations used by the tests:
  // - non [a-z0-9._-] -> '_'
  // - collapse repeats
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function coerceServerIdFromUrl(serverUrl) {
  try {
    const u = new URL(String(serverUrl));
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    return `${u.hostname}-${port}`;
  } catch {
    return 'default';
  }
}

export function buildTokenStorageCredentialKeys({ serverUrl, stackName }) {
  const keys = new Set();
  keys.add('auth_credentials__srv_default');

  const serverId = coerceServerIdFromUrl(serverUrl);
  keys.add(`auth_credentials__srv_${sanitizeTokenStorageKey(serverId)}`);

  const stack = String(stackName ?? '').trim();
  if (stack) {
    const scope = sanitizeTokenStorageKey(`stack_${stack}_id_default`);
    keys.add(`auth_credentials__srv_${scope}`);
  }

  const rawServerUrl = String(serverUrl ?? '').trim();
  if (rawServerUrl) {
    keys.add(`auth_credentials__srv_${sha256Base64Url(rawServerUrl)}`);

    // Legacy probe: localhost vs 127.0.0.1 hashing are treated distinct in older clients.
    try {
      const u = new URL(rawServerUrl);
      if (u.hostname === 'localhost') {
        // Preserve the original "origin-only" formatting (no trailing slash) so the hash matches
        // the legacy TokenStorage scope.
        const port = u.port ? `:${u.port}` : '';
        const altOrigin = `${u.protocol}//127.0.0.1${port}`;
        keys.add(`auth_credentials__srv_${sha256Base64Url(altOrigin)}`);
      }
    } catch {
      // ignore
    }
  }

  return Array.from(keys);
}

export function buildServerProfilesSeedEntries({ serverUrl, nowMs }) {
  const id = coerceServerIdFromUrl(serverUrl);
  const serverState = {
    activeServerId: id,
    activeServerIdIsExplicit: true,
    servers: {
      [id]: {
        serverUrl: String(serverUrl),
        lastSeenAt: Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now(),
      },
    },
  };

  return {
    serverId: id,
    // Session storage is tab-scoped; the UI expects `activeServerId` here.
    sessionStorageEntries: [['activeServerId', id]],
    // MMKV-backed server profile state is mirrored into localStorage.
    localStorageEntries: [['mmkv.server-profiles\\server-state-v1', JSON.stringify(serverState)]],
  };
}
