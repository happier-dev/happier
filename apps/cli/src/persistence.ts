/**
 * Minimal persistence functions for Happier CLI
 * 
 * Handles settings and private key storage in ~/.happier/ or local .happier/
 */

import { FileHandle } from 'node:fs/promises'
import { readFile, writeFile, mkdir, open, unlink, rename, stat, chmod } from 'node:fs/promises'
import { chmodSync, existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, renameSync } from 'node:fs'
import { constants } from 'node:fs'
import { dirname } from 'node:path'
import { configuration } from '@/configuration'
import { sanitizeServerIdForFilesystem } from '@/server/serverId';
import * as z from 'zod';
import { encodeBase64 } from '@/api/encryption';
import { logger } from '@/ui/logger';

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

// Settings schema version: Integer for overall Settings structure compatibility.
// Incremented when Settings structure changes.
export const SUPPORTED_SCHEMA_VERSION = 5;

interface Settings {
  // Schema version for backwards compatibility
  schemaVersion: number
  onboardingCompleted: boolean
  /**
   * Active server profile id (schema v5+).
   * Defaults to "official" when unset.
   */
  activeServerId?: string
  /**
   * Server profiles (schema v5+).
   */
  servers?: Record<string, {
    id: string
    name: string
    serverUrl: string
    webappUrl: string
    createdAt: number
    updatedAt: number
    lastUsedAt: number
  }>
  /**
   * Per-server machine IDs (schema v5+).
   */
  machineIdByServerId?: Record<string, string | undefined>
  machineIdConfirmedByServerByServerId?: Record<string, boolean | undefined>
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
}

const defaultSettings: Settings = {
  schemaVersion: SUPPORTED_SCHEMA_VERSION,
  onboardingCompleted: false,
  activeServerId: 'official',
  servers: {
    official: {
      id: 'official',
      name: 'official',
      serverUrl: 'https://api.happier.dev',
      webappUrl: 'https://app.happier.dev',
      createdAt: 0,
      updatedAt: 0,
      lastUsedAt: 0,
    },
  },
  machineIdByServerId: {},
  machineIdConfirmedByServerByServerId: {},
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

    const officialId = 'official';
    migrated.activeServerId = officialId;
    migrated.servers = {
      [officialId]: {
        id: officialId,
        name: 'official',
        serverUrl: DEFAULT_SERVER_URL,
        webappUrl: DEFAULT_WEBAPP_URL,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: now,
      },
    };

    if (typeof migrated.machineId === 'string' && migrated.machineId.trim()) {
      migrated.machineIdByServerId = { [officialId]: migrated.machineId.trim() };
    } else {
      migrated.machineIdByServerId = {};
    }
    if (typeof migrated.machineIdConfirmedByServer === 'boolean') {
      migrated.machineIdConfirmedByServerByServerId = { [officialId]: migrated.machineIdConfirmedByServer };
    } else {
      migrated.machineIdConfirmedByServerByServerId = {};
    }

    const legacyCursor = migrated.lastChangesCursorByAccountId && typeof migrated.lastChangesCursorByAccountId === 'object'
      ? migrated.lastChangesCursorByAccountId
      : {};
    migrated.lastChangesCursorByServerIdByAccountId = { [officialId]: legacyCursor };

    // Remove legacy single-server fields from disk representation.
    if ('machineId' in migrated) delete migrated.machineId;
    if ('machineIdConfirmedByServer' in migrated) delete migrated.machineIdConfirmedByServer;
    if ('lastChangesCursorByAccountId' in migrated) delete migrated.lastChangesCursorByAccountId;

    migrated.schemaVersion = 5;
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
  lastHeartbeatAt?: number;
  daemonLogPath?: string;
  controlToken?: string;
}

const DaemonLocallyPersistedStateSchemaV2 = z.object({
  pid: z.number().int().positive(),
  httpPort: z.number().int().positive(),
  startedAt: z.number().int().nonnegative(),
  startedWithCliVersion: z.string(),
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
): DaemonLocallyPersistedState | null {
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
    // test homes even if settings.json.activeServerId is left at "official".
    const activeServerId = sanitizeServerIdForFilesystem(
      configuration.activeServerId ?? merged.activeServerId ?? 'official',
      'official',
    );
    if (merged.machineIdByServerId && typeof merged.machineIdByServerId === 'object') {
      const mid = merged.machineIdByServerId[activeServerId];
      if (typeof mid === 'string' && mid.trim()) merged.machineId = mid.trim();
    }
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
  if (!existsSync(configuration.happyHomeDir)) {
    await mkdir(configuration.happyHomeDir, { recursive: true })
  }

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
  // Timing constants
  const LOCK_RETRY_INTERVAL_MS = 100;  // How long to wait between lock attempts
  const MAX_LOCK_ATTEMPTS = 50;        // Maximum number of attempts (5 seconds total)
  const STALE_LOCK_TIMEOUT_MS = 10000; // Consider lock stale after 10 seconds

  const lockFile = configuration.settingsFile + '.lock';
  const tmpFile = configuration.settingsFile + '.tmp';
  let fileHandle;
  let attempts = 0;

  // Acquire exclusive lock with retries
  while (attempts < MAX_LOCK_ATTEMPTS) {
    try {
      // O_CREAT | O_EXCL | O_WRONLY = create exclusively, fail if exists
      fileHandle = await open(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      break;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // Lock file exists, wait and retry
        attempts++;
        await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS));

        // Check for stale lock
        try {
          const stats = await stat(lockFile);
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
    if (!existsSync(configuration.happyHomeDir)) {
      await mkdir(configuration.happyHomeDir, { recursive: true });
    }

    // Write atomically using rename
    await writeFile(tmpFile, JSON.stringify(serializeSettingsForDisk(updated), null, 2), { mode: 0o600 });
    await rename(tmpFile, configuration.settingsFile); // Atomic on POSIX
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
    configuration.activeServerId === 'official' &&
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
          secret: new Uint8Array(Buffer.from(credentials.secret, 'base64'))
        }
      };
    } else if (credentials.encryption) {
      return {
        token: credentials.token,
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(Buffer.from(credentials.encryption.publicKey, 'base64')),
          machineKey: new Uint8Array(Buffer.from(credentials.encryption.machineKey, 'base64'))
        }
      }
    }
  } catch {
    return null
  }
  return null
}

export async function writeCredentialsLegacy(credentials: { secret: Uint8Array, token: string }): Promise<void> {
  if (!existsSync(configuration.happyHomeDir)) {
    await mkdir(configuration.happyHomeDir, { recursive: true })
  }
  await writeFile(configuration.privateKeyFile, JSON.stringify({
    secret: encodeBase64(credentials.secret),
    token: credentials.token
  }, null, 2), { mode: 0o600 });
  await bestEffortChmod(configuration.privateKeyFile, 0o600)

  // Migrate legacy single-server credential file (official server only).
  if (configuration.activeServerId === 'official' && configuration.legacyPrivateKeyFile !== configuration.privateKeyFile) {
    if (existsSync(configuration.legacyPrivateKeyFile)) {
      await unlink(configuration.legacyPrivateKeyFile).catch(() => {});
    }
  }
}

export async function writeCredentialsDataKey(credentials: { publicKey: Uint8Array, machineKey: Uint8Array, token: string }): Promise<void> {
  if (!existsSync(configuration.happyHomeDir)) {
    await mkdir(configuration.happyHomeDir, { recursive: true })
  }
  await writeFile(configuration.privateKeyFile, JSON.stringify({
    encryption: { publicKey: encodeBase64(credentials.publicKey), machineKey: encodeBase64(credentials.machineKey) },
    token: credentials.token
  }, null, 2), { mode: 0o600 });
  await bestEffortChmod(configuration.privateKeyFile, 0o600)

  // Migrate legacy single-server credential file (official server only).
  if (configuration.activeServerId === 'official' && configuration.legacyPrivateKeyFile !== configuration.privateKeyFile) {
    if (existsSync(configuration.legacyPrivateKeyFile)) {
      await unlink(configuration.legacyPrivateKeyFile).catch(() => {});
    }
  }
}

export async function clearCredentials(): Promise<void> {
  if (existsSync(configuration.privateKeyFile)) {
    await unlink(configuration.privateKeyFile).catch(() => {});
  }
  if (configuration.activeServerId === 'official' && existsSync(configuration.legacyPrivateKeyFile)) {
    await unlink(configuration.legacyPrivateKeyFile).catch(() => {});
  }
}

export async function clearMachineId(): Promise<void> {
  await updateSettings((settings) => {
    const activeServerId = sanitizeServerIdForFilesystem(
      configuration.activeServerId ?? settings.activeServerId ?? 'official',
      'official',
    );
    const nextMap = { ...(settings.machineIdByServerId ?? {}) };
    if (!(activeServerId in nextMap)) return settings;
    delete nextMap[activeServerId];
    const nextConfirmed = { ...(settings.machineIdConfirmedByServerByServerId ?? {}) };
    if (activeServerId in nextConfirmed) delete nextConfirmed[activeServerId];
    return {
      ...settings,
      machineIdByServerId: Object.keys(nextMap).length ? nextMap : {},
      machineIdConfirmedByServerByServerId: Object.keys(nextConfirmed).length ? nextConfirmed : {},
    };
  });
}

export async function readLastChangesCursor(accountId: string): Promise<number> {
  if (!accountId) return 0;
  const settings = await readSettings();
  const activeServerId = sanitizeServerIdForFilesystem(
    configuration.activeServerId ?? settings.activeServerId ?? 'official',
    'official',
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
      configuration.activeServerId ?? settings.activeServerId ?? 'official',
      'official',
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
export async function readDaemonState(): Promise<DaemonLocallyPersistedState | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Note: daemon state is written atomically via rename; retry helps if the reader races with filesystem.
      const content = await readFile(configuration.daemonStateFile, 'utf-8');
      const parsed = DaemonLocallyPersistedStateSchema.safeParse(JSON.parse(content));
      if (!parsed.success) {
        logger.warn(`[PERSISTENCE] Daemon state file is invalid: ${configuration.daemonStateFile}`, parsed.error);
        // File is corrupt/unexpected structure; retry won't help.
        return null;
      }
      return normalizeDaemonState(parsed.data);
    } catch (error) {
      // A SyntaxError from JSON.parse indicates the file is corrupt; retrying won't fix it.
      if (error instanceof SyntaxError) {
        logger.warn(`[PERSISTENCE] Daemon state file is corrupt and could not be parsed: ${configuration.daemonStateFile}`, error);
        return null;
      }
      const err = error as NodeJS.ErrnoException;
      if (err?.code === 'ENOENT') {
        if (attempt === 3) return null;
        await new Promise((resolve) => setTimeout(resolve, 15));
        continue;
      }
      if (attempt === 3) {
        logger.warn(`[PERSISTENCE] Failed to read daemon state file after 3 attempts: ${configuration.daemonStateFile}`, error);
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  return null;
}

/**
 * Write daemon state to local file (synchronously for atomic operation)
 */
export function writeDaemonState(state: DaemonLocallyPersistedState): void {
  const dir = dirname(configuration.daemonStateFile);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${configuration.daemonStateFile}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
    try {
      renameSync(tmpPath, configuration.daemonStateFile);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      // On Windows, renameSync may fail if destination exists.
      if (err?.code === 'EEXIST' || err?.code === 'EPERM') {
        try {
          unlinkSync(configuration.daemonStateFile);
        } catch {
          // ignore unlink failure (e.g. ENOENT)
        }
        renameSync(tmpPath, configuration.daemonStateFile);
      } else {
        throw e;
      }
    }
    bestEffortChmodSync(configuration.daemonStateFile, 0o600)
  } catch (e) {
    // Best-effort cleanup to avoid leaving behind orphan tmp files on failures like disk full.
    try {
      if (existsSync(tmpPath)) {
        unlinkSync(tmpPath);
      }
    } catch {
      // ignore cleanup failure
    }
    throw e;
  }
}

/**
 * Clean up daemon state file and lock file
 */
export async function clearDaemonState(): Promise<void> {
  if (existsSync(configuration.daemonStateFile)) {
    await unlink(configuration.daemonStateFile);
  }
  const tmpPath = `${configuration.daemonStateFile}.tmp`;
  if (existsSync(tmpPath)) {
    await unlink(tmpPath).catch(() => {});
  }
  // Also clean up lock file if it exists (for stale cleanup)
  if (existsSync(configuration.daemonLockFile)) {
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

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // O_EXCL ensures we only create if it doesn't exist (atomic lock acquisition)
      const fileHandle = await open(
        configuration.daemonLockFile,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
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
      unlinkSync(configuration.daemonLockFile);
    }
  } catch { }
}
