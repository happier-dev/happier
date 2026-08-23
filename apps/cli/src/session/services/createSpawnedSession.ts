import type {
  AcpConfigOptionOverridesV1,
  BackendTargetRefV1,
  ConnectedServiceBindingsV1,
  SessionMcpSelectionV1,
  SessionSpawnSourceContextV1,
} from '@happier-dev/protocol';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createPendingFirstInput } from '@/daemon/spawn/pendingFirstInput';

import { resolveDaemonSpawnSessionByNonce, spawnDaemonSession } from '@/daemon/controlClient';
import type { Credentials } from '@/persistence';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { SpawnDaemonSessionRequestSchema, type SpawnDaemonSessionRequest } from '@/rpc/handlers/spawnSessionOptionsContract';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { fetchSessionById, getOrCreateSessionByTag } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { summarizeSessionRecord, type SessionSummary } from '@/cli/output/session/sessionSummary';
import { delay } from '@/utils/time';
import { abandonSpawnedSessionBestEffort, awaitSpawnedSessionId, type SpawnSessionNonceResolver } from './awaitSpawnedSessionId';
import { requestSessionStop } from './requestSessionStop';
import { archiveSessionByIdBestEffort } from './setSessionArchivedState';
import {
  createConnectedServiceChildLaunchContext,
  type ConnectedServiceChildLaunchContext,
} from '@/session/fork/connectedServiceForkLaunchContext';

/**
 * In-process spawn transport for an ingress that already runs inside the
 * daemon.
 *
 * The default transport is the daemon control client, an HTTP call to the
 * daemon's own control server. The machine-RPC replay ingresses run inside that
 * same daemon and hold the in-process `spawnSession` handler, so routing them
 * back through HTTP would be a self-call. They inject their handler here
 * instead, merging their own ingress-specific spawn options inside the adapter.
 *
 * The successor tree carries the same seam under the same name; keep the shapes
 * aligned so the trees converge.
 */
export type DirectSpawnedSessionTransport = Readonly<{
  spawn: (request: SpawnDaemonSessionRequest) => Promise<unknown>;
  resolveSpawnSessionByNonce?: SpawnSessionNonceResolver;
}>;

/**
 * Immutable source lineage a Replay-seeded child is created from.
 *
 * Reused on the create path (persisted into the child's `forkV1`/`replaySeedV1`)
 * and on the rejoin path (authenticating that a reused creation identity names
 * the same source recipe before the child is used).
 */
export type ReplaySeededCreationSourceRecipe = Readonly<{
  sourceSessionId: string;
  cutoffSeqInclusive: number;
}>;

/**
 * Replay-seeded creation mode for the canonical creator.
 *
 * The Session row is committed here, with the canonical creation metadata
 * already composed by `buildReplaySeededSpawnRecipe`, and the launched runner
 * attaches to that exact row. This replaces the retired duplicate replay-seeded
 * row creator so one owner holds row creation, create-or-rejoin settlement, and
 * orphan cleanup for every Replay ingress.
 */
export type ReplaySeededSessionCreationV1 = Readonly<{
  /**
   * Durable per-attempt creation identity owned by the invoking ingress. Each
   * ingress keeps its existing retry key — `replay:<source>:<cutoff>:<uuid>` for
   * the continuation ingresses and `fork:<parent>:<cutoff>:<uuid>` for the fork
   * replay branch. This owner never invents or rewrites one.
   */
  tag: string;
  /** Legacy creation-metadata `flavor` recorded for the child. */
  agentId: string;
  /** Canonical creation metadata from `buildReplaySeededSpawnRecipe`. */
  metadata: Record<string, unknown>;
  sourceRecipe: ReplaySeededCreationSourceRecipe;
}>;

export type CreateSpawnedSessionParams = Readonly<{
  credentials: Credentials;
  directory: string;
  machineId?: string;
  backendTarget: BackendTargetRefV1;
  modelId?: string;
  modelUpdatedAt?: number;
  permissionMode?: string;
  permissionModeUpdatedAt?: number;
  agentModeId?: string;
  agentModeUpdatedAt?: number;
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
  title?: string;
  tag?: string;
  initialMessage?: string;
  profileId?: string;
  environmentVariables?: Record<string, string>;
  connectedServices?: ConnectedServiceBindingsV1;
  connectedServicesUpdatedAt?: number;
  mcpSelection?: SessionMcpSelectionV1;
  transcriptStorage?: 'persisted' | 'direct';
  terminal?: SpawnDaemonSessionRequest['terminal'];
  windowsRemoteSessionLaunchMode?: SpawnDaemonSessionRequest['windowsRemoteSessionLaunchMode'];
  windowsRemoteSessionConsole?: SpawnDaemonSessionRequest['windowsRemoteSessionConsole'];
  windowsTerminalWindowName?: string;
  codexBackendMode?: SpawnDaemonSessionRequest['codexBackendMode'];
  agentRuntimeDescriptorV1?: SpawnDaemonSessionRequest['agentRuntimeDescriptorV1'];
  approvedNewDirectoryCreation?: boolean;
  /** Stable caller-owned identity for one launch attempt. */
  spawnNonce?: string;
  /** Caller-owned pending first-input custody; preserved exactly when supplied. */
  pendingFirstInput?: SpawnDaemonSessionRequest['pendingFirstInput'];
  resume?: string;
  experimentalCodexAcp?: boolean;
  /**
   * Raw source intent retained only for canonical existing-row and settled-child
   * validation. It is Action-private creator input, not a new RPC field.
   */
  sourceContext?: SessionSpawnSourceContextV1;
  /**
   * Commit the Session row here, seeded from a resolved Replay recipe, and
   * attach the launched runner to it. Absent for ordinary authoring, where the
   * runner bootstrap creates the row.
   */
  replaySeededCreation?: ReplaySeededSessionCreationV1;
  /**
   * A fork's already-minted child launch projection. The fork and the
   * replay-seeded creator share this one projection so the committed row and
   * the direct spawn attach to it with the same identity.
   */
  connectedServiceChildLaunch?: ConnectedServiceChildLaunchContext;
  /** Resolve an already-submitted launch attempt without sending another spawn. */
  resumeOnly?: boolean;
  /** In-daemon transport for an ingress that must not self-call over HTTP. */
  directTransport?: DirectSpawnedSessionTransport;
  /** Tracked-operation cooperative cancellation; never kills a spawned process. */
  signal?: AbortSignal;
}>;

const DEFAULT_SPAWNED_SESSION_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_SPAWNED_SESSION_FETCH_POLL_INTERVAL_MS = 200;
const SPAWN_TRANSIENT_ERROR_MARKERS = [
  'Request failed: /spawn-session, The socket connection was closed unexpectedly',
] as const;

// This is deliberately the creator's *cleanup* projection, not a second
// daemon outcome model. The daemon's nonce registry owns accepted attempts;
// there is no protocol-level phase bit for an error response. Keep this list
// limited to codes whose current daemon producers return before a child is
// admitted. Unknown, legacy, transport, and post-admission codes must retain
// the fresh row because they can still name a live child.
const DEFINITE_REPLAY_SEEDED_PRE_ADMISSION_ERROR_CODES = new Set<string>([
  SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
  SPAWN_SESSION_ERROR_CODES.INVALID_ENVIRONMENT_VARIABLES,
  SPAWN_SESSION_ERROR_CODES.AUTH_ENV_UNEXPANDED,
  SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
  SPAWN_SESSION_ERROR_CODES.RESUME_MISSING_ENCRYPTION_KEY,
  SPAWN_SESSION_ERROR_CODES.DIRECTORY_CREATE_FAILED,
  SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
]);

function resolvePositiveIntFromEnv(key: string, fallback: number): number {
  const raw = String(process.env[key] ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

async function waitForSpawnedSessionVisibility(params: Readonly<{
  token: string;
  sessionId: string;
  timeoutMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
}>): Promise<Awaited<ReturnType<typeof fetchSessionById>> | null> {
  const deadlineMs = Date.now() + params.timeoutMs;
  let attempt = 0;
  while (true) {
    throwIfActionOperationAborted(params.signal);
    attempt += 1;
    const session = await fetchSessionById({ token: params.token, sessionId: params.sessionId });
    throwIfActionOperationAborted(params.signal);
    if (session) return session;
    if (Date.now() >= deadlineMs) return null;
    // Avoid tight loops when callers set absurdly low env overrides.
    await waitForDelayOrAbort(Math.max(25, params.pollIntervalMs), params.signal);
  }
}

function throwIfActionOperationAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Action operation cancelled');
  error.name = 'AbortError';
  throw error;
}

async function waitForDelayOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return await delay(ms);
  throwIfActionOperationAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      const error = new Error('Action operation cancelled');
      error.name = 'AbortError';
      reject(error);
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    void delay(ms).then(
      () => { cleanup(); resolve(); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}

function isTransientSpawnFailure(spawnResponse: unknown): boolean {
  if (!spawnResponse || typeof spawnResponse !== 'object') return false;
  if (
    (spawnResponse as { status?: unknown }).status === 'pending' &&
    (spawnResponse as { errorCode?: unknown }).errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT
  ) {
    return true;
  }
  const message = typeof (spawnResponse as { error?: unknown }).error === 'string'
    ? (spawnResponse as { error: string }).error
    : '';
  if (!message) return false;
  return SPAWN_TRANSIENT_ERROR_MARKERS.some((marker) => message.includes(marker));
}

function readSpawnResponseRecord(spawnResponse: unknown): Readonly<Record<string, unknown>> | null {
  return spawnResponse !== null && typeof spawnResponse === 'object' && !Array.isArray(spawnResponse)
    ? spawnResponse as Readonly<Record<string, unknown>>
    : null;
}

function createCodedError(message: string, code: string, details?: unknown): Error {
  const error = new Error(message);
  (error as { code?: string }).code = code;
  if (details !== undefined) {
    (error as { details?: unknown }).details = details;
  }
  return error;
}

function readNonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Non-blank check that preserves the producer's exact bytes (messages, codes). */
function readNonBlankExactString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isDefiniteReplaySeededPreAdmissionRejection(errorCode: unknown): boolean {
  return typeof errorCode === 'string'
    && DEFINITE_REPLAY_SEEDED_PRE_ADMISSION_ERROR_CODES.has(errorCode);
}

export function readPersistedReplaySeedSourceRecipe(
  ownerMetadata: Readonly<Record<string, unknown>> | null | undefined,
): ReplaySeededCreationSourceRecipe | null {
  if (!ownerMetadata) return null;
  const replaySeed = ownerMetadata.replaySeedV1;
  if (replaySeed && typeof replaySeed === 'object' && !Array.isArray(replaySeed)) {
    const record = replaySeed as Readonly<Record<string, unknown>>;
    const sourceSessionId = readNonBlankString(record.sourceSessionId);
    const cutoffSeqInclusive = readFiniteNumber(record.sourceCutoffSeqInclusive);
    if (sourceSessionId !== null && cutoffSeqInclusive !== null) {
      return { sourceSessionId, cutoffSeqInclusive };
    }
  }
  const fork = ownerMetadata.forkV1;
  if (fork && typeof fork === 'object' && !Array.isArray(fork)) {
    const record = fork as Readonly<Record<string, unknown>>;
    const sourceSessionId = readNonBlankString(record.parentSessionId);
    const cutoffSeqInclusive = readFiniteNumber(record.parentCutoffSeqInclusive);
    if (sourceSessionId !== null && cutoffSeqInclusive !== null) {
      return { sourceSessionId, cutoffSeqInclusive };
    }
  }
  return null;
}

export function replaySeedSourceRecipeConflicts(
  persisted: ReplaySeededCreationSourceRecipe | null,
  requested: ReplaySeededCreationSourceRecipe | SessionSpawnSourceContextV1,
): boolean {
  if (!persisted) return false;
  if ('forkPoint' in requested) {
    if (persisted.sourceSessionId !== requested.sourceSessionId) return true;
    // `latest` names the first attempt's immutable stored snapshot. A rejoin
    // authenticates source without reinterpreting it against a newer head.
    return requested.forkPoint.type === 'seq'
      && persisted.cutoffSeqInclusive !== requested.forkPoint.upToSeqInclusive;
  }
  return persisted.sourceSessionId !== requested.sourceSessionId
    || persisted.cutoffSeqInclusive !== requested.cutoffSeqInclusive;
}

/**
 * Replay-seeded creation, owned by the canonical creator.
 *
 * The row is committed here from the already-resolved recipe, the launched
 * runner attaches to it through `existingSessionId`, and cleanup only applies
 * to a fresh row after a definite pre-admission rejection. The returned row
 * always proves the requested source lineage before a runner attaches.
 */
async function createReplaySeededSpawnedSession(args: Readonly<{
  params: CreateSpawnedSessionParams;
  replaySeededCreation: ReplaySeededSessionCreationV1;
  spawnRequestInput: Readonly<Record<string, unknown>>;
  dispatchSpawnRequest: (request: SpawnDaemonSessionRequest) => Promise<unknown>;
}>): Promise<Readonly<{ created: true; sessionId: string; session: SessionSummary }>> {
  const { params, replaySeededCreation } = args;
  throwIfActionOperationAborted(params.signal);
  const tag = replaySeededCreation.tag.trim();
  if (!tag) {
    throw createCodedError('Missing tag', SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST);
  }

  // The launch below attaches the runner to this brand-new row through
  // `existingSessionId`. Its child row and that attach request must therefore
  // receive one identity from the shared child-launch owner; metadata alone is
  // not an input the daemon can consume while it resolves this new attachment.
  const connectedServiceChildLaunch = params.connectedServiceChildLaunch
    ?? createConnectedServiceChildLaunchContext({
      spawn: args.spawnRequestInput,
      metadata: replaySeededCreation.metadata,
    });

  const created = await getOrCreateSessionByTag({
    credentials: params.credentials,
    tag,
    metadata: {
      tag,
      path: params.directory,
      host: os.hostname(),
      flavor: replaySeededCreation.agentId,
      ...replaySeededCreation.metadata,
      ...connectedServiceChildLaunch.metadata,
    },
    agentState: null,
  });

  const sessionId = readNonBlankString((created.session as { id?: unknown } | null)?.id) ?? '';
  if (!sessionId) {
    throw createCodedError(
      'Failed to create replay-seeded session (missing id)',
      SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
    );
  }

  // A creation identity must be answered by a row that PROVES the requested
  // lineage — positive evidence, not merely the absence of a contradiction.
  //
  // The row this call gets back may be one it never created, and the check runs
  // unconditionally. That is why absence is not innocent: a row whose metadata
  // will not decode, or that carries no source recipe at all, contradicts
  // nothing — the recipe reader returns null and the conflict check answers
  // `false` for want of anything to compare — and the caller's seed and runner
  // would then attach to a Session this call never authenticated.
  //
  // The create outcome pays nothing for this: a row this call just created
  // always carries the recipe it just encoded, so it always proves its own
  // lineage. Consumption keeps these fields (it blanks `seedText` and spreads
  // the rest), so an exact retry after the child has already run still rejoins.
  const ownerMetadata = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession: created.session });
  const persistedSourceRecipe = readPersistedReplaySeedSourceRecipe(
    ownerMetadata as Readonly<Record<string, unknown>> | null,
  );
  if (persistedSourceRecipe === null) {
    throw createCodedError(
      'Existing Session creation candidate could not be authenticated',
      'creation_conflict',
      { sessionId },
    );
  }
  if (replaySeedSourceRecipeConflicts(
    persistedSourceRecipe,
    params.sourceContext ?? replaySeededCreation.sourceRecipe,
  )) {
    throw createCodedError(
      'Existing Session was created from a different source recipe',
      'creation_conflict',
      { sessionId },
    );
  }

  // A row can be rejoined from an earlier attempt, and a throw or timeout after
  // dispatch may hide a live child. Archive only a row this call created and
  // only when the daemon positively reports a pre-admission rejection.
  let spawnResponse: unknown;
  try {
    spawnResponse = await args.dispatchSpawnRequest(
      SpawnDaemonSessionRequestSchema.parse({
        ...args.spawnRequestInput,
        ...connectedServiceChildLaunch.spawn,
        existingSessionId: sessionId,
      }),
    );
    throwIfActionOperationAborted(params.signal);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    const errorCode = readNonBlankExactString((error as { code?: unknown } | null)?.code)
      ?? SPAWN_SESSION_ERROR_CODES.UNEXPECTED;
    if (created.created && isDefiniteReplaySeededPreAdmissionRejection(errorCode)) {
      await archiveSessionByIdBestEffort({ token: params.credentials.token, sessionId });
    }
    throw createCodedError(
      error instanceof Error && error.message.trim().length > 0 ? error.message : 'Failed to spawn session',
      errorCode,
      { sessionId, spawnResponse: null, spawnDispatchThrew: true },
    );
  }
  const spawnResponseRecord = readSpawnResponseRecord(spawnResponse);
  const spawnSucceeded = spawnResponseRecord?.type === 'success' || spawnResponseRecord?.success === true;
  if (!spawnSucceeded) {
    const errorCode = readNonBlankExactString(spawnResponseRecord?.errorCode)
      ?? SPAWN_SESSION_ERROR_CODES.UNEXPECTED;
    if (created.created && isDefiniteReplaySeededPreAdmissionRejection(errorCode)) {
      await archiveSessionByIdBestEffort({ token: params.credentials.token, sessionId });
    }
    throw createCodedError(
      readNonBlankExactString(spawnResponseRecord?.errorMessage)
        ?? readNonBlankExactString(spawnResponseRecord?.error)
        ?? 'Failed to spawn session',
      errorCode,
      { sessionId, spawnResponse: spawnResponse ?? null },
    );
  }

  // The row is already known and its tag was written at creation, so the
  // visibility round trip and the tag post-update are both unnecessary. An
  // explicitly supplied title still has to be applied.
  const normalizedTitle = typeof params.title === 'string' ? params.title.trim() : '';
  if (normalizedTitle) {
    await updateSessionMetadataWithRetry({
      token: params.credentials.token,
      credentials: params.credentials,
      sessionId,
      rawSession: created.session,
      updater: (metadata) => ({
        ...metadata,
        summary: { text: normalizedTitle, updatedAt: Date.now() },
      }),
    });
  }

  return {
    created: true,
    sessionId,
    session: summarizeSessionRecord({ credentials: params.credentials, session: created.session }),
  };
}

function isAcceptedPendingSpawn(spawnResponse: unknown): boolean {
  if (!spawnResponse || typeof spawnResponse !== 'object') return false;
  if ((spawnResponse as { success?: unknown }).success !== true) return false;
  return (spawnResponse as { status?: unknown }).status === 'pending'
    || (spawnResponse as { sessionIdStatus?: unknown }).sessionIdStatus === 'pending';
}

export async function createSpawnedSession(
  params: CreateSpawnedSessionParams,
): Promise<Readonly<{ created: true; sessionId: string; session: SessionSummary }>> {
  throwIfActionOperationAborted(params.signal);
  const callerOwnedSpawnNonce = typeof params.spawnNonce === 'string' && params.spawnNonce.trim().length > 0
    ? params.spawnNonce.trim()
    : null;
  const spawnNonce = callerOwnedSpawnNonce ?? randomUUID();
  const dispatchSpawnRequest: (request: SpawnDaemonSessionRequest) => Promise<unknown> = params.directTransport
    ? params.directTransport.spawn
    : spawnDaemonSession;
  const resolveSpawnSessionByNonce = params.directTransport?.resolveSpawnSessionByNonce
    ?? resolveDaemonSpawnSessionByNonce;
  const spawnRequestInput = {
    directory: params.directory,
    spawnNonce,
    ...(params.machineId ? { machineId: params.machineId } : {}),
    backendTarget: params.backendTarget,
    ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
    ...(typeof params.permissionModeUpdatedAt === 'number' && Number.isFinite(params.permissionModeUpdatedAt)
      ? { permissionModeUpdatedAt: params.permissionModeUpdatedAt }
      : {}),
    ...(params.agentModeId ? { agentModeId: params.agentModeId } : {}),
    ...(typeof params.agentModeUpdatedAt === 'number' && Number.isFinite(params.agentModeUpdatedAt)
      ? { agentModeUpdatedAt: params.agentModeUpdatedAt }
      : {}),
    ...(params.modelId
      ? {
          modelId: params.modelId,
          modelUpdatedAt: typeof params.modelUpdatedAt === 'number' && Number.isFinite(params.modelUpdatedAt)
            ? params.modelUpdatedAt
            : Date.now(),
        }
      : {}),
    ...(params.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: params.sessionConfigOptionOverrides } : {}),
    ...(params.pendingFirstInput
      ? { pendingFirstInput: params.pendingFirstInput }
      : typeof params.initialMessage === 'string' && params.initialMessage.trim().length > 0
        ? { pendingFirstInput: createPendingFirstInput({ text: params.initialMessage, spawnNonce }) }
        : {}),
    ...(params.profileId ? { profileId: params.profileId } : {}),
    ...(params.environmentVariables ? { environmentVariables: params.environmentVariables } : {}),
    ...(params.connectedServices ? { connectedServices: params.connectedServices } : {}),
    ...(typeof params.connectedServicesUpdatedAt === 'number' && Number.isFinite(params.connectedServicesUpdatedAt)
      ? { connectedServicesUpdatedAt: params.connectedServicesUpdatedAt }
      : {}),
    ...(params.mcpSelection ? { mcpSelection: params.mcpSelection } : {}),
    ...(params.transcriptStorage ? { transcriptStorage: params.transcriptStorage } : {}),
    ...(params.terminal ? { terminal: params.terminal } : {}),
    ...(params.windowsRemoteSessionLaunchMode ? { windowsRemoteSessionLaunchMode: params.windowsRemoteSessionLaunchMode } : {}),
    ...(params.windowsRemoteSessionConsole ? { windowsRemoteSessionConsole: params.windowsRemoteSessionConsole } : {}),
    ...(params.windowsTerminalWindowName ? { windowsTerminalWindowName: params.windowsTerminalWindowName } : {}),
    ...(params.codexBackendMode ? { codexBackendMode: params.codexBackendMode } : {}),
    ...(params.agentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1: params.agentRuntimeDescriptorV1 } : {}),
    ...(params.resume ? { resume: params.resume } : {}),
    ...(typeof params.experimentalCodexAcp === 'boolean'
      ? { experimentalCodexAcp: params.experimentalCodexAcp }
      : {}),
    ...(typeof params.approvedNewDirectoryCreation === 'boolean'
      ? { approvedNewDirectoryCreation: params.approvedNewDirectoryCreation }
      : {}),
  };

  if (params.replaySeededCreation) {
    return await createReplaySeededSpawnedSession({
      params,
      replaySeededCreation: params.replaySeededCreation,
      spawnRequestInput,
      dispatchSpawnRequest,
    });
  }

  const spawnRequest = SpawnDaemonSessionRequestSchema.parse(spawnRequestInput);
  const spawnResponse: unknown = params.resumeOnly === true
    ? { success: true as const, status: 'pending' as const, sessionIdStatus: 'pending' as const, spawnNonce }
    : await dispatchSpawnRequest(spawnRequest);
  throwIfActionOperationAborted(params.signal);
  const spawnResponseRecord = readSpawnResponseRecord(spawnResponse);
  const acceptedWithoutSessionId = isAcceptedPendingSpawn(spawnResponse) || isTransientSpawnFailure(spawnResponse);
  const hasDirectSessionId = spawnResponseRecord?.success === true
    && typeof spawnResponseRecord.sessionId === 'string'
    && spawnResponseRecord.sessionId.trim().length > 0;
  if (!acceptedWithoutSessionId && !hasDirectSessionId) {
    const error = new Error(
      readNonBlankExactString(spawnResponseRecord?.error) ?? 'Failed to spawn session',
    );
    (error as { code?: string }).code =
      spawnResponseRecord?.requiresUserApproval === true
        ? 'conflict'
        : readNonBlankExactString(spawnResponseRecord?.errorCode) ?? 'unknown_error';
    (error as { details?: unknown }).details = spawnResponse ?? null;
    throw error;
  }
  const settledSpawn = await awaitSpawnedSessionId({
    result: acceptedWithoutSessionId
      ? { type: 'success', sessionIdStatus: 'pending', spawnNonce }
      : spawnResponse,
    resolveSpawnSessionByNonce: resolveSpawnSessionByNonce,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (settledSpawn.type === 'error') {
    if (
      acceptedWithoutSessionId
      && !callerOwnedSpawnNonce
      && params.resumeOnly !== true
      && settledSpawn.errorCode !== SPAWN_SESSION_ERROR_CODES.UNEXPECTED
    ) {
      abandonSpawnedSessionBestEffort({
        spawnNonce,
        reason: settledSpawn.errorMessage,
        resolveSpawnSessionByNonce: resolveSpawnSessionByNonce,
        stopSession: async (sessionId) => {
          const stopped = await requestSessionStop({
            credentials: params.credentials,
            idOrPrefix: sessionId,
          });
          return stopped.ok && stopped.stopped;
        },
        archiveSession: async (sessionId) => {
          await archiveSessionByIdBestEffort({ token: params.credentials.token, sessionId });
        },
      });
    }
    const error = new Error(
      settledSpawn.errorMessage
      || readNonBlankExactString(spawnResponseRecord?.error)
      || 'Failed to spawn session',
    );
    (error as { code?: string }).code = settledSpawn.errorCode;
    (error as { details?: unknown }).details = {
      spawnResponse: spawnResponse ?? null,
      ...(acceptedWithoutSessionId ? { spawnNonce } : {}),
    };
    throw error;
  }
  const sessionId = settledSpawn.sessionId;

  const fetchTimeoutMs = resolvePositiveIntFromEnv('HAPPIER_SESSION_SPAWN_FETCH_TIMEOUT_MS', DEFAULT_SPAWNED_SESSION_FETCH_TIMEOUT_MS);
  const pollIntervalMs = resolvePositiveIntFromEnv('HAPPIER_SESSION_SPAWN_FETCH_POLL_INTERVAL_MS', DEFAULT_SPAWNED_SESSION_FETCH_POLL_INTERVAL_MS);
  let rawSession = await waitForSpawnedSessionVisibility({
    token: params.credentials.token,
    sessionId,
    timeoutMs: fetchTimeoutMs,
    pollIntervalMs,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (!rawSession) {
    const error = new Error(`Timed out waiting for spawned session ${sessionId} to appear on the server`);
    (error as { code?: string }).code = 'timeout';
    (error as { details?: unknown }).details = { sessionId, timeoutMs: fetchTimeoutMs };
    throw error;
  }

  if (params.sourceContext) {
    const ownerMetadata = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession });
    const persistedSourceRecipe = readPersistedReplaySeedSourceRecipe(
      ownerMetadata as Readonly<Record<string, unknown>> | null,
    );
    if (!persistedSourceRecipe) {
      throw createCodedError(
        'Settled Session source lineage could not be authenticated',
        'creation_conflict',
        { sessionId },
      );
    }
    if (replaySeedSourceRecipeConflicts(persistedSourceRecipe, params.sourceContext)) {
      throw createCodedError(
        'Settled Session was created from a different source recipe',
        'creation_conflict',
        { sessionId },
      );
    }
  }

  const normalizedTitle = typeof params.title === 'string' ? params.title.trim() : '';
  const normalizedTag = typeof params.tag === 'string' ? params.tag.trim() : '';
  if (normalizedTitle || normalizedTag) {
    await updateSessionMetadataWithRetry({
      token: params.credentials.token,
      credentials: params.credentials,
      sessionId,
      rawSession,
      updater: (metadata) => ({
        ...metadata,
        ...(normalizedTag ? { tag: normalizedTag } : {}),
        ...(normalizedTitle
          ? {
              summary: {
                text: normalizedTitle,
                updatedAt: Date.now(),
              },
            }
          : {}),
      }),
    });

    rawSession = await waitForSpawnedSessionVisibility({
      token: params.credentials.token,
      sessionId,
      timeoutMs: fetchTimeoutMs,
      pollIntervalMs,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!rawSession) {
      const error = new Error(`Timed out waiting for spawned session ${sessionId} after metadata update`);
      (error as { code?: string }).code = 'timeout';
      (error as { details?: unknown }).details = { sessionId, timeoutMs: fetchTimeoutMs, stage: 'metadata_update' };
      throw error;
    }
  }

  return {
    created: true,
    sessionId,
    session: summarizeSessionRecord({ credentials: params.credentials, session: rawSession }),
  };
}
