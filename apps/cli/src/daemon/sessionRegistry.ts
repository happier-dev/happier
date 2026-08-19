import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import { CATALOG_AGENT_IDS } from '@/backends/types';
import {
  buildSessionRunnerRespawnDescriptorV1FromSpawnOptions,
  SessionRunnerRespawnDescriptorV1Schema,
  type RespawnDescriptorEncryptionMaterial,
} from './processSupervision/sessionRunnerRespawnDescriptor';
import { resolveReleaseRingScopedBasename } from '@/cli/runtime/publicReleaseChannel';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { TerminalHostHealthState } from './types';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';

const DaemonSessionMarkerSchema = z.object({
  pid: z.number().int().positive(),
  happySessionId: z.string(),
  happyHomeDir: z.string(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  flavor: z.enum(CATALOG_AGENT_IDS).optional(),
  startedBy: z.enum(['daemon', 'terminal']).optional(),
  cwd: z.string().optional(),
  // Process identity safety (PID reuse mitigation). Hash of the observed process command line.
  processCommandHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  processInstanceFingerprint: z.string().trim().min(1).max(512).optional(),
  // Optional debug-only sample of the observed command (best-effort; may be truncated by ps-list).
  processCommand: z.string().optional(),
  metadata: z.any().optional(),
  // Safe daemon respawn inputs (no secrets). Used to reconstruct SpawnSessionOptions after reattach.
  respawn: SessionRunnerRespawnDescriptorV1Schema.optional(),
  // Durable marker that a connected-service auth switch has entered the gated restart primitive.
  connectedServiceRestartIntent: z.object({
    v: z.literal(1),
    requestedAtMs: z.number().int().nonnegative(),
  }).optional(),
  terminalHostHealth: z.object({
    status: z.literal('host_dead'),
    sessionId: z.string().trim().min(1),
    runnerPid: z.number().int().positive(),
    hostKind: z.string().trim().min(1),
    zellijSessionName: z.string().trim().min(1).optional(),
    observedAt: z.number().int().nonnegative(),
    reason: z.string().trim().min(1),
  }).optional(),
  activeTurnId: z.string().trim().min(1).max(512).optional(),
});

export type DaemonSessionMarker = z.infer<typeof DaemonSessionMarkerSchema>;

export function hashProcessCommand(command: string): string {
  return createHash('sha256').update(command).digest('hex');
}

function currentDaemonSessionsDir(): string {
  return join(configuration.happyHomeDir, 'tmp', resolveReleaseRingScopedBasename('daemon-sessions', configuration.publicReleaseRing));
}


function legacyDaemonSessionsDir(): string | null {
  return configuration.publicReleaseRing === 'stable' ? null : join(configuration.happyHomeDir, 'tmp', 'daemon-sessions');
}

function markerReadDirs(): string[] {
  const currentDir = currentDaemonSessionsDir();
  const legacyDir = legacyDaemonSessionsDir();
  return legacyDir ? [currentDir, legacyDir] : [currentDir];
}

function markerPathsForPid(pid: number): string[] {
  return markerReadDirs().map((dir) => join(dir, `pid-${pid}.json`));
}

const sessionMarkerMutationLocks = new Map<number, Promise<void>>();
const SESSION_MARKER_LOCK_TIMEOUT_MS = 5_000;
const SESSION_MARKER_LOCK_STALE_MS = 30_000;

async function runWithSessionMarkerMutationLock<T>(pid: number, task: () => Promise<T>): Promise<T> {
  const previous = sessionMarkerMutationLocks.get(pid) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  sessionMarkerMutationLocks.set(pid, next);
  await previous.catch(() => undefined);
  try {
    return await withJsonOwnerFileLock({
      lockPath: join(currentDaemonSessionsDir(), `pid-${pid}.json.lock`),
      timeoutMs: SESSION_MARKER_LOCK_TIMEOUT_MS,
      staleAfterMs: SESSION_MARKER_LOCK_STALE_MS,
      errorCode: 'SESSION_MARKER_MUTATION_LOCK_TIMEOUT',
    }, task);
  } finally {
    release();
    if (sessionMarkerMutationLocks.get(pid) === next) {
      sessionMarkerMutationLocks.delete(pid);
    }
  }
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export type WriteSessionMarkerOptions = Readonly<{
  preserveConnectedServiceRestartIntent?: boolean;
  preserveTerminalHostHealth?: boolean;
}>;

/**
 * A replay seed is the user's prior conversation in cleartext. The marker mirrors the
 * session metadata reported at startup and then carries that snapshot verbatim for the
 * whole process lifetime, so mirroring the seed would leave the plaintext of an e2ee
 * Session in a temp file long after the provider consumed it — and long after the
 * Session-metadata owner retired its own copy.
 *
 * No marker reader consumes the seed: readers take `flavor`, terminal state, resume
 * bindings and connected-service snapshots. Retirement itself belongs to the seed's
 * canonical owner in `agent/runtime/replaySeed/replaySeedV1.ts`, and this blanks the
 * mirror the same way that owner does — `seedText: ''`, identity fields intact —
 * rather than dropping `replaySeedV1` or the marker file.
 */
function withoutMirroredReplaySeedText(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata;
  const seed = (metadata as { replaySeedV1?: unknown }).replaySeedV1;
  if (!seed || typeof seed !== 'object' || Array.isArray(seed)) return metadata;
  const seedText = (seed as { seedText?: unknown }).seedText;
  if (typeof seedText !== 'string' || seedText.length === 0) return metadata;
  return {
    ...(metadata as Record<string, unknown>),
    replaySeedV1: { ...(seed as Record<string, unknown>), seedText: '' },
  };
}

async function writeSessionMarkerUnlocked(
  marker: Omit<DaemonSessionMarker, 'createdAt' | 'updatedAt' | 'happyHomeDir'> & { createdAt?: number; updatedAt?: number },
  options: WriteSessionMarkerOptions = {},
): Promise<void> {
  const currentDir = currentDaemonSessionsDir();
  await ensureDir(currentDir);
  const now = Date.now();
  const filePath = join(currentDir, `pid-${marker.pid}.json`);

  let createdAtFromDisk: number | undefined;
  let existingMarkerFromDisk: DaemonSessionMarker | null = null;
  for (const candidatePath of markerPathsForPid(marker.pid)) {
    try {
      const raw = await readFile(candidatePath, 'utf-8');
      const existing = DaemonSessionMarkerSchema.safeParse(JSON.parse(raw));
      if (existing.success) {
        existingMarkerFromDisk = existing.data;
        createdAtFromDisk = existing.data.createdAt;
        break;
      }
    } catch (e) {
      // ignore ENOENT (new marker); log other errors for diagnostics
      const err = e as NodeJS.ErrnoException;
      if (err?.code !== 'ENOENT') {
        logger.debug(`[sessionRegistry] Could not read existing session marker pid-${marker.pid}.json to preserve createdAt`, e);
      }
    }
  }

  const preservedConnectedServiceRestartIntent =
    options.preserveConnectedServiceRestartIntent === true
    && marker.connectedServiceRestartIntent === undefined
    && existingMarkerFromDisk?.happySessionId === marker.happySessionId
      ? existingMarkerFromDisk.connectedServiceRestartIntent
      : undefined;
  const preservedTerminalHostHealth =
    options.preserveTerminalHostHealth !== false
    && marker.terminalHostHealth === undefined
    && existingMarkerFromDisk?.happySessionId === marker.happySessionId
      ? existingMarkerFromDisk.terminalHostHealth
      : undefined;
  const payload: DaemonSessionMarker = DaemonSessionMarkerSchema.parse({
    ...marker,
    ...(preservedConnectedServiceRestartIntent
      ? { connectedServiceRestartIntent: preservedConnectedServiceRestartIntent }
      : {}),
    ...(preservedTerminalHostHealth ? { terminalHostHealth: preservedTerminalHostHealth } : {}),
    ...(marker.metadata === undefined
      ? {}
      : { metadata: withoutMirroredReplaySeedText(marker.metadata) }),
    happyHomeDir: configuration.happyHomeDir,
    createdAt: marker.createdAt ?? createdAtFromDisk ?? now,
    updatedAt: now,
  });
  await writeJsonAtomic(filePath, payload);
}

export async function writeSessionMarker(
  marker: Omit<DaemonSessionMarker, 'createdAt' | 'updatedAt' | 'happyHomeDir'> & { createdAt?: number; updatedAt?: number },
  options: WriteSessionMarkerOptions = {},
): Promise<void> {
  await runWithSessionMarkerMutationLock(marker.pid, () => writeSessionMarkerUnlocked(marker, options));
}

export async function updateSessionMarkerActiveTurn(params: Readonly<{
  pid: number;
  sessionId: string;
  activeTurnId: string | null;
}>): Promise<boolean> {
  return await runWithSessionMarkerMutationLock(params.pid, async () => {
    const existing = await readSessionMarkerForPid(params.pid);
    if (!existing || existing.happySessionId !== params.sessionId) return false;

    const {
      activeTurnId: _activeTurnId,
      happyHomeDir: _happyHomeDir,
      updatedAt: _updatedAt,
      ...rest
    } = existing;
    await writeSessionMarkerUnlocked({
      ...rest,
      ...(params.activeTurnId ? { activeTurnId: params.activeTurnId } : {}),
    });
    return true;
  });
}

/**
 * Rewrite an existing marker's respawn descriptor from updated spawn options,
 * preserving all other marker fields (identity, metadata, process hash).
 *
 * Needed after in-place session mutations that do NOT respawn the runner —
 * e.g. a hot-applied connected-service auth switch updates the tracked
 * session's bindings in memory only; without refreshing the durable marker a
 * daemon restart restores the spawn-time bindings and treats real switch
 * requests as 'unchanged' while the runtime auth has actually moved on.
 *
 * No-op when no marker exists for the pid (nothing to refresh).
 */
export async function refreshSessionMarkerRespawn(params: Readonly<{
  pid: number;
  spawnOptions: SpawnSessionOptions;
  encryptionMaterial?: RespawnDescriptorEncryptionMaterial;
}>): Promise<void> {
  await runWithSessionMarkerMutationLock(params.pid, async () => {
    let existing: DaemonSessionMarker | null = null;
    for (const candidatePath of markerPathsForPid(params.pid)) {
      try {
        const raw = await readFile(candidatePath, 'utf-8');
        const parsed = DaemonSessionMarkerSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          existing = parsed.data;
          break;
        }
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err?.code !== 'ENOENT') {
          logger.debug(`[sessionRegistry] Could not read session marker pid-${params.pid}.json for respawn refresh`, e);
        }
      }
    }
    if (!existing) return;

    const respawn = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(
      params.spawnOptions,
      params.encryptionMaterial ? { encryptionMaterial: params.encryptionMaterial } : undefined,
    );
    if (!respawn) return;

    const { happyHomeDir: _happyHomeDir, updatedAt: _updatedAt, ...rest } = existing;
    await writeSessionMarkerUnlocked({
      ...rest,
      respawn,
    });
  });
}

export async function publishSessionMarkerTerminalHostHealth(params: Readonly<{
  pid: number;
  health: TerminalHostHealthState;
}>): Promise<boolean> {
  return await runWithSessionMarkerMutationLock(params.pid, async () => {
    const existing = await readSessionMarkerForPid(params.pid);
    if (!existing) return false;
    if (existing.happySessionId !== params.health.sessionId) return false;

    const { happyHomeDir: _happyHomeDir, updatedAt: _updatedAt, ...rest } = existing;
    await writeSessionMarkerUnlocked({
      ...rest,
      terminalHostHealth: params.health,
    });
    return true;
  });
}

export async function clearSessionMarkerTerminalHostHealth(params: Readonly<{
  pid: number;
  sessionId: string;
}>): Promise<boolean> {
  return await runWithSessionMarkerMutationLock(params.pid, async () => {
    const existing = await readSessionMarkerForPid(params.pid);
    if (!existing || existing.happySessionId !== params.sessionId) return false;

    const {
      happyHomeDir: _happyHomeDir,
      updatedAt: _updatedAt,
      terminalHostHealth: _terminalHostHealth,
      ...rest
    } = existing;
    await writeSessionMarkerUnlocked(rest, { preserveTerminalHostHealth: false });
    return true;
  });
}

export async function readSessionMarkerForPid(pid: number): Promise<DaemonSessionMarker | null> {
  for (const candidatePath of markerPathsForPid(pid)) {
    try {
      const raw = await readFile(candidatePath, 'utf-8');
      const parsed = DaemonSessionMarkerSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code !== 'ENOENT') {
        logger.debug(`[sessionRegistry] Could not read session marker pid-${pid}.json`, e);
      }
    }
  }
  return null;
}

function normalizeSessionId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function markSessionMarkerConnectedServiceRestartIntent(params: Readonly<{
  pid: number;
  requestedAtMs?: number;
}>): Promise<boolean> {
  return await runWithSessionMarkerMutationLock(params.pid, async () => {
    const existing = await readSessionMarkerForPid(params.pid);
    if (!existing) return false;

    const requestedAtMs = typeof params.requestedAtMs === 'number' && Number.isFinite(params.requestedAtMs)
      ? Math.max(0, Math.trunc(params.requestedAtMs))
      : Date.now();
    const { happyHomeDir: _happyHomeDir, updatedAt: _updatedAt, ...rest } = existing;
    await writeSessionMarkerUnlocked({
      ...rest,
      connectedServiceRestartIntent: {
        v: 1,
        requestedAtMs,
      },
    });
    return true;
  });
}

export async function clearSessionMarkerConnectedServiceRestartIntent(pid: number): Promise<void> {
  await runWithSessionMarkerMutationLock(pid, async () => {
    const existing = await readSessionMarkerForPid(pid);
    if (!existing?.connectedServiceRestartIntent) return;

    const {
      happyHomeDir: _happyHomeDir,
      updatedAt: _updatedAt,
      connectedServiceRestartIntent: _connectedServiceRestartIntent,
      ...rest
    } = existing;
    await writeSessionMarkerUnlocked(rest);
  });
}

export async function promoteSessionMarkerConnectedServiceRestartIntent(params: Readonly<{
  fromPid: number;
  toPid: number;
}>): Promise<boolean> {
  const lockPids = Array.from(new Set([params.fromPid, params.toPid])).sort((left, right) => left - right);
  const [firstPid, secondPid] = lockPids;
  return await runWithSessionMarkerMutationLock(firstPid!, async () => {
    if (secondPid === undefined || secondPid === firstPid) {
      return await promoteSessionMarkerConnectedServiceRestartIntentUnlocked(params);
    }
    return await runWithSessionMarkerMutationLock(secondPid, async () => (
      await promoteSessionMarkerConnectedServiceRestartIntentUnlocked(params)
    ));
  });
}

async function promoteSessionMarkerConnectedServiceRestartIntentUnlocked(params: Readonly<{
  fromPid: number;
  toPid: number;
}>): Promise<boolean> {
  const fromMarker = await readSessionMarkerForPid(params.fromPid);
  const toMarker = await readSessionMarkerForPid(params.toPid);
  const restartIntent = fromMarker?.connectedServiceRestartIntent;
  if (!fromMarker || !toMarker || !restartIntent) return false;
  if (!normalizeSessionId(fromMarker.happySessionId) || normalizeSessionId(fromMarker.happySessionId) !== normalizeSessionId(toMarker.happySessionId)) {
    return false;
  }

  const { happyHomeDir: _happyHomeDir, updatedAt: _updatedAt, ...rest } = toMarker;
  await writeSessionMarkerUnlocked({
    ...rest,
    connectedServiceRestartIntent: restartIntent,
  });
  return true;
}

async function removeSessionMarkerUnlocked(pid: number): Promise<void> {
  for (const filePath of markerPathsForPid(pid)) {
    try {
      await unlink(filePath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code !== 'ENOENT') {
        logger.debug(`[sessionRegistry] Failed to remove session marker pid-${pid}.json`, e);
      }
    }
  }
}

export async function removeSessionMarker(pid: number): Promise<void> {
  await runWithSessionMarkerMutationLock(pid, async () => {
    await removeSessionMarkerUnlocked(pid);
  });
}

export async function listSessionMarkers(): Promise<DaemonSessionMarker[]> {
  const markersByPid = new Map<number, DaemonSessionMarker>();

  for (const dir of markerReadDirs()) {
    await ensureDir(dir);
    const entries = await readdir(dir);
    for (const name of entries) {
      if (!name.startsWith('pid-') || !name.endsWith('.json')) continue;
      const full = join(dir, name);
      try {
        const raw = await readFile(full, 'utf-8');
        const parsed = DaemonSessionMarkerSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) {
          logger.debug(`[sessionRegistry] Failed to parse session marker ${name}`, parsed.error);
          continue;
        }
        // Extra safety: only accept markers for our home dir.
        if (parsed.data.happyHomeDir !== configuration.happyHomeDir) continue;
        if (!markersByPid.has(parsed.data.pid)) {
          markersByPid.set(parsed.data.pid, parsed.data);
        }
      } catch (e) {
        logger.debug(`[sessionRegistry] Failed to read or parse session marker ${name}`, e);
        // ignore unreadable marker
      }
    }
  }

  return Array.from(markersByPid.values());
}
