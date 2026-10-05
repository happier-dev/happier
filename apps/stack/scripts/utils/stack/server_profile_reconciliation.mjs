import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createServerUrlComparableKey } from '@happier-dev/protocol/server/urls';

function normalizeServerUrl(url) {
  return String(url ?? '').trim().replace(/\/+$/, '');
}

function comparableServerUrl(url) {
  const normalized = normalizeServerUrl(url);
  if (!normalized) return '';
  try {
    return createServerUrlComparableKey(normalized);
  } catch {
    return '';
  }
}

export function deriveEnvServerIdFromUrl(url) {
  const normalized = comparableServerUrl(url) || normalizeServerUrl(url);
  if (!normalized) return null;
  let h = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `env_${(h >>> 0).toString(16)}`;
}

function readCliSettings(homeDir) {
  const baseDir = String(homeDir ?? '').trim();
  if (!baseDir) return null;
  const settingsPath = join(baseDir, 'settings.json');
  if (!existsSync(settingsPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function coerceServerProfileFromSettings(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const serverUrl = normalizeServerUrl(raw.serverUrl);
  const webappUrl = normalizeServerUrl(raw.webappUrl);
  const localServerUrl = normalizeServerUrl(raw.localServerUrl);
  const legacyPublicServerUrl = normalizeServerUrl(raw.publicServerUrl);
  const canonicalServerUrl = legacyPublicServerUrl && legacyPublicServerUrl !== serverUrl ? legacyPublicServerUrl : serverUrl;
  if (!id || !canonicalServerUrl || !webappUrl) return null;
  return {
    id,
    serverUrl: canonicalServerUrl,
    localServerUrl: localServerUrl || null,
    webappUrl,
  };
}

export function readActiveServerUrlsFromCliSettings(homeDir) {
  try {
    const parsed = readCliSettings(homeDir);
    if (!parsed) return null;
    const schemaVersion = Number(parsed.schemaVersion ?? 0);
    if (!Number.isFinite(schemaVersion) || schemaVersion < 5) return null;
    const activeServerId = typeof parsed.activeServerId === 'string' ? parsed.activeServerId.trim() : '';
    const servers = parsed.servers && typeof parsed.servers === 'object' ? parsed.servers : null;
    if (!activeServerId || !servers) return null;
    return coerceServerProfileFromSettings(servers[activeServerId]);
  } catch {
    return null;
  }
}

export function assertStackServerProfileReconciled({
  homeDir,
  serverId,
  internalServerUrl,
  publicServerUrl,
}) {
  const expectedId = String(serverId ?? '').trim();
  const expectedInternalUrl = normalizeServerUrl(internalServerUrl);
  const expectedPublicUrl = normalizeServerUrl(publicServerUrl);
  const settings = readCliSettings(homeDir);
  const activeServerId = typeof settings?.activeServerId === 'string' ? settings.activeServerId.trim() : '';
  const servers = settings?.servers && typeof settings.servers === 'object' ? settings.servers : null;
  const rawProfile = servers && expectedId ? servers[expectedId] : null;
  // Read the persisted profile the way the CLI resolves it. The CLI profile writer does not persist a
  // `localServerUrl` equal to `serverUrl`, so the local relay URL is only split when present.
  const profile = coerceServerProfileFromSettings(rawProfile);

  let reason = null;
  if (!settings) reason = 'settings could not be read after the CLI exited';
  else if (activeServerId !== expectedId) reason = `active profile remained ${activeServerId || 'unset'}`;
  else if (!rawProfile || typeof rawProfile !== 'object') reason = `profile ${expectedId} was not written`;
  else if (!profile) reason = `profile ${expectedId} is incomplete`;
  else if (profile.id !== expectedId) reason = `profile ${expectedId} has a different identity`;
  else if (profile.serverUrl !== expectedPublicUrl) reason = 'canonical server URL was not updated';
  else if ((profile.localServerUrl ?? profile.serverUrl) !== expectedInternalUrl) reason = 'local relay URL was not updated';
  else if (profile.webappUrl !== expectedPublicUrl) reason = 'web app URL was not updated';

  if (!reason) return;
  const error = new Error(
    `[hstack] the selected Happier CLI exited successfully but did not apply the requested stack relay profile (${reason}). `
      + 'Upgrade or rebuild the Happier CLI before launching this stack.',
  );
  error.code = 'ESTACKCLIPROFILERECONCILIATION';
  throw error;
}

/**
 * Builds the canonical CLI command that refreshes one stack-owned profile before a stack
 * invocation or daemon launch. Persistence remains owned by the CLI profile writer.
 */
export function buildStackServerProfileSetArgs({ serverId, internalServerUrl, publicServerUrl }) {
  const id = String(serverId ?? '').trim();
  const localServerUrl = normalizeServerUrl(internalServerUrl);
  const canonicalServerUrl = normalizeServerUrl(publicServerUrl);
  if (!id || !localServerUrl || !canonicalServerUrl) {
    throw new Error('Stack server profile reconciliation requires an id and both server URLs.');
  }
  // `serverUrl` is the profile's canonical, advertisable address: pairing links, QR codes and
  // share flows are built from it. The loopback address this process actually calls belongs on
  // `localServerUrl`, so a link produced here names a host other devices can resolve.
  return [
    'server',
    'set',
    '--server-id',
    id,
    '--server-url',
    canonicalServerUrl,
    '--local-server-url',
    localServerUrl,
    '--webapp-url',
    canonicalServerUrl,
    '--json',
  ];
}
