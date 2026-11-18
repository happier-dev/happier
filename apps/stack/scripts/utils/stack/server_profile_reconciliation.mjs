import { existsSync, readFileSync } from 'node:fs';
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { createServerUrlComparableKey } from '@happier-dev/protocol/server/urls';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { resolveServerIdentityRecordPath } from '@happier-dev/cli-common/firstPartyRuntime/personalHome/layout';

import { resolveStackEnvPath } from '../paths/paths.mjs';
import { getServerLightDataDirFromEnvOrDefault } from './dirs.mjs';

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

// The established profile, not a response from the new port, names the Home
// whose authenticated descriptor must be published before endpoint refresh.
export function readStackServerProfileHomeDescriptor({ homeDir, serverId }) {
  const settings = readCliSettings(homeDir);
  if (!settings && existsSync(join(homeDir, 'settings.json'))) {
    throw new Error('Cannot read the established Home profile for server readiness');
  }
  const profile = settings?.servers?.[serverId || settings.activeServerId];
  if (profile?.homeConnectionDescriptor === undefined) return null;
  return HomeConnectionDescriptorV1Schema.parse(profile.homeConnectionDescriptor);
}

// A shared-database consumer's own server mints and keeps its Home identity in a private record
// (owner ruling 2026-11-18, 2129113c152). That record is the only authority by which this stack
// recognizes a Home identity change as one it originated; every other stack has none.
export function resolveStackOwnServerIdentityRecordPath(env) {
  if (!String(env?.HAPPIER_STACK_SHARED_DB_SOURCE_STACK ?? '').trim()) return null;
  const stackBaseDir = resolveStackEnvPath(null, env).baseDir;
  return resolveServerIdentityRecordPath(getServerLightDataDirFromEnvOrDefault({ stackBaseDir, env }));
}

/** The identity this stack's own server recorded, or null when the stack has no such record. */
export function readStackOwnServerIdentity(env) {
  const recordPath = resolveStackOwnServerIdentityRecordPath(env);
  if (!recordPath || !existsSync(recordPath)) return null;
  return readFileSync(recordPath, 'utf-8').trim() || null;
}

// An explicit `--server <id>` that names a saved profile of the stack's own public URL selects the
// stack endpoint, not a foreign server, so the stack's current relay URLs apply to that profile.
export function stackOwnsServerProfile({ homeDir, serverId, publicServerUrl }) {
  const id = String(serverId ?? '').trim();
  const profile = id ? coerceServerProfileFromSettings(readCliSettings(homeDir)?.servers?.[id]) : null;
  const expected = comparableServerUrl(publicServerUrl);
  return Boolean(profile && expected && comparableServerUrl(profile.serverUrl) === expected);
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
export function buildStackServerProfileSetArgs({ serverId, internalServerUrl, publicServerUrl, homeIdentityRecordPath = null }) {
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
    // Only a stack whose own server recorded a different Home identity than the profile
    // established names that record; the CLI verifies it against the live authenticated Home.
    ...(homeIdentityRecordPath ? ['--home-identity-record', homeIdentityRecordPath] : []),
    '--json',
  ];
}

/**
 * The stack-owned profile's Home binding, snapshotted by the reload rollback owner right before a
 * replacement activates. Only a shared-database consumer can change it by its own doing.
 */
export function readStackServerProfileHomeBinding({ env, homeDir, serverId }) {
  if (!resolveStackOwnServerIdentityRecordPath(env)) return null;
  const profile = readCliSettings(homeDir)?.servers?.[serverId];
  if (!profile || profile.homeConnectionDescriptor === undefined) return null;
  return { homeDir, serverId, homeConnectionDescriptor: profile.homeConnectionDescriptor,
    homeConnectionDescriptorAuthority: profile.homeConnectionDescriptorAuthority ?? null };
}

/**
 * Restores a snapshotted Home binding when a failed replacement re-established the profile on its
 * own server's identity, so the incumbent revision's server is accepted again. Takes the CLI's
 * settings lock and refuses while another writer holds it.
 */
export async function restoreStackServerProfileHomeBinding(binding) {
  const settingsPath = join(binding.homeDir, 'settings.json');
  const settings = readCliSettings(binding.homeDir);
  const profile = settings?.servers?.[binding.serverId];
  if (!profile || isDeepStrictEqual(profile.homeConnectionDescriptor, binding.homeConnectionDescriptor)) return false;
  const lockPath = `${settingsPath}.lock`;
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    await lock.writeFile(String(process.pid));
    const current = JSON.parse(await readFile(settingsPath, 'utf-8'));
    const { homeConnectionDescriptorAuthority: _authority, ...rest } = current.servers[binding.serverId];
    current.servers[binding.serverId] = { ...rest, homeConnectionDescriptor: binding.homeConnectionDescriptor,
      ...(binding.homeConnectionDescriptorAuthority ? { homeConnectionDescriptorAuthority: binding.homeConnectionDescriptorAuthority } : {}) };
    const temporaryPath = `${settingsPath}.${process.pid}.rollback.tmp`;
    await writeFile(temporaryPath, JSON.stringify(current, null, 2), { mode: 0o600 });
    await rename(temporaryPath, settingsPath);
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
  return true;
}

// The CLI owns refusal classification: exit 1 is an expected typed refusal,
// exit 2 is an unexpected error. Do not reproduce its code catalogue here.
export function classifyStackServerProfileFailure(error) {
  if (error?.exitCode !== 1) return null;
  for (const line of String(error?.message ?? '').split('\n')) {
    const start = line.indexOf('{');
    if (start < 0) continue;
    let envelope;
    try { envelope = JSON.parse(line.slice(start)); } catch { continue; }
    if (envelope?.v !== 1 || envelope.ok !== false || envelope.kind !== 'server_set') continue;
    const code = envelope.error?.code;
    if (typeof code !== 'string' || !code) continue;
    return Object.assign(new Error(`Stack Home profile refresh refused (${code}); verify the selected Home and sign in before restarting.`), {
      code, phase: 'home-profile', component: 'daemon', entryGraph: 'cli', retryable: false,
    });
  }
  return null;
}
