import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createServerUrlComparableKey } from '@happier-dev/protocol';

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
  const baseDir = String(homeDir ?? '').trim();
  if (!baseDir) return null;
  const settingsPath = join(baseDir, 'settings.json');
  if (!existsSync(settingsPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
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

/**
 * Builds the canonical CLI command that refreshes one stack-owned profile before a stack
 * invocation or daemon launch. Persistence remains owned by the CLI profile writer.
 */
export function buildStackServerProfileSetArgs({ serverId, internalServerUrl, publicServerUrl }) {
  const id = String(serverId ?? '').trim();
  const serverUrl = normalizeServerUrl(internalServerUrl);
  const webappUrl = normalizeServerUrl(publicServerUrl);
  if (!id || !serverUrl || !webappUrl) {
    throw new Error('Stack server profile reconciliation requires an id and both server URLs.');
  }
  return [
    'server',
    'set',
    '--server-id',
    id,
    '--server-url',
    serverUrl,
    '--local-server-url',
    serverUrl,
    '--webapp-url',
    webappUrl,
    '--migrate-matching-profile-state',
    '--json',
  ];
}
