import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { SessionRunnerStartingModeV1Schema } from '@happier-dev/protocol/sessions/control/sessionRunnerRuntimeV1';
import { retireGoneLocalSessionRpcHost } from '@/session/transport/rpc/localSessionRpcChannel';
import { configuration } from '@/configuration';
import type { SessionHeldAgentV1 } from '@/subprocess/supervision/sessionHolder';
import { logger } from '@/ui/logger';
import { randomUUID } from 'node:crypto';
import { hashProcessCommand, processIdentityMatches } from '@happier-dev/cli-common/processInstance';
import { mkdir, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as z from 'zod/mini';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { CATALOG_AGENT_IDS } from '@/agent/catalog/ids';
import {
  SessionRunnerRespawnDescriptorV1Schema,
  writeSessionRunnerRespawnDescriptorForPersistence,
} from './processSupervision/sessionRunnerRespawnDescriptor';
import { resolveReleaseRingScopedBasename } from '@/cli/runtime/publicReleaseChannel';
import { processGenerationMatches, readProcessIdentityByPid } from './processIdentity';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { AgentSessionStartupInstructionsMarkerV1Schema } from '@happier-dev/protocol/runtime/agentSessionStartupInstructionsV1';
import { PluginSourceCustodyV1Schema, pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { AgentSessionStartupInstructionsMarkerV1, PluginSourceCustodyV1 } from '@happier-dev/protocol';
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
import { RequesterWorkAttributionStoredReadV1Schema, RequesterWorkAttributionV1Schema,
  type RequesterWorkAttributionV1 } from './lifecycle/requesterWorkAttribution';
import type { ConnectedServiceMaterializedStateObservationBinding } from './connectedServices/materialization/materializer';
import { parseSessionTrackingKey, type SessionTrackingKey } from './sessions/sessionTrackingKey';

const ConnectedServiceMaterializedStateObservationBindingSchema = lazyZodSchema(() => z.strictObject({
  agentId: z.string().check(z.minLength(1)),
  pluginId: z.string().check(z.minLength(1)),
  sourceCustody: PluginSourceCustodyV1Schema,
  nativeHomeRoot: z.string().check(z.minLength(1)),
  entries: z.array(z.strictObject({
    entryPath: z.string().check(z.minLength(1)),
    sourceEntryRoot: z.string().check(z.minLength(1)),
    materializedEntryPath: z.string().check(z.minLength(1)),
  })),
}));

const DaemonSessionMarkerSchema = lazyZodSchema(() => z.object({
  pid: z.number().check(z.int(), z.positive()),
  happySessionId: z.string(),
  happyHomeDir: z.string(),
  createdAt: z.number().check(z.int(), z.positive()),
  updatedAt: z.number().check(z.int(), z.positive()),
  flavor: z.optional(z.enum(CATALOG_AGENT_IDS)),
  startedBy: z.optional(z.enum(['daemon', 'terminal'])),
  cwd: z.optional(z.string()),
  linuxLaunchUnit: z.optional(z.string().check(z.refine(unit => unit.startsWith('happier-') && !unit.includes('/') && unit.endsWith('.scope')))),
  requesterWorkAttributionV1: z.optional(RequesterWorkAttributionStoredReadV1Schema),
  // Legacy positive-classification witness and diagnostic snapshot. Mutable command text is not process generation.
  processCommandHash: z.optional(z.string().check(z.regex(/^[a-f0-9]{64}$/))),
  // Canonical OS process-generation witness paired with the PID.
  processStartTimeMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  // 0.2 predecessor marker witness. Read for adoption safety; new writes use
  // processStartTimeMs from the current process-identity owner.
  processInstanceFingerprint: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
  // Optional debug-only sample of the observed command; not an identity witness.
  processCommand: z.optional(z.string()),
  sessionRunnerStartingMode: z.optional(SessionRunnerStartingModeV1Schema),
  metadata: z.optional(z.any()),
  // Safe daemon respawn inputs (no secrets). Used to reconstruct SpawnSessionOptions after reattach.
  respawn: z.optional(SessionRunnerRespawnDescriptorV1Schema),
  // Durable marker that a connected-service auth switch has entered the gated restart primitive.
  connectedServiceRestartIntent: z.optional(z.object({
    v: z.literal(1),
    requestedAtMs: z.number().check(z.int(), z.nonnegative()),
  })),
  // Stable private authority-document path only. The scoped capability is
  // atomically rotated inside that document and must never enter the marker.
  agentRuntimeDaemonServiceAuthorityFilePath:
    z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(32_768))),
  activeTurnId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
  // Agents the runner's per-Session holders keep, by role. A crashed runner's
  // live primary Agent is spared and handed to its respawned runner.
  heldAgentsV1: z.optional(z.array(z.strictObject({
    role: z.literal('primary'),
    socketPath: z.string().check(z.minLength(1), z.maxLength(4096)),
    holderPid: z.number().check(z.int(), z.positive()),
    agentPid: z.number().check(z.int(), z.positive()),
    // A target-held Agent: the relay its runner reaches the target through (served again after a daemon restart).
    relaySocketPath: z.optional(z.string().check(z.minLength(1), z.maxLength(4096))),
  })).check(z.maxLength(1))),
  agentRuntimeDaemonServiceActiveAdmission: z.optional(z.strictObject({
    turnId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
    inputId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
    userMessageSeq: z.nullable(z.number().check(z.int(), z.nonnegative())),
    userMessageSeqs:
      z.array(z.number().check(z.int(), z.nonnegative())).check(z.maxLength(4_096)),
  })),
  agentRuntimeDaemonServiceSessionOpenAttestation:
    z.optional(AgentRuntimeDaemonServiceSessionOpenAttestationV1Schema),
  // Non-secret byte-retention facts for the exact live runner. Destructive
  // managed-dependency owners revalidate the marker's process identity before
  // consulting these pins; effect authority remains in the private document.
  runnerAgentSourceCustodyV1: z.optional(PluginSourceCustodyV1Schema),
  materializedStateObservationBinding:
    z.optional(ConnectedServiceMaterializedStateObservationBindingSchema),
  runnerManagedDependencyRetentionV1:
    z.optional(RunnerManagedDependencyRetentionV1Schema),
  // Required startup identity persisted before runtime open; not proof of application.
  agentSessionStartupInstructionsMarkerV1:
    z.optional(AgentSessionStartupInstructionsMarkerV1Schema),
}).check(z.superRefine((marker, context) => {
  if (
    marker.agentRuntimeDaemonServiceActiveAdmission
    && marker.agentRuntimeDaemonServiceActiveAdmission.turnId
      !== marker.activeTurnId
  ) {
    context.addIssue({
      code: "custom",
      path: ['agentRuntimeDaemonServiceActiveAdmission', 'turnId'],
      message:
        'Runner Agent daemon-service admission must match the active turn',
    });
  }
})));

type StoredDaemonSessionMarker = Omit<z.infer<typeof DaemonSessionMarkerSchema>, 'materializedStateObservationBinding'> & {
  materializedStateObservationBinding?: ConnectedServiceMaterializedStateObservationBinding;
};
/** A Session marker as read: the file name is the Session's tracking key and is never stored in the body. */
export type DaemonSessionMarker = StoredDaemonSessionMarker & Readonly<{ trackingKey: SessionTrackingKey }>;

function sessionMarkerFileName(trackingKey: SessionTrackingKey): string {
  return `${trackingKey}.json`;
}

function withTrackingKey(stored: StoredDaemonSessionMarker, trackingKey: SessionTrackingKey): DaemonSessionMarker {
  return { ...stored, trackingKey };
}
const DaemonSessionMarkerStoredReadSchema = createStoredReadSchema(DaemonSessionMarkerSchema);
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

export { hashProcessCommand } from '@happier-dev/cli-common/processInstance';

type SessionMarkerReadScope = Pick<typeof configuration, 'happyHomeDir' | 'publicReleaseRing'>;

function daemonSessionsDir(scope: SessionMarkerReadScope = configuration): string {
  return join(
    scope.happyHomeDir,
    'tmp',
    resolveReleaseRingScopedBasename('daemon-sessions', scope.publicReleaseRing),
  );
}

function daemonSessionMarkerDirs(scope: SessionMarkerReadScope = configuration): string[] {
  const primaryDir = daemonSessionsDir(scope);
  const legacyPreviewDir = join(scope.happyHomeDir, 'tmp', 'daemon-sessions.preview');
  return primaryDir === legacyPreviewDir ? [primaryDir] : [primaryDir, legacyPreviewDir];
}

const sessionMarkerMutationLocks = new Map<SessionTrackingKey, Promise<void>>();
const SESSION_MARKER_LOCK_TIMEOUT_MS = 5_000;
const SESSION_MARKER_LOCK_STALE_MS = 30_000;

async function runWithSessionMarkerMutationLock<T>(trackingKey: SessionTrackingKey, task: () => Promise<T>): Promise<T> {
  const previous = sessionMarkerMutationLocks.get(trackingKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  sessionMarkerMutationLocks.set(trackingKey, next);
  await previous.catch(() => undefined);
  try {
    return await withJsonOwnerFileLock({
      lockPath: join(daemonSessionsDir(), `${sessionMarkerFileName(trackingKey)}.lock`),
      timeoutMs: SESSION_MARKER_LOCK_TIMEOUT_MS,
      staleAfterMs: SESSION_MARKER_LOCK_STALE_MS,
      errorCode: 'SESSION_MARKER_MUTATION_LOCK_TIMEOUT',
      readProcessStartedAtMs: async (ownerPid) =>
        (await readProcessIdentityByPid(ownerPid))?.processStartTimeMs ?? null,
    }, task);
  } finally {
    release();
    if (sessionMarkerMutationLocks.get(trackingKey) === next) {
      sessionMarkerMutationLocks.delete(trackingKey);
    }
  }
}


async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export type WriteSessionMarkerOptions = Readonly<{
  preserveConnectedServiceRestartIntent?: boolean;
  preserveActiveTurnId?: boolean;
  preserveRunnerAgentSourceCustody?: boolean;
  preserveRunnerManagedDependencyRetention?: boolean;
  preserveMaterializedStateObservationBinding?: boolean;
  /** The held-Agent owner replaces the list itself; every other writer keeps it. */
  preserveHeldAgents?: boolean;
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

export function isPidPlaceholderSessionId(value: string): boolean {
  return /^PID-\d+$/u.test(value);
}

function sessionMarkerProcessOwnershipMatches(
  marker: Pick<DaemonSessionMarker, 'happySessionId' | 'processStartTimeMs'>,
  expected: Readonly<{
    happySessionId: string;
    processStartTimeMs: number;
  }>,
): boolean {
  return marker.happySessionId === expected.happySessionId
    && processGenerationMatches(
      marker.processStartTimeMs,
      expected.processStartTimeMs,
    );
}

function sessionMarkerRunnerMutationMatches(
  marker: DaemonSessionMarker,
  expected: Readonly<{
    pid: number;
    sessionId: string;
    processStartTimeMs: number;
    processCommandHash: string;
  }>,
): boolean {
  return marker.happySessionId === expected.sessionId
    && processIdentityMatches(marker, expected);
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
  const filePath = join(daemonSessionsDir(), sessionMarkerFileName(marker.trackingKey));

  let createdAtFromDisk: number | undefined;
  let existingMarkerFromDisk: DaemonSessionMarker | null = null;
  try {
    const raw = await readFile(filePath, 'utf-8');
    const existing = DaemonSessionMarkerStoredReadSchema.safeParse(JSON.parse(raw));
    if (existing.success) {
      existingMarkerFromDisk = withTrackingKey(existing.data, marker.trackingKey);
      createdAtFromDisk = existing.data.createdAt;
    }
  } catch (e) {
    // ignore ENOENT (new marker); log other errors for diagnostics
    const err = e as NodeJS.ErrnoException;
    if (err?.code !== 'ENOENT') {
      logger.debug(`[sessionRegistry] Could not read existing session marker ${sessionMarkerFileName(marker.trackingKey)} to preserve createdAt`, e);
    }
  }

  const canonicalAdoptionRequested =
    options.adoptCanonicalSessionIdFromPidPlaceholder === true;
  if (canonicalAdoptionRequested) {
    const canonicalSessionId = marker.happySessionId.trim();
    const existingSessionId = existingMarkerFromDisk?.happySessionId ?? '';
    const incomingProcessCommandHash = marker.processCommandHash;
    const incomingProcessStartTimeMs = marker.processStartTimeMs;
    const identityMatches =
      existingMarkerFromDisk !== null
      && incomingProcessStartTimeMs !== undefined
      && processIdentityMatches(existingMarkerFromDisk, {
        pid: marker.pid,
        processStartTimeMs: incomingProcessStartTimeMs,
        processCommandHash: incomingProcessCommandHash,
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
      logger.debug('[sessionRegistry] Canonical adoption ownership mismatch', {
        pid: marker.pid,
        canonicalIdValid: Boolean(canonicalSessionId) && !isPidPlaceholderSessionId(canonicalSessionId),
        existingMarkerPresent: existingMarkerFromDisk !== null,
        placeholderOrSameSession: sessionIdentityCanAdopt,
        noncePresent: existingSpawnNonce.length > 0 && incomingSpawnNonce.length > 0,
        nonceEqual: spawnNonceMatches,
        existingStartWitnessPresent: existingMarkerFromDisk?.processStartTimeMs !== undefined,
        incomingStartWitnessPresent: incomingProcessStartTimeMs !== undefined,
        startWitnessEqual: processGenerationMatches(existingMarkerFromDisk?.processStartTimeMs, incomingProcessStartTimeMs),
        commandHashEqual: Boolean(existingMarkerFromDisk?.processCommandHash)
          && existingMarkerFromDisk?.processCommandHash === incomingProcessCommandHash,
      });
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
    && marker.processStartTimeMs !== undefined
    && sessionMarkerProcessOwnershipMatches(
      existingMarkerFromDisk,
      {
        happySessionId: marker.happySessionId,
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
    && marker.processStartTimeMs !== undefined
    && sessionMarkerProcessOwnershipMatches(
      existingMarkerFromDisk,
      {
        happySessionId: marker.happySessionId,
        processStartTimeMs: marker.processStartTimeMs,
      },
    )
      ? existingMarkerFromDisk.respawn
      : undefined;
  const existingRunnerAgentSourceCustody =
    options.preserveRunnerAgentSourceCustody !== false
    &&
    existingMarkerFromDisk?.runnerAgentSourceCustodyV1
    && marker.processStartTimeMs !== undefined
    && sessionMarkerProcessOwnershipMatches(
      existingMarkerFromDisk,
      {
        happySessionId: marker.happySessionId,
        processStartTimeMs: marker.processStartTimeMs,
      },
    )
      ? existingMarkerFromDisk.runnerAgentSourceCustodyV1
      : undefined;
  if (
    existingRunnerAgentSourceCustody
    && marker.runnerAgentSourceCustodyV1
    && !pluginSourceCustodyV1Equal(
      marker.runnerAgentSourceCustodyV1,
      existingRunnerAgentSourceCustody,
    )
  ) {
    throw new Error(
      'Runner Agent source custody cannot change for the same process identity',
    );
  }
  const preservedRunnerAgentSourceCustody =
    marker.runnerAgentSourceCustodyV1 === undefined
      ? existingRunnerAgentSourceCustody
      : undefined;
  const preservedMaterializedStateObservationBinding =
    options.preserveMaterializedStateObservationBinding !== false
    && marker.materializedStateObservationBinding === undefined
    && existingMarkerFromDisk?.materializedStateObservationBinding
    && marker.processStartTimeMs !== undefined
    && (canonicalAdoptionRequested || sessionMarkerProcessOwnershipMatches(existingMarkerFromDisk, {
      happySessionId: marker.happySessionId,
      processStartTimeMs: marker.processStartTimeMs,
    }))
      ? existingMarkerFromDisk.materializedStateObservationBinding
      : undefined;
  const incomingRequesterAttribution = marker.requesterWorkAttributionV1
    ? RequesterWorkAttributionV1Schema.parse(marker.requesterWorkAttributionV1)
    : undefined;
  const existingRequesterAttribution = existingMarkerFromDisk?.requesterWorkAttributionV1
    && marker.processStartTimeMs !== undefined
    && (canonicalAdoptionRequested || sessionMarkerProcessOwnershipMatches(existingMarkerFromDisk, {
      happySessionId: marker.happySessionId, processStartTimeMs: marker.processStartTimeMs,
    }))
      ? existingMarkerFromDisk.requesterWorkAttributionV1 : undefined;
  if (incomingRequesterAttribution && existingRequesterAttribution
    && !isDeepStrictEqual(incomingRequesterAttribution, existingRequesterAttribution)) {
    throw new Error('session_marker_requester_attribution_conflict');
  }
  const requesterWorkAttributionV1 = incomingRequesterAttribution ?? existingRequesterAttribution;
  const retainedLinuxLaunchUnit = existingMarkerFromDisk?.linuxLaunchUnit
    && marker.processStartTimeMs !== undefined
    && (canonicalAdoptionRequested || sessionMarkerProcessOwnershipMatches(existingMarkerFromDisk, {
      happySessionId: marker.happySessionId, processStartTimeMs: marker.processStartTimeMs,
    })) ? existingMarkerFromDisk.linuxLaunchUnit : undefined;
  // The runner's held Agents survive it: a respawned runner or a restarted daemon adopts them
  // from this record, so a refresh of the same runner process keeps it.
  const preservedHeldAgents =
    options.preserveHeldAgents !== false
    && marker.heldAgentsV1 === undefined
    && existingMarkerFromDisk?.heldAgentsV1?.length
    && marker.processStartTimeMs !== undefined
    && sessionMarkerProcessOwnershipMatches(existingMarkerFromDisk, {
      happySessionId: marker.happySessionId,
      processStartTimeMs: marker.processStartTimeMs,
    })
      ? existingMarkerFromDisk.heldAgentsV1
      : undefined;
  const { trackingKey: _trackingKey, ...markerBody } = marker;
  const payload: StoredDaemonSessionMarker = DaemonSessionMarkerSchema.parse({
    ...(preservedHeldAgents ? { heldAgentsV1: preservedHeldAgents } : {}),
    ...markerBody,
    ...(marker.linuxLaunchUnit ?? retainedLinuxLaunchUnit ? { linuxLaunchUnit: marker.linuxLaunchUnit ?? retainedLinuxLaunchUnit } : {}),
    ...(requesterWorkAttributionV1 ? { requesterWorkAttributionV1 } : {}),
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
    ...(marker.sessionRunnerStartingMode === undefined
      && existingMarkerFromDisk?.sessionRunnerStartingMode !== undefined
      && marker.processStartTimeMs !== undefined
      && sessionMarkerProcessOwnershipMatches(existingMarkerFromDisk, {
        happySessionId: marker.happySessionId,
        processStartTimeMs: marker.processStartTimeMs,
      })
      ? { sessionRunnerStartingMode: existingMarkerFromDisk.sessionRunnerStartingMode }
      : {}),
    ...(preservedRunnerAgentSourceCustody
      ? {
          runnerAgentSourceCustodyV1: preservedRunnerAgentSourceCustody,
        }
      : {}),
    ...(preservedMaterializedStateObservationBinding
      ? { materializedStateObservationBinding: preservedMaterializedStateObservationBinding }
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
  await runWithSessionMarkerMutationLock(marker.trackingKey, () => writeSessionMarkerUnlocked(marker, options));
}

export async function updateSessionMarkerAgentSessionStartupInstructionsMarker(
  params: Readonly<{
    trackingKey: SessionTrackingKey;
    sessionId: string;
    marker: AgentSessionStartupInstructionsMarkerV1;
    expectedSpawnNonce?: string;
  }>,
): Promise<boolean> {
  return await runWithSessionMarkerMutationLock(params.trackingKey, async () => {
    const existing = await readSessionMarker(params.trackingKey);
    const sessionId = params.sessionId.trim();
    const expectedSpawnNonce = params.expectedSpawnNonce?.trim() ?? '';
    const canAdoptCanonicalSessionId =
      existing?.happySessionId === `PID-${existing?.pid}`
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
    trackingKey: SessionTrackingKey;
    sessionId: string;
    processCommandHash: string;
    processStartTimeMs: number;
    authorityFilePath: string;
  }>,
): Promise<boolean> {
  return await runWithSessionMarkerMutationLock(params.trackingKey, async () => {
    const existing = await readSessionMarker(params.trackingKey);
    if (
      !existing
      || !sessionMarkerRunnerMutationMatches(existing, params)
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
    trackingKey: SessionTrackingKey;
    sessionId: string;
    processCommandHash: string;
    processStartTimeMs: number;
    authorityFilePath: string;
    sourceCustody?: PluginSourceCustodyV1;
    retention?: RunnerManagedDependencyRetentionV1;
  }>,
): Promise<boolean> {
  if (
    (params.sourceCustody === undefined)
    !== (params.retention === undefined)
  ) {
    return false;
  }
  const expectedRetention = params.retention
    ? RunnerManagedDependencyRetentionV1Schema.parse(params.retention)
    : undefined;
  return await runWithSessionMarkerMutationLock(params.trackingKey, async () => {
    const existing = await readSessionMarker(params.trackingKey);
    if (
      !existing
      || !sessionMarkerRunnerMutationMatches(existing, params)
      || existing.agentRuntimeDaemonServiceAuthorityFilePath
        !== params.authorityFilePath
      || (
        params.sourceCustody !== undefined
        && (
          !existing.runnerAgentSourceCustodyV1
          || !pluginSourceCustodyV1Equal(
            existing.runnerAgentSourceCustodyV1,
            params.sourceCustody,
          )
          || !isDeepStrictEqual(
            existing.runnerManagedDependencyRetentionV1,
            expectedRetention,
          )
        )
      )
    ) {
      return false;
    }
    if (params.sourceCustody === undefined) {
      const {
        agentRuntimeDaemonServiceAuthorityFilePath: _authorityFilePath,
        agentRuntimeDaemonServiceSessionOpenAttestation: _sessionOpenAttestation,
        materializedStateObservationBinding: _materializedStateObservationBinding,
        happyHomeDir: _happyHomeDir,
        updatedAt: _updatedAt,
        ...rest
      } = existing;
      await writeSessionMarkerUnlocked(rest, { preserveMaterializedStateObservationBinding: false });
      return true;
    }
    const {
      agentRuntimeDaemonServiceAuthorityFilePath: _authorityFilePath,
      agentRuntimeDaemonServiceSessionOpenAttestation: _sessionOpenAttestation,
      runnerAgentSourceCustodyV1: _sourceCustody,
      runnerManagedDependencyRetentionV1: _retention,
      materializedStateObservationBinding: _materializedStateObservationBinding,
      happyHomeDir: _happyHomeDir,
      updatedAt: _updatedAt,
      ...rest
    } = existing;
    await writeSessionMarkerUnlocked(rest, {
      preserveRunnerAgentSourceCustody: false,
      preserveRunnerManagedDependencyRetention: false,
      preserveMaterializedStateObservationBinding: false,
    });
    return true;
  });
}

export async function updateSessionMarkerRunnerManagedDependencyRetention(
  params: Readonly<{
    pid: number;
    trackingKey: SessionTrackingKey;
    sessionId: string;
    processCommandHash: string;
    processStartTimeMs: number;
    retention: RunnerManagedDependencyRetentionV1;
  }>,
): Promise<boolean> {
  return await runWithSessionMarkerMutationLock(params.trackingKey, async () => {
    const existing = await readSessionMarker(params.trackingKey);
    if (
      !existing
      || !sessionMarkerRunnerMutationMatches(existing, params)
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
    trackingKey: SessionTrackingKey;
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
  return await runWithSessionMarkerMutationLock(params.trackingKey, async () => {
    const existing = await readSessionMarker(params.trackingKey);
    if (
      !existing
      || !sessionMarkerRunnerMutationMatches(existing, params)
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

export async function updateSessionMarkerRunnerAgentSourceCustody(
  params: Readonly<{
    pid: number;
    trackingKey: SessionTrackingKey;
    sessionId: string;
    processCommandHash: string;
    processStartTimeMs: number;
    sourceCustody: PluginSourceCustodyV1;
    materializedStateObservationBinding?: ConnectedServiceMaterializedStateObservationBinding;
    requesterWorkAttributionV1?: RequesterWorkAttributionV1;
  }>,
): Promise<boolean> {
  return await runWithSessionMarkerMutationLock(params.trackingKey, async () => {
    const existing = await readSessionMarker(params.trackingKey);
    if (
      !existing
      || !sessionMarkerRunnerMutationMatches(existing, params)
      || (
        existing.runnerAgentSourceCustodyV1 !== undefined
        && !pluginSourceCustodyV1Equal(
          existing.runnerAgentSourceCustodyV1,
          params.sourceCustody,
        )
      )
      || (params.requesterWorkAttributionV1 !== undefined
        && existing.requesterWorkAttributionV1 !== undefined
        && !isDeepStrictEqual(existing.requesterWorkAttributionV1, params.requesterWorkAttributionV1))
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
      runnerAgentSourceCustodyV1: params.sourceCustody,
      ...(params.materializedStateObservationBinding
        ? { materializedStateObservationBinding: params.materializedStateObservationBinding } : {}),
      ...(params.requesterWorkAttributionV1
        ? { requesterWorkAttributionV1: params.requesterWorkAttributionV1 } : {}),
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
    trackingKey: SessionTrackingKey;
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
    params.trackingKey,
    async () => {
      const marker =
        await readSessionMarker(params.trackingKey);
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
  trackingKey: SessionTrackingKey,
  ownership?: SessionMarkerOwnership & Readonly<{ isStillOwned?: () => boolean; startedBy?: 'terminal' }>,
): Promise<boolean> {
  let removed = false;
  for (const dir of daemonSessionMarkerDirs()) {
    const filePath = join(dir, sessionMarkerFileName(trackingKey));
    try {
      let marker: StoredDaemonSessionMarker | null = null;
      try {
        const raw = await readFile(filePath, 'utf-8');
        const parsed = DaemonSessionMarkerStoredReadSchema.safeParse(JSON.parse(raw));
        if (parsed.success && parsed.data.happyHomeDir === configuration.happyHomeDir) {
          marker = parsed.data;
        }
      } catch {
        // Marker removal must not be blocked by stale or malformed marker contents.
      }
      if (ownership) {
        if (
          marker?.happySessionId !== ownership.happySessionId
          || (ownership.startedBy !== undefined && marker.startedBy !== ownership.startedBy)
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
      // The runner is gone: retire its same-machine Session RPC endpoint (only if still its own)
      // and end this process's in-flight local calls to it.
      if (marker?.happySessionId) await retireGoneLocalSessionRpcHost({ sessionId: marker.happySessionId, pid: marker.pid });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code !== 'ENOENT') {
        logger.debug(`[sessionRegistry] Failed to remove session marker ${sessionMarkerFileName(trackingKey)}`, e);
      }
    }
  }
  return removed;
}

export async function removeSessionMarker(trackingKey: SessionTrackingKey): Promise<void> {
  await runWithSessionMarkerMutationLock(trackingKey, () => removeSessionMarkerUnlocked(trackingKey));
}

export async function removeSessionMarkerIfOwned(params: Readonly<{
  trackingKey: SessionTrackingKey;
  happySessionId: string;
  processCommandHash?: string;
  processStartTimeMs?: number;
  isStillOwned?: () => boolean;
  startedBy?: 'terminal';
}>): Promise<boolean> {
  return await runWithSessionMarkerMutationLock(params.trackingKey, () => removeSessionMarkerUnlocked(params.trackingKey, {
    happySessionId: params.happySessionId,
    processCommandHash: params.processCommandHash,
    processStartTimeMs: params.processStartTimeMs,
    isStillOwned: params.isStillOwned,
    startedBy: params.startedBy,
  }));
}

/**
 * Moves a Session marker from its launcher (wrapper) process to the runner it
 * started. The marker stays the Session's own file (named by its tracking
 * key); only the hosting process fields change.
 */
export async function promoteSessionMarkerPid(
  params: Readonly<{
    trackingKey: SessionTrackingKey;
    fromPid: number;
    toPid: number;
  }>,
  dependencies: Readonly<{
    readProcessIdentityByPidFn?: typeof readProcessIdentityByPid;
  }> = {},
): Promise<SessionMarkerPromotionResult | null> {
  const { trackingKey, fromPid, toPid } = params;
  if (fromPid === toPid) {
    return {
      sourceMarkerOwnership: null,
      targetMarkerOwnership: null,
    };
  }

  return await runWithSessionMarkerMutationLock(trackingKey, async () => {
    const marker = await readSessionMarker(trackingKey);
    if (!marker) {
      return {
        sourceMarkerOwnership: null,
        targetMarkerOwnership: null,
      };
    }
    const ownershipOf = (value: DaemonSessionMarker): SessionMarkerOwnership => ({
      happySessionId: value.happySessionId,
      ...(value.processCommandHash
        ? { processCommandHash: value.processCommandHash }
        : {}),
      ...(value.processStartTimeMs !== undefined
        ? { processStartTimeMs: value.processStartTimeMs }
        : {}),
    });
    if (marker.pid === toPid) {
      // Already promoted (a joined duplicate report).
      return {
        sourceMarkerOwnership: null,
        targetMarkerOwnership: ownershipOf(marker),
        ...(marker.processCommand
          ? { targetProcessCommand: marker.processCommand }
          : {}),
      };
    }
    if (marker.pid !== fromPid) return null;
    const sourceMarkerOwnership = ownershipOf(marker);

    const {
      happyHomeDir: _happyHomeDir,
      pid: _previousPid,
      updatedAt: _updatedAt,
      connectedServiceRestartIntent: _connectedServiceRestartIntent,
      processCommandHash: _sourceProcessCommandHash,
      processStartTimeMs: _sourceProcessStartTimeMs,
      processCommand: _sourceProcessCommand,
      ...markerInput
    } = marker;
    const targetProcessIdentity = await (
      dependencies.readProcessIdentityByPidFn ?? readProcessIdentityByPid
    )(toPid);
    const targetProcessCommand = targetProcessIdentity?.command.trim() ?? '';
    const promotedProcessIdentity =
      targetProcessIdentity?.processStartTimeMs !== undefined
        ? {
            processStartTimeMs: targetProcessIdentity.processStartTimeMs,
            ...(targetProcessCommand ? {
              processCommand: targetProcessCommand,
              processCommandHash: hashProcessCommand(targetProcessCommand),
            } : {}),
          }
        : null;
    await writeSessionMarkerUnlocked({
      ...markerInput,
      pid: toPid,
      createdAt: marker.createdAt,
      ...(promotedProcessIdentity ?? {}),
    });
    return {
      sourceMarkerOwnership,
      targetMarkerOwnership: {
        happySessionId: marker.happySessionId,
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

export async function readSessionMarker(trackingKey: SessionTrackingKey,
  scope: SessionMarkerReadScope = configuration,
): Promise<DaemonSessionMarker | null> {
  for (const dir of daemonSessionMarkerDirs(scope)) {
    const filePath = join(dir, sessionMarkerFileName(trackingKey));
    try {
      const raw = await readFile(filePath, 'utf-8');
      const parsed = DaemonSessionMarkerStoredReadSchema.safeParse(JSON.parse(raw));
      if (parsed.success && parsed.data.happyHomeDir === scope.happyHomeDir) {
        return withTrackingKey(parsed.data, trackingKey);
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code !== 'ENOENT') {
        logger.debug(`[sessionRegistry] Could not read session marker ${sessionMarkerFileName(trackingKey)}`, e);
      }
    }
  }
  return null;
}

export async function markSessionMarkerConnectedServiceRestartIntent(params: Readonly<{
  trackingKey: SessionTrackingKey;
  requestedAtMs?: number;
}>): Promise<boolean> {
  return await runWithSessionMarkerMutationLock(params.trackingKey, async () => {
    const existing = await readSessionMarker(params.trackingKey);
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

export async function clearSessionMarkerConnectedServiceRestartIntent(trackingKey: SessionTrackingKey): Promise<void> {
  await runWithSessionMarkerMutationLock(trackingKey, async () => {
    const existing = await readSessionMarker(trackingKey);
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

/** Records the runner's held Agents (replacing the previous list); false when the marker is not this Session's. */
export async function updateSessionMarkerHeldAgents(params: Readonly<{
  trackingKey: SessionTrackingKey;
  sessionId: string;
  heldAgentsV1: readonly SessionHeldAgentV1[];
}>): Promise<boolean> {
  return await runWithSessionMarkerMutationLock(params.trackingKey, async () => {
    const existing = await readSessionMarker(params.trackingKey);
    if (!existing || existing.happySessionId !== params.sessionId) return false;
    const { happyHomeDir: _happyHomeDir, updatedAt: _updatedAt, heldAgentsV1: _previous, ...rest } = existing;
    await writeSessionMarkerUnlocked({ ...rest, ...(params.heldAgentsV1.length ? { heldAgentsV1: [...params.heldAgentsV1] } : {}) },
      { preserveHeldAgents: false });
    return true;
  });
}

export async function updateSessionMarkerActiveTurn(params: Readonly<{
  trackingKey: SessionTrackingKey;
  sessionId: string;
  activeTurnId: string | null;
  expectedActiveTurnId?: string;
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
  return await runWithSessionMarkerMutationLock(params.trackingKey, async () => {
    const existing = await readSessionMarker(params.trackingKey);
    if (!existing || existing.happySessionId !== params.sessionId) return false;
    if (params.expectedActiveTurnId !== undefined && existing.activeTurnId !== params.expectedActiveTurnId) {
      return false;
    }
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
    trackingKey: SessionTrackingKey;
    sessionId: string;
    authorityFilePath: string;
    attestation:
      AgentRuntimeDaemonServiceSessionOpenAttestationV1;
  }>,
): Promise<boolean> {
  return await runWithSessionMarkerMutationLock(params.trackingKey, async () => {
    const existing = await readSessionMarker(params.trackingKey);
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

/**
 * The tracking key of the marker a runner process holds for one of its
 * Sessions. A runner addresses its own marker by (process, Session); the
 * daemon addresses it by key.
 */
export async function findSessionMarkerTrackingKey(
  params: Readonly<{ pid: number; sessionId: string }>,
  scope: SessionMarkerReadScope = configuration,
): Promise<SessionTrackingKey | null> {
  for (const dir of daemonSessionMarkerDirs(scope)) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      const trackingKey = name.endsWith('.json') ? parseSessionTrackingKey(name.slice(0, -'.json'.length)) : null;
      if (!trackingKey) continue;
      const marker = await readSessionMarker(trackingKey, scope);
      if (marker?.pid === params.pid && marker.happySessionId === params.sessionId) return trackingKey;
    }
  }
  return null;
}

export async function listSessionMarkers(options: Readonly<{
  requireComplete?: boolean;
}> = {}): Promise<DaemonSessionMarker[]> {
  const markerByKey = new Map<SessionTrackingKey, DaemonSessionMarker>();
  for (const dir of daemonSessionMarkerDirs()) {
    await ensureDir(dir);
    const entries = await readdir(dir);
    for (const name of entries) {
      const trackingKey = name.endsWith('.json') ? parseSessionTrackingKey(name.slice(0, -'.json'.length)) : null;
      if (!trackingKey) continue;
      const full = join(dir, name);
      try {
        const raw = await readFile(full, 'utf-8');
        const parsed = DaemonSessionMarkerStoredReadSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) {
          if (options.requireComplete) throw parsed.error;
          logger.debug(`[sessionRegistry] Failed to parse session marker ${name}`, parsed.error);
          continue;
        }
        // Extra safety: only accept markers for our home dir.
        if (parsed.data.happyHomeDir !== configuration.happyHomeDir) continue;
        const existing = markerByKey.get(trackingKey);
        if (!existing || parsed.data.updatedAt > existing.updatedAt) {
          markerByKey.set(trackingKey, withTrackingKey(parsed.data, trackingKey));
        }
      } catch (e) {
        if (options.requireComplete) {
          throw new Error('session_marker_inventory_incomplete', { cause: e });
        }
        logger.debug(`[sessionRegistry] Failed to read or parse session marker ${name}`, e);
        // ignore unreadable marker
      }
    }
  }
  return Array.from(markerByKey.values());
}
