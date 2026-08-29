import {
  SPAWN_SESSION_ERROR_CODES,
  readConnectedServiceMaterializationIdentityV1FromMetadata,
  normalizeSpawnSessionNonceResolution,
  buildSpawnedFirstTurnLocalId,
  buildSessionSpawnInitialInputLocalIdV1,
  hasSessionInputContentV1,
  sessionCreationCorrespondenceMatchesV1,
  type BackendTargetRefV2,
  type SessionCreationCorrespondenceV1,
  type SessionCreationTagV1,
  type SessionSpawnNewInitialInputDispositionV1,
  type SessionSpawnSourceContextV1,
  type SessionOrganizationPlacementV1,
  type SessionModelSelectionV1,
  type SpawnSessionNonceResolution,
  type PluginSessionInputAttachmentV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';
import { randomUUID } from 'node:crypto';
import os from 'node:os';

import { createAuthenticationHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';
import { validateStoredAuthTokenAgainstActiveServer } from '@/auth/validateStoredAuthTokenAgainstActiveServer';
import type { StoredCredentials } from '@/persistence';
import {
  SpawnDaemonSessionRequestSchema,
  type SpawnDaemonSessionRequest,
} from '@/rpc/handlers/spawnSessionOptionsContract';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import {
  fetchSessionById,
  fetchSessionOrganizationPlacement,
  getOrCreateSessionByTag,
  lookupSessionsByTags,
} from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { summarizeSessionRecord, type SessionSummary } from '@/cli/output/session/sessionSummary';
import { delay } from '@/utils/time';
import { logger } from '@/utils/logger';
import { sendSessionMessage } from './sendSessionMessage';
import { abandonSpawnedSessionBestEffort, awaitSpawnedSessionId } from './awaitSpawnedSessionId';
import { archiveSessionOnceInactive } from './archiveSessionOnceInactive';
import { requestSessionStop } from './requestSessionStop';
import { createStableSpawnNonce } from '@/session/shared/spawnNonce';
import {
  createConnectedServiceChildLaunchContext,
  type ConnectedServiceChildLaunchContext,
} from '@/session/fork/connectedServiceForkLaunchContext';

/**
 * Host-private local path for an exact daemon's canonical spawn lifecycle.
 * It is intentionally consumed only after the public V2 Action owner has
 * normalized identity and policy; it is never another ingress schema.
 */
export type DirectSpawnedSessionTransport = Readonly<{
  spawn: (
    request: SpawnDaemonSessionRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<unknown>;
  resolveSpawnSessionByNonce: (
    spawnNonce: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<SpawnSessionNonceResolution>;
}>;

/**
 * Immutable source lineage a Replay-seeded child is created from.
 *
 * Reused on the create path (persisted into the child's `forkV1`/`replaySeedV1`)
 * and on the rejoin path (authenticating that a reused creation identity names
 * the same source recipe before any input or navigation).
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
 * attaches to that exact row. This replaces the retired second Replay row
 * creator so one owner holds row creation, create-or-rejoin settlement, and
 * orphan cleanup for every Replay ingress.
 */
export type ReplaySeededSessionCreationV1 = Readonly<{
  /**
   * Durable per-attempt creation identity supplied by the invoking ingress.
   * Each ingress keeps its own existing retry key: spawn_new passes its
   * `sessionCreationTag`, the replay fork its fork nonce, and the legacy
   * continue-with-replay ingress its existing replay nonce/tag.
   */
  tag: string;
  /** Legacy creation-metadata `flavor` recorded for the child. */
  flavor: string;
  /** Canonical creation metadata from `buildReplaySeededSpawnRecipe`. */
  metadata: Record<string, unknown>;
  sourceRecipe: ReplaySeededCreationSourceRecipe;
}>;

export type CreateSpawnedSessionParams = Readonly<{
  credentials: StoredCredentials;
  directory: string;
  /**
   * Session creation is always dispatched to this exact machine.
   *
   * Optional only when `directTransport` is supplied: that transport IS the
   * exact target, so an in-process daemon ingress with no machine identity of
   * its own cannot silently fan out to another machine.
   */
  machineId?: string;
  /** Released remote-daemon compatibility projection and configured ACP target. */
  backendTarget?: BackendTargetRefV2;
  sessionCreationTag?: SessionCreationTagV1;
  sessionCreationCorrespondence?: SessionCreationCorrespondenceV1;
  organizationPlacement?: SessionOrganizationPlacementV1;
  modelSelection?: SessionModelSelectionV1;
  /** Mutable presentation written only through the fresh create envelope. */
  initialTitle?: string;
  /**
   * Private sidecar from a provenance-bounded predecessor approval-artifact
   * replay; never accepted from live Action/RPC ingress or sent as a server
   * Session tag.
   */
  legacyMetadataLabel?: string;
  initialInput?: Readonly<{
    text?: string;
    attachments?: readonly PluginSessionInputAttachmentV1[];
  }>;
  buildInitialInputHandoff?: (localId: string) => Readonly<{
    meta?: Record<string, unknown>;
    inputAdmission: NonNullable<Parameters<typeof sendSessionMessage>[0]['inputAdmission']>;
  }>;
  /** Authenticated target transport required for machine-only input admission. */
  machineAdmissionTransport?: NonNullable<
    Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport']
  >;
  /** Stable caller-owned identity for one launch attempt. */
  spawnNonce?: string;
  /**
   * Raw source intent retained only for canonical existing-row and
   * settled-child validation. It is host-private creator input, not a
   * machine-RPC field.
   */
  sourceContext?: SessionSpawnSourceContextV1;
  /**
   * Commit the Session row here, seeded from a resolved Replay recipe, and
   * attach the launched runner to it. Absent for ordinary authoring, where the
   * runner bootstrap creates the row from the creation tag.
   */
  replaySeededCreation?: ReplaySeededSessionCreationV1;
  /**
   * A fork-owned projection already minted by the shared child-launch owner.
   * It keeps the committed row and its direct runner attachment on one identity.
   */
  connectedServiceChildLaunch?: ConnectedServiceChildLaunchContext;
  /** Resolve an already-submitted launch attempt without sending another spawn. */
  resumeOnly?: boolean;
  /** Exact-daemon in-process transport for the closed server-origin bridge. */
  directTransport?: DirectSpawnedSessionTransport;
  /** In-process current-daemon transport; preserves the canonical RPC handlers. */
  machineActionTransport?: (
    method: string,
    request: unknown,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<unknown>;
  signal?: AbortSignal;
} & Partial<Pick<
  SpawnSessionOptions,
  | 'permissionMode'
  | 'permissionModeUpdatedAt'
  | 'agentModeId'
  | 'agentModeUpdatedAt'
  | 'accountSettingsVersionHint'
  | 'initialTranscriptAfterSeq'
  | 'executionAuthorization'
  | 'sessionConfigOptionOverrides'
  | 'profileId'
  | 'environmentVariables'
  | 'resume'
  | 'approvedNewDirectoryCreation'
  | 'connectedServices'
  | 'connectedServicesUpdatedAt'
  | 'mcpSelection'
  | 'transcriptStorage'
  | 'terminal'
  | 'windowsRemoteSessionLaunchMode'
  | 'windowsRemoteSessionConsole'
  | 'windowsTerminalWindowName'
  | 'runtimeDescriptorV1'
  | 'agentSessionStartupInstructionsV1'
  | 'agentTarget'
>>>;

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

type SpawnedSessionVisibility =
  | Readonly<{
      type: 'visible';
      session: NonNullable<Awaited<ReturnType<typeof fetchSessionById>>>;
    }>
  | Readonly<{ type: 'unavailable' | 'cancelled' | 'failed' }>;

async function waitForSpawnedSessionVisibility(params: Readonly<{
  token: string;
  sessionId: string;
  timeoutMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
}>): Promise<SpawnedSessionVisibility> {
  const deadlineMs = Date.now() + params.timeoutMs;
  while (true) {
    if (params.signal?.aborted) return { type: 'cancelled' };
    let session: Awaited<ReturnType<typeof fetchSessionById>>;
    try {
      session = await fetchSessionById({
        token: params.token,
        sessionId: params.sessionId,
        ...(params.signal ? { signal: params.signal } : {}),
      });
    } catch (error) {
      if (params.signal?.aborted) return { type: 'cancelled' };
      return { type: 'failed' };
    }
    if (session) return { type: 'visible', session };
    if (Date.now() >= deadlineMs) return { type: 'unavailable' };
    // Avoid tight loops when callers set absurdly low env overrides.
    await delay(Math.max(25, params.pollIntervalMs));
  }
}

async function readKnownSessionAccountEncryptionCurrentness(params: Readonly<{
  token: string;
  signal?: AbortSignal;
}>): Promise<Awaited<ReturnType<typeof fetchAccountEncryptionCurrentness>> | null> {
  if (params.signal?.aborted) return null;
  try {
    return await fetchAccountEncryptionCurrentness({
      token: params.token,
      ...(params.signal ? { signal: params.signal } : {}),
    });
  } catch {
    if (!params.signal?.aborted) {
      logger.warn(
        '[SESSION SPAWN] Known Session Account currentness read failed',
        { code: 'session_spawn_account_currentness_unavailable' },
      );
    }
    return null;
  }
}

function isTransientSpawnFailure(spawnResponse: unknown): boolean {
  if (!spawnResponse || typeof spawnResponse !== 'object') return false;
  if (
    (spawnResponse as { errorCode?: unknown }).errorCode
    === SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK
  ) {
    return false;
  }
  if (
    (spawnResponse as { status?: unknown }).status === 'pending'
    && (spawnResponse as { errorCode?: unknown }).errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT
  ) {
    return true;
  }
  const message = typeof (spawnResponse as { error?: unknown }).error === 'string'
    ? (spawnResponse as { error: string }).error
    : '';
  if (!message) return false;
  return SPAWN_TRANSIENT_ERROR_MARKERS.some((marker) => message.includes(marker));
}

async function assertStoredAuthTokenValidForSpawn(token: string): Promise<void> {
  const validation = await validateStoredAuthTokenAgainstActiveServer(token);
  if (validation.state !== 'invalid') return;

  const status = isAuthenticationStatus(validation.httpStatus) ? validation.httpStatus : 401;
  throw createAuthenticationHttpStatusError(status, `Authentication failed before spawning session (${status})`);
}

function isAcceptedPendingSpawn(spawnResponse: unknown): boolean {
  if (!spawnResponse || typeof spawnResponse !== 'object') return false;
  if ((spawnResponse as { success?: unknown }).success !== true) return false;
  return (spawnResponse as { status?: unknown }).status === 'pending'
    || (spawnResponse as { sessionIdStatus?: unknown }).sessionIdStatus === 'pending';
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

type LegacyMetadataLabelWriteParams = Readonly<
  Omit<Parameters<typeof updateSessionMetadataWithRetry>[0], 'updater'> & {
    legacyMetadataLabel?: string;
  }
>;

async function writeLegacyMetadataLabelBestEffort(
  params: LegacyMetadataLabelWriteParams,
): Promise<void> {
  const legacyMetadataLabel = typeof params.legacyMetadataLabel === 'string'
    ? params.legacyMetadataLabel.trim()
    : '';
  if (!legacyMetadataLabel) return;

  const { legacyMetadataLabel: _legacyMetadataLabel, ...metadataWrite } = params;
  try {
    await updateSessionMetadataWithRetry({
      ...metadataWrite,
      updater: (metadata) => ({
        ...metadata,
        tag: legacyMetadataLabel,
      }),
    });
  } catch {
    logger.warn(
      '[SESSION SPAWN] Legacy metadata label compatibility write failed',
      { code: 'legacy_metadata_label_write_failed' },
    );
  }
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readNonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Read the source lineage a Session row was actually created from.
 *
 * `replaySeedV1` is the authoritative record; `forkV1` is consulted only when a
 * predecessor row carries lineage without a seed envelope. Absent lineage is
 * "no evidence", never "matches".
 */
export function readPersistedReplaySeedSourceRecipe(
  ownerMetadata: Readonly<Record<string, unknown>> | null | undefined,
): ReplaySeededCreationSourceRecipe | null {
  if (!ownerMetadata) return null;
  const replaySeed = ownerMetadata.replaySeedV1;
  if (replaySeed && typeof replaySeed === 'object' && !Array.isArray(replaySeed)) {
    const record = replaySeed as Readonly<Record<string, unknown>>;
    const sourceSessionId = readNonBlankString(record.sourceSessionId);
    const cutoffSeqInclusive = readNumber(record.sourceCutoffSeqInclusive);
    if (sourceSessionId !== null && cutoffSeqInclusive !== null) {
      return { sourceSessionId, cutoffSeqInclusive };
    }
  }
  const fork = ownerMetadata.forkV1;
  if (fork && typeof fork === 'object' && !Array.isArray(fork)) {
    const record = fork as Readonly<Record<string, unknown>>;
    const sourceSessionId = readNonBlankString(record.parentSessionId);
    const cutoffSeqInclusive = readNumber(record.parentCutoffSeqInclusive);
    if (sourceSessionId !== null && cutoffSeqInclusive !== null) {
      return { sourceSessionId, cutoffSeqInclusive };
    }
  }
  return null;
}

export function replaySeedSourceRecipeConflicts(
  persisted: ReplaySeededCreationSourceRecipe | null,
  requested?: ReplaySeededCreationSourceRecipe | SessionSpawnSourceContextV1,
): boolean {
  if (!requested) return persisted !== null;
  if (!persisted) return true;
  if ('forkPoint' in requested) {
    if (persisted.sourceSessionId !== requested.sourceSessionId) return true;
    // `latest` is resolved once when the child is first created. A retry must
    // prove the same source but must not reinterpret that original snapshot
    // against a later source head. An explicit seq remains exact.
    return requested.forkPoint.type === 'seq'
      && persisted.cutoffSeqInclusive !== requested.forkPoint.upToSeqInclusive;
  }
  return persisted.sourceSessionId !== requested.sourceSessionId
    || persisted.cutoffSeqInclusive !== requested.cutoffSeqInclusive;
}

type ExistingSessionCreationCandidateValidation =
  | Readonly<{ kind: 'matched' }>
  | Readonly<{ kind: 'correspondence_conflict' }>
  | Readonly<{ kind: 'source_recipe_missing' }>
  | Readonly<{ kind: 'source_recipe_conflict' }>;

/**
 * The canonical existing-row proof shared by preflight rejoin, atomic
 * get-or-create, and post-spawn settlement. Callers retain their ingress
 * error projection, but none may independently decide whether an immutable
 * correspondence or replay source recipe proves the candidate child.
 */
function validateExistingSessionCreationCandidate(params: Readonly<{
  ownerMetadata: Readonly<Record<string, unknown>> | null | undefined;
  correspondence?: SessionCreationCorrespondenceV1;
  sourceRecipe?: ReplaySeededCreationSourceRecipe | SessionSpawnSourceContextV1;
  validateSourceRecipe: boolean;
}>): ExistingSessionCreationCandidateValidation {
  if (
    params.correspondence
    && !sessionCreationCorrespondenceMatchesV1(
      params.ownerMetadata?.sessionCreationCorrespondenceV1,
      params.correspondence,
    )
  ) {
    return { kind: 'correspondence_conflict' };
  }
  if (!params.validateSourceRecipe) return { kind: 'matched' };

  const persistedSourceRecipe = readPersistedReplaySeedSourceRecipe(params.ownerMetadata);
  if (params.sourceRecipe && persistedSourceRecipe === null) {
    return { kind: 'source_recipe_missing' };
  }
  return replaySeedSourceRecipeConflicts(persistedSourceRecipe, params.sourceRecipe)
    ? { kind: 'source_recipe_conflict' }
    : { kind: 'matched' };
}

async function submitSpawnInitialInput(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  initialInput?: CreateSpawnedSessionParams['initialInput'];
  localId: string;
  initialInputHandoff?: ReturnType<NonNullable<CreateSpawnedSessionParams['buildInitialInputHandoff']>>;
  machineAdmissionTransport?: CreateSpawnedSessionParams['machineAdmissionTransport'];
  signal?: AbortSignal;
}>): Promise<SessionSpawnNewInitialInputDispositionV1> {
  const text = typeof params.initialInput?.text === 'string' ? params.initialInput.text : '';
  const attachmentCount = params.initialInput?.attachments?.length ?? 0;
  if (!hasSessionInputContentV1({ text, attachmentCount })) return { status: 'notRequested' };
  // Session identity is already settled at this call site. A caller that
  // retired before Message admission began has a definite nested rejection,
  // not a reason to recast the committed Session as cancelled.
  if (params.signal?.aborted) {
    return { status: 'rejected', code: 'session_input_cancelled' };
  }
  if (!params.initialInputHandoff) {
    throw createCodedError(
      'Initial input requires Message-owned admission identity',
      SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      { sessionId: params.sessionId },
    );
  }
  const initialInputHandoff = params.initialInputHandoff;
  try {
    const sent = await sendSessionMessage({
      credentials: params.credentials,
      idOrPrefix: params.sessionId,
      message: text,
      wait: false,
      timeoutMs: 60_000,
      localId: params.localId,
      inputAdmission: initialInputHandoff.inputAdmission,
      ...(initialInputHandoff.meta ? { messageMeta: initialInputHandoff.meta } : {}),
      requestedAction: { v: 1, kind: 'send_now' },
      ...(params.machineAdmissionTransport
        ? { machineAdmissionTransport: params.machineAdmissionTransport }
        : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    return sent.admissionResult;
  } catch {
    return {
      status: 'outcomeUnknown',
      localId: params.localId,
      code: 'session_input_action_execution_failed',
    };
  }
}

// This is deliberately the creator's cleanup projection, not a second daemon
// outcome model. Only these known producers reject before a runner can attach;
// every other response, throw, or legacy code may still name a live child.
const DEFINITE_REPLAY_SEEDED_PRE_ADMISSION_ERROR_CODES = new Set<string>([
  SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
  SPAWN_SESSION_ERROR_CODES.INVALID_ENVIRONMENT_VARIABLES,
  SPAWN_SESSION_ERROR_CODES.AUTH_ENV_UNEXPANDED,
  SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
  SPAWN_SESSION_ERROR_CODES.RESUME_MISSING_ENCRYPTION_KEY,
  SPAWN_SESSION_ERROR_CODES.DIRECTORY_CREATE_FAILED,
  SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
]);

function isDefiniteReplaySeededPreAdmissionRejection(code: unknown): boolean {
  return typeof code === 'string'
    && DEFINITE_REPLAY_SEEDED_PRE_ADMISSION_ERROR_CODES.has(code);
}

/**
 * Dispatch the launch for an already-committed replay-seeded row.
 *
 * A returned row may be fresh or rejoined. Cleanup is therefore deliberately
 * narrower than dispatch failure: only a fresh row plus a known pre-admission
 * rejection proves this creator can archive it.
 */
async function dispatchReplaySeededSpawn(args: Readonly<{
  token: string;
  sessionId: string;
  createdHere: boolean;
  dispatchSpawnRequest: (request: SpawnDaemonSessionRequest) => Promise<unknown>;
  spawnRequestInput: Record<string, unknown>;
}>): Promise<unknown> {
  try {
    return await args.dispatchSpawnRequest(
      SpawnDaemonSessionRequestSchema.parse({
        ...args.spawnRequestInput,
        existingSessionId: args.sessionId,
      }),
    );
  } catch (error) {
    const code = error && typeof error === 'object'
      ? (error as { code?: unknown }).code
      : undefined;
    if (args.createdHere && isDefiniteReplaySeededPreAdmissionRejection(code)) {
      await archiveSessionOnceInactive({ token: args.token, sessionId: args.sessionId })
        .catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Replay-seeded creation, owned by the canonical creator.
 *
 * The row is committed here from the already-resolved recipe, the launched
 * runner attaches to it, and one orphan settlement covers a definite launch
 * failure. Every Replay ingress supplies its own durable creation identity in
 * `replaySeededCreation.tag`; this owner never invents or rewrites one.
 */
async function createReplaySeededSpawnedSession(args: Readonly<{
  params: CreateSpawnedSessionParams;
  replaySeededCreation: ReplaySeededSessionCreationV1;
  spawnRequestInput: Readonly<Record<string, unknown>>;
  dispatchSpawnRequest: (request: SpawnDaemonSessionRequest) => Promise<unknown>;
  initialInputLocalId: string;
  initialInputHandoff?: ReturnType<NonNullable<CreateSpawnedSessionParams['buildInitialInputHandoff']>>;
}>): Promise<Readonly<{
  disposition: 'created' | 'rejoined';
  sessionId: string;
  organizationPlacement: SessionOrganizationPlacementV1;
  initialInput: SessionSpawnNewInitialInputDispositionV1;
  session?: SessionSummary;
}>> {
  const { params, replaySeededCreation } = args;
  const tag = replaySeededCreation.tag.trim();
  if (!tag) {
    throw createCodedError(
      'Replay-seeded Session creation requires a creation tag',
      SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    );
  }
  if (params.resumeOnly === true) {
    // Resume-only must not submit a new launch. A committed earlier attempt is
    // already answered by the correspondence rejoin above, so reaching here
    // means the attempt is unresolved — report it as retryable with the same
    // creation identity rather than committing a row that nothing will launch.
    throw createCodedError(
      'Replay-seeded creation attempt could not be resolved without submitting a new launch',
      SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      { tag },
    );
  }
  const accountEncryptionCurrentness = await readKnownSessionAccountEncryptionCurrentness({
    token: params.credentials.token,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  let connectedServiceChildLaunch = params.connectedServiceChildLaunch
    ?? createConnectedServiceChildLaunchContext({
      spawn: args.spawnRequestInput,
      metadata: replaySeededCreation.metadata,
    });
  // `legacyMetadataLabel` is the predecessor approval-artifact replay's private
  // label and writes the same `tag` metadata field this creation already owns.
  // The two never co-occur: that replay path carries no source recipe.
  const created = await getOrCreateSessionByTag({
    credentials: params.credentials,
    tag,
    metadata: {
      tag,
      path: params.directory,
      host: os.hostname(),
      flavor: replaySeededCreation.flavor,
      ...replaySeededCreation.metadata,
      ...connectedServiceChildLaunch.metadata,
    },
    agentState: null,
    ...(params.organizationPlacement ? { organizationPlacement: params.organizationPlacement } : {}),
    ...(accountEncryptionCurrentness ? { accountEncryptionCurrentness } : {}),
  });
  const sessionId = typeof created.session?.id === 'string' ? created.session.id.trim() : '';
  if (!sessionId) {
    throw createCodedError(
      'Failed to create replay-seeded session (missing id)',
      SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
    );
  }
  // A reused creation identity must name the same immutable source recipe.
  // Creation is get-or-create, so a reused tag rejoins an existing row, and a
  // rejoin is exactly the sibling correspondence path's rule: the immutable
  // recipe must be authenticated before this branch attaches a seed or input to
  // it. An unreadable candidate is refused rather than silently attached, so
  // neither a transient currentness read nor an undecryptable row can turn a
  // source conflict into a seeded continuation of another Session. A row this
  // call just created cannot conflict with itself and needs no such evidence.
  if (created.created !== true) {
    if (!accountEncryptionCurrentness) {
      throw createCodedError(
        'Existing Session creation candidate could not be authenticated',
        SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        { sessionId },
      );
    }
    const ownerMetadata = tryDecryptSessionOwnerMetadataView({
      credentials: params.credentials,
      accountEncryptionMode: accountEncryptionCurrentness.mode,
      rawSession: created.session,
    });
    const candidateValidation = validateExistingSessionCreationCandidate({
      ownerMetadata,
      correspondence: params.sessionCreationCorrespondence,
      sourceRecipe: params.sourceContext ?? replaySeededCreation.sourceRecipe,
      validateSourceRecipe: true,
    });
    if (candidateValidation.kind === 'correspondence_conflict') {
      throw createCodedError(
        'Existing Session creation correspondence conflicts with the admitted immutable recipe',
        'creation_conflict',
        { sessionId },
      );
    }
    // POSITIVE evidence, not merely the absence of a contradiction. A readable
    // row that names a different source is the loud case; the quiet one is a
    // row whose owner metadata will not decrypt, or carries no recipe at all —
    // that row is refused before comparison, so the seed is never attached to
    // a Session this call did not authenticate. Consumption keeps
    // these fields (it blanks `seedText` and spreads the rest), so an exact
    // retry after the child has already run still rejoins.
    if (candidateValidation.kind === 'source_recipe_missing') {
      throw createCodedError(
        'Existing Session creation candidate could not be authenticated',
        SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        { sessionId },
      );
    }
    if (candidateValidation.kind === 'source_recipe_conflict') {
      throw createCodedError(
        'Existing Session was created from a different source recipe',
        'creation_conflict',
        { sessionId },
      );
    }
    if (connectedServiceChildLaunch.materializationIdentity) {
      const persistedMaterializationIdentity = readConnectedServiceMaterializationIdentityV1FromMetadata(ownerMetadata);
      if (!persistedMaterializationIdentity) {
        throw createCodedError(
          'Existing Session connected-service identity could not be authenticated',
          'creation_conflict',
          { sessionId },
        );
      }
      connectedServiceChildLaunch = {
        ...connectedServiceChildLaunch,
        materializationIdentity: persistedMaterializationIdentity,
        spawn: {
          ...connectedServiceChildLaunch.spawn,
          connectedServiceMaterializationIdentityV1: persistedMaterializationIdentity,
        },
        metadata: {
          ...connectedServiceChildLaunch.metadata,
          connectedServiceMaterializationIdentityV1: persistedMaterializationIdentity,
        },
      };
    }
  }

  const spawnResponse = await dispatchReplaySeededSpawn({
    token: params.credentials.token,
    sessionId,
    createdHere: created.created === true,
    dispatchSpawnRequest: args.dispatchSpawnRequest,
    spawnRequestInput: {
      ...args.spawnRequestInput,
      ...connectedServiceChildLaunch.spawn,
    },
  });
  const spawnResponseRecord = readSpawnResponseRecord(spawnResponse);
  const spawnSucceeded = spawnResponseRecord?.type === 'success'
    || spawnResponseRecord?.success === true;
  if (!spawnSucceeded) {
    // Only a fresh row plus a known pre-admission rejection proves this owner
    // can archive. Rejoins and ambiguous/post-admission outcomes may be live.
    if (
      created.created === true
      && isDefiniteReplaySeededPreAdmissionRejection(spawnResponseRecord?.errorCode)
    ) {
      await archiveSessionOnceInactive({ token: params.credentials.token, sessionId })
        .catch(() => undefined);
    }
    throw createCodedError(
      typeof spawnResponseRecord?.errorMessage === 'string' && spawnResponseRecord.errorMessage.trim().length > 0
        ? spawnResponseRecord.errorMessage
        : typeof spawnResponseRecord?.error === 'string' && spawnResponseRecord.error.trim().length > 0
          ? spawnResponseRecord.error
          : 'Failed to spawn session',
      typeof spawnResponseRecord?.errorCode === 'string' && spawnResponseRecord.errorCode.trim().length > 0
        ? spawnResponseRecord.errorCode
        : SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
      { sessionId, spawnResponse: spawnResponse ?? null },
    );
  }

  let organizationPlacement: SessionOrganizationPlacementV1 = params.organizationPlacement
    ?? { folderId: null, tagIds: [] };
  try {
    organizationPlacement = await fetchSessionOrganizationPlacement({
      token: params.credentials.token,
      sessionId,
      ...(params.signal ? { signal: params.signal } : {}),
    });
  } catch {
    // The committed Session is already known; a mutable presentation read
    // cannot undo that fact.
  }
  // The committed Session is settled here; the initial input flows through
  // the one Message-owned admission owner so the disposition is the exact
  // admission outcome, never a fabricated acceptance.
  const initialInput = await submitSpawnInitialInput({
    credentials: params.credentials,
    sessionId,
    initialInput: params.initialInput,
    localId: args.initialInputLocalId,
    initialInputHandoff: args.initialInputHandoff,
    machineAdmissionTransport: params.machineAdmissionTransport,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  return {
    disposition: created.created ? 'created' : 'rejoined',
    sessionId,
    organizationPlacement,
    initialInput,
    ...(accountEncryptionCurrentness
      ? {
        session: summarizeSessionRecord({
          credentials: params.credentials,
          accountEncryptionMode: accountEncryptionCurrentness.mode,
          session: created.session,
        }),
      }
      : {}),
  };
}

export async function createSpawnedSession(
  params: CreateSpawnedSessionParams,
): Promise<Readonly<{
  disposition: 'created' | 'rejoined';
  sessionId: string;
  organizationPlacement: SessionOrganizationPlacementV1;
  initialInput: SessionSpawnNewInitialInputDispositionV1;
  session?: SessionSummary;
}>> {
  const exactMachineId = typeof params.machineId === 'string'
    ? params.machineId.trim()
    : '';
  if (!exactMachineId && !params.directTransport) {
    throw createCodedError(
      'Session creation requires an exact machine target',
      SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    );
  }
  const callerOwnedSpawnNonce = typeof params.spawnNonce === 'string' && params.spawnNonce.trim().length > 0
    ? params.spawnNonce.trim()
    : null;
  // Public Action/RPC calls do not carry the host action request id. Their
  // durable creation tag is already the canonical retry identity, so use it
  // for settlement rather than inventing a generated nonce that cleanup could
  // later mistake for an abandoned one-off attempt.
  const creationOwnedSpawnNonce = params.sessionCreationTag
    ? createStableSpawnNonce('session.spawn_new.creation', {
      sessionCreationTag: params.sessionCreationTag,
    })
    : null;
  // A public creation key is the durable retry identity. The transport request
  // id only distinguishes otherwise-unkeyed calls and must never change the
  // first-turn local id for a retry of the same creation.
  const spawnNonce = creationOwnedSpawnNonce ?? callerOwnedSpawnNonce ?? randomUUID();
  const hasRetryableSpawnNonce = callerOwnedSpawnNonce !== null || creationOwnedSpawnNonce !== null;
  const initialInputText = typeof params.initialInput?.text === 'string' ? params.initialInput.text : '';
  const initialInputRequested = hasSessionInputContentV1({
    text: initialInputText,
    attachmentCount: params.initialInput?.attachments?.length ?? 0,
  });
  const initialInputLocalId = params.sessionCreationTag
    ? buildSessionSpawnInitialInputLocalIdV1({ sessionCreationTag: params.sessionCreationTag })
    : buildSpawnedFirstTurnLocalId(spawnNonce);
  if (!initialInputLocalId) {
    throw createCodedError(
      'Spawn identity did not produce a valid first-turn identity',
      SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    );
  }
  const initialInputHandoff = initialInputRequested
    ? params.buildInitialInputHandoff?.(initialInputLocalId)
    : undefined;
  if (initialInputRequested && !initialInputHandoff) {
    throw createCodedError(
      'Initial input requires Message-owned admission identity',
      SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    );
  }
  const spawnRequestInput = {
    directory: params.directory,
    spawnNonce,
    ...(exactMachineId ? { machineId: exactMachineId } : {}),
    ...(params.agentTarget ? { agentTarget: params.agentTarget } : {}),
    ...(!params.agentTarget && params.backendTarget ? { backendTarget: params.backendTarget } : {}),
    ...(params.sessionCreationTag ? { sessionCreationTag: params.sessionCreationTag } : {}),
    ...(params.sessionCreationCorrespondence
      ? { sessionCreationCorrespondence: params.sessionCreationCorrespondence }
      : {}),
    ...(typeof params.initialTitle === 'string' && params.initialTitle.trim().length > 0
      ? { initialTitle: params.initialTitle.trim() }
      : {}),
    ...(params.modelSelection ? { modelSelection: params.modelSelection } : {}),
    ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
    ...(typeof params.permissionModeUpdatedAt === 'number' && Number.isFinite(params.permissionModeUpdatedAt)
      ? { permissionModeUpdatedAt: params.permissionModeUpdatedAt }
      : {}),
    ...(params.agentModeId ? { agentModeId: params.agentModeId } : {}),
    ...(typeof params.agentModeUpdatedAt === 'number' && Number.isFinite(params.agentModeUpdatedAt)
      ? { agentModeUpdatedAt: params.agentModeUpdatedAt }
      : {}),
    ...(typeof params.accountSettingsVersionHint === 'number' && Number.isFinite(params.accountSettingsVersionHint)
      ? { accountSettingsVersionHint: params.accountSettingsVersionHint }
      : {}),
    ...(typeof params.initialTranscriptAfterSeq === 'number' && Number.isFinite(params.initialTranscriptAfterSeq)
      ? { initialTranscriptAfterSeq: params.initialTranscriptAfterSeq }
      : {}),
    ...(params.executionAuthorization ? { executionAuthorization: params.executionAuthorization } : {}),
    ...(params.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: params.sessionConfigOptionOverrides } : {}),
    ...(typeof params.profileId === 'string' ? { profileId: params.profileId } : {}),
    ...(params.environmentVariables ? { environmentVariables: params.environmentVariables } : {}),
    ...(params.resume ? { resume: params.resume } : {}),
    ...(typeof params.approvedNewDirectoryCreation === 'boolean'
      ? { approvedNewDirectoryCreation: params.approvedNewDirectoryCreation }
      : {}),
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
    ...(params.runtimeDescriptorV1 ? { runtimeDescriptorV1: params.runtimeDescriptorV1 } : {}),
    ...(params.agentSessionStartupInstructionsV1
      ? { agentSessionStartupInstructionsV1: params.agentSessionStartupInstructionsV1 }
      : {}),
  } satisfies Record<string, unknown>;
  const spawnRequest = SpawnDaemonSessionRequestSchema.parse(spawnRequestInput);
  const isProviderBound = spawnRequest.modelSelection?.ref.providerConnectionId != null;
  await assertStoredAuthTokenValidForSpawn(params.credentials.token);
  params.signal?.throwIfAborted();
  if (params.sessionCreationTag && params.sessionCreationCorrespondence) {
    const lookup = await lookupSessionsByTags({
      token: params.credentials.token,
      tags: [params.sessionCreationTag],
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (lookup.state === 'available' && lookup.sessions.length > 1) {
      throw createCodedError(
        'Session creation tag matched more than one Session',
        'creation_conflict',
      );
    }
    const existing = lookup.state === 'available' ? lookup.sessions[0] : undefined;
    if (existing) {
      const accountEncryptionCurrentness = await readKnownSessionAccountEncryptionCurrentness({
        token: params.credentials.token,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      // A matching creation tag only finds a candidate. The immutable recipe
      // must be authenticated before this branch can rejoin it or attach input.
      if (!accountEncryptionCurrentness) {
        throw createCodedError(
          'Existing Session creation candidate could not be authenticated',
          SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
          { spawnNonce },
        );
      }
      const ownerMetadata = tryDecryptSessionOwnerMetadataView({
        credentials: params.credentials,
        accountEncryptionMode: accountEncryptionCurrentness.mode,
        rawSession: existing,
      });
      const candidateValidation = validateExistingSessionCreationCandidate({
        ownerMetadata,
        correspondence: params.sessionCreationCorrespondence,
        sourceRecipe: params.sourceContext ?? params.replaySeededCreation?.sourceRecipe,
        validateSourceRecipe: true,
      });
      if (candidateValidation.kind === 'correspondence_conflict') {
        throw createCodedError(
          'Existing Session creation correspondence conflicts with the admitted immutable recipe',
          'creation_conflict',
          { sessionId: existing.id },
        );
      }
      // Strict SessionCreationCorrespondenceV1 does not carry the source
      // recipe, so a rejoin additionally authenticates the persisted Replay
      // lineage against the requested source before input or navigation.
      if (candidateValidation.kind === 'source_recipe_missing' || candidateValidation.kind === 'source_recipe_conflict') {
        throw createCodedError(
          'Existing Session was created from a different source recipe',
          'creation_conflict',
          { sessionId: existing.id },
        );
      }
      let organizationPlacement = params.sessionCreationCorrespondence.recipe.organization;
      try {
        organizationPlacement = await fetchSessionOrganizationPlacement({
          token: params.credentials.token,
          sessionId: existing.id,
          ...(params.signal ? { signal: params.signal } : {}),
        });
      } catch {
        // The committed Session and its authenticated correspondence are
        // already known. A mutable presentation read cannot undo that fact.
      }
      await writeLegacyMetadataLabelBestEffort({
        token: params.credentials.token,
        credentials: params.credentials,
        accountEncryptionCurrentness,
        sessionId: existing.id,
        rawSession: existing,
        legacyMetadataLabel: params.legacyMetadataLabel,
      });
      const initialInput = await submitSpawnInitialInput({
        credentials: params.credentials,
        sessionId: existing.id,
        initialInput: params.initialInput,
        localId: initialInputLocalId,
        initialInputHandoff,
        machineAdmissionTransport: params.machineAdmissionTransport,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      return {
        disposition: 'rejoined',
        sessionId: existing.id,
        organizationPlacement,
        initialInput,
        session: summarizeSessionRecord({
          credentials: params.credentials,
          accountEncryptionMode: accountEncryptionCurrentness.mode,
          session: existing,
        }),
      };
    }
  }
  const dispatchSpawnRequest = async (request: SpawnDaemonSessionRequest): Promise<unknown> => {
    try {
      return params.directTransport
        ? await params.directTransport.spawn(
          // Released cli-v0.2.1 daemons do not read agentTarget. Keep the
          // caller-supplied exact backend projection only at this version-skew
          // transport seam; remove when those remote readers are unreachable.
          (params.agentTarget && params.backendTarget
            ? { ...request, backendTarget: params.backendTarget }
            : request),
          params.signal ? { signal: params.signal } : undefined,
        )
        : params.machineActionTransport
          ? await params.machineActionTransport(
            isProviderBound
              ? RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE
              : RPC_METHODS.SPAWN_HAPPY_SESSION,
            request,
            params.signal ? { signal: params.signal } : undefined,
          )
          : await callMachineRpc({
          credentials: params.credentials,
          machineId: exactMachineId,
          method: isProviderBound
            ? RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE
            : RPC_METHODS.SPAWN_HAPPY_SESSION,
          request,
          ...(params.signal ? { signal: params.signal } : {}),
        });
    } catch (error) {
      if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
        throw createCodedError(
          isProviderBound
            ? 'Provider-bound session creation is unavailable because the selected machine does not support this request'
            : 'Exact-machine session creation is unavailable because the selected machine does not support this request',
          SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
        );
      }
      if (params.signal?.aborted) {
        throw createCodedError(
          'Session-spawn submission may have been accepted before caller cancellation',
          SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
          { spawnNonce },
        );
      }
      if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'MACHINE_RPC_TIMEOUT') {
        (error as { details?: unknown }).details = { spawnNonce };
      }
      throw error;
    }
  };

  if (params.replaySeededCreation) {
    return await createReplaySeededSpawnedSession({
      params,
      replaySeededCreation: params.replaySeededCreation,
      spawnRequestInput,
      dispatchSpawnRequest,
      initialInputLocalId,
      ...(initialInputHandoff ? { initialInputHandoff } : {}),
    });
  }

  let spawnResponse: unknown;
  if (params.resumeOnly === true) {
    spawnResponse = { success: true as const, status: 'pending' as const, sessionIdStatus: 'pending' as const, spawnNonce };
  } else {
    spawnResponse = await dispatchSpawnRequest(spawnRequest);
  }
  const resolveSpawnSessionByNonce = async (
    nonce: string,
    signal?: AbortSignal,
  ): Promise<SpawnSessionNonceResolution> => {
    try {
      if (params.directTransport) {
        return normalizeSpawnSessionNonceResolution(
          await params.directTransport.resolveSpawnSessionByNonce(nonce, { signal }),
        );
      }
      const resolved = params.machineActionTransport
        ? await params.machineActionTransport(
          RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
          { spawnNonce: nonce },
          signal ? { signal } : undefined,
        )
        : await callMachineRpc({
          credentials: params.credentials,
          machineId: exactMachineId,
          method: RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
          request: { spawnNonce: nonce },
          ...(signal ? { signal } : {}),
        });
      return normalizeSpawnSessionNonceResolution(resolved);
    } catch (error) {
      if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
        return { status: 'unsupported' };
      }
      throw error;
    }
  };
  const spawnResponseRecord = readSpawnResponseRecord(spawnResponse);
  const directSessionId = typeof spawnResponseRecord?.sessionId === 'string'
    ? spawnResponseRecord.sessionId.trim()
    : '';
  const acceptedWithoutSessionId = isAcceptedPendingSpawn(spawnResponse)
    || isTransientSpawnFailure(spawnResponse)
    || (spawnResponseRecord?.type === 'success' && !directSessionId);
  const hasDirectSessionId = (spawnResponseRecord?.success === true || spawnResponseRecord?.type === 'success')
    && directSessionId.length > 0;
  if (!acceptedWithoutSessionId && !hasDirectSessionId) {
    const responseError = typeof spawnResponseRecord?.errorMessage === 'string' && spawnResponseRecord.errorMessage.trim().length > 0
      ? spawnResponseRecord.errorMessage
      : typeof spawnResponseRecord?.error === 'string' && spawnResponseRecord.error.trim().length > 0
        ? spawnResponseRecord.error
        : 'Failed to spawn session';
    throw createCodedError(
      responseError,
      spawnResponseRecord?.requiresUserApproval === true || spawnResponseRecord?.type === 'requestToApproveDirectoryCreation'
        ? 'conflict'
        : typeof spawnResponseRecord?.errorCode === 'string' && spawnResponseRecord.errorCode.trim().length > 0
          ? spawnResponseRecord.errorCode
          : 'unknown_error',
      spawnResponse ?? null,
    );
  }
  const settledSpawn = await awaitSpawnedSessionId({
    result: acceptedWithoutSessionId
      ? { type: 'success', spawnNonce, sessionIdStatus: 'pending' }
      : spawnResponse,
    spawnNonce,
    resolveSpawnSessionByNonce: (nonce) => resolveSpawnSessionByNonce(nonce, params.signal),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (settledSpawn.type === 'error') {
    if (
      acceptedWithoutSessionId
      && !hasRetryableSpawnNonce
      && params.resumeOnly !== true
      && settledSpawn.errorCode !== SPAWN_SESSION_ERROR_CODES.UNEXPECTED
    ) {
      abandonSpawnedSessionBestEffort({
        spawnNonce,
        reason: settledSpawn.errorMessage,
        resolveSpawnSessionByNonce: (nonce) => resolveSpawnSessionByNonce(nonce),
        stopSession: async (sessionId) => {
          const stopped = await requestSessionStop({ credentials: params.credentials, idOrPrefix: sessionId });
          return stopped.ok && stopped.stopped;
        },
        archiveSession: async (sessionId) => {
          await archiveSessionOnceInactive({ token: params.credentials.token, sessionId });
        },
      });
    }
    const error = new Error(
      settledSpawn.errorMessage
      || (typeof spawnResponseRecord?.error === 'string' && spawnResponseRecord.error.trim().length > 0
        ? spawnResponseRecord.error
        : 'Failed to spawn session'),
    );
    (error as { code?: string }).code = settledSpawn.errorCode;
    (error as { details?: unknown }).details = {
      spawnResponse: spawnResponse ?? null,
      ...(acceptedWithoutSessionId ? { spawnNonce } : {}),
    };
    throw error;
  }
  const sessionId = settledSpawn.sessionId;
  const sessionCreationOutcome = settledSpawn.sessionCreationOutcome;
  if (!sessionCreationOutcome) {
    throw createCodedError(
      'Spawn settlement did not include the authoritative create-or-rejoin outcome',
      SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
      { sessionId },
    );
  }
  // The Session row is committed and settled here; initial input is submitted
  // through the one Message-owned admission owner only after the settled
  // candidate is authenticated, so the returned disposition is the exact
  // admission outcome, never a fabricated acceptance.
  const submitInitialInput = () => submitSpawnInitialInput({
    credentials: params.credentials,
    sessionId,
    initialInput: params.initialInput,
    localId: initialInputLocalId,
    initialInputHandoff,
    machineAdmissionTransport: params.machineAdmissionTransport,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const fetchTimeoutMs = resolvePositiveIntFromEnv('HAPPIER_SESSION_SPAWN_FETCH_TIMEOUT_MS', DEFAULT_SPAWNED_SESSION_FETCH_TIMEOUT_MS);
  const pollIntervalMs = resolvePositiveIntFromEnv('HAPPIER_SESSION_SPAWN_FETCH_POLL_INTERVAL_MS', DEFAULT_SPAWNED_SESSION_FETCH_POLL_INTERVAL_MS);
  const visibility = await waitForSpawnedSessionVisibility({
    token: params.credentials.token,
    sessionId,
    timeoutMs: fetchTimeoutMs,
    pollIntervalMs,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (visibility.type === 'failed') {
    logger.warn(
      '[SESSION SPAWN] Settled Session visibility read failed',
      { code: 'session_spawn_visibility_unavailable' },
    );
  }
  const rawSession = visibility.type === 'visible' ? visibility.session : null;
  if (!rawSession) {
    if (
      params.sourceContext
      || (sessionCreationOutcome.disposition === 'rejoined' && params.sessionCreationCorrespondence)
    ) {
      throw createCodedError(
        'Settled Session creation candidate could not be authenticated before visibility settled',
        SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        { sessionId },
      );
    }
    const initialInput = await submitInitialInput();
    return {
      disposition: sessionCreationOutcome.disposition,
      sessionId,
      organizationPlacement: sessionCreationOutcome.organizationPlacement,
      initialInput,
    };
  }

  const accountEncryptionCurrentness = await readKnownSessionAccountEncryptionCurrentness({
    token: params.credentials.token,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (
    !accountEncryptionCurrentness
    && (
      params.sourceContext
      || (sessionCreationOutcome.disposition === 'rejoined' && params.sessionCreationCorrespondence)
    )
  ) {
    throw createCodedError(
      'Rejoined Session creation candidate could not be authenticated',
      SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      { sessionId },
    );
  }
  const ownerMetadata = accountEncryptionCurrentness && (params.sessionCreationCorrespondence || params.sourceContext)
    ? tryDecryptSessionOwnerMetadataView({
      credentials: params.credentials,
      accountEncryptionMode: accountEncryptionCurrentness.mode,
      rawSession,
    })
    : null;
  const candidateValidation = validateExistingSessionCreationCandidate({
    ownerMetadata,
    correspondence: params.sessionCreationCorrespondence,
    sourceRecipe: params.sourceContext,
    validateSourceRecipe: Boolean(params.sourceContext),
  });
  if (candidateValidation.kind === 'correspondence_conflict') {
    throw createCodedError(
      'Spawned Session correspondence does not match the admitted immutable recipe',
      'creation_conflict',
      { sessionId },
    );
  }
  if (candidateValidation.kind === 'source_recipe_missing' || candidateValidation.kind === 'source_recipe_conflict') {
    throw createCodedError(
      'Settled Session was created from a different source recipe',
      'creation_conflict',
      { sessionId },
    );
  }
  if (accountEncryptionCurrentness) {
    await writeLegacyMetadataLabelBestEffort({
      token: params.credentials.token,
      credentials: params.credentials,
      accountEncryptionCurrentness,
      sessionId,
      rawSession,
      legacyMetadataLabel: params.legacyMetadataLabel,
    });
  }
  const initialInput = await submitInitialInput();

  return {
    disposition: sessionCreationOutcome.disposition,
    sessionId,
    organizationPlacement: sessionCreationOutcome.organizationPlacement,
    initialInput,
    ...(accountEncryptionCurrentness
      ? {
          session: summarizeSessionRecord({
            credentials: params.credentials,
            accountEncryptionMode: accountEncryptionCurrentness.mode,
            session: rawSession,
          }),
        }
      : {}),
  };
}
