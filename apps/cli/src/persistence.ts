import { SessionSpawnLaunchErrorV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnLaunchErrorV1';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
/**
 * Minimal persistence functions for Happier CLI
 * 
 * Handles settings and private key storage in ~/.happier/ or local .happier/
 */

import { randomUUID } from 'node:crypto'
import tweetnacl from 'tweetnacl';
import { isDeepStrictEqual } from 'node:util';
import { FileHandle } from 'node:fs/promises'
import { readFile, writeFile, mkdir, open, unlink, rename, stat, chmod, readdir } from 'node:fs/promises'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { constants } from 'node:fs'
import type { AccountE2eeCustody } from '@happier-dev/sync-client'
import { dirname, join } from 'node:path'
import { resolveBuildDefaultProfile, resolveDefaultWebappUrl } from '@happier-dev/cli-common/happierCloud';
import { configuration } from './configuration';
import { resolveCliApiToken } from './auth/cliApiToken';
import { resolveDaemonStateCandidatePaths } from './daemon/ownership/daemonOwnershipPaths';
import {
  DaemonPublicReleaseChannelLabelSchema,
  DaemonStartupSourceSchema,
  type DaemonStartupSource,
} from './daemon/ownership/daemonOwnershipMetadata';
import { deriveServerIdFromUrl, isServerIdFilesystemSafe, sanitizeServerIdForFilesystem } from './server/serverId';
import { isLocalishServerUrl } from './server/serverUrlClassification';
import type { PublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';
import { isPidPresent, isPidProvablyAbsent, parseDaemonLockSnapshot, probeProcessLiveness, type DaemonLockRecord, type DaemonLockSnapshot } from '@happier-dev/cli-common/process';
export type { DaemonLockSnapshot } from '@happier-dev/cli-common/process';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import { processGenerationProvesReuse } from '@happier-dev/cli-common/processInstance';
import { createServerUrlComparableKey } from '@happier-dev/protocol/server/urls/serverUrlComparableKey';
import * as z from 'zod/mini';
import { ProcessBirthWitnessSchema } from './processes/census/decodeHelperCensus';
import type { ProcessBirthWitness } from './daemon/processIdentity';
import { decodeBase64, encodeBase64 } from './api/encryption';
import { logger } from './ui/logger';
import { resolveMachineIdForServerFromSettings } from './daemon/resolveMachineIdForServerFromSettings';
import { cleanupAtomicWriteTempFiles, cleanupAtomicWriteTempFilesSync, writeJsonAtomicSync } from './utils/fs/writeJsonAtomicSync';
import type { MachineReplacementReason } from '@happier-dev/protocol';
import { RequesterWorkAttributionV1Schema, type RequesterWorkAttributionV1 } from '@happier-dev/protocol/machines/requesterWorkAttributionV1';
import { reclaimJsonOwnerFileLockSnapshot, withJsonOwnerFileLock } from './utils/fs/jsonOwnerFileLock';
import { readProcessRunState } from './daemon/processRunState';
import { decodeJwtPayload } from './cloud/decodeJwtPayload';
import { readAuthTokenProvenance } from '@happier-dev/protocol/auth/authToken';
import { ensurePrivateDirectoryPreservingTraversal } from './utils/fs/protectedLocalState';

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
  if (process.platform !== 'win32') {
    try {
      await ensurePrivateDirectoryPreservingTraversal(configuration.happyHomeDir);
    } catch {
      // Existing home permission repair is best-effort.
    }
  }
}

function resolveDaemonStateCandidatePathsForCurrentLifecycle(): readonly string[] {
  return resolveDaemonStateCandidatePaths({
    serverDir: dirname(configuration.daemonStateFile),
    preferredRing: configuration.publicReleaseRing,
  });
}

function resolveLegacyDaemonStatePathsForCurrentLifecycle(): string[] {
  return resolveDaemonStateCandidatePathsForCurrentLifecycle()
    .filter((candidatePath) => candidatePath !== configuration.daemonStateFile);
}

function hasExplicitDaemonLifecycleScope(): boolean {
  return isServerIdFilesystemSafe(String(process.env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID ?? '').trim());
}

function cleanupLegacyDaemonStateFilesBestEffortSync(): void {
  for (const legacyPath of resolveLegacyDaemonStatePathsForCurrentLifecycle()) {
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
  for (const legacyPath of resolveLegacyDaemonStatePathsForCurrentLifecycle()) {
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

const PERSISTENCE_LOCK_TIMEOUT_MS = 5000;
const PERSISTENCE_STALE_LOCK_TIMEOUT_MS = 10000;

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
    /** Exact protocol-owned descriptor observed from this authenticated Home. */
    homeConnectionDescriptor?: import('@happier-dev/protocol').HomeConnectionDescriptorV1
    /** Whether the descriptor is exact or advisory; written by the server profile owner. */
    homeConnectionDescriptorAuthority?: import('@/server/serverProfiles').ServerProfile['homeConnectionDescriptorAuthority']
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
  /**
   * Last applied Machine role set per server and Machine (stored `rolesV1.active`; absent = every core role).
   * The daemon boots from it so roles that are off never start, even offline; metadata stays the desired value.
   */
  machineRolesByServerIdByMachineId?: Record<string, Record<string, readonly string[] | undefined> | undefined>
  /** Opt-in startup refresh of stale runners; known active turns are skipped. */
  restartSessionRunnersOnUpdate?: boolean
  chromeMode?: boolean
  plugins?: {
    devWatch?: boolean
  }
  // ---- Derived fields (not persisted in v5+) ----
  /**
   * Machine id for the active server (derived from machineIdByServerId).
   * Kept for backwards compatibility with older call sites.
   */
  machineId?: string
  machineIdConfirmedByServer?: boolean
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

const defaultHome = resolveBuildDefaultProfile().home;
const defaultHomeId = defaultHome ? deriveServerIdFromUrl(defaultHome.url) : '';
const defaultSettings: Settings = {
  schemaVersion: SUPPORTED_SCHEMA_VERSION,
  onboardingCompleted: false,
  activeServerId: defaultHomeId,
  servers: defaultHome ? {
    [defaultHomeId]: {
      id: defaultHomeId,
      name: new URL(defaultHome.url).hostname,
      serverUrl: defaultHome.url,
      webappUrl: resolveDefaultWebappUrl(defaultHome.url),
      createdAt: 0,
      updatedAt: 0,
    },
  } : {},
  machineIdByServerId: {},
  machineIdByServerIdByAccountId: {},
  lastTokenSubByServerId: {},
  machineIdConfirmedByServerByServerId: {},
  machineReplacementCandidatesByServerIdByAccountId: {},
  plugins: {
    devWatch: true,
  },
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
    const DEFAULT_WEBAPP_URL = 'https://cloud.happier.dev';
    const now = Date.now();

    const cloudId = 'cloud';
    migrated.activeServerId = cloudId;
    migrated.servers = {
      [cloudId]: {
        id: cloudId,
        name: 'Happier Cloud',
        // Historical v4 credentials belonged to this endpoint, independent of this build's defaults.
        serverUrl: 'https://api.happier.dev',
        webappUrl: DEFAULT_WEBAPP_URL,
        createdAt: now,
        updatedAt: now,
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
  /** Zero while the lifecycle-lock owner is preparing its local control server. */
  httpPort: number;
  startedAt: number;
  startedWithCliVersion: string;
  startedWithPublicReleaseChannel?: PublicReleaseRingLabel;
  /**
   * The CLI bundle this daemon is executing, and when that bundle was built. The version
   * string above cannot distinguish a current build from one a package build left behind,
   * so these are what tell an operator which bytes are actually running.
   */
  startedWithRuntimeEntrypoint?: string;
  startedWithRuntimeBuiltAt?: string;
  runtimeId?: string;
  daemonExecutionGenerationV1?: string;
  startupSource?: DaemonStartupSource;
  serviceLabel?: string;
  machineId?: string;
  accountId?: string;
  lastHeartbeatAt?: number;
  /**
   * Whether this daemon had completed its machine-control RPC registration as of
   * `lastHeartbeatAt`. Written by the heartbeat, which is the only writer of this record
   * after startup, so the two fields always share one observation instant.
   *
   * A PID probe cannot tell a working daemon from one whose registration never completed —
   * the exact state that read as healthy for 56 minutes on pid 26058 — and this is the fact
   * the daemon already had and was not reporting. Absent means the daemon published no such
   * fact (older daemon, or no heartbeat yet): unknown, never unhealthy.
   */
  machineControlReady?: boolean;
  sourceRuntimeReloadRequired?: import("@happier-dev/cli-common/sourceRuntimeEntries").SourceRuntimeDependencyStatus;
  daemonLogPath?: string;
  controlToken?: string;
  /**
   * This daemon process's birth (pid + native start identity), stamped by the lifecycle-lock owner
   * on every publication. A state left behind by an unclean exit names a pid the OS may recycle;
   * its birth tells the recycled process apart from the daemon (local Session channel admission).
   */
  processBirth?: ProcessBirthWitness;
}

const DaemonLocallyPersistedStateSchemaV2 = lazyZodSchema(() => z.object({
  pid: z.number().check(z.int(), z.positive()),
  httpPort: z.number().check(z.int(), z.nonnegative()),
  startedAt: z.number().check(z.int(), z.nonnegative()),
  startedWithCliVersion: z.string(),
  startedWithPublicReleaseChannel: z.optional(DaemonPublicReleaseChannelLabelSchema),
  startedWithRuntimeEntrypoint: z.optional(z.string().check(z.minLength(1))),
  startedWithRuntimeBuiltAt: z.optional(z.string().check(z.minLength(1))),
  runtimeId: z.optional(z.string().check(z.minLength(1))),
  daemonExecutionGenerationV1: z.optional(z.string().check(z.minLength(1))),
  startupSource: z.optional(DaemonStartupSourceSchema),
  serviceLabel: z.optional(z.string().check(z.minLength(1))),
  machineId: z.optional(z.string().check(z.minLength(1))),
  accountId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  lastHeartbeatAt: z.optional(z.number().check(z.int(), z.nonnegative())),
  machineControlReady: z.optional(z.boolean()),
  sourceRuntimeReloadRequired: z.optional(z.object({
    code: z.literal('SOURCE_RUNTIME_RELOAD_REQUIRED'),
    subtype: z.nonoptional(SessionSpawnLaunchErrorV1Schema.shape.subtype),
  })),
  daemonLogPath: z.optional(z.string()),
  controlToken: z.optional(z.string()),
  processBirth: z.optional(ProcessBirthWitnessSchema),
}).check(z.refine(state => state.httpPort > 0 || (
  state.controlToken === undefined && state.startupSource !== undefined
  && state.startedWithPublicReleaseChannel !== undefined && state.machineControlReady === false
), { message: 'A startup publication has no control listener or ready Machine' })));

// Legacy format (string timestamps, no control token).
const DaemonLocallyPersistedStateSchemaLegacy = lazyZodSchema(() => z.object({
  pid: z.number().check(z.int(), z.positive()),
  httpPort: z.number().check(z.int(), z.positive()),
  startTime: z.string(),
  startedWithCliVersion: z.string(),
  lastHeartbeat: z.optional(z.string()),
  daemonLogPath: z.optional(z.string()),
}));

export const DaemonLocallyPersistedStateSchema = lazyZodSchema(() => z.union([
  DaemonLocallyPersistedStateSchemaV2,
  DaemonLocallyPersistedStateSchemaLegacy,
]));

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

async function readSettingsFromDisk(): Promise<{ settings: Settings; needsMigration: boolean }> {
  let content: string;
  try {
    content = await readFile(configuration.settingsFile, 'utf8');
  } catch (error) {
    // Only a confirmed missing file is safe to initialize with defaults.
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { settings: { ...defaultSettings }, needsMigration: true };
    throw error;
  }

  const raw = JSON.parse(content)

  // Check schema version (default to 1 if missing)
  const schemaVersion = raw.schemaVersion ?? 1;

  // Warn if schema version is newer than supported
  if (schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    logger.warn(
      `Settings file uses schema v${schemaVersion}, newer than the supported v${SUPPORTED_SCHEMA_VERSION}. ` +
      'Update Happier CLI for full functionality.'
    );
  }

  // Migrate if needed
  const migrated = migrateSettings(raw, schemaVersion);

  // Merge with defaults to ensure all required fields exist
  const merged: Settings = serializeSettingsForDisk({ ...defaultSettings, ...migrated });

  // Derive backwards-compat fields for the *effective* active server (schema v5+).
  // The configuration layer resolves env overrides (HAPPIER_SERVER_URL/HAPPIER_WEBAPP_URL) into
  // a deterministic server id; use that id so per-server machine ids work in hermetic
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
  return { settings: merged, needsMigration: schemaVersion < SUPPORTED_SCHEMA_VERSION };
}

export async function readSettings(): Promise<Settings> {
  try {
    return (await readSettingsFromDisk()).settings;
  } catch (error) {
    logger.warn(`Failed to read settings: ${error instanceof Error ? error.message : String(error)}`);
    return { ...defaultSettings };
  }
}

function serializeSettingsForDisk(settings: Settings): Settings {
  const schemaVersion = settings.schemaVersion ?? SUPPORTED_SCHEMA_VERSION;
  const { lastChangesCursorByAccountId: _legacyCursor,
    lastChangesCursorByServerIdByAccountId: _legacyScopedCursors, ...withoutCursors } = settings as Settings & {
      lastChangesCursorByAccountId?: unknown;
      lastChangesCursorByServerIdByAccountId?: unknown;
    };
  if (schemaVersion < 5) return withoutCursors;

  // Strip derived/legacy fields so we don't regress back to single-server semantics.
  const {
    machineId: _machineId,
    machineIdConfirmedByServer: _machineIdConfirmedByServer,
    ...rest
  } = withoutCursors;
  return {
    ...rest,
    ...(rest.servers ? { servers: Object.fromEntries(Object.entries(rest.servers).map(([id, profile]) => {
      // 0.2 timestamps are imported before publication, never written back.
      const { lastUsedAt: _lastUsedAt, ...preference } = profile as typeof profile & { lastUsedAt?: unknown };
      return [id, preference];
    })) } : {}),
  };
}

export async function writeSettings(settings: Settings): Promise<void> {
  await ensureHappyHomeDirExists();
  // Import predecessor state before a settings publication can retire its source.
  await ensureAccountChangesCursorsImported();
  await ensureServerProfileObservationsImported();

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
  const MAX_LOCK_ATTEMPTS = PERSISTENCE_LOCK_TIMEOUT_MS / LOCK_RETRY_INTERVAL_MS;
  const STALE_LOCK_TIMEOUT_MS = PERSISTENCE_STALE_LOCK_TIMEOUT_MS;
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
            if (!isPidPresent(ownerPid)) {
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
    // Never turn a failed read or migration into a destructive defaults write.
    const { settings: current, needsMigration } = await readSettingsFromDisk();
    await ensureAccountChangesCursorsImported();
    await ensureServerProfileObservationsImported();

    // Apply update
    const updated = await updater(current);
    if (!needsMigration && isDeepStrictEqual(current, updated)) return updated;

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

const credentialsSchema = lazyZodSchema(() => z.object({
  token: z.optional(z.string()),
  secret: z.nullish(z.string().check(z.base64())), // Legacy
  encryption: z.nullish(z.object({
    publicKey: z.string().check(z.base64()),
    machineKey: z.string().check(z.base64())
  })),
  /** This computer's own reclassification of its keys; absent means active. */
  custody: z.optional(z.literal('historical')),
}))

export type AccountEncryptionCredentials =
  | {
    type: 'legacy', secret: Uint8Array
  }
  | {
    type: 'dataKey', publicKey: Uint8Array, machineKey: Uint8Array
  };

/**
 * Invocation-only credential provenance. It is deliberately not persisted:
 * an ordinary stored bearer proves an interactive CLI session. Private Agent
 * Session custody and API Tokens must never inherit present-user authority.
 */
export type CredentialProvenance = 'stored_session' | 'api_token';

type CredentialProvenanceMarker = Readonly<{
  /** Missing provenance is intentionally treated as Account automation. */
  credentialProvenance?: CredentialProvenance;
  /** Private Session custody restricts saved-Home readers; never encoded or transported. */
  requesterSessionCredentialScope?: Readonly<{
    serverId: string;
    serverHttpBaseUrl: string;
    /** Accepted private child custody, not serialized credentials or caller input. */
    requesterSession?: Readonly<{ sessionId: string; attribution: RequesterWorkAttributionV1; homeServerIdentityId?: string;
      /** The daemon's Machine admission for this requester, carried from private custody. */
      machineAdmission?: Readonly<{ custodianAccountId: string; role?: 'use' | 'manage' }> }>;
  }>;
}>;

export type Credentials = CredentialProvenanceMarker & {
  token: string,
  encryption: AccountEncryptionCredentials,
  /**
   * Only this computer writes `historical` (keyless re-auth or the person's
   * confirmation); a Home's reported mode never does. Absent means active.
   */
  accountE2eeCustody?: 'historical',
}

export type TokenOnlyCredentials = CredentialProvenanceMarker & {
  token: string;
  encryption: null;
}

export type StoredCredentials = Credentials | TokenOnlyCredentials;

/** Called only by admitted/private-custody owners, never by the serialized credential decoder. */
export function bindRequesterSessionCredentialScope(credentials: StoredCredentials,
  scope: NonNullable<StoredCredentials['requesterSessionCredentialScope']>): StoredCredentials {
  const existing = credentials.requesterSessionCredentialScope;
  if (existing) {
    if (existing.serverId !== scope.serverId || existing.serverHttpBaseUrl !== scope.serverHttpBaseUrl) {
      throw new Error('requester_session_credential_scope_mismatch');
    }
    if (scope.requesterSession && !isDeepStrictEqual(existing.requesterSession, scope.requesterSession)) {
      throw new Error('requester_session_credential_scope_mismatch');
    }
    return credentials;
  }
  const requesterSession = scope.requesterSession ? Object.freeze({
    sessionId: scope.requesterSession.sessionId,
    attribution: Object.freeze(RequesterWorkAttributionV1Schema.parse(scope.requesterSession.attribution)),
    ...(scope.requesterSession.homeServerIdentityId ? { homeServerIdentityId: scope.requesterSession.homeServerIdentityId } : {}),
    ...(scope.requesterSession.machineAdmission ? { machineAdmission: Object.freeze({ ...scope.requesterSession.machineAdmission }) } : {}),
  }) : undefined;
  Object.defineProperty(credentials, 'requesterSessionCredentialScope', {
    value: Object.freeze({ ...scope, ...(requesterSession ? { requesterSession } : {}) }),
    enumerable: false, writable: false, configurable: false,
  });
  return credentials;
}

/** Preserve invocation-only context while a host parser validates/clones the
 * credential bytes. Serialized/authored scope properties are not custody and
 * must not downgrade into an interactive stored-session identity. */
export function preserveStoredCredentialsHostContext(source: unknown, normalized: StoredCredentials): StoredCredentials {
  if (!source || typeof source !== 'object' || !('token' in source) || source.token !== normalized.token) return normalized;
  const scope = Object.getOwnPropertyDescriptor(source, 'requesterSessionCredentialScope');
  if (scope) {
    const value: unknown = scope.value;
    if (scope.enumerable !== false || scope.writable !== false || scope.configurable !== false
      || !('value' in scope) || !value || typeof value !== 'object' || !Object.isFrozen(value)) return normalized;
    Object.defineProperty(normalized, 'requesterSessionCredentialScope', scope);
  }
  const provenance = Object.getOwnPropertyDescriptor(source, 'credentialProvenance');
  if (provenance && 'value' in provenance
    && (provenance.value === 'stored_session' || provenance.value === 'api_token')) {
    Object.defineProperty(normalized, 'credentialProvenance', provenance);
  }
  return normalized;
}

/** Canonical access.key representation; private Session custody uses the same codec. */
export function decodeStoredCredentials(value: unknown): StoredCredentials | null {
  const parsed = credentialsSchema.safeParse(value);
  if (!parsed.success || !parsed.data.token) return null;
  const credentials = parsed.data;
  const encryption: AccountEncryptionCredentials | null = credentials.secret
    ? { type: 'legacy', secret: decodeBase64(credentials.secret) }
    : credentials.encryption
      ? { type: 'dataKey', publicKey: decodeBase64(credentials.encryption.publicKey), machineKey: decodeBase64(credentials.encryption.machineKey) }
      : null;
  return encryption
    ? { token: credentials.token!, encryption, ...(credentials.custody ? { accountE2eeCustody: credentials.custody } : {}),
        credentialProvenance: 'stored_session' }
    : { token: credentials.token!, encryption: null, credentialProvenance: 'stored_session' };
}

/** Any in-hand credential: custody is read from what the caller holds, not from disk. */
export type AccountE2eeCustodyHolder = Readonly<{ encryption: unknown; accountE2eeCustody?: 'historical' }>;

/** The custody input to the shared Account mode admission decision. */
export function readAccountE2eeCustody(credentials: AccountE2eeCustodyHolder): AccountE2eeCustody {
  if (!credentials.encryption) return 'absent';
  return credentials.accountE2eeCustody === 'historical' ? 'historical' : 'active';
}

/**
 * Custody of the Account E2EE material this computer stores beside `token`.
 * A bearer no stored credential holds carries no keys here: API tokens and
 * private Session custody are read through their own exact owners.
 */
export async function readAccountE2eeCustodyForToken(token: string): Promise<AccountE2eeCustody> {
  if (sessionProcessEnvironment().HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE !== undefined || resolveCliApiToken()) {
    const scoped = await readStoredCredentials().catch(() => null);
    if (scoped?.token === token) return readAccountE2eeCustody(scoped);
    if (sessionProcessEnvironment().HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE !== undefined) return 'absent';
  }
  const serverIds = await readdir(configuration.serversDir).catch(() => [] as string[]);
  for (const serverId of new Set([configuration.activeServerId, ...serverIds, 'cloud'])) {
    const stored = await readStoredCredentialCustodyForServerId(serverId).catch(() => null);
    if (stored?.token === token) return readAccountE2eeCustody(stored);
  }
  return 'absent';
}

/** The person's explicit reclassification of this computer's keys; the bytes never change. */
export async function writeAccountE2eeCustodyForServerId(
  serverIdRaw: string,
  expectedToken: string,
  custody: 'active' | 'historical',
): Promise<boolean> {
  const stored = await readStoredCredentialCustodyForServerId(serverIdRaw);
  if (!stored?.encryption || stored.token !== expectedToken) return false;
  const { accountE2eeCustody: _previous, ...material } = stored;
  await writeStoredCredentialsForServerId(serverIdRaw, custody === 'historical' ? { ...material, accountE2eeCustody: 'historical' } : material);
  return true;
}

export function encodeStoredCredentials(credentials: StoredCredentials): z.infer<typeof credentialsSchema> & Pick<StoredCredentials, 'token'> {
  const custody = credentials.encryption && credentials.accountE2eeCustody === 'historical' ? { custody: 'historical' as const } : {};
  return credentials.encryption?.type === 'legacy'
    ? { token: credentials.token, secret: encodeBase64(credentials.encryption.secret), ...custody }
    : credentials.encryption?.type === 'dataKey'
      ? { token: credentials.token, encryption: {
          publicKey: encodeBase64(credentials.encryption.publicKey), machineKey: encodeBase64(credentials.encryption.machineKey),
        }, ...custody }
      : { token: credentials.token };
}

/**
 * Requester credentials this computer hands to another Machine: the bearer plus
 * active Account E2EE material only. Historical keys and their device-local
 * marker stay here; the sealer or the receiving daemon matches the result to the
 * Home-signed Account mode.
 */
export function encodeRequesterCredentials(credentials: StoredCredentials): Omit<ReturnType<typeof encodeStoredCredentials>, 'custody'> {
  return readAccountE2eeCustody(credentials) === 'active' ? encodeStoredCredentials(credentials) : { token: credentials.token };
}

export class CliReloginRequiredError extends Error {
  readonly code = 'cli_relogin_required';

  constructor() {
    super('Happier updated how the CLI signs in. Please run `happier auth login` again.');
    this.name = 'CliReloginRequiredError';
  }
}

function sameCredentialBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index]);
}

/** Exact current credential identity used by credential-refreshing operation owners. */
export function sameStoredCredentials(
  left: StoredCredentials,
  right: StoredCredentials | null | undefined,
): boolean {
  if (!right || left.token !== right.token || left.credentialProvenance !== right.credentialProvenance) return false;
  if (left.requesterSessionCredentialScope?.serverId !== right.requesterSessionCredentialScope?.serverId
    || left.requesterSessionCredentialScope?.serverHttpBaseUrl !== right.requesterSessionCredentialScope?.serverHttpBaseUrl) return false;
  if (left.encryption === null || right.encryption === null) return left.encryption === right.encryption;
  if (readAccountE2eeCustody(left) !== readAccountE2eeCustody(right)) return false;
  if (left.encryption.type === 'legacy' && right.encryption.type === 'legacy') {
    return sameCredentialBytes(left.encryption.secret, right.encryption.secret);
  }
  if (left.encryption.type === 'dataKey' && right.encryption.type === 'dataKey') {
    return sameCredentialBytes(left.encryption.publicKey, right.encryption.publicKey)
      && sameCredentialBytes(left.encryption.machineKey, right.encryption.machineKey);
  }
  return false;
}

/**
 * Only the credential reader may attest an interactive stored CLI session.
 * Private Agent Session custody is not an interactive terminal sign-in, even
 * when it borrows that sign-in's bearer. Synthetic/legacy callers without this
 * marker likewise fail closed as automation.
 */
export function hasStoredSessionCredentialProvenance(
  credentials: StoredCredentials | null | undefined,
): boolean {
  return credentials?.credentialProvenance === 'stored_session'
    && !credentials.requesterSessionCredentialScope?.requesterSession;
}

export async function readCredentials(): Promise<Credentials | null> {
  const credentials = await readStoredCredentials();
  return credentials?.encryption ? credentials : null;
}

export async function readStoredCredentials(
  options: Readonly<{ serverId?: string }> = {},
): Promise<StoredCredentials | null> {
  const serverId = options.serverId ?? configuration.activeServerId;
  if (options.serverId !== undefined && !isServerIdFilesystemSafe(serverId)) return null;
  // Explicit Session custody is authoritative for this child. A missing,
  // unsafe, or mismatched file must never become a custodian/global sign-in.
  const requesterCredentialFile = sessionProcessEnvironment().HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE;
  if (requesterCredentialFile !== undefined) {
    const { readRequesterSessionCredentialsForChild } = await import('./daemon/sessionEncryption/requesterSessionCustody');
    const credentials = await readRequesterSessionCredentialsForChild(requesterCredentialFile);
    return options.serverId === undefined || credentials?.requesterSessionCredentialScope?.serverId === serverId
      ? credentials : null;
  }
  const apiToken = resolveCliApiToken();
  if (apiToken) {
    return {
      token: apiToken,
      encryption: null,
      credentialProvenance: 'api_token',
    };
  }

  const primaryPath = options.serverId === undefined
    ? configuration.privateKeyFile
    : join(configuration.serversDir, serverId, 'access.key');
  return await readStoredProfileCredentialFile(serverId, primaryPath, 'invocation');
}

type StoredCredentialReadPurpose = 'invocation' | 'custody';

async function readStoredProfileCredentialFile(
  serverId: string,
  primaryPath: string,
  purpose: StoredCredentialReadPurpose,
): Promise<StoredCredentials | null> {
  const legacyPath = configuration.legacyPrivateKeyFile;
  const path = existsSync(primaryPath) ? primaryPath : serverId === 'cloud' && existsSync(legacyPath) ? legacyPath : null;
  return path ? await readStoredCredentialsFile(path, purpose) : null;
}

async function readStoredCredentialsFile(path: string, purpose: StoredCredentialReadPurpose): Promise<StoredCredentials | null> {
  try {
    const keyBase64 = (await readFile(path, 'utf8'));
    const credentials = credentialsSchema.parse(JSON.parse(keyBase64));
    if (!credentials.token) return null;
    // This unsigned marker only refuses an obsolete bearer. The Home still
    // verifies every credential; this read never grants authority. A read never
    // rewrites the key file: the next deliberate login replaces it.
    if (purpose === 'invocation') {
      const payload = decodeJwtPayload(credentials.token);
      const provenance = payload && typeof payload.sub === 'string' && payload.sub.trim()
        ? readAuthTokenProvenance(payload, { allowLegacyHome: true }) : null;
      if (provenance?.provenance.kind === 'account') throw new CliReloginRequiredError();
    }
    return decodeStoredCredentials(credentials);
  } catch (error) {
    if (error instanceof CliReloginRequiredError) throw error;
    // A file removed between the existence check and the read is ordinary sign-out.
    // Anything else (corrupt JSON, invalid shape, IO) reads as signed out too, but
    // must stay diagnosable. Name only the failure class: a parser message can quote the bearer.
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : null;
    if (code !== 'ENOENT') {
      logger.warnLocalFile('[persistence] Stored credentials are unreadable; treating them as signed out', {
        path, reason: code ?? (error instanceof Error ? error.name : typeof error),
      });
    }
    return null
  }
}

/** Use the exact profile's credential for execution, excluding the invocation's ambient API token. */
export function readStoredCredentialsForServerId(serverId: string): Promise<StoredCredentials | null> {
  return readStoredProfileCredentials(serverId, 'invocation');
}

/** Inspect exact stored material for local custody, migration, or enrollment readback. */
export function readStoredCredentialCustodyForServerId(serverId: string): Promise<StoredCredentials | null> {
  return readStoredProfileCredentials(serverId, 'custody');
}

async function readStoredProfileCredentials(serverIdRaw: string, purpose: StoredCredentialReadPurpose): Promise<StoredCredentials | null> {
  const serverId = String(serverIdRaw ?? '').trim();
  if (!isServerIdFilesystemSafe(serverId)) return null;
  // A saved-Home selector cannot escape the child's authoritative custody or
  // turn its borrowed Account bearer into a present-person terminal sign-in.
  if (sessionProcessEnvironment().HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE !== undefined) {
    return await readStoredCredentials({ serverId });
  }
  const primaryPath = join(configuration.serversDir, serverId, 'access.key');
  return await readStoredProfileCredentialFile(serverId, primaryPath, purpose);
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

export class HistoricalEncryptionIdentityUnavailableError extends Error {
  readonly code = 'HISTORICAL_ENCRYPTION_IDENTITY_UNAVAILABLE' as const;
  constructor() {
    super('The retained encryption key cannot be associated with this Account. Existing credentials were preserved.');
    this.name = 'HistoricalEncryptionIdentityUnavailableError';
  }
}

/** Identity captured before enrollment registration can update the profile's last Account. */
export type TokenOnlyCredentialRefreshOptions = Readonly<{ previousAccountId?: string | null }>;

export async function prepareCredentialsTokenOnlyForServerId(
  serverIdRaw: string,
  credentials: Readonly<{ token: string }>,
  options: TokenOnlyCredentialRefreshOptions = {},
): Promise<StoredCredentials> {
  const serverId = String(serverIdRaw ?? '').trim();
  const token = String(credentials.token ?? '').trim();
  if (!isServerIdFilesystemSafe(serverId) || !token) throw new Error('Invalid server credential target.');
  const accountId = decodeJwtPayload(token)?.sub;
  const primaryPath = join(configuration.serversDir, serverId, 'access.key');
  const path = existsSync(primaryPath) ? primaryPath
    : serverId === 'cloud' && existsSync(configuration.legacyPrivateKeyFile) ? configuration.legacyPrivateKeyFile : null;
  if (!path) return { token, encryption: null };
  // A failed storage read must not silently erase the retained key.
  const raw = await readFile(path, 'utf8');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { token, encryption: null }; }
  const parsed = credentialsSchema.safeParse(value);
  if (!parsed.success) return { token, encryption: null };
  const previous = parsed.data;
  const retained = decodeStoredCredentials({ ...previous, token });
  if (!retained?.encryption) return { token, encryption: null };
  const encryption = retained.encryption;
  if (encryption.type === 'legacy') {
    if (encryption.secret.length !== 32) return { token, encryption: null };
  } else {
    if (encryption.machineKey.length !== 32 || encryption.publicKey.length !== 32) return { token, encryption: null };
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(encryption.machineKey).publicKey;
    if (!sameCredentialBytes(publicKey, encryption.publicKey)) return { token, encryption: null };
  }
  const previousAccountId = previous.token === undefined
    ? options.previousAccountId !== undefined ? options.previousAccountId
      : (await readSettings()).lastTokenSubByServerId?.[serverId]
    : decodeJwtPayload(previous.token)?.sub;
  if (typeof accountId !== 'string' || !accountId.trim()
    || typeof previousAccountId !== 'string' || !previousAccountId.trim()) {
    throw new HistoricalEncryptionIdentityUnavailableError();
  }
  if (previousAccountId.trim() !== accountId.trim()) return { token, encryption: null };
  // A keyless sign-in to the same Account keeps the keys for encrypted
  // history; they no longer pin this computer to E2EE mode.
  return { token, encryption, accountE2eeCustody: 'historical' };
}

export async function writeCredentialsTokenOnly(
  credentials: { token: string },
  options: TokenOnlyCredentialRefreshOptions = {},
): Promise<void> {
  await ensureHappyHomeDirExists();
  await writeCredentialsTokenOnlyForServerId(configuration.activeServerId, credentials, options);
  if (configuration.activeServerId === 'cloud' && configuration.legacyPrivateKeyFile !== configuration.privateKeyFile) {
    if (existsSync(configuration.legacyPrivateKeyFile)) {
      await unlink(configuration.legacyPrivateKeyFile).catch(() => {});
    }
  }
}

/** Refresh a profile bearer, preserving genuine same-Account historical key custody. */
export async function writeCredentialsTokenOnlyForServerId(
  serverIdRaw: string,
  credentials: Readonly<{ token: string }>,
  options: TokenOnlyCredentialRefreshOptions = {},
): Promise<void> {
  const serverId = String(serverIdRaw ?? '').trim();
  const persisted = encodeStoredCredentials(await prepareCredentialsTokenOnlyForServerId(serverId, credentials, options));
  const serverDir = join(configuration.serversDir, serverId);
  const credentialPath = join(serverDir, 'access.key');
  await mkdir(serverDir, { recursive: true });
  await bestEffortChmod(serverDir, 0o700);
  await writeFile(credentialPath, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  await bestEffortChmod(credentialPath, 0o600);
}

/** Writes an exact profile credential without changing the active Home. */
export async function writeStoredCredentialsForServerId(
  serverIdRaw: string,
  credentials: StoredCredentials,
): Promise<void> {
  const serverId = String(serverIdRaw ?? '').trim();
  const token = String(credentials.token ?? '').trim();
  if (!isServerIdFilesystemSafe(serverId) || !token) throw new Error('Invalid server credential target.');
  const serverDir = join(configuration.serversDir, serverId);
  const credentialPath = join(serverDir, 'access.key');
  const persisted = encodeStoredCredentials({ ...credentials, token });
  await mkdir(serverDir, { recursive: true });
  await bestEffortChmod(serverDir, 0o700);
  await writeFile(credentialPath, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  await bestEffortChmod(credentialPath, 0o600);
}

export async function removeStoredCredentialsForServerId(serverIdRaw: string): Promise<void> {
  const serverId = String(serverIdRaw ?? '').trim();
  if (!isServerIdFilesystemSafe(serverId)) throw new Error('Invalid server credential target.');
  await unlink(join(configuration.serversDir, serverId, 'access.key')).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
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

/** Device-local usage observations, independent of deliberate Home preferences. */
export type ServerProfileObservations = Readonly<Record<string, number>>;

function readServerProfileObservationsFile(): ServerProfileObservations | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(configuration.happyHomeDir, 'server-profile-observations.json'), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid server profile observations');
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, number] =>
      typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function readLegacyServerProfileObservations(): ServerProfileObservations {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configuration.settingsFile, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  if (!raw || typeof raw !== 'object' || !('servers' in raw)
    || !raw.servers || typeof raw.servers !== 'object') return {};
  return Object.fromEntries(Object.entries(raw.servers).flatMap(([id, profile]) => {
    if (!profile || typeof profile !== 'object' || !('lastUsedAt' in profile)) return [];
    const value = profile.lastUsedAt;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? [[id, value] as const] : [];
  }));
}

async function updateServerProfileObservations(
  updater: (current: ServerProfileObservations) => ServerProfileObservations,
): Promise<ServerProfileObservations> {
  await ensureHappyHomeDirExists();
  const path = join(configuration.happyHomeDir, 'server-profile-observations.json');
  // Same persistence owner and multiprocess admission contract as checkpoints.
  return withJsonOwnerFileLock({ lockPath: `${path}.lock`, timeoutMs: PERSISTENCE_LOCK_TIMEOUT_MS,
    staleAfterMs: PERSISTENCE_STALE_LOCK_TIMEOUT_MS, errorCode: 'server_profile_observations_lock_timeout' }, async () => {
    const stored = readServerProfileObservationsFile();
    const current = stored ?? readLegacyServerProfileObservations();
    const next = updater(current);
    // An empty file also completes the one-way predecessor import.
    if (!stored || !isDeepStrictEqual(current, next)) writeJsonAtomicSync(path, next);
    return next;
  });
}

export async function readServerProfileObservations(): Promise<ServerProfileObservations> {
  return readServerProfileObservationsFile() ?? updateServerProfileObservations(current => current);
}

async function ensureServerProfileObservationsImported(): Promise<void> {
  if (!existsSync(join(configuration.happyHomeDir, 'server-profile-observations.json'))) {
    await readServerProfileObservations();
  }
}

export async function writeServerProfileLastUsedAt(serverId: string, lastUsedAt: number): Promise<void> {
  await updateServerProfileObservations(current => ({ ...current, [serverId]: lastUsedAt }));
}

export async function clearServerProfileObservations(serverId: string): Promise<void> {
  await updateServerProfileObservations(current => {
    if (!Object.prototype.hasOwnProperty.call(current, serverId)) return current;
    const next = { ...current };
    delete next[serverId];
    return next;
  });
}

export type AccountChangesCursors = Readonly<Record<string, Readonly<Record<string, number>>>>;

function normalizeAccountChangesCursors(value: unknown): AccountChangesCursors {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([serverId, byAccount]) => {
    if (!byAccount || typeof byAccount !== 'object' || Array.isArray(byAccount)) return [];
    const entries = Object.entries(byAccount).filter((entry): entry is [string, number] =>
      typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0);
    return entries.length ? [[serverId, Object.fromEntries(entries)]] : [];
  }));
}

function readAccountChangesCursorsFile(): AccountChangesCursors | null {
  try {
    return normalizeAccountChangesCursors(JSON.parse(readFileSync(join(configuration.happyHomeDir, 'changes-cursors.json'), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function readLegacyAccountChangesCursors(): AccountChangesCursors {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configuration.settingsFile, 'utf8'));
  } catch (error) {
    // Match readSettings' existing malformed-JSON recovery. Unreadable settings
    // have no usable checkpoint to import and must remain repairable.
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const settings = raw as Record<string, unknown>;
  // 0.2 schema v5/v6 and the pre-v5 single-cloud cursor are import-only inputs.
  return normalizeAccountChangesCursors(settings.lastChangesCursorByServerIdByAccountId
    ?? { cloud: settings.lastChangesCursorByAccountId });
}

async function updateAccountChangesCursors(updater: (current: AccountChangesCursors) => AccountChangesCursors): Promise<AccountChangesCursors> {
  const observed = readAccountChangesCursorsFile();
  if (observed && updater(observed) === observed) return observed;
  await ensureHappyHomeDirExists();
  const path = join(configuration.happyHomeDir, 'changes-cursors.json');
  // Reuse the settings persistence owner's existing 5s lock admission / 10s stale
  // contract. CLI commands and session/daemon processes can update different scopes.
  return await withJsonOwnerFileLock({ lockPath: `${path}.lock`, timeoutMs: PERSISTENCE_LOCK_TIMEOUT_MS,
    staleAfterMs: PERSISTENCE_STALE_LOCK_TIMEOUT_MS, errorCode: 'changes_cursor_lock_timeout' }, async () => {
    const stored = readAccountChangesCursorsFile();
    const current = stored ?? readLegacyAccountChangesCursors();
    const next = updater(current);
    // Persist even an empty initial import: reset/logout must never re-import a
    // stale predecessor field. Subsequent equal acknowledgements do no writes.
    if (!stored || next !== current) writeJsonAtomicSync(path, next);
    return next;
  });
}

export async function readAccountChangesCursors(): Promise<AccountChangesCursors> {
  return readAccountChangesCursorsFile() ?? await updateAccountChangesCursors(current => current);
}

async function ensureAccountChangesCursorsImported(): Promise<void> {
  // The file's presence completes the one-way import. Settings publications must
  // not depend on reading established runtime progress (including a damaged file).
  if (!existsSync(join(configuration.happyHomeDir, 'changes-cursors.json'))) {
    await readAccountChangesCursors();
  }
}

export async function clearServerAccountChangesCursors(serverId: string): Promise<void> {
  const target = sanitizeServerIdForFilesystem(serverId, 'cloud');
  await updateAccountChangesCursors(current => {
    if (!Object.prototype.hasOwnProperty.call(current, target)) return current;
    const next = { ...current };
    delete next[target];
    return next;
  });
}

export async function copyServerAccountChangesCursors(sourceId: string, targetId: string): Promise<void> {
  await updateAccountChangesCursors(current => {
    if (Object.prototype.hasOwnProperty.call(current, targetId)
      || !Object.prototype.hasOwnProperty.call(current, sourceId)) return current;
    return { ...current, [targetId]: current[sourceId] };
  });
}

export async function readAccountChangesCursor(accountId: string): Promise<number> {
  if (!accountId) return 0;
  const byServer = await readAccountChangesCursors();
  const activeServerId = sanitizeServerIdForFilesystem(configuration.activeServerId, 'cloud');
  const cursor = byServer[activeServerId]?.[accountId];
  return typeof cursor === 'number' && Number.isFinite(cursor) && cursor >= 0 ? cursor : 0;
}

export async function writeAccountChangesCursor(accountId: string, cursor: number): Promise<void> {
  if (!accountId) return;
  if (!Number.isFinite(cursor) || cursor < 0) return;
  const next = Math.floor(cursor);

  await updateAccountChangesCursors((byServer) => {
    const activeServerId = sanitizeServerIdForFilesystem(configuration.activeServerId, 'cloud');
    const currentMap = Object.prototype.hasOwnProperty.call(byServer, activeServerId) ? byServer[activeServerId] : {};
    if (next === 0) {
      if (!Object.prototype.hasOwnProperty.call(currentMap, accountId)) return byServer;
      const copy = { ...currentMap };
      delete copy[accountId];
      const nextByServer = { ...byServer };
      if (Object.keys(copy).length) nextByServer[activeServerId] = copy;
      else delete nextByServer[activeServerId];
      return nextByServer;
    }

    if (currentMap[accountId] === next) return byServer;
    return { ...byServer, [activeServerId]: { ...currentMap, [accountId]: next } };
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

    const alive = candidates.filter((state) => isPidPresent(state.pid));

    if (candidates.length === 1) return alive[0] ?? null;

    // Prefer "alive" daemons when multiple stale files exist (we still fail closed if ambiguous).
    if (alive.length === 1) return alive[0];
    return null;
  } catch {
    return null;
  }
}

export async function readDaemonState(): Promise<DaemonLocallyPersistedState | null> {
  const candidatePaths = resolveDaemonStateCandidatePathsForCurrentLifecycle();
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
        // Legacy discovery stays read-only. An arbitrary CLI reader does not own the daemon
        // lifecycle lock and must not overwrite a successor's canonical publication.
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
      if (attempt === 3) {
        // Released daemons predate explicit lifecycle scope and may still be discoverable through
        // their endpoint profile. Explicitly scoped callers fail closed to their exact owner.
        return hasExplicitDaemonLifecycleScope()
          ? null
          : await readDaemonStateFallbackFromServersDir();
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
      continue;
    }
  }
  return null;
}

/**
 * Test/fixture-only unowned daemon-state publication.
 *
 * Production callers use writeDaemonStateForLockOwner so only the exact lifecycle-lock holder
 * can publish. Keeping this raw helper avoids duplicating fixture serialization across tests.
 */
export function writeDaemonState(state: DaemonLocallyPersistedState): void {
  writeJsonAtomicSync(configuration.daemonStateFile, state);
  cleanupLegacyDaemonStateFilesBestEffortSync();
}

/**
 * Test/fixture-only broad teardown for isolated temporary homes.
 */
export async function clearDaemonStateForTestTeardown(
  options: Readonly<{ includeLockFile?: boolean }> = {},
): Promise<void> {
  const includeLockFile = options.includeLockFile ?? true;
  if (existsSync(configuration.daemonStateFile)) {
    await unlink(configuration.daemonStateFile);
  }
  await cleanupAtomicWriteTempFiles(configuration.daemonStateFile);
  await cleanupLegacyDaemonStateFilesBestEffort();
  if (includeLockFile) await clearReplaceableDaemonLock();
}

/**
 * Acquire an exclusive lock file for the daemon.
 * The lock file proves the daemon is running and prevents multiple instances.
 * Returns the file handle to hold for the daemon's lifetime, or null if locked.
 */
const daemonLockRawByHandle = new WeakMap<FileHandle, string>();
/** The lock owner's own birth, captured with the lock and stamped on each state it publishes. */
const daemonProcessBirthByHandle = new WeakMap<FileHandle, ProcessBirthWitness>();

export type DaemonStateOwner = Readonly<
  Pick<DaemonLocallyPersistedState, 'pid' | 'httpPort' | 'startedAt' | 'controlToken'>
>;

function isCurrentDaemonLockHandleOwner(lockHandle: FileHandle): boolean {
  const ownRaw = daemonLockRawByHandle.get(lockHandle);
  if (!ownRaw) return false;
  const current = readDaemonLockSnapshot();
  return current?.raw === ownRaw
    && current.record?.pid === process.pid;
}

export function daemonStateMatchesOwner(
  state: DaemonLocallyPersistedState,
  expectedOwner: DaemonStateOwner,
): boolean {
  return state.pid === expectedOwner.pid
    && state.httpPort === expectedOwner.httpPort
    && state.startedAt === expectedOwner.startedAt
    && state.controlToken === expectedOwner.controlToken;
}

/**
 * Publish daemon state only while the caller still owns the exact structured lifecycle lock.
 *
 * The ownership check and atomic state rename are synchronous on one JS thread. A successor
 * therefore cannot acquire the released lock between the check and the publication.
 */
export function writeDaemonStateForLockOwner(
  lockHandle: FileHandle,
  state: DaemonLocallyPersistedState,
): boolean {
  if (state.pid !== process.pid || !isCurrentDaemonLockHandleOwner(lockHandle)) {
    return false;
  }
  const processBirth = daemonProcessBirthByHandle.get(lockHandle);
  writeDaemonState(processBirth ? { ...state, processBirth } : state);
  return true;
}

/**
 * The published daemon's process generation: the only peer a local Session host admits. Null when
 * no daemon is published or its publication carries no birth for its pid (unprovable: refused).
 */
export async function readPublishedDaemonProcessBirth(): Promise<ProcessBirthWitness | null> {
  const state = await readDaemonState();
  return state?.processBirth && state.processBirth.pid === state.pid ? state.processBirth : null;
}

/**
 * Remove only this process's state while it still owns the exact lifecycle lock.
 *
 * Self-restart predecessors have already released their lock, so they preserve the successor's
 * canonical state and all adjacent atomic/legacy publications.
 */
export function clearDaemonStateForLockOwner(
  lockHandle: FileHandle,
  expectedOwner: DaemonStateOwner,
): boolean {
  if (
    expectedOwner.pid !== process.pid
    || !isCurrentDaemonLockHandleOwner(lockHandle)
  ) {
    return false;
  }

  let current: DaemonLocallyPersistedState;
  try {
    const parsed = DaemonLocallyPersistedStateSchema.safeParse(
      JSON.parse(readFileSync(configuration.daemonStateFile, 'utf8')),
    );
    if (!parsed.success) return false;
    current = normalizeDaemonState(parsed.data);
  } catch {
    return false;
  }
  if (!daemonStateMatchesOwner(current, expectedOwner)) return false;

  try {
    unlinkSync(configuration.daemonStateFile);
  } catch {
    return false;
  }
  try {
    cleanupAtomicWriteTempFilesSync(configuration.daemonStateFile);
  } catch {
    // best-effort after exact lifecycle ownership was proven
  }
  try {
    cleanupLegacyDaemonStateFilesBestEffortSync();
  } catch {
    // best-effort after exact lifecycle ownership was proven
  }
  return true;
}

export type DaemonLockOwnerInspection =
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'starting'; pid: number; evidence: 'classified' | 'live-unclassified' }>
  | Readonly<{ status: 'replaceable'; pid: number | null; reason: 'dead' | 'unrelated' | 'invalid' }>;

export function readDaemonLockSnapshot(lockPath = configuration.daemonLockFile, strictRead = false): DaemonLockSnapshot | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    if (strictRead) throw error;
    return { raw: '', pid: null, record: null };
  }
  return parseDaemonLockSnapshot(raw);
}

export function readDaemonLockPid(): number | null {
  return readDaemonLockSnapshot()?.pid ?? null;
}

/**
 * Returns the structured lifecycle identity recorded by the active daemon lock.
 * Legacy PID-only locks deliberately do not satisfy identity-sensitive callers.
 */
export function readDaemonLockOwnerIdentity(): Readonly<{
  pid: number;
  processStartedAtMs: number;
  processInstanceFingerprint?: string;
}> | null {
  const record = readDaemonLockSnapshot()?.record;
  return record
    ? {
        pid: record.pid,
        processStartedAtMs: record.processStartedAtMs,
        ...(record.processInstanceFingerprint
          ? { processInstanceFingerprint: record.processInstanceFingerprint }
          : {}),
      }
    : null;
}

async function inspectDaemonLockSnapshotOwner(snapshot: DaemonLockSnapshot, options: Readonly<{ unobservablePidIsUnverified?: boolean }> = {}): Promise<DaemonLockOwnerInspection> {
  const pid = snapshot.pid;
  if (!pid) return { status: 'replaceable', pid: null, reason: 'invalid' };

  const liveness = probeProcessLiveness(pid);
  if (liveness === 'absent') {
    if (options.unobservablePidIsUnverified) return { status: 'starting', pid, evidence: 'live-unclassified' };
    return { status: 'replaceable', pid, reason: 'dead' };
  }
  if (liveness === 'access_denied') return { status: 'starting', pid, evidence: 'live-unclassified' };

  const currentIdentity = snapshot.record
    ? await (await import('@/daemon/processIdentity')).readProcessIdentityByPid(pid)
    : null;
  if (snapshot.record && currentIdentity
    && processGenerationProvesReuse(
      snapshot.record.processStartedAtMs,
      currentIdentity.processStartTimeMs,
    )) {
    return { status: 'replaceable', pid, reason: 'unrelated' };
  }

  const { classifyDaemonLifecycleProcessByPid } = await import('@/daemon/processInspection');
  const ownerProcess = await classifyDaemonLifecycleProcessByPid(pid)
    .catch(() => ({ kind: 'unknown' as const }));
  if (ownerProcess.kind === 'daemon') {
    return { status: 'starting', pid, evidence: 'classified' };
  }
  if (ownerProcess.kind === 'not_daemon') {
    return { status: 'replaceable', pid, reason: 'unrelated' };
  }
  const runState = await readProcessRunState(pid);
  if (runState === 'dead' || runState === 'zombie') {
    return { status: 'replaceable', pid, reason: 'dead' };
  }
  return { status: 'starting', pid, evidence: 'live-unclassified' };
}

export async function inspectDaemonLockOwner(lockPath = configuration.daemonLockFile, options: Readonly<{ unobservablePidIsUnverified?: boolean }> = {}): Promise<DaemonLockOwnerInspection> {
  const snapshot = readDaemonLockSnapshot(lockPath);
  return snapshot ? await inspectDaemonLockSnapshotOwner(snapshot, options) : { status: 'missing' };
}

export async function clearReplaceableDaemonLock(): Promise<void> {
  const snapshot = readDaemonLockSnapshot();
  if (!snapshot) return;
  const owner = await inspectDaemonLockSnapshotOwner(snapshot);
  if (owner.status === 'replaceable') {
    await reclaimJsonOwnerFileLockSnapshot(configuration.daemonLockFile, snapshot.raw);
  }
}

/** Reclaim only a proven-dead publication whose observed state and lifecycle lock are unchanged. */
export async function reclaimDeadDaemonPublication(options: Readonly<{
  stateFile?: string;
  expectedState?: Readonly<{ pid: number; httpPort: number; startedAt?: number; controlToken?: string }> | null;
  expectedPid?: number;
  expectedLockRaw?: string | null;
}> = {}): Promise<boolean> {
  const stateFile = options.stateFile ?? configuration.daemonStateFile;
  const lockFile = `${stateFile}.lock`;
  const readOptional = (path: string): string | null => {
    try { return readFileSync(path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  try {
    const lockRaw = options.expectedLockRaw === undefined ? readOptional(lockFile) : options.expectedLockRaw;
    const expected = options.expectedState ?? null;
    const lockPid = lockRaw === null ? null : parseDaemonLockSnapshot(lockRaw).pid;
    const pid = expected?.pid ?? lockPid;
    if (options.expectedPid !== undefined && pid !== options.expectedPid) return false;
    if (!pid || !Number.isSafeInteger(pid) || pid <= 0 || !isPidProvablyAbsent(pid)) return false;
    if (lockRaw !== null && lockPid !== pid) return false;
    if (readOptional(lockFile) !== lockRaw) return false;
    const stateRaw = readOptional(stateFile);
    if (stateRaw !== null) {
      const parsed = DaemonLocallyPersistedStateSchema.safeParse(JSON.parse(stateRaw));
      if (!parsed.success || !expected) return false;
      const current = normalizeDaemonState(parsed.data);
      if (!daemonStateMatchesOwner(current, { ...expected, startedAt: expected.startedAt ?? current.startedAt })) return false;
      const reclaimed = await reclaimJsonOwnerFileLockSnapshot(stateFile, stateRaw, async (quarantinePath) => {
        const raw = await readFile(quarantinePath, 'utf8');
        if (!isPidProvablyAbsent(pid) || readOptional(lockFile) !== lockRaw) throw new Error('Daemon owner changed during cleanup');
        return raw;
      });
      if (reclaimed !== 'reclaimed') return false;
    }
    if (lockRaw === null) return true;
    return await reclaimJsonOwnerFileLockSnapshot(lockFile, lockRaw, async (quarantinePath) => {
      const raw = await readFile(quarantinePath, 'utf8');
      if (!isPidProvablyAbsent(pid) || readOptional(stateFile) !== null) throw new Error('Daemon publication changed during cleanup');
      return raw;
    }) === 'reclaimed';
  } catch {
    return false;
  }
}

export async function acquireDaemonLock(
  maxAttempts: number = 5,
  delayIncrementMs: number = 200
): Promise<FileHandle | null> {
  await import('@/daemon/doctor');
  await mkdir(dirname(configuration.daemonLockFile), { recursive: true });
  const { readProcessIdentityByPid } = await import('@/daemon/processIdentity');
  const currentProcessIdentity = await readProcessIdentityByPid(process.pid);
  const currentProcessStartedAtMs = currentProcessIdentity?.processStartTimeMs;
  // The same census row's native start is this process's birth witness (see ProcessBirthWitness).
  const processBirth: ProcessBirthWitness | null = currentProcessIdentity?.censusRow?.pid === process.pid
    ? { pid: process.pid, start: currentProcessIdentity.censusRow.start } : null;
  if (!Number.isSafeInteger(currentProcessStartedAtMs) || currentProcessStartedAtMs === undefined || currentProcessStartedAtMs < 0) {
    throw new Error('Current daemon process generation is unavailable');
  }
  const processInstanceFingerprint = readProcessInstanceFingerprintSync(process.pid);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const raw = JSON.stringify({
      t: 'happier_daemon_lock_v2',
      pid: process.pid,
      ownerToken: randomUUID(),
      processStartedAtMs: currentProcessStartedAtMs,
      ...(processInstanceFingerprint ? { processInstanceFingerprint } : {}),
      createdAtMs: Date.now(),
    } satisfies DaemonLockRecord);
    try {
      // Prefer the string flag form for Windows Bun-compiled binaries, which mis-handle numeric O_EXCL flags.
      const fileHandle = await open(
        configuration.daemonLockFile,
        process.platform === 'win32' ? 'wx+' : 'wx',
        0o600
      );
      let writeCompleted = false;
      try {
        await fileHandle.writeFile(raw);
        writeCompleted = true;
        await fileHandle.sync();
      } catch (error) {
        await fileHandle.close().catch(() => undefined);
        if (writeCompleted) {
          await reclaimJsonOwnerFileLockSnapshot(configuration.daemonLockFile, raw).catch(() => undefined);
        }
        throw error;
      }
      daemonLockRawByHandle.set(fileHandle, raw);
      if (processBirth) daemonProcessBirthByHandle.set(fileHandle, processBirth);
      return fileHandle;
    } catch (error: any) {
      if (error.code === 'EEXIST') {
        try {
          const snapshot = readDaemonLockSnapshot();
          const owner = snapshot
            ? await inspectDaemonLockSnapshotOwner(snapshot)
            : { status: 'missing' as const };
          if (owner.status === 'replaceable') {
            if (snapshot) {
              const reclaim = await reclaimJsonOwnerFileLockSnapshot(
                configuration.daemonLockFile,
                snapshot.raw,
              );
              if (reclaim === 'ownership_unknown') return null;
            }
            continue;
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
  const ownRaw = daemonLockRawByHandle.get(lockHandle);
  try {
    await lockHandle.close();
  } catch { }

  if (!ownRaw) return;
  daemonLockRawByHandle.delete(lockHandle);
  await reclaimJsonOwnerFileLockSnapshot(configuration.daemonLockFile, ownRaw).catch(() => undefined);
}
