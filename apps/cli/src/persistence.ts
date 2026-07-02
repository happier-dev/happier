/**
 * Minimal persistence functions for Happier CLI
 * 
 * Handles settings and private key storage in ~/.happier/ or local .happier/
 */

import { FileHandle } from 'node:fs/promises'
import { readFile, writeFile, mkdir, open, unlink, rename, stat, chmod, readdir } from 'node:fs/promises'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { configuration } from './configuration';
import { resolveDaemonStateCandidatePaths } from './daemon/ownership/daemonOwnershipPaths';
import {
  DaemonPublicReleaseChannelLabelSchema,
  DaemonStartupSourceSchema,
  type DaemonStartupSource,
} from './daemon/ownership/daemonOwnershipMetadata';
import { sanitizeServerIdForFilesystem } from './server/serverId';
import { isLocalishServerUrl } from './server/serverUrlClassification';
import type { PublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';
import { createServerUrlComparableKey } from '@happier-dev/protocol';
import * as z from 'zod';
import { decodeBase64, encodeBase64 } from './api/encryption';
import { logger } from './ui/logger';
import { resolveMachineIdForServerFromSettings } from './daemon/resolveMachineIdForServerFromSettings';
import { cleanupAtomicWriteTempFiles, cleanupAtomicWriteTempFilesSync, writeJsonAtomicSync } from './utils/fs/writeJsonAtomicSync';
import type { MachineReplacementReason } from '@happier-dev/protocol';

async function bestEffortChmod(path: string, mode: number): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    await chmod(path, mode);
  } catch {
    // best-effort
  }
}

function bestEffortChmodSync(path: string, mode: number): void {
  if (process.platform === 'win32') return;
  try {
    chmodSync(path, mode);
  } catch {
    // best-effort
  }
}

async function ensureHappyHomeDirExists(): Promise<void> {
  if (!existsSync(configuration.happyHomeDir)) {
    await mkdir(configuration.happyHomeDir, { recursive: true });
  }
  await bestEffortChmod(configuration.happyHomeDir, 0o700);
}

function resolveLegacyDaemonStatePathsForActiveServer(): string[] {
  return resolveDaemonStateCandidatePaths({
    serverDir: configuration.activeServerDir,
    preferredRing: configuration.publicReleaseRing,
  }).filter((candidatePath) => candidatePath !== configuration.daemonStateFile);
}

function cleanupLegacyDaemonStateFilesBestEffortSync(): void {
  for (const legacyPath of resolveLegacyDaemonStatePathsForActiveServer()) {
    try {
      if (existsSync(legacyPath)) {
        unlinkSync(legacyPath);
      }
    } catch {
      // best-effort
    }
    cleanupAtomicWriteTempFilesSync(legacyPath);
  }
}

async function cleanupLegacyDaemonStateFilesBestEffort(): Promise<void> {
  for (const legacyPath of resolveLegacyDaemonStatePathsForActiveServer()) {
    try {
      if (existsSync(legacyPath)) {
        await unlink(legacyPath);
      }
    } catch {
      // best-effort
    }
    await cleanupAtomicWriteTempFiles(legacyPath);
  }
}

// Settings schema version: Integer for overall Settings structure compatibility.
// Incremented when Settings structure changes.
export const SUPPORTED_SCHEMA_VERSION = 6;

export interface Settings {
  // Schema version for backwards compatibility
  schemaVersion: number
  onboardingCompleted: boolean
  /**
   * Active server profile id (schema v5+).
   * Defaults to "cloud" when unset.
   */
  activeServerId?: string
  /**
   * Server profiles (schema v5+).
   */
  servers?: Record<string, {
    id: string
    name: string
    serverUrl: string
    /**
     * Optional device-local API URL optimization (schema v6+).
     * When set, the CLI may use this for API calls, but it must never be embedded into deep links/QR codes.
     */
    localServerUrl?: string
    webappUrl: string
    createdAt: number
    updatedAt: number
    lastUsedAt: number
  }>
  /**
   * Per-server machine IDs (schema v5+).
   */
  machineIdByServerId?: Record<string, string | undefined>
  /**
   * Per-server, per-account machine IDs (schema v6+; best-effort backfill).
   *
   * This prevents a single stack home from reusing a machine id that belongs to a different account
   * when credentials are swapped (e.g. due to credential repair/migration or manual re-auth).
   */
  machineIdByServerIdByAccountId?: Record<string, Record<string, string | undefined> | undefined>
  /**
   * Last observed JWT `sub` (account id) per server id (schema v6+; best-effort).
   *
   * Used to bind machineId selection to an account even when call sites only have Settings.
   */
  lastTokenSubByServerId?: Record<string, string | undefined>
  machineIdConfirmedByServerByServerId?: Record<string, boolean | undefined>
  machineReplacementCandidatesByServerIdByAccountId?: Record<string, Record<string, MachineReplacementCandidate> | undefined>
  daemonAutoStartWhenRunningHappy?: boolean
  chromeMode?: boolean
  /**
   * Per-server, per-account reconnect cursor for `/v2/changes`.
   * Keyed by server id, then server account id.
   */
  lastChangesCursorByServerIdByAccountId?: Record<string, Record<string, number>>

  // ---- Derived fields (not persisted in v5+) ----
  /**
   * Machine id for the active server (derived from machineIdByServerId).
   * Kept for backwards compatibility with older call sites.
   */
  machineId?: string
  machineIdConfirmedByServer?: boolean
  /**
   * Cursor map for the active server (derived from lastChangesCursorByServerIdByAccountId).
   * Kept for backwards compatibility with older call sites.
   */
  lastChangesCursorByAccountId?: Record<string, number>

  /**
   * Device-local daemon memory settings (schema v5+; stored as an opaque JSON payload).
   * Parsed/normalized by `settings/memorySettings.ts`.
   */
  memory?: unknown
}

export type MachineReplacementCandidate = Readonly<{
  machineId: string
  replacementReason: MachineReplacementReason
  createdAt: number
}>

const defaultSettings: Settings = {
  schemaVersion: SUPPORTED_SCHEMA_VERSION,
  onboardingCompleted: false,
  activeServerId: 'cloud',
  servers: {
    cloud: {
      id: 'cloud',
      name: 'Happier Cloud',
      serverUrl: 'https://api.happier.dev',
      webappUrl: 'https://app.happier.dev',
      createdAt: 0,
      updatedAt: 0,
      lastUsedAt: 0,
    },
  },
  machineIdByServerId: {},
  machineIdByServerIdByAccountId: {},
  lastTokenSubByServerId: {},
  machineIdConfirmedByServerByServerId: {},
  machineReplacementCandidatesByServerIdByAccountId: {},
  lastChangesCursorByServerIdByAccountId: {},
}

/**
 * Migrate settings from old schema versions to current
 * Always backwards compatible - preserves all data
 */
function migrateSettings(raw: any, fromVersion: number): any {
  let migrated = { ...raw };

  // Migration from v2 to v3 (removed CLI-local env cache)
  if (fromVersion < 3) {
    if ('localEnvironmentVariables' in migrated) {
      delete migrated.localEnvironmentVariables;
    }
    migrated.schemaVersion = 3;
  }

  // Migration from v3 to v4 (removed CLI-local profile persistence)
  if (fromVersion < 4) {
    if ('profiles' in migrated) delete migrated.profiles;
    if ('activeProfileId' in migrated) delete migrated.activeProfileId;
    migrated.schemaVersion = 4;
  }

  // Migration from v4 to v5 (server profiles + per-server state)
  if (fromVersion < 5) {
    const DEFAULT_SERVER_URL = 'https://api.happier.dev';
    const DEFAULT_WEBAPP_URL = 'https://app.happier.dev';
    const now = Date.now();

    const cloudId = 'cloud';
    migrated.activeServerId = cloudId;
    migrated.servers = {
      [cloudId]: {
        id: cloudId,
        name: 'Happier Cloud',
        serverUrl: DEFAULT_SERVER_URL,
        webappUrl: DEFAULT_WEBAPP_URL,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: now,
      },
    };

    if (typeof migrated.machineId === 'string' && migrated.machineId.trim()) {
      migrated.machineIdByServerId = { [cloudId]: migrated.machineId.trim() };
    } else {
      migrated.machineIdByServerId = {};
    }
    if (typeof migrated.machineIdConfirmedByServer === 'boolean') {
      migrated.machineIdConfirmedByServerByServerId = { [cloudId]: migrated.machineIdConfirmedByServer };
    } else {
      migrated.machineIdConfirmedByServerByServerId = {};
    }

    const legacyCursor = migrated.lastChangesCursorByAccountId && typeof migrated.lastChangesCursorByAccountId === 'object'
      ? migrated.lastChangesCursorByAccountId
      : {};
    migrated.lastChangesCursorByServerIdByAccountId = { [cloudId]: legacyCursor };

    // Remove legacy single-server fields from disk representation.
    if ('machineId' in migrated) delete migrated.machineId;
    if ('machineIdConfirmedByServer' in migrated) delete migrated.machineIdConfirmedByServer;
    if ('lastChangesCursorByAccountId' in migrated) delete migrated.lastChangesCursorByAccountId;

    migrated.schemaVersion = 5;
  }

  // Migration from v5 to v6 (canonical serverUrl + optional localServerUrl)
  if (fromVersion < 6) {
    const normalizeUrl = (value: unknown): string =>
      String(value ?? '').trim().replace(/\/+$/, '');

    const servers = migrated?.servers && typeof migrated.servers === 'object' ? migrated.servers : null;
    if (servers) {
      for (const [id, value] of Object.entries(servers as Record<string, any>)) {
        if (!value || typeof value !== 'object') continue;
        const serverUrl = normalizeUrl((value as any).serverUrl);
        const publicServerUrl = normalizeUrl((value as any).publicServerUrl);
        if (publicServerUrl && publicServerUrl !== serverUrl) {
          (value as any).serverUrl = publicServerUrl;
          if (serverUrl && isLocalishServerUrl(serverUrl)) {
            (value as any).localServerUrl = serverUrl;
          }
        }
        if ('publicServerUrl' in (value as any)) {
          delete (value as any).publicServerUrl;
        }
        (servers as any)[id] = value;
      }
    }

    migrated.schemaVersion = 6;
  }

  // Future migrations go here:
  // if (fromVersion < 6) { ... }

  return migrated;
}

/**
 * Daemon state persisted locally (different from API DaemonState)
 * This is written to disk by the daemon to track its local process state
 */
export interface DaemonLocallyPersistedState {
  pid: number;
  httpPort: number;
  startedAt: number;
  startedWithCliVersion: string;
  startedWithPublicReleaseChannel?: PublicReleaseRingLabel;
  runtimeId?: string;
  startupSource?: DaemonStartupSource;
  serviceLabel?: string;
  machineId?: string;
  lastHeartbeatAt?: number;
  daemonLogPath?: string;
  controlToken?: string;
}

const DaemonLocallyPersistedStateSchemaV2 = z.object({
  pid: z.number().int().positive(),
  httpPort: z.number().int().positive(),
  startedAt: z.number().int().nonnegative(),
  startedWithCliVersion: z.string(),
  startedWithPublicReleaseChannel: DaemonPublicReleaseChannelLabelSchema.optional(),
  runtimeId: z.string().min(1).optional(),
  startupSource: DaemonStartupSourceSchema.optional(),
  serviceLabel: z.string().min(1).optional(),
  machineId: z.string().min(1).optional(),
  lastHeartbeatAt: z.number().int().nonnegative().optional(),
  daemonLogPath: z.string().optional(),
  controlToken: z.string().optional(),
});

// Legacy format (string timestamps, no control token).
const DaemonLocallyPersistedStateSchemaLegacy = z.object({
  pid: z.number().int().positive(),
  httpPort: z.number().int().positive(),
  startTime: z.string(),
  startedWithCliVersion: z.string(),
  lastHeartbeat: z.string().optional(),
  daemonLogPath: z.string().optional(),
});

export const DaemonLocallyPersistedStateSchema = z.union([
  DaemonLocallyPersistedStateSchemaV2,
  DaemonLocallyPersistedStateSchemaLegacy,
]);

function parseDateToEpochMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeDaemonState(
  value: z.infer<typeof DaemonLocallyPersistedStateSchema>,
): DaemonLocallyPersistedState {
  if ('startedAt' in value) {
    return value as DaemonLocallyPersistedState;
  }

  const startedAt = parseDateToEpochMs(value.startTime) ?? Date.now();
  const lastHeartbeatAt = value.lastHeartbeat ? (parseDateToEpochMs(value.lastHeartbeat) ?? undefined) : undefined;
  return {
    pid: value.pid,
    httpPort: value.httpPort,
    startedAt,
    startedWithCliVersion: value.startedWithCliVersion,
    startedWithPublicReleaseChannel: undefined,
    runtimeId: undefined,
    startupSource: undefined,
    serviceLabel: undefined,
    machineId: undefined,
    lastHeartbeatAt,
    daemonLogPath: value.daemonLogPath,
  };
}

export async function readSettings(): Promise<Settings> {
  if (!existsSync(configuration.settingsFile)) {
    return { ...defaultSettings }
  }

  try {
    // Read raw settings
    const content = await readFile(configuration.settingsFile, 'utf8')
    const raw = JSON.parse(content)

    // Check schema version (default to 1 if missing)
    const schemaVersion = raw.schemaVersion ?? 1;

    // Warn if schema version is newer than supported
    if (schemaVersion > SUPPORTED_SCHEMA_VERSION) {
      logger.warn(
        `⚠️ Settings schema v${schemaVersion} > supported v${SUPPORTED_SCHEMA_VERSION}. ` +
        'Update Happier CLI for full functionality.'
      );
    }

    // Migrate if needed
    const migrated = migrateSettings(raw, schemaVersion);

    // Merge with defaults to ensure all required fields exist
    const merged: Settings = { ...defaultSettings, ...migrated };

    // Derive backwards-compat fields for the *effective* active server (schema v5+).
    // The configuration layer resolves env overrides (HAPPIER_SERVER_URL/HAPPIER_WEBAPP_URL) into
    // a deterministic server id; use that id so per-server machine ids/cursors work in hermetic
    // test homes even if settings.json.activeServerId is left at "cloud".
    const activeServerId = sanitizeServerIdForFilesystem(
      configuration.activeServerId ?? merged.activeServerId ?? 'cloud',
      'cloud',
    );
    const lastTokenSub =
      merged.lastTokenSubByServerId && typeof merged.lastTokenSubByServerId === 'object'
        ? merged.lastTokenSubByServerId[activeServerId]
        : undefined;
    const resolvedMachineId = resolveMachineIdForServerFromSettings(
      merged,
      activeServerId,
      typeof lastTokenSub === 'string' && lastTokenSub.trim() ? lastTokenSub.trim() : null,
    );
    if (resolvedMachineId) merged.machineId = resolvedMachineId;
    if (merged.machineIdConfirmedByServerByServerId && typeof merged.machineIdConfirmedByServerByServerId === 'object') {
      const v = merged.machineIdConfirmedByServerByServerId[activeServerId];
      if (typeof v === 'boolean') merged.machineIdConfirmedByServer = v;
    }
    if (merged.lastChangesCursorByServerIdByAccountId && typeof merged.lastChangesCursorByServerIdByAccountId === 'object') {
      const cursorMap = merged.lastChangesCursorByServerIdByAccountId[activeServerId];
      if (cursorMap && typeof cursorMap === 'object') merged.lastChangesCursorByAccountId = cursorMap;
    }

    return merged;
  } catch (error: any) {
    logger.warn(`Failed to read settings: ${error.message}`);
    // Return defaults on any error
    return { ...defaultSettings }
  }
}

function serializeSettingsForDisk(settings: Settings): Settings {
  const schemaVersion = settings.schemaVersion ?? SUPPORTED_SCHEMA_VERSION;
  if (schemaVersion < 5) return settings;

  // Strip derived/legacy fields so we don't regress back to single-server semantics.
  const {
    machineId: _machineId,
    machineIdConfirmedByServer: _machineIdConfirmedByServer,
    lastChangesCursorByAccountId: _lastChangesCursorByAccountId,
    ...rest
  } = settings;
  return rest as Settings;
}

export async function writeSettings(settings: Settings): Promise<void> {
  await ensureHappyHomeDirExists();

  // Ensure schema version is set before writing
  const settingsWithVersion = serializeSettingsForDisk({
    ...settings,
    schemaVersion: settings.schemaVersion ?? SUPPORTED_SCHEMA_VERSION
  });

  await writeFile(configuration.settingsFile, JSON.stringify(settingsWithVersion, null, 2), { mode: 0o600 })
  await bestEffortChmod(configuration.settingsFile, 0o600)
}

/**
 * Atomically update settings with multi-process safety via file locking
 * @param updater Function that takes current settings and returns updated settings
 * @returns The updated settings
 */
export async function updateSettings(
  updater: (current: Settings) => Settings | Promise<Settings>
): Promise<Settings> {
  const { findHappyProcessByPid } = await import('@/daemon/doctor');

  const isTransientSettingsRenameError = (error: unknown): boolean => {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '').trim()
      : '';
    return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
  };

  const renameSettingsFileWithRetry = async (sourcePath: string, targetPath: string): Promise<void> => {
    const MAX_RENAME_ATTEMPTS = 30;
    const RENAME_RETRY_INTERVAL_MS = 100;

    let attempt = 0;
    while (true) {
      try {
        await rename(sourcePath, targetPath);
        return;
      } catch (error) {
        if (
          !isTransientSettingsRenameError(error)
          || attempt >= MAX_RENAME_ATTEMPTS - 1
        ) {
          throw error;
        }
      }

      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_INTERVAL_MS));
    }
  };

  // Timing constants
  const LOCK_RETRY_INTERVAL_MS = 100;  // How long to wait between lock attempts
  const MAX_LOCK_ATTEMPTS = 50;        // Maximum number of attempts (5 seconds total)
  const STALE_LOCK_TIMEOUT_MS = 10000; // Consider lock stale after 10 seconds
  const EMPTY_LOCK_GRACE_MS = 1000;    // Break empty locks quickly when a process dies before writing its pid

  await ensureHappyHomeDirExists();

  const lockFile = configuration.settingsFile + '.lock';
  const tmpFile = configuration.settingsFile + '.tmp';
  let fileHandle;
  let attempts = 0;

  const parseSettingsLockOwnerPid = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
    return parsed;
  };

  const isSettingsLockOwnerAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      return nodeError?.code === 'EPERM';
    }
  };

  // Acquire exclusive lock with retries
  while (attempts < MAX_LOCK_ATTEMPTS) {
    try {
      // Prefer the string flag form for Windows Bun-compiled binaries, which mis-handle numeric O_EXCL flags.
      fileHandle = await open(lockFile, 'wx', 0o600);
      await fileHandle.writeFile(`${process.pid}\n`, 'utf8');
      break;
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        attempts++;
        await ensureHappyHomeDirExists();
        continue;
      }
      if (err.code === 'EEXIST') {
        // Lock file exists, wait and retry
        attempts++;
        await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS));

        try {
          const lockContents = await readFile(lockFile, 'utf8');
          const ownerPid = parseSettingsLockOwnerPid(lockContents);
          if (ownerPid !== null) {
            if (!isSettingsLockOwnerAlive(ownerPid)) {
              await unlink(lockFile).catch(() => { });
              continue;
            }

            const ownerProcess = await findHappyProcessByPid(ownerPid).catch(() => null);
            if (!ownerProcess) {
              await unlink(lockFile).catch(() => { });
              continue;
            }
          }

          const stats = await stat(lockFile);
          if (lockContents.trim().length === 0 && Date.now() - stats.mtimeMs > EMPTY_LOCK_GRACE_MS) {
            await unlink(lockFile).catch(() => { });
            continue;
          }

          if (Date.now() - stats.mtimeMs > STALE_LOCK_TIMEOUT_MS) {
            await unlink(lockFile).catch(() => { });
          }
        } catch { }
      } else {
        throw err;
      }
    }
  }

  if (!fileHandle) {
    throw new Error(`Failed to acquire settings lock after ${MAX_LOCK_ATTEMPTS * LOCK_RETRY_INTERVAL_MS / 1000} seconds`);
  }

  try {
    // Read current settings with defaults
    const current = await readSettings() || { ...defaultSettings };

    // Apply update
    const updated = await updater(current);

    // Ensure directory exists
    await ensureHappyHomeDirExists();

    // Write atomically using rename
    await writeFile(tmpFile, JSON.stringify(serializeSettingsForDisk(updated), null, 2), { mode: 0o600 });
    await renameSettingsFileWithRetry(tmpFile, configuration.settingsFile); // Atomic on POSIX, retried for transient Windows file locks
    await bestEffortChmod(configuration.settingsFile, 0o600)

    return updated;
  } finally {
    // Release lock
    await fileHandle.close();
    await unlink(lockFile).catch(() => { }); // Remove lock file
  }
}

//
// Authentication
//

const credentialsSchema = z.object({
  token: z.string(),
  secret: z.string().base64().nullish(), // Legacy
  encryption: z.object({
    publicKey: z.string().base64(),
    machineKey: z.string().base64()
  }).nullish()
})

export type Credentials = {
  token: string,
  encryption: {
    type: 'legacy', secret: Uint8Array
  } | {
    type: 'dataKey', publicKey: Uint8Array, machineKey: Uint8Array
  }
}

export async function readCredentials(): Promise<Credentials | null> {
  const primaryPath = configuration.privateKeyFile;
  const legacyPath = configuration.legacyPrivateKeyFile;
  const canUseLegacy =
    configuration.activeServerId === 'cloud' &&
    existsSync(legacyPath) &&
    !existsSync(primaryPath);

  const path = existsSync(primaryPath) ? primaryPath : canUseLegacy ? legacyPath : null;
  if (!path) return null;
  try {
    const keyBase64 = (await readFile(path, 'utf8'));
    const credentials = credentialsSchema.parse(JSON.parse(keyBase64));
    if (credentials.secret) {
      return {
        token: credentials.token,
        encryption: {
          type: 'legacy',
          secret: decodeBase64(credentials.secret)
        }
      };
    } else if (credentials.encryption) {
      return {
        token: credentials.token,
        encryption: {
          type: 'dataKey',
          publicKey: decodeBase64(credentials.encryption.publicKey),
          machineKey: decodeBase64(credentials.encryption.machineKey)
        }
      }
    }
  } catch {
    return null
  }
  return null
}

export async function writeCredentialsLegacy(credentials: { secret: Uint8Array, token: string }): Promise<void> {
  await ensureHappyHomeDirExists();
  await writeFile(configuration.privateKeyFile, JSON.stringify({
    secret: encodeBase64(credentials.secret),
    token: credentials.token
  }, null, 2), { mode: 0o600 });
  await bestEffortChmod(configuration.privateKeyFile, 0o600)

  // Migrate legacy single-server credential file (cloud server only).
  if (configuration.activeServerId === 'cloud' && configuration.legacyPrivateKeyFile !== configuration.privateKeyFile) {
    if (existsSync(configuration.legacyPrivateKeyFile)) {
      await unlink(configuration.legacyPrivateKeyFile).catch(() => {});
    }
  }
}

export async function writeCredentialsDataKey(credentials: { publicKey: Uint8Array, machineKey: Uint8Array, token: string }): Promise<void> {
  await ensureHappyHomeDirExists();
  await writeFile(configuration.privateKeyFile, JSON.stringify({
    encryption: { publicKey: encodeBase64(credentials.publicKey), machineKey: encodeBase64(credentials.machineKey) },
    token: credentials.token
  }, null, 2), { mode: 0o600 });
  await bestEffortChmod(configuration.privateKeyFile, 0o600)

  // Migrate legacy single-server credential file (cloud server only).
  if (configuration.activeServerId === 'cloud' && configuration.legacyPrivateKeyFile !== configuration.privateKeyFile) {
    if (existsSync(configuration.legacyPrivateKeyFile)) {
      await unlink(configuration.legacyPrivateKeyFile).catch(() => {});
    }
  }
}

export async function clearCredentials(): Promise<void> {
  if (existsSync(configuration.privateKeyFile)) {
    await unlink(configuration.privateKeyFile).catch(() => {});
  }
  if (configuration.activeServerId === 'cloud' && existsSync(configuration.legacyPrivateKeyFile)) {
    await unlink(configuration.legacyPrivateKeyFile).catch(() => {});
  }
}

export async function clearMachineId(opts?: Readonly<{
  preserveReplacementCandidate?: boolean
  replacementAccountId?: string | null
  replacementReason?: MachineReplacementReason
  now?: number
}>): Promise<void> {
  await updateSettings((settings) => {
    const activeServerId = sanitizeServerIdForFilesystem(
      configuration.activeServerId ?? settings.activeServerId ?? 'cloud',
      'cloud',
    );
    const nextMap = { ...(settings.machineIdByServerId ?? {}) };
    const currentMachineId = typeof nextMap[activeServerId] === 'string'
      ? String(nextMap[activeServerId]).trim()
      : '';
    const nextPerAccount = { ...(settings.machineIdByServerIdByAccountId ?? {}) };
    if (activeServerId in nextPerAccount) delete nextPerAccount[activeServerId];
    const nextLastSub = { ...(settings.lastTokenSubByServerId ?? {}) };
    const explicitReplacementAccountId = typeof opts?.replacementAccountId === 'string'
      ? opts.replacementAccountId.trim()
      : '';
    const storedAccountId = typeof nextLastSub[activeServerId] === 'string'
      ? String(nextLastSub[activeServerId]).trim()
      : '';
    const currentAccountId = explicitReplacementAccountId || storedAccountId;
    const nextReplacementCandidates = { ...(settings.machineReplacementCandidatesByServerIdByAccountId ?? {}) };
    if (opts?.preserveReplacementCandidate === true && currentMachineId && currentAccountId) {
      const byAccount = { ...(nextReplacementCandidates[activeServerId] ?? {}) };
      byAccount[currentAccountId] = {
        machineId: currentMachineId,
        replacementReason: opts.replacementReason ?? 'reauth',
        createdAt: opts.now ?? Date.now(),
      };
      nextReplacementCandidates[activeServerId] = byAccount;
    }
    if (activeServerId in nextLastSub) delete nextLastSub[activeServerId];
    if (activeServerId in nextMap) delete nextMap[activeServerId];
    const nextConfirmed = { ...(settings.machineIdConfirmedByServerByServerId ?? {}) };
    if (activeServerId in nextConfirmed) delete nextConfirmed[activeServerId];
    return {
      ...settings,
      machineIdByServerId: Object.keys(nextMap).length ? nextMap : {},
      machineIdByServerIdByAccountId: Object.keys(nextPerAccount).length ? nextPerAccount : {},
      machineReplacementCandidatesByServerIdByAccountId: Object.keys(nextReplacementCandidates).length ? nextReplacementCandidates : {},
      lastTokenSubByServerId: Object.keys(nextLastSub).length ? nextLastSub : {},
      machineIdConfirmedByServerByServerId: Object.keys(nextConfirmed).length ? nextConfirmed : {},
    };
  });
}

export async function readLastChangesCursor(accountId: string): Promise<number> {
  if (!accountId) return 0;
  const settings = await readSettings();
  const activeServerId = sanitizeServerIdForFilesystem(
    configuration.activeServerId ?? settings.activeServerId ?? 'cloud',
    'cloud',
  );
  const cursor = settings.lastChangesCursorByServerIdByAccountId?.[activeServerId]?.[accountId];
  return typeof cursor === 'number' && Number.isFinite(cursor) && cursor >= 0 ? cursor : 0;
}

export async function writeLastChangesCursor(accountId: string, cursor: number): Promise<void> {
  if (!accountId) return;
  if (!Number.isFinite(cursor) || cursor < 0) return;
  const next = Math.floor(cursor);

  await updateSettings((settings) => {
    const activeServerId = sanitizeServerIdForFilesystem(
      configuration.activeServerId ?? settings.activeServerId ?? 'cloud',
      'cloud',
    );
    const byServer = settings.lastChangesCursorByServerIdByAccountId ?? {};
    const currentMap = byServer[activeServerId] ?? {};
    if (next === 0) {
      if (!(accountId in currentMap)) return settings;
      const copy = { ...currentMap };
      delete copy[accountId];
      const nextByServer = { ...byServer };
      if (Object.keys(copy).length) nextByServer[activeServerId] = copy;
      else delete nextByServer[activeServerId];
      return { ...settings, lastChangesCursorByServerIdByAccountId: nextByServer };
    }

    if (currentMap[accountId] === next) return settings;
    const nextByServer = { ...byServer, [activeServerId]: { ...currentMap, [accountId]: next } };
    return {
      ...settings,
      lastChangesCursorByServerIdByAccountId: nextByServer,
    };
  });
}

/**
 * Read daemon state from local file
 */
async function readDaemonStateFallbackFromServersDir(): Promise<DaemonLocallyPersistedState | null> {
  try {
    const settings = await readSettings().catch(() => defaultSettings);
    const activeServerId = sanitizeServerIdForFilesystem(
      configuration.activeServerId ?? settings.activeServerId ?? 'cloud',
      'cloud',
    );
    const currentServerComparableKey = (() => {
      const raw = String(configuration.publicServerUrl || configuration.serverUrl || '').trim();
      if (!raw) return null;
      try {
        return createServerUrlComparableKey(raw);
      } catch {
        return null;
      }
    })();
    const allowedServerIds = new Set<string>();
    if (activeServerId) {
      allowedServerIds.add(activeServerId);
    }
    const servers = settings.servers && typeof settings.servers === 'object' ? settings.servers : {};
    if (currentServerComparableKey) {
      for (const [serverId, profile] of Object.entries(servers)) {
        if (!profile || typeof profile !== 'object' || Array.isArray(profile)) continue;
        const profileServerUrl = String((profile as { serverUrl?: unknown }).serverUrl ?? '').trim();
        if (!profileServerUrl) continue;
        try {
          if (createServerUrlComparableKey(profileServerUrl) === currentServerComparableKey) {
            allowedServerIds.add(serverId);
          }
        } catch {
          // Ignore malformed persisted server URLs during fallback discovery.
        }
      }
    }

    const dirents = await readdir(configuration.serversDir, { withFileTypes: true });
    const candidates: DaemonLocallyPersistedState[] = [];
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      if (allowedServerIds.size > 0 && !allowedServerIds.has(dirent.name)) continue;
      for (const candidatePath of resolveDaemonStateCandidatePaths({
        serverDir: join(configuration.serversDir, dirent.name),
        preferredRing: configuration.publicReleaseRing,
      })) {
        try {
          const content = await readFile(candidatePath, 'utf-8');
          const parsed = DaemonLocallyPersistedStateSchema.safeParse(JSON.parse(content));
          if (!parsed.success) continue;
          candidates.push(normalizeDaemonState(parsed.data));
          break;
        } catch {
          continue;
        }
      }
    }

    if (candidates.length === 0) return null;

    const alive = candidates.filter((state) => {
      try {
        process.kill(state.pid, 0);
        return true;
      } catch {
        return false;
      }
    });

    if (candidates.length === 1) return alive[0] ?? null;

    // Prefer "alive" daemons when multiple stale files exist (we still fail closed if ambiguous).
    if (alive.length === 1) return alive[0];
    return null;
  } catch {
    return null;
  }
}

export async function readDaemonState(): Promise<DaemonLocallyPersistedState | null> {
  const candidatePaths = resolveDaemonStateCandidatePaths({
    serverDir: configuration.activeServerDir,
    preferredRing: configuration.publicReleaseRing,
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    let sawEnoent = false;
    for (const candidatePath of candidatePaths) {
      try {
        // Note: daemon state is written atomically via rename; retry helps if the reader races with filesystem.
        const content = await readFile(candidatePath, 'utf-8');
        const parsed = DaemonLocallyPersistedStateSchema.safeParse(JSON.parse(content));
        if (!parsed.success) {
          logger.warn(`[PERSISTENCE] Daemon state file is invalid: ${candidatePath}`, parsed.error);
          // File is corrupt/unexpected structure; retry won't help.
          return null;
        }
        const normalized = normalizeDaemonState(parsed.data);
        if (candidatePath !== configuration.daemonStateFile) {
          try {
            writeDaemonState(normalized);
          } catch (promotionError) {
            logger.warn(`[PERSISTENCE] Failed to promote legacy daemon state into canonical path: ${candidatePath}`, promotionError);
          }
        }
        return normalized;
      } catch (error) {
        // A SyntaxError from JSON.parse indicates the file is corrupt; retrying won't fix it.
        if (error instanceof SyntaxError) {
          logger.warn(`[PERSISTENCE] Daemon state file is corrupt and could not be parsed: ${candidatePath}`, error);
          return null;
        }
        const err = error as NodeJS.ErrnoException;
        if (err?.code === 'ENOENT') {
          sawEnoent = true;
          continue;
        }
        if (attempt === 3) {
          logger.warn(`[PERSISTENCE] Failed to read daemon state file after 3 attempts: ${candidatePath}`, error);
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    }
    if (sawEnoent) {
      if (attempt === 3) return await readDaemonStateFallbackFromServersDir();
      await new Promise((resolve) => setTimeout(resolve, 15));
      continue;
    }
  }
  return null;
}

/**
 * Write daemon state to local file (synchronously for atomic operation)
 */
export function writeDaemonState(state: DaemonLocallyPersistedState): void {
  writeJsonAtomicSync(configuration.daemonStateFile, state);
  cleanupLegacyDaemonStateFilesBestEffortSync();
}

/**
 * Clean up daemon state file and, for stale cleanup paths, the lock file.
 */
export async function clearDaemonState(options: Readonly<{ includeLockFile?: boolean }> = {}): Promise<void> {
  const includeLockFile = options.includeLockFile ?? true;
  if (existsSync(configuration.daemonStateFile)) {
    await unlink(configuration.daemonStateFile);
  }
  await cleanupAtomicWriteTempFiles(configuration.daemonStateFile);
  await cleanupLegacyDaemonStateFilesBestEffort();
  // Also clean up lock file if it exists (for stale cleanup)
  if (includeLockFile && existsSync(configuration.daemonLockFile)) {
    try {
      await unlink(configuration.daemonLockFile);
    } catch {
      // Lock file might be held by running daemon, ignore error
    }
  }
}

/**
 * Acquire an exclusive lock file for the daemon.
 * The lock file proves the daemon is running and prevents multiple instances.
 * Returns the file handle to hold for the daemon's lifetime, or null if locked.
 */
export async function acquireDaemonLock(
  maxAttempts: number = 5,
  delayIncrementMs: number = 200
): Promise<FileHandle | null> {
  const { findHappyProcessByPid } = await import('@/daemon/doctor');
  await mkdir(dirname(configuration.daemonLockFile), { recursive: true });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Prefer the string flag form for Windows Bun-compiled binaries, which mis-handle numeric O_EXCL flags.
      const fileHandle = await open(
        configuration.daemonLockFile,
        'wx',
        0o600
      );
      // Write PID to lock file for debugging
      await fileHandle.writeFile(String(process.pid));
      return fileHandle;
    } catch (error: any) {
      if (error.code === 'EEXIST') {
        // Lock file exists, check if process is still running
        try {
          const lockPid = readFileSync(configuration.daemonLockFile, 'utf-8').trim();
          if (lockPid && !isNaN(Number(lockPid))) {
            const pid = Number(lockPid);
            try {
              process.kill(pid, 0); // Check if process exists

              // PID reuse safety: only treat the lock as valid if the PID looks like a happier daemon.
              // Otherwise a recycled PID can wedge daemon startup forever.
              const proc = await findHappyProcessByPid(pid);
              const isDaemon = proc?.type === 'daemon' || proc?.type === 'dev-daemon';
              if (!isDaemon) {
                unlinkSync(configuration.daemonLockFile);
                continue; // Retry acquisition
              }
            } catch {
              // Process doesn't exist, remove stale lock
              unlinkSync(configuration.daemonLockFile);
              continue; // Retry acquisition
            }
          }
        } catch {
          // Can't read lock file, might be corrupted
        }
      }

      if (attempt === maxAttempts) {
        return null;
      }
      const delayMs = attempt * delayIncrementMs;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

/**
 * Release daemon lock by closing handle and deleting lock file
 */
export async function releaseDaemonLock(lockHandle: FileHandle): Promise<void> {
  try {
    await lockHandle.close();
  } catch { }

  try {
    if (existsSync(configuration.daemonLockFile)) {
      const lockOwner = readFileSync(configuration.daemonLockFile, 'utf-8').trim();
      if (lockOwner === String(process.pid)) {
        unlinkSync(configuration.daemonLockFile);
      }
    }
  } catch { }
}
