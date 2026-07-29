import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import { CATALOG_AGENT_IDS } from '@/agent/catalog/ids';
import {
  SessionRunnerRespawnDescriptorV1Schema,
  writeSessionRunnerRespawnDescriptorForPersistence,
} from './processSupervision/sessionRunnerRespawnDescriptor';
import { resolveReleaseRingScopedBasename } from '@/cli/runtime/publicReleaseChannel';
import { cleanupPluginLocalServicesBridgeTokenFile } from './local/services/pluginBridgeAuthorization';
import { readProcessIdentityByPid } from './processIdentity';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import {
  AgentSessionStartupInstructionsMarkerV1Schema,
  type AgentSessionStartupInstructionsMarkerV1,
} from '@happier-dev/protocol';

const PluginLocalServicesBridgeAuthorizationSchema = z.object({
  v: z.literal(1),
  tokenHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  pluginId: z.string().trim().min(1).max(256),
  contributionId: z.string().trim().min(1).max(256),
  tokenFilePath: z.string().trim().min(1).optional(),
}).strict();

export const ManagedLocalServiceRunAttachmentV1Schema = z.object({
  v: z.literal(1),
  process: z.object({
    pid: z.number().int().positive(),
    processStartTimeMs: z.number().int().nonnegative(),
    processCommandHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  endpoint: z.object({
    host: z.enum(['127.0.0.1', '::1']),
    port: z.number().int().min(1).max(65_535),
  }).strict(),
  materialization: z.object({
    rootDir: z.string().trim().min(1).max(16_384),
    materializationId: z.string().trim().min(1).max(512),
  }).strict(),
}).strict();

export type ManagedLocalServiceRunAttachmentV1 = z.infer<
  typeof ManagedLocalServiceRunAttachmentV1Schema
>;

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
  // Canonical OS process birth timestamp paired with the PID and command hash.
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
  localServicesBridgeAuthorization: PluginLocalServicesBridgeAuthorizationSchema.optional(),
  activeTurnId: z.string().trim().min(1).max(512).optional(),
  // Required startup identity persisted before runtime open; not proof of application.
  agentSessionStartupInstructionsMarkerV1:
    AgentSessionStartupInstructionsMarkerV1Schema.optional(),
  managedLocalServiceRunAttachment: ManagedLocalServiceRunAttachmentV1Schema.optional(),
});

export type DaemonSessionMarker = z.infer<typeof DaemonSessionMarkerSchema>;

type SessionMarkerWriteInput = Omit<
  DaemonSessionMarker,
  'createdAt' | 'updatedAt' | 'happyHomeDir' | 'managedLocalServiceRunAttachment'
> & Readonly<{
  createdAt?: number;
  updatedAt?: number;
}>;

type InternalSessionMarkerWriteInput = SessionMarkerWriteInput & Readonly<{
  managedLocalServiceRunAttachment?: ManagedLocalServiceRunAttachmentV1;
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
  preserveManagedLocalServiceRunAttachment?: boolean;
  adoptCanonicalSessionIdFromPidPlaceholder?: boolean;
}>;

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

export function managedLocalServiceRunAttachmentsEqual(
  left: ManagedLocalServiceRunAttachmentV1 | undefined | null,
  right: ManagedLocalServiceRunAttachmentV1 | undefined | null,
): boolean {
  if (!left || !right) return !left && !right;
  return left.v === right.v
    && left.process.pid === right.process.pid
    && left.process.processStartTimeMs === right.process.processStartTimeMs
    && left.process.processCommandHash === right.process.processCommandHash
    && left.endpoint.host === right.endpoint.host
    && left.endpoint.port === right.endpoint.port
    && left.materialization.rootDir === right.materialization.rootDir
    && left.materialization.materializationId === right.materialization.materializationId;
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
  marker: InternalSessionMarkerWriteInput,
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
  const preservedAgentSessionStartupInstructionsMarker =
    marker.agentSessionStartupInstructionsMarkerV1 === undefined
    && existingMarkerFromDisk?.agentSessionStartupInstructionsMarkerV1
    && (
      existingMarkerFromDisk.happySessionId === marker.happySessionId
      || canonicalAdoptionRequested
    )
      ? existingMarkerFromDisk.agentSessionStartupInstructionsMarkerV1
      : undefined;
  const preservedManagedLocalServiceRunAttachment =
    options.preserveManagedLocalServiceRunAttachment !== false
    && marker.managedLocalServiceRunAttachment === undefined
    && existingMarkerFromDisk?.managedLocalServiceRunAttachment
    && marker.processCommandHash !== undefined
    && marker.processStartTimeMs !== undefined
    && (
      sessionMarkerProcessOwnershipMatches(existingMarkerFromDisk, {
        happySessionId: marker.happySessionId,
        processCommandHash: marker.processCommandHash,
        processStartTimeMs: marker.processStartTimeMs,
      })
      || (
        canonicalAdoptionRequested
        && sessionMarkerProcessIdentityMatches(existingMarkerFromDisk, {
          processCommandHash: marker.processCommandHash,
          processStartTimeMs: marker.processStartTimeMs,
        })
      )
    )
      ? existingMarkerFromDisk.managedLocalServiceRunAttachment
      : undefined;
  const payload: DaemonSessionMarker = DaemonSessionMarkerSchema.parse({
    ...marker,
    ...(preservedConnectedServiceRestartIntent
      ? { connectedServiceRestartIntent: preservedConnectedServiceRestartIntent }
      : {}),
    ...(preservedActiveTurnId ? { activeTurnId: preservedActiveTurnId } : {}),
    ...(preservedAgentSessionStartupInstructionsMarker
      ? {
          agentSessionStartupInstructionsMarkerV1:
            preservedAgentSessionStartupInstructionsMarker,
        }
      : {}),
    ...(preservedManagedLocalServiceRunAttachment
      ? { managedLocalServiceRunAttachment: preservedManagedLocalServiceRunAttachment }
      : {}),
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
  const {
    managedLocalServiceRunAttachment: _managedLocalServiceRunAttachment,
    ...ownedInput
  } = marker as InternalSessionMarkerWriteInput;
  await runWithSessionMarkerMutationLock(marker.pid, () => writeSessionMarkerUnlocked(ownedInput, options));
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

export async function rewriteSessionMarkerRespawnEnvironmentCiphertextIfOwned(
  params: Readonly<{
    pid: number;
    ownership: Readonly<{
      happySessionId: string;
      processCommandHash: string;
      processStartTimeMs: number;
    }>;
    expectedCiphertext: string;
    replacementCiphertext: string;
  }>,
): Promise<boolean> {
  return await runWithSessionMarkerMutationLock(
    params.pid,
    async () => {
      const existing =
        await readSessionMarkerForPid(params.pid);
      if (
        !existing
        || !sessionMarkerProcessOwnershipMatches(
          existing,
          params.ownership,
        )
        || existing.respawn?.sealedEnvironmentVariables
          ?.ciphertext !== params.expectedCiphertext
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
        respawn: {
          ...existing.respawn,
          sealedEnvironmentVariables: {
            format: 'account_scoped_v1',
            ciphertext: params.replacementCiphertext,
          },
        },
      });
      return true;
    },
  );
}

export async function writeSessionMarkerWithManagedLocalServiceRunAttachment(params: Readonly<{
  marker: SessionMarkerWriteInput;
  attachment: ManagedLocalServiceRunAttachmentV1;
}>): Promise<void> {
  await runWithSessionMarkerMutationLock(params.marker.pid, () => (
    writeSessionMarkerUnlocked({
      ...params.marker,
      managedLocalServiceRunAttachment:
        ManagedLocalServiceRunAttachmentV1Schema.parse(params.attachment),
    }, {
      preserveManagedLocalServiceRunAttachment: false,
    })
  ));
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
    expectedManagedLocalServiceRunAttachment?:
      ManagedLocalServiceRunAttachmentV1;
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
        || (
          params.expectedManagedLocalServiceRunAttachment
          && (
            !marker.managedLocalServiceRunAttachment
            || !managedLocalServiceRunAttachmentsEqual(
              marker.managedLocalServiceRunAttachment,
              params.expectedManagedLocalServiceRunAttachment,
            )
          )
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

export type ManagedLocalServiceRunAttachmentMarkerOwnership = Readonly<{
  happySessionId: string;
  processCommandHash: string;
  processStartTimeMs: number;
}>;

export async function setSessionMarkerManagedLocalServiceRunAttachment(params: Readonly<{
  pid: number;
  ownership: ManagedLocalServiceRunAttachmentMarkerOwnership;
  expectedAttachment: ManagedLocalServiceRunAttachmentV1 | null;
  attachment: ManagedLocalServiceRunAttachmentV1;
}>): Promise<boolean> {
  return await runWithSessionMarkerMutationLock(params.pid, async () => {
    const existing = await readSessionMarkerForPid(params.pid);
    if (
      !existing
      || !sessionMarkerProcessOwnershipMatches(existing, params.ownership)
      || !managedLocalServiceRunAttachmentsEqual(
        existing.managedLocalServiceRunAttachment,
        params.expectedAttachment,
      )
    ) {
      return false;
    }
    const {
      happyHomeDir: _happyHomeDir,
      updatedAt: _updatedAt,
      managedLocalServiceRunAttachment: _managedLocalServiceRunAttachment,
      ...rest
    } = existing;
    await writeSessionMarkerUnlocked({
      ...rest,
      managedLocalServiceRunAttachment: ManagedLocalServiceRunAttachmentV1Schema.parse(params.attachment),
    });
    return true;
  });
}

export async function clearSessionMarkerManagedLocalServiceRunAttachment(params: Readonly<{
  pid: number;
  ownership: ManagedLocalServiceRunAttachmentMarkerOwnership;
  attachment: ManagedLocalServiceRunAttachmentV1;
}>): Promise<'cleared' | 'already_absent' | 'mismatch'> {
  return await runWithSessionMarkerMutationLock(params.pid, async () => {
    const existing = await readSessionMarkerForPid(params.pid);
    if (
      !existing
      || !sessionMarkerProcessOwnershipMatches(existing, params.ownership)
    ) {
      return 'mismatch';
    }
    if (existing.managedLocalServiceRunAttachment === undefined) {
      return 'already_absent';
    }
    if (
      !managedLocalServiceRunAttachmentsEqual(
        existing.managedLocalServiceRunAttachment,
        params.attachment,
      )
    ) {
      return 'mismatch';
    }
    const {
      happyHomeDir: _happyHomeDir,
      updatedAt: _updatedAt,
      managedLocalServiceRunAttachment: _managedLocalServiceRunAttachment,
      ...rest
    } = existing;
    await writeSessionMarkerUnlocked(rest, {
      preserveManagedLocalServiceRunAttachment: false,
    });
    return 'cleared';
  });
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
      if (marker) {
        cleanupPluginLocalServicesBridgeTokenFile({
          happyHomeDir: configuration.happyHomeDir,
          publicReleaseRing: configuration.publicReleaseRing,
          tokenFilePath: marker.localServicesBridgeAuthorization?.tokenFilePath,
        });
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
      const sourceAttachment = sourceMarker.managedLocalServiceRunAttachment;
      const targetAttachment = targetMarker.managedLocalServiceRunAttachment;
      if (
        sourceAttachment
        && targetAttachment
        && !managedLocalServiceRunAttachmentsEqual(sourceAttachment, targetAttachment)
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
      if (sourceAttachment ?? targetAttachment) {
        const targetProcessIdentity = await (
          dependencies.readProcessIdentityByPidFn ?? readProcessIdentityByPid
        )(toPid);
        const targetProcessCommand = targetProcessIdentity?.command.trim() ?? '';
        if (
          !targetProcessCommand
          || targetProcessIdentity?.processStartTimeMs === undefined
          || targetMarker.processStartTimeMs !== targetProcessIdentity.processStartTimeMs
          || targetMarker.processCommandHash !== hashProcessCommand(targetProcessCommand)
        ) {
          return null;
        }
      }

      const {
        happyHomeDir: _happyHomeDir,
        updatedAt: _updatedAt,
        managedLocalServiceRunAttachment: _targetManagedLocalServiceRunAttachment,
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
        ...((sourceAttachment ?? targetAttachment)
          ? { managedLocalServiceRunAttachment: sourceAttachment ?? targetAttachment }
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
      managedLocalServiceRunAttachment,
      ...markerInput
    } = sourceMarker;
    const targetProcessIdentity = await (
      dependencies.readProcessIdentityByPidFn ?? readProcessIdentityByPid
    )(toPid);
    const targetProcessCommand = targetProcessIdentity?.command.trim() ?? '';
    if (
      managedLocalServiceRunAttachment
      && (!targetProcessCommand || targetProcessIdentity?.processStartTimeMs === undefined)
    ) {
      return null;
    }
    const promotedProcessIdentity =
      targetProcessCommand && targetProcessIdentity?.processStartTimeMs !== undefined
        ? {
            processCommand: targetProcessCommand,
            processCommandHash: hashProcessCommand(targetProcessCommand),
            processStartTimeMs: targetProcessIdentity.processStartTimeMs,
          }
        : null;
    const promotedHappySessionId =
      managedLocalServiceRunAttachment
      && markerInput.happySessionId === `PID-${fromPid}`
        ? `PID-${toPid}`
        : markerInput.happySessionId;
    await writeSessionMarkerUnlocked({
      ...markerInput,
      happySessionId: promotedHappySessionId,
      pid: toPid,
      createdAt: sourceMarker.createdAt,
      ...(promotedProcessIdentity ?? {}),
      ...(managedLocalServiceRunAttachment
        ? { managedLocalServiceRunAttachment }
        : {}),
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

async function readSessionMarkerForPid(pid: number): Promise<DaemonSessionMarker | null> {
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
    }, { preserveActiveTurnId: false });
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
