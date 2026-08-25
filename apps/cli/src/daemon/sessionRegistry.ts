import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as z from 'zod';
import { CATALOG_AGENT_IDS } from '@/agent/catalog/ids';
import {
  SessionRunnerRespawnDescriptorV1Schema,
  writeSessionRunnerRespawnDescriptorForPersistence,
} from './processSupervision/sessionRunnerRespawnDescriptor';
import { resolveReleaseRingScopedBasename } from '@/cli/runtime/publicReleaseChannel';
import { readProcessIdentityByPid } from './processIdentity';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import {
  AgentSessionStartupInstructionsMarkerV1Schema,
  type AgentSessionStartupInstructionsMarkerV1,
} from '@happier-dev/protocol';
import {
  AgentRuntimeDaemonServiceSessionOpenAttestationV1Schema,
  type AgentRuntimeDaemonServiceSessionOpenAttestationV1,
} from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import {
  areRunnerManagedProviderRetainedAuthoritiesEqual,
  mergeRunnerManagedDependencyRetentionV1,
  RunnerManagedDependencyRetentionV1Schema,
  type RunnerManagedDependencyRetentionV1,
  RunnerManagedProviderRetainedAuthorityV1Schema,
  type RunnerManagedProviderRetainedAuthorityV1,
  withRunnerManagedProviderAuthorityRetention,
} from '@/plugins/runtime/runner/runnerManagedDependencyRetention';

const DaemonSessionMarkerSchema = z.object({
  pid: z.number().int().positive(),
  happySessionId: z.string(),
  happyHomeDir: z.string(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  flavor: z.enum(CATALOG_AGENT_IDS).optional(),
  startedBy: z.enum(['daemon', 'terminal']).optional(),
  cwd: z.string().optional(),
  // Legacy positive-classification witness and diagnostic snapshot. Mutable command text is not process generation.
  processCommandHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  // Canonical OS process-generation witness paired with the PID.
  processStartTimeMs: z.number().int().nonnegative().optional(),
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
  // Stable private authority-document path only. The scoped capability is
  // atomically rotated inside that document and must never enter the marker.
  agentRuntimeDaemonServiceAuthorityFilePath:
    z.string().trim().min(1).max(32_768).optional(),
  activeTurnId: z.string().trim().min(1).max(512).optional(),
  agentRuntimeDaemonServiceActiveAdmission: z.object({
    turnId: z.string().trim().min(1).max(512),
    inputId: z.string().trim().min(1).max(512),
    userMessageSeq: z.number().int().nonnegative().nullable(),
    userMessageSeqs:
      z.array(z.number().int().nonnegative()).max(4_096),
  }).strict().optional(),
  agentRuntimeDaemonServiceSessionOpenAttestation:
    AgentRuntimeDaemonServiceSessionOpenAttestationV1Schema.optional(),
  // Non-secret byte-retention facts for the exact live runner. Destructive
  // managed-dependency owners revalidate the marker's process identity before
  // consulting these pins; effect authority remains in the private document.
  runnerAgentImmutableGenerationId:
    z.string().trim().min(1).max(512).optional(),
  runnerManagedDependencyRetentionV1:
    RunnerManagedDependencyRetentionV1Schema.optional(),
  // Required startup identity persisted before runtime open; not proof of application.
  agentSessionStartupInstructionsMarkerV1:
    AgentSessionStartupInstructionsMarkerV1Schema.optional(),
}).superRefine((marker, context) => {
  if (
    marker.agentRuntimeDaemonServiceActiveAdmission
    && marker.agentRuntimeDaemonServiceActiveAdmission.turnId
      !== marker.activeTurnId
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['agentRuntimeDaemonServiceActiveAdmission', 'turnId'],
      message:
        'Runner Agent daemon-service admission must match the active turn',
    });
  }
});

export type DaemonSessionMarker = z.infer<typeof DaemonSessionMarkerSchema>;
type AgentRuntimeDaemonServiceActiveAdmission = Readonly<{
  turnId: string;
  inputId: string;
  userMessageSeq: number | null;
  userMessageSeqs: readonly number[];
}>;

function agentRuntimeDaemonServiceActiveAdmissionsEqual(
  left: AgentRuntimeDaemonServiceActiveAdmission | undefined,
  right: AgentRuntimeDaemonServiceActiveAdmission,
): boolean {
  return Boolean(
    left
    && left.turnId === right.turnId
    && left.inputId === right.inputId
    && left.userMessageSeq === right.userMessageSeq
    && left.userMessageSeqs.length === right.userMessageSeqs.length
    && left.userMessageSeqs.every(
      (sequence, index) => sequence === right.userMessageSeqs[index],
    ),
  );
}

type SessionMarkerWriteInput = Omit<
  DaemonSessionMarker,
  'createdAt' | 'updatedAt' | 'happyHomeDir'
> & Readonly<{
  createdAt?: number;
  updatedAt?: number;
}>;

export function hashProcessCommand(command: string): string {
  return createHash('sha256').update(command).digest('hex');
}

function daemonSessionsDir(): string {
  return join(
    configuration.happyHomeDir,
    'tmp',
    resolveReleaseRingScopedBasename('daemon-sessions', configuration.publicReleaseRing),
  );
}

function daemonSessionMarkerDirs(): string[] {
  const primaryDir = daemonSessionsDir();
  const legacyPreviewDir = join(configuration.happyHomeDir, 'tmp', 'daemon-sessions.preview');
  return primaryDir === legacyPreviewDir ? [primaryDir] : [primaryDir, legacyPreviewDir];
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
      lockPath: join(daemonSessionsDir(), `pid-${pid}.json.lock`),
      timeoutMs: SESSION_MARKER_LOCK_TIMEOUT_MS,
      staleAfterMs: SESSION_MARKER_LOCK_STALE_MS,
      errorCode: 'SESSION_MARKER_MUTATION_LOCK_TIMEOUT',
      readProcessStartedAtMs: async (ownerPid) =>
        (await readProcessIdentityByPid(ownerPid))?.processStartTimeMs ?? null,
    }, task);
  } finally {
    release();
    if (sessionMarkerMutationLocks.get(pid) === next) {
      sessionMarkerMutationLocks.delete(pid);
    }
  }
}

async function runWithSessionMarkerMutationLocks<T>(
  pids: readonly number[],
  task: () => Promise<T>,
): Promise<T> {
  const orderedPids = Array.from(new Set(pids)).sort((left, right) => left - right);
  const acquire = async (index: number): Promise<T> => {
    const pid = orderedPids[index];
    if (pid === undefined) {
      return await task();
    }
    return await runWithSessionMarkerMutationLock(pid, () => acquire(index + 1));
  };
  return await acquire(0);
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
    try {
      await rename(tmpPath, filePath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      // On Windows, rename may fail if destination exists.
      if (err?.code === 'EEXIST' || err?.code === 'EPERM') {
        try {
          await unlink(filePath);
        } catch {
          // ignore unlink failure (e.g. ENOENT)
        }
        await rename(tmpPath, filePath);
        return;
      }
      throw e;
    }
  } catch (e) {
    // Best-effort cleanup to avoid leaving behind orphaned temp files on failure.
    try {
      await unlink(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw e;
  }
}

export type WriteSessionMarkerOptions = Readonly<{
  preserveConnectedServiceRestartIntent?: boolean;
  preserveActiveTurnId?: boolean;
  preserveRunnerAgentImmutableGenerationId?: boolean;
  preserveRunnerManagedDependencyRetention?: boolean;
  adoptCanonicalSessionIdFromPidPlaceholder?: boolean;
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

function isPidPlaceholderSessionId(value: string): boolean {
  return /^PID-\d+$/u.test(value);
}

function sessionMarkerProcessOwnershipMatches(
  marker: Pick<DaemonSessionMarker, 'happySessionId' | 'processCommandHash' | 'processStartTimeMs'>,
  expected: Readonly<{
    happySessionId: string;
    processCommandHash: string;
    processStartTimeMs: number;
  }>,
): boolean {
  return marker.happySessionId === expected.happySessionId
    && marker.processCommandHash === expected.processCommandHash
    && marker.processStartTimeMs === expected.processStartTimeMs;
}

function sessionMarkerProcessIdentityMatches(
  marker: Pick<DaemonSessionMarker, 'processCommandHash' | 'processStartTimeMs'>,
  expected: Readonly<{
    processCommandHash: string;
    processStartTimeMs: number;
  }>,
): boolean {
  return marker.processCommandHash === expected.processCommandHash
    && marker.processStartTimeMs === expected.processStartTimeMs;
}

function agentSessionStartupInstructionsMarkersEqual(
  left: AgentSessionStartupInstructionsMarkerV1 | undefined | null,
  right: AgentSessionStartupInstructionsMarkerV1 | undefined | null,
): boolean {
  if (!left || !right) return !left && !right;
  return left.v === right.v
    && left.id === right.id
    && left.revision === right.revision;
}

async function writeSessionMarkerUnlocked(
  marker: SessionMarkerWriteInput,
  options: WriteSessionMarkerOptions = {},
): Promise<void> {
  await ensureDir(daemonSessionsDir());
  const now = Date.now();
  const filePath = join(daemonSessionsDir(), `pid-${marker.pid}.json`);

  let createdAtFromDisk: number | undefined;
  let existingMarkerFromDisk: DaemonSessionMarker | null = null;
  try {
    const raw = await readFile(filePath, 'utf-8');
    const existing = DaemonSessionMarkerSchema.safeParse(JSON.parse(raw));
    if (existing.success) {
      existingMarkerFromDisk = existing.data;
      createdAtFromDisk = existing.data.createdAt;
    }
  } catch (e) {
    // ignore ENOENT (new marker); log other errors for diagnostics
    const err = e as NodeJS.ErrnoException;
    if (err?.code !== 'ENOENT') {
      logger.debug(`[sessionRegistry] Could not read existing session marker pid-${marker.pid}.json to preserve createdAt`, e);
    }
  }

  const canonicalAdoptionRequested =
    options.adoptCanonicalSessionIdFromPidPlaceholder === true;
  if (canonicalAdoptionRequested) {
    const canonicalSessionId = marker.happySessionId.trim();
    const existingSessionId = existingMarkerFromDisk?.happySessionId ?? '';
    const identityMatches =
      existingMarkerFromDisk !== null
      && marker.processCommandHash !== undefined
      && marker.processStartTimeMs !== undefined
      && sessionMarkerProcessIdentityMatches(existingMarkerFromDisk, {
        processCommandHash: marker.processCommandHash,
        processStartTimeMs: marker.processStartTimeMs,
      });
    const sessionIdentityCanAdopt =
      existingSessionId === `PID-${marker.pid}`
      || existingSessionId === canonicalSessionId;
    const existingSpawnNonce =
      existingMarkerFromDisk?.respawn?.spawnNonce?.trim() ?? '';
    const incomingSpawnNonce = marker.respawn?.spawnNonce?.trim() ?? '';
    const spawnNonceMatches =
      existingSpawnNonce.length > 0
      && existingSpawnNonce === incomingSpawnNonce;
    if (
      !canonicalSessionId
      || isPidPlaceholderSessionId(canonicalSessionId)
      || !identityMatches
      || !sessionIdentityCanAdopt
      || !spawnNonceMatches
    ) {
      throw new Error(
        'session_marker_canonical_adoption_ownership_mismatch',
      );
    }
  }
  if (
    marker.agentSessionStartupInstructionsMarkerV1
    && existingMarkerFromDisk?.agentSessionStartupInstructionsMarkerV1
    && (
      existingMarkerFromDisk.happySessionId === marker.happySessionId
      || canonicalAdoptionRequested
    )
    && !agentSessionStartupInstructionsMarkersEqual(
      marker.agentSessionStartupInstructionsMarkerV1,
      existingMarkerFromDisk.agentSessionStartupInstructionsMarkerV1,
    )
  ) {
    throw new Error(
      'session_marker_startup_instructions_marker_conflict',
    );
  }

  const preservedConnectedServiceRestartIntent =
    options.preserveConnectedServiceRestartIntent === true
    && marker.connectedServiceRestartIntent === undefined
    && existingMarkerFromDisk?.happySessionId === marker.happySessionId
      ? existingMarkerFromDisk.connectedServiceRestartIntent
      : undefined;
  const preservedActiveTurnId =
    options.preserveActiveTurnId !== false
    && marker.activeTurnId === undefined
    && existingMarkerFromDisk?.happySessionId === marker.happySessionId
      ? existingMarkerFromDisk.activeTurnId
      : undefined;
  const preservedAgentRuntimeDaemonServiceActiveAdmission =
    options.preserveActiveTurnId !== false
    && marker.agentRuntimeDaemonServiceActiveAdmission
      === undefined
    && existingMarkerFromDisk?.happySessionId
      === marker.happySessionId
    && existingMarkerFromDisk
      .agentRuntimeDaemonServiceActiveAdmission
      ?.turnId === preservedActiveTurnId
      ? existingMarkerFromDisk
          .agentRuntimeDaemonServiceActiveAdmission
      : undefined;
  const preservedAgentSessionStartupInstructionsMarker =
    marker.agentSessionStartupInstructionsMarkerV1 === undefined
    && existingMarkerFromDisk?.agentSessionStartupInstructionsMarkerV1
    && (
      existingMarkerFromDisk.happySessionId === marker.happySessionId
      || canonicalAdoptionRequested
    )
      ? existingMarkerFromDisk.agentSessionStartupInstructionsMarkerV1
      : undefined;
  const preservedRunnerManagedDependencyRetention =
    options.preserveRunnerManagedDependencyRetention !== false
    &&
    marker.runnerManagedDependencyRetentionV1 === undefined
    && existingMarkerFromDisk?.runnerManagedDependencyRetentionV1
    && marker.processCommandHash !== undefined
    && marker.processStartTimeMs !== undefined
    && sessionMarkerProcessOwnershipMatches(
      existingMarkerFromDisk,
      {
        happySessionId: marker.happySessionId,
        processCommandHash: marker.processCommandHash,
        processStartTimeMs: marker.processStartTimeMs,
      },
    )
      ? existingMarkerFromDisk
          .runnerManagedDependencyRetentionV1
      : undefined;
  const preservedRespawn =
    marker.respawn === undefined
    && existingMarkerFromDisk?.respawn
    && marker.startedBy === 'daemon'
    && existingMarkerFromDisk.startedBy === 'daemon'
    && marker.processCommandHash !== undefined
    && marker.processStartTimeMs !== undefined
    && sessionMarkerProcessOwnershipMatches(
      existingMarkerFromDisk,
      {
        happySessionId: marker.happySessionId,
        processCommandHash: marker.processCommandHash,
        processStartTimeMs: marker.processStartTimeMs,
      },
    )
      ? existingMarkerFromDisk.respawn
      : undefined;
  const existingRunnerAgentImmutableGenerationId =
    options.preserveRunnerAgentImmutableGenerationId !== false
    &&
    existingMarkerFromDisk?.runnerAgentImmutableGenerationId
    && marker.processCommandHash !== undefined
    && marker.processStartTimeMs !== undefined
    && sessionMarkerProcessOwnershipMatches(
      existingMarkerFromDisk,
      {
        happySessionId: marker.happySessionId,
        processCommandHash: marker.processCommandHash,
        processStartTimeMs: marker.processStartTimeMs,
      },
    )
      ? existingMarkerFromDisk.runnerAgentImmutableGenerationId
      : undefined;
  if (
    existingRunnerAgentImmutableGenerationId
    && marker.runnerAgentImmutableGenerationId
    && marker.runnerAgentImmutableGenerationId
      !== existingRunnerAgentImmutableGenerationId
  ) {
    throw new Error(
      'Runner Agent immutable generation cannot change for the same process identity',
    );
  }
  const preservedRunnerAgentImmutableGenerationId =
    marker.runnerAgentImmutableGenerationId === undefined
      ? existingRunnerAgentImmutableGenerationId
      : undefined;
  const payload: DaemonSessionMarker = DaemonSessionMarkerSchema.parse({
    ...marker,
    ...(preservedConnectedServiceRestartIntent
      ? { connectedServiceRestartIntent: preservedConnectedServiceRestartIntent }
      : {}),
    ...(preservedActiveTurnId ? { activeTurnId: preservedActiveTurnId } : {}),
    ...(preservedAgentRuntimeDaemonServiceActiveAdmission
      ? {
          agentRuntimeDaemonServiceActiveAdmission:
            preservedAgentRuntimeDaemonServiceActiveAdmission,
        }
      : {}),
    ...(preservedAgentSessionStartupInstructionsMarker
      ? {
          agentSessionStartupInstructionsMarkerV1:
            preservedAgentSessionStartupInstructionsMarker,
        }
      : {}),
    ...(preservedRunnerManagedDependencyRetention
      ? {
          runnerManagedDependencyRetentionV1:
            preservedRunnerManagedDependencyRetention,
        }
      : {}),
    ...(preservedRespawn ? { respawn: preservedRespawn } : {}),
    ...(preservedRunnerAgentImmutableGenerationId
      ? {
          runnerAgentImmutableGenerationId:
            preservedRunnerAgentImmutableGenerationId,
        }
      : {}),
    ...(marker.metadata === undefined
      ? {}
      : { metadata: withoutMirroredReplaySeedText(marker.metadata) }),
    happyHomeDir: configuration.happyHomeDir,
    createdAt: marker.createdAt ?? createdAtFromDisk ?? now,
    updatedAt: now,
  });
  await writeJsonAtomic(filePath, payload.respawn
    ? {
        ...payload,
        respawn: writeSessionRunnerRespawnDescriptorForPersistence(payload.respawn),
      }
    : payload);
}

export async function writeSessionMarker(
  marker: SessionMarkerWriteInput,
  options: WriteSessionMarkerOptions = {},
): Promise<void> {
  await runWithSessionMarkerMutationLock(marker.pid, () => writeSessionMarkerUnlocked(marker, options));
}

export async function updateSessionMarkerAgentSessionStartupInstructionsMarker(
  params: Readonly<{
    pid: number;
    sessionId: string;
    marker: AgentSessionStartupInstructionsMarkerV1;
    expectedSpawnNonce?: string;
  }>,
): Promise<boolean> {
  return await runWithSessionMarkerMutationLock(params.pid, async () => {
    const existing = await readSessionMarkerForPid(params.pid);
    const sessionId = params.sessionId.trim();
    const expectedSpawnNonce = params.expectedSpawnNonce?.trim() ?? '';
    const canAdoptCanonicalSessionId =
      existing?.happySessionId === `PID-${params.pid}`
      && sessionId.length > 0
      && !isPidPlaceholderSessionId(sessionId)
      && expectedSpawnNonce.length > 0
      && existing.respawn?.spawnNonce?.trim() === expectedSpawnNonce;
    if (
      !existing
      || sessionId.length === 0
      || (
        existing.happySessionId !== sessionId
        && !canAdoptCanonicalSessionId
      )
      || (
        existing.agentSessionStartupInstructionsMarkerV1
        && !agentSessionStartupInstructionsMarkersEqual(
          existing.agentSessionStartupInstructionsMarkerV1,
          params.marker,
        )
      )
    ) {
      return false;
    }
    const {
      happyHomeDir: _happyHomeDir,
      updatedAt: _updatedAt,
      ...rest
    } = existing;
    await writeSessionMarkerUnlocked({
      ...rest,
      happySessionId: sessionId,
      agentSessionStartupInstructionsMarkerV1:
        AgentSessionStartupInstructionsMarkerV1Schema.parse(params.marker),
    });
    return true;
  });
}

export async function updateSessionMarkerAgentRuntimeDaemonServiceAuthorityPath(
  params: Readonly<{
    pid: number;
    sessionId: string;
    processCommandHash: string;
    processStartTimeMs: number;
    authorityFilePath: string;
  }>,
): Promise<boolean> {
  return await runWithSessionMarkerMutationLock(params.pid, async () => {
    const existing = await readSessionMarkerForPid(params.pid);
    if (
      !existing
      || existing.happySessionId !== params.sessionId
      || existing.processCommandHash !== params.processCommandHash
      || existing.processStartTimeMs !== params.processStartTimeMs
    ) {
      return false;
    }
    const {
      happyHomeDir: _happyHomeDir,
      updatedAt: _updatedAt,
      ...rest
    } = existing;
    await writeSessionMarkerUnlocked({
      ...rest,
      agentRuntimeDaemonServiceAuthorityFilePath: params.authorityFilePath,
    });
    return true;
  });
}

/**
 * Removes only promotion facts owned by an exact foreground runner candidate.
 * The marker remains the Session lifecycle owner: a failed promotion must not
 * delete unrelated terminal/daemon custody that shares the same process.
 */
export async function clearSessionMarkerAgentRuntimeDaemonServicePromotionIfOwned(
  params: Readonly<{
    pid: number;
    sessionId: string;
    processCommandHash: string;
    processStartTimeMs: number;
    authorityFilePath: string;
    immutableGenerationId?: string;
    retention?: RunnerManagedDependencyRetentionV1;
  }>,
): Promise<boolean> {
  if (
    (params.immutableGenerationId === undefined)
    !== (params.retention === undefined)
  ) {
    return false;
  }
  const expectedRetention = params.retention
    ? RunnerManagedDependencyRetentionV1Schema.parse(params.retention)
    : undefined;
  return await runWithSessionMarkerMutationLock(params.pid, async () => {
    const existing = await readSessionMarkerForPid(params.pid);
    if (
      !existing
      || existing.happySessionId !== params.sessionId
      || existing.processCommandHash !== params.processCommandHash
      || existing.processStartTimeMs !== params.processStartTimeMs
      || existing.agentRuntimeDaemonServiceAuthorityFilePath
        !== params.authorityFilePath
      || (
        params.immutableGenerationId !== undefined
        && (
          existing.runnerAgentImmutableGenerationId
            !== params.immutableGenerationId
          || !isDeepStrictEqual(
            existing.runnerManagedDependencyRetentionV1,
            expectedRetention,
          )
        )
      )
    ) {
      return false;
    }
    if (params.immutableGenerationId === undefined) {
      const {
        agentRuntimeDaemonServiceAuthorityFilePath: _authorityFilePath,
        agentRuntimeDaemonServiceSessionOpenAttestation: _sessionOpenAttestation,
        happyHomeDir: _happyHomeDir,
        updatedAt: _updatedAt,
        ...rest
      } = existing;
      await writeSessionMarkerUnlocked(rest);
      return true;
    }
    const {
      agentRuntimeDaemonServiceAuthorityFilePath: _authorityFilePath,
      agentRuntimeDaemonServiceSessionOpenAttestation: _sessionOpenAttestation,
      runnerAgentImmutableGenerationId: _immutableGenerationId,
      runnerManagedDependencyRetentionV1: _retention,
      happyHomeDir: _happyHomeDir,
      updatedAt: _updatedAt,
      ...rest
    } = existing;
    await writeSessionMarkerUnlocked(rest, {
      preserveRunnerAgentImmutableGenerationId: false,
      preserveRunnerManagedDependencyRetention: false,
    });
    return true;
  });
}

export async function updateSessionMarkerRunnerManagedDependencyRetention(
  params: Readonly<{
    pid: number;
    sessionId: string;
    processCommandHash: string;
    processStartTimeMs: number;
    retention: RunnerManagedDependencyRetentionV1;
  }>,
): Promise<boolean> {
  return await runWithSessionMarkerMutationLock(params.pid, async () => {
    const existing = await readSessionMarkerForPid(params.pid);
    if (
      !existing
      || existing.happySessionId !== params.sessionId
      || existing.processCommandHash !== params.processCommandHash
      || existing.processStartTimeMs !== params.processStartTimeMs
    ) {
      return false;
    }
    const {
      happyHomeDir: _happyHomeDir,
      updatedAt: _updatedAt,
      ...rest
    } = existing;
    await writeSessionMarkerUnlocked({
      ...rest,
      runnerManagedDependencyRetentionV1:
        withRunnerManagedProviderAuthorityRetention(
          mergeRunnerManagedDependencyRetentionV1(
            existing.runnerManagedDependencyRetentionV1,
            params.retention,
          ),
          existing.runnerManagedDependencyRetentionV1
            ?.adoptedManagedProviderAuthority ?? null,
        ),
    });
    return true;
  });
}

export async function updateSessionMarkerRunnerManagedProviderAuthority(
  params: Readonly<{
    pid: number;
    sessionId: string;
    processCommandHash: string;
    processStartTimeMs: number;
  } & (
    Readonly<{
      authority: RunnerManagedProviderRetainedAuthorityV1;
    }>
    | Readonly<{
      authority: null;
      expectedAuthority: RunnerManagedProviderRetainedAuthorityV1;
    }>
  )>,
): Promise<boolean> {
  return await runWithSessionMarkerMutationLock(params.pid, async () => {
    const existing = await readSessionMarkerForPid(params.pid);
    if (
      !existing
      || existing.happySessionId !== params.sessionId
      || existing.processCommandHash !== params.processCommandHash
      || existing.processStartTimeMs !== params.processStartTimeMs
    ) {
      return false;
    }
    const currentAuthority =
      existing.runnerManagedDependencyRetentionV1
        ?.adoptedManagedProviderAuthority;
    const authority = params.authority
      ? RunnerManagedProviderRetainedAuthorityV1Schema.parse(
          params.authority,
        )
      : null;
    if (authority) {
      if (
        currentAuthority
        && !areRunnerManagedProviderRetainedAuthoritiesEqual(
          currentAuthority,
          authority,
        )
      ) {
        return false;
      }
    } else {
      if (!('expectedAuthority' in params)) {
        return false;
      }
      const expectedAuthority =
        RunnerManagedProviderRetainedAuthorityV1Schema.parse(
          params.expectedAuthority,
        );
      if (
        !areRunnerManagedProviderRetainedAuthoritiesEqual(
          currentAuthority,
          expectedAuthority,
        )
      ) {
        return false;
      }
    }
    const {
      happyHomeDir: _happyHomeDir,
      updatedAt: _updatedAt,
      ...rest
    } = existing;
    await writeSessionMarkerUnlocked({
      ...rest,
      runnerManagedDependencyRetentionV1:
        withRunnerManagedProviderAuthorityRetention(
          existing.runnerManagedDependencyRetentionV1,
          authority,
        ),
    });
    return true;
  });
}

export async function updateSessionMarkerRunnerAgentImmutableGenerationId(
  params: Readonly<{
    pid: number;
    sessionId: string;
    processCommandHash: string;
    processStartTimeMs: number;
    immutableGenerationId: string;
  }>,
): Promise<boolean> {
  return await runWithSessionMarkerMutationLock(params.pid, async () => {
    const existing = await readSessionMarkerForPid(params.pid);
    if (
      !existing
      || existing.happySessionId !== params.sessionId
      || existing.processCommandHash !== params.processCommandHash
      || existing.processStartTimeMs !== params.processStartTimeMs
      || (
        existing.runnerAgentImmutableGenerationId !== undefined
        && existing.runnerAgentImmutableGenerationId
          !== params.immutableGenerationId
      )
    ) {
      return false;
    }
    const {
      happyHomeDir: _happyHomeDir,
      updatedAt: _updatedAt,
      ...rest
    } = existing;
    await writeSessionMarkerUnlocked({
      ...rest,
      runnerAgentImmutableGenerationId:
        params.immutableGenerationId,
    });
    return true;
  });
}

export type SessionMarkerOwnership = Readonly<{
  happySessionId: string;
  processCommandHash?: string;
  processStartTimeMs?: number;
}>;

export type SessionMarkerPromotionResult = Readonly<{
  sourceMarkerOwnership: SessionMarkerOwnership | null;
  targetMarkerOwnership: SessionMarkerOwnership | null;
  targetProcessCommand?: string;
}>;

export async function readExactSessionMarkerOwnership(
  params: Readonly<{
    pid: number;
    ownership: Readonly<{
      happySessionId: string;
      processCommandHash: string;
      processStartTimeMs: number;
    }>;
    expectedSpawnNonce?: string;
  }>,
): Promise<Readonly<{
  ownership: SessionMarkerOwnership;
  processCommand?: string;
}> | null> {
  return await runWithSessionMarkerMutationLock(
    params.pid,
    async () => {
      const marker =
        await readSessionMarkerForPid(params.pid);
      if (
        !marker
        || marker.happySessionId
          !== params.ownership.happySessionId
        || marker.processCommandHash
          !== params.ownership.processCommandHash
        || marker.processStartTimeMs
          !== params.ownership.processStartTimeMs
        || (
          params.expectedSpawnNonce
          && marker.respawn?.spawnNonce?.trim()
            !== params.expectedSpawnNonce
        )
      ) {
        return null;
      }
      return {
        ownership: {
          happySessionId: marker.happySessionId,
          processCommandHash: marker.processCommandHash,
          processStartTimeMs: marker.processStartTimeMs,
        },
        ...(marker.processCommand
          ? { processCommand: marker.processCommand }
          : {}),
      };
    },
  );
}

async function removeSessionMarkerUnlocked(
  pid: number,
  ownership?: SessionMarkerOwnership & Readonly<{ isStillOwned?: () => boolean }>,
): Promise<boolean> {
  let removed = false;
  for (const dir of daemonSessionMarkerDirs()) {
    const filePath = join(dir, `pid-${pid}.json`);
    try {
      let marker: DaemonSessionMarker | null = null;
      try {
        const raw = await readFile(filePath, 'utf-8');
        const parsed = DaemonSessionMarkerSchema.safeParse(JSON.parse(raw));
        if (parsed.success && parsed.data.happyHomeDir === configuration.happyHomeDir) {
          marker = parsed.data;
        }
      } catch {
        // Marker removal must not be blocked by stale or malformed marker contents.
      }
      if (ownership) {
        if (
          marker?.happySessionId !== ownership.happySessionId
          || (
            ownership.processCommandHash !== undefined
            && marker.processCommandHash !== ownership.processCommandHash
          )
          || (
            ownership.processStartTimeMs !== undefined
            && marker.processStartTimeMs !== ownership.processStartTimeMs
          )
        ) {
          continue;
        }
        if (ownership.isStillOwned && !ownership.isStillOwned()) {
          return removed;
        }
      }
      await unlink(filePath);
      removed = true;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code !== 'ENOENT') {
        logger.debug(`[sessionRegistry] Failed to remove session marker pid-${pid}.json`, e);
      }
    }
  }
  return removed;
}

export async function removeSessionMarker(pid: number): Promise<void> {
  await runWithSessionMarkerMutationLock(pid, () => removeSessionMarkerUnlocked(pid));
}

export async function removeSessionMarkerIfOwned(params: Readonly<{
  pid: number;
  happySessionId: string;
  processCommandHash?: string;
  processStartTimeMs?: number;
  isStillOwned?: () => boolean;
}>): Promise<boolean> {
  return await runWithSessionMarkerMutationLock(params.pid, () => removeSessionMarkerUnlocked(params.pid, {
    happySessionId: params.happySessionId,
    processCommandHash: params.processCommandHash,
    processStartTimeMs: params.processStartTimeMs,
    isStillOwned: params.isStillOwned,
  }));
}

export async function promoteSessionMarkerPid(
  fromPid: number,
  toPid: number,
  dependencies: Readonly<{
    readProcessIdentityByPidFn?: typeof readProcessIdentityByPid;
  }> = {},
): Promise<SessionMarkerPromotionResult | null> {
  if (fromPid === toPid) {
    return {
      sourceMarkerOwnership: null,
      targetMarkerOwnership: null,
    };
  }

  return await runWithSessionMarkerMutationLocks([fromPid, toPid], async () => {
    const sourceMarker = await readSessionMarkerForPid(fromPid);
    if (!sourceMarker) {
      return (await readSessionMarkerForPid(toPid)) === null
        ? {
            sourceMarkerOwnership: null,
            targetMarkerOwnership: null,
          }
        : null;
    }
    const sourceMarkerOwnership: SessionMarkerOwnership = {
      happySessionId: sourceMarker.happySessionId,
      ...(sourceMarker.processCommandHash
        ? { processCommandHash: sourceMarker.processCommandHash }
        : {}),
      ...(sourceMarker.processStartTimeMs !== undefined
        ? { processStartTimeMs: sourceMarker.processStartTimeMs }
        : {}),
    };
    const targetMarker = await readSessionMarkerForPid(toPid);
    if (targetMarker) {
      const sourceSpawnNonce = sourceMarker.respawn?.spawnNonce?.trim() ?? '';
      const targetSpawnNonce = targetMarker.respawn?.spawnNonce?.trim() ?? '';
      const sourceSessionId = sourceMarker.happySessionId.trim();
      const targetSessionId = targetMarker.happySessionId.trim();
      const sourceMatchesExpectedPlaceholder = sourceMarker.happySessionId === `PID-${fromPid}`;
      const sourceMatchesCanonicalTarget =
        sourceSessionId.length > 0
        && !/^PID-\d+$/.test(sourceSessionId)
        && sourceSessionId === targetSessionId;
      const sourceAndTargetMatchExpectedPlaceholders =
        sourceMatchesExpectedPlaceholder
        && targetSessionId === `PID-${toPid}`;
      const sourcePlaceholderMatchesCanonicalTarget =
        sourceMatchesExpectedPlaceholder
        && !/^PID-\d+$/.test(targetSessionId);
      if (
        (
          !sourceAndTargetMatchExpectedPlaceholders
          && !sourcePlaceholderMatchesCanonicalTarget
          && !sourceMatchesCanonicalTarget
        )
        || !targetSessionId
        || !sourceSpawnNonce
        || sourceSpawnNonce !== targetSpawnNonce
      ) {
        return null;
      }
      const sourceStartupInstructionsMarker =
        sourceMarker.agentSessionStartupInstructionsMarkerV1;
      const targetStartupInstructionsMarker =
        targetMarker.agentSessionStartupInstructionsMarkerV1;
      if (
        sourceStartupInstructionsMarker
        && targetStartupInstructionsMarker
        && !agentSessionStartupInstructionsMarkersEqual(
          sourceStartupInstructionsMarker,
          targetStartupInstructionsMarker,
        )
      ) {
        return null;
      }
      const {
        happyHomeDir: _happyHomeDir,
        updatedAt: _updatedAt,
        ...targetInput
      } = targetMarker;
      await writeSessionMarkerUnlocked({
        ...targetInput,
        ...(targetMarker.activeTurnId === undefined && sourceMarker.activeTurnId !== undefined
          ? { activeTurnId: sourceMarker.activeTurnId }
          : {}),
        ...(targetStartupInstructionsMarker === undefined
          && sourceStartupInstructionsMarker !== undefined
          ? {
              agentSessionStartupInstructionsMarkerV1:
                sourceStartupInstructionsMarker,
            }
          : {}),
        pid: toPid,
        createdAt: targetMarker.createdAt,
      });
      return {
        sourceMarkerOwnership,
        targetMarkerOwnership: {
          happySessionId: targetMarker.happySessionId,
          ...(targetMarker.processCommandHash
            ? { processCommandHash: targetMarker.processCommandHash }
            : {}),
          ...(targetMarker.processStartTimeMs !== undefined
            ? { processStartTimeMs: targetMarker.processStartTimeMs }
            : {}),
        },
        ...(targetMarker.processCommand
          ? { targetProcessCommand: targetMarker.processCommand }
          : {}),
      };
    }

    const {
      happyHomeDir: _happyHomeDir,
      pid: _previousPid,
      updatedAt: _updatedAt,
      connectedServiceRestartIntent: _connectedServiceRestartIntent,
      processCommandHash: _sourceProcessCommandHash,
      processStartTimeMs: _sourceProcessStartTimeMs,
      processCommand: _sourceProcessCommand,
      ...markerInput
    } = sourceMarker;
    const targetProcessIdentity = await (
      dependencies.readProcessIdentityByPidFn ?? readProcessIdentityByPid
    )(toPid);
    const targetProcessCommand = targetProcessIdentity?.command.trim() ?? '';
    const promotedProcessIdentity =
      targetProcessCommand && targetProcessIdentity?.processStartTimeMs !== undefined
        ? {
            processCommand: targetProcessCommand,
            processCommandHash: hashProcessCommand(targetProcessCommand),
            processStartTimeMs: targetProcessIdentity.processStartTimeMs,
          }
        : null;
    const promotedHappySessionId = markerInput.happySessionId;
    await writeSessionMarkerUnlocked({
      ...markerInput,
      happySessionId: promotedHappySessionId,
      pid: toPid,
      createdAt: sourceMarker.createdAt,
      ...(promotedProcessIdentity ?? {}),
    });
    return {
      sourceMarkerOwnership,
      targetMarkerOwnership: {
        happySessionId: promotedHappySessionId,
        ...(promotedProcessIdentity
          ? {
              processCommandHash:
                promotedProcessIdentity.processCommandHash,
              processStartTimeMs:
                promotedProcessIdentity.processStartTimeMs,
            }
          : {}),
      },
      ...(promotedProcessIdentity
        ? { targetProcessCommand: promotedProcessIdentity.processCommand }
        : {}),
    };
  });
}

export async function readSessionMarkerForPid(pid: number): Promise<DaemonSessionMarker | null> {
  for (const dir of daemonSessionMarkerDirs()) {
    const filePath = join(dir, `pid-${pid}.json`);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const parsed = DaemonSessionMarkerSchema.safeParse(JSON.parse(raw));
      if (parsed.success && parsed.data.happyHomeDir === configuration.happyHomeDir) {
        return parsed.data;
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code !== 'ENOENT') {
        logger.debug(`[sessionRegistry] Could not read session marker pid-${pid}.json`, e);
      }
    }
  }
  return null;
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

export async function updateSessionMarkerActiveTurn(params: Readonly<{
  pid: number;
  sessionId: string;
  activeTurnId: string | null;
  agentRuntimeDaemonServiceActiveAdmission?:
    AgentRuntimeDaemonServiceActiveAdmission;
  expectedAgentRuntimeDaemonServiceActiveAdmission?:
    AgentRuntimeDaemonServiceActiveAdmission;
}>): Promise<boolean> {
  if (
    params.agentRuntimeDaemonServiceActiveAdmission
    && params.agentRuntimeDaemonServiceActiveAdmission.turnId
      !== params.activeTurnId
  ) {
    return false;
  }
  return await runWithSessionMarkerMutationLock(params.pid, async () => {
    const existing = await readSessionMarkerForPid(params.pid);
    if (!existing || existing.happySessionId !== params.sessionId) return false;
    if (
      params.expectedAgentRuntimeDaemonServiceActiveAdmission
      && !agentRuntimeDaemonServiceActiveAdmissionsEqual(
        existing.agentRuntimeDaemonServiceActiveAdmission,
        params.expectedAgentRuntimeDaemonServiceActiveAdmission,
      )
    ) {
      return false;
    }

    const {
      activeTurnId: _activeTurnId,
      agentRuntimeDaemonServiceActiveAdmission:
        _agentRuntimeDaemonServiceActiveAdmission,
      happyHomeDir: _happyHomeDir,
      updatedAt: _updatedAt,
      ...rest
    } = existing;
    await writeSessionMarkerUnlocked({
      ...rest,
      ...(params.activeTurnId ? { activeTurnId: params.activeTurnId } : {}),
      ...(params.agentRuntimeDaemonServiceActiveAdmission
        ? {
            agentRuntimeDaemonServiceActiveAdmission:
              {
                ...params.agentRuntimeDaemonServiceActiveAdmission,
                userMessageSeqs: [
                  ...params
                    .agentRuntimeDaemonServiceActiveAdmission
                    .userMessageSeqs,
                ],
              },
          }
        : {}),
    }, { preserveActiveTurnId: false });
    return true;
  });
}

export async function updateSessionMarkerAgentRuntimeSessionOpenAttestation(
  params: Readonly<{
    pid: number;
    sessionId: string;
    authorityFilePath: string;
    attestation:
      AgentRuntimeDaemonServiceSessionOpenAttestationV1;
  }>,
): Promise<boolean> {
  return await runWithSessionMarkerMutationLock(params.pid, async () => {
    const existing = await readSessionMarkerForPid(params.pid);
    if (
      !existing
      || existing.happySessionId !== params.sessionId
      || existing.agentRuntimeDaemonServiceAuthorityFilePath
        !== params.authorityFilePath
    ) {
      return false;
    }
    const {
      agentRuntimeDaemonServiceSessionOpenAttestation:
        _agentRuntimeDaemonServiceSessionOpenAttestation,
      happyHomeDir: _happyHomeDir,
      updatedAt: _updatedAt,
      ...rest
    } = existing;
    await writeSessionMarkerUnlocked({
      ...rest,
      agentRuntimeDaemonServiceSessionOpenAttestation:
        AgentRuntimeDaemonServiceSessionOpenAttestationV1Schema
          .parse(params.attestation),
    });
    return true;
  });
}

export async function listSessionMarkers(): Promise<DaemonSessionMarker[]> {
  const markerByPid = new Map<number, DaemonSessionMarker>();
  for (const dir of daemonSessionMarkerDirs()) {
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
        const existing = markerByPid.get(parsed.data.pid);
        if (!existing || parsed.data.updatedAt > existing.updatedAt) {
          markerByPid.set(parsed.data.pid, parsed.data);
        }
      } catch (e) {
        logger.debug(`[sessionRegistry] Failed to read or parse session marker ${name}`, e);
        // ignore unreadable marker
      }
    }
  }
  return Array.from(markerByPid.values());
}
