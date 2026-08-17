import type {
  AcpConfigOptionOverridesV1,
  BackendTargetRefV1,
  ConnectedServiceBindingsV1,
  SessionMcpSelectionV1,
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
  /**
   * Commit the Session row here, seeded from a resolved Replay recipe, and
   * attach the launched runner to it. Absent for ordinary authoring, where the
   * runner bootstrap creates the row.
   */
  replaySeededCreation?: ReplaySeededSessionCreationV1;
  /** Resolve an already-submitted launch attempt without sending another spawn. */
  resumeOnly?: boolean;
  /** In-daemon transport for an ingress that must not self-call over HTTP. */
  directTransport?: DirectSpawnedSessionTransport;
}>;

const DEFAULT_SPAWNED_SESSION_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_SPAWNED_SESSION_FETCH_POLL_INTERVAL_MS = 200;
const SPAWN_TRANSIENT_ERROR_MARKERS = [
  'Request failed: /spawn-session, The socket connection was closed unexpectedly',
] as const;

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
}>): Promise<Awaited<ReturnType<typeof fetchSessionById>> | null> {
  const deadlineMs = Date.now() + params.timeoutMs;
  let attempt = 0;
  while (true) {
    attempt += 1;
    const session = await fetchSessionById({ token: params.token, sessionId: params.sessionId });
    if (session) return session;
    if (Date.now() >= deadlineMs) return null;
    // Avoid tight loops when callers set absurdly low env overrides.
    await delay(Math.max(25, params.pollIntervalMs));
  }
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
  requested: ReplaySeededCreationSourceRecipe,
): boolean {
  if (!persisted) return false;
  return persisted.sourceSessionId !== requested.sourceSessionId
    || persisted.cutoffSeqInclusive !== requested.cutoffSeqInclusive;
}

/**
 * Replay-seeded creation, owned by the canonical creator.
 *
 * The row is committed here from the already-resolved recipe, the launched
 * runner attaches to it through `existingSessionId`, and one orphan settlement
 * covers a launch failure. This tree's `getOrCreateSessionByTag` returns no
 * `created` flag, so the source-recipe check runs unconditionally against the
 * returned row — correct for both the create and the rejoin outcome.
 */
async function createReplaySeededSpawnedSession(args: Readonly<{
  params: CreateSpawnedSessionParams;
  replaySeededCreation: ReplaySeededSessionCreationV1;
  spawnRequestInput: Readonly<Record<string, unknown>>;
  dispatchSpawnRequest: (request: SpawnDaemonSessionRequest) => Promise<unknown>;
}>): Promise<Readonly<{ created: true; sessionId: string; session: SessionSummary }>> {
  const { params, replaySeededCreation } = args;
  const tag = replaySeededCreation.tag.trim();
  if (!tag) {
    throw createCodedError('Missing tag', SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST);
  }

  const { session } = await getOrCreateSessionByTag({
    credentials: params.credentials,
    tag,
    metadata: {
      tag,
      path: params.directory,
      host: os.hostname(),
      flavor: replaySeededCreation.agentId,
      ...replaySeededCreation.metadata,
    },
    agentState: null,
  });

  const sessionId = readNonBlankString((session as { id?: unknown } | null)?.id) ?? '';
  if (!sessionId) {
    throw createCodedError(
      'Failed to create replay-seeded session (missing id)',
      SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
    );
  }

  // A reused creation identity must name the same immutable source recipe.
  //
  // This tree's `getOrCreateSessionByTag` returns no `created` flag, so the
  // check runs unconditionally against the returned row — correct for both the
  // create and the rejoin outcome. The row's own bytes supply the one signal
  // that does distinguish them safely: a row this call just created always
  // carries metadata this daemon can decode, because it just encoded it. Stored
  // bytes we cannot decode therefore mean a pre-existing row whose lineage
  // cannot be authenticated, and attaching a runner to it would silently seed
  // the caller's continuation from an unverified source. Fail closed.
  //
  // Absent metadata bytes are a different case: nothing to contradict, so the
  // recipe check simply finds no conflict evidence and creation proceeds.
  const ownerMetadata = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession: session });
  const hasStoredMetadataBytes =
    typeof (session as { metadata?: unknown } | null)?.metadata === 'string'
    && String((session as { metadata: string }).metadata).trim().length > 0;
  if (ownerMetadata === null && hasStoredMetadataBytes) {
    throw createCodedError(
      'Existing Session metadata could not be authenticated against the requested source recipe',
      'creation_conflict',
      { sessionId },
    );
  }
  if (replaySeedSourceRecipeConflicts(
    readPersistedReplaySeedSourceRecipe(ownerMetadata as Readonly<Record<string, unknown>> | null),
    replaySeededCreation.sourceRecipe,
  )) {
    throw createCodedError(
      'Existing Session was created from a different source recipe',
      'creation_conflict',
      { sessionId },
    );
  }

  // Once the row exists, EVERY launch failure has to settle it — a rejected
  // envelope and a throwing transport orphan the row identically, so the
  // settlement covers both rather than only the returned-error path.
  let spawnResponse: unknown;
  try {
    spawnResponse = await args.dispatchSpawnRequest(
      SpawnDaemonSessionRequestSchema.parse({
        ...args.spawnRequestInput,
        existingSessionId: sessionId,
      }),
    );
  } catch (error) {
    await archiveSessionByIdBestEffort({ token: params.credentials.token, sessionId });
    throw createCodedError(
      error instanceof Error && error.message.trim().length > 0 ? error.message : 'Failed to spawn session',
      readNonBlankExactString((error as { code?: unknown } | null)?.code)
        ?? SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
      { sessionId, spawnResponse: null, spawnDispatchThrew: true },
    );
  }
  const spawnResponseRecord = readSpawnResponseRecord(spawnResponse);
  const spawnSucceeded = spawnResponseRecord?.type === 'success' || spawnResponseRecord?.success === true;
  if (!spawnSucceeded) {
    // The single orphan settlement every Replay ingress used to duplicate.
    await archiveSessionByIdBestEffort({ token: params.credentials.token, sessionId });
    throw createCodedError(
      readNonBlankExactString(spawnResponseRecord?.errorMessage)
        ?? readNonBlankExactString(spawnResponseRecord?.error)
        ?? 'Failed to spawn session',
      readNonBlankExactString(spawnResponseRecord?.errorCode) ?? SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
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
      rawSession: session,
      updater: (metadata) => ({
        ...metadata,
        summary: { text: normalizedTitle, updatedAt: Date.now() },
      }),
    });
  }

  return {
    created: true,
    sessionId,
    session: summarizeSessionRecord({ credentials: params.credentials, session }),
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
    ...(typeof params.initialMessage === 'string' && params.initialMessage.trim().length > 0
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
  });
  if (!rawSession) {
    const error = new Error(`Timed out waiting for spawned session ${sessionId} to appear on the server`);
    (error as { code?: string }).code = 'timeout';
    (error as { details?: unknown }).details = { sessionId, timeoutMs: fetchTimeoutMs };
    throw error;
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
