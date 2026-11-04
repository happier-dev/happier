import { normalizeSpawnSessionErrorDetail, SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';
import { readConnectedServiceMaterializationIdentityV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/connectedServiceMaterializationIdentityV1';
import { normalizeSpawnSessionNonceResolution } from '@happier-dev/protocol/sessions/spawnSessionNonce';
import { buildSpawnedFirstTurnLocalId, buildSessionSpawnInitialInputLocalIdV1 } from '@happier-dev/protocol/sessions/messages/spawnedFirstTurn';
import { sessionCreationCorrespondenceMatchesV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { commitPreparedSessionBirthV1 } from '@happier-dev/protocol/sessions';
import { migrateRetainedSessionWorkContextV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { prepareSessionMemoryInheritance } from '@/agent/prompting/coding/sessionPromptStack';
import { DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS } from '@happier-dev/protocol/sessions/creation/sessionSpawnBudget';
import { SessionForkFilesNotCopiedV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SessionAttestedContextV1Schema, type SessionAttestedContextV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { hasSessionInputContentV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAuthoringV1';
import { SessionRolesV1Schema } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { supportsMachineSessionSpawnProtocolVersionV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import type { BackendTargetRefV2, MachinePoolSelectionOriginV1, SessionCreationCorrespondenceV1, SessionCreationTagV1, SessionSpawnNewInitialInputDispositionV1, SessionSpawnSourceContextV1, SessionOrganizationPlacementV1, SessionModelSelectionV1, SpawnSessionNonceResolution, PluginSessionInputAttachmentV1, RawIngressStructuredInputV1, SessionForkFilesNotCopiedV1 } from '@happier-dev/protocol';
import type { SessionSpawnNewInitialInputV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { SessionCreationHostContinuationV1 } from '@happier-dev/protocol/actions/executor/types';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';
import { randomUUID } from 'node:crypto';
import { isDefiniteSpawnPreAdmissionRejection } from './spawnPreAdmissionRejection';
import os from 'node:os';
import { pickSessionCreateOriginFields } from '@/session/shared/sessionCreateOrigin';
import { applyInitialSessionCreationFactsToMetadata, buildCommittedLaunchMetadata } from '@/agent/runtime/createSessionMetadata';
import { resolveAvailableAccountSettings } from '@/settings/accountSettings/resolveAvailableAccountSettings';

import { createAuthenticationHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';
import { validateStoredAuthTokenAgainstActiveServer } from '@/auth/validateStoredAuthTokenAgainstActiveServer';
import type { StoredCredentials } from '@/persistence';
import {
  SpawnDaemonSessionRequestSchema,
  type SpawnDaemonSessionRequest,
} from '@/rpc/handlers/spawnSessionOptionsContract';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { readMachineOperationProtocolCapabilitiesV1 } from '@/api/machine/machineOperationProtocolCapabilities';
import {
  fetchSessionById,
  fetchSessionOrganizationPlacement,
  getOrCreateSessionByTag,
  lookupSessionsByTags,
} from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { callExactMachineRpc, readMachineRpcRequestDisposition } from '@/session/transport/rpc/machineRpc';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { summarizeSessionRecord, type SessionSummary } from '@/cli/output/session/sessionSummary';
import { openSessionEventSource } from '@/session/transport/socket/sessionSocketAgentState';
import { logger } from '@/utils/logger';
import { sendSessionMessage } from './sendSessionMessage';
import { ensureSessionMachineAccessKeyBinding } from '@/api/session/ensureSessionMachineAccessKeyBinding';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';
import { submitSpawnInitialInput } from './submitSpawnInitialInput';
import { abandonSpawnedSessionBestEffort, awaitSpawnedSessionId, type SpawnSessionNonceResolver } from './awaitSpawnedSessionId';
import { archiveSessionOnceInactive } from './archiveSessionOnceInactive';
import { requestSessionStop } from './requestSessionStop';
import { createSessionCreationSpawnNonce } from '@/session/shared/spawnNonce';
import { seedForkVisualsBestEffort } from '@/session/fork/seedForkVisuals';
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
    options?: Readonly<{ signal?: AbortSignal; localActionContext?: import('@/api/rpc/types').RpcLocalActionContext }> & Pick<SpawnSessionOptions, 'creationAuthorization' | 'callerInputConstraints' | 'requesterSessionBootstrap'>,
  ) => Promise<unknown>;
  resolveSpawnSessionByNonce: (
    spawnNonce: string,
    options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
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

/** The same row commit/attach lifecycle with optional Replay lineage. */
type SeededSessionCreationV1 = Omit<ReplaySeededSessionCreationV1, 'flavor' | 'sourceRecipe'>
  & Partial<Pick<ReplaySeededSessionCreationV1, 'flavor' | 'sourceRecipe'>>;

export type CreateSpawnedSessionParams = Readonly<import('@happier-dev/protocol').SessionCreateOriginFieldsV1 & {
  credentials: StoredCredentials;
  /** Host-admitted requester Account fact; never accepted from public spawn input. */
  accountEncryptionCurrentness?: AccountEncryptionCurrentnessResponse;
  /** Authenticated target Home used by qualified Context preparation; never persisted in spawn input. */
  serverId?: string;
  /** Invocation-local Account policy supplied by the authenticated Action owner. */
  accountSettings?: Readonly<Record<string, unknown>>;
  directoryKind?: 'path' | 'managed';
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
  /** Informational origin persisted only by the fresh canonical creator. */
  placementOrigin?: MachinePoolSelectionOriginV1;
  authoringOrigin?: import('@happier-dev/protocol/plugins/ui').PluginUiNewSessionSeedOriginV1;
  organizationPlacement?: SessionOrganizationPlacementV1;
  initialAccess?: import('@happier-dev/protocol').SessionInitialAccessDraftV1;
  initialTriggers?: readonly import('@happier-dev/protocol').SessionInitialTriggerAdmissionV1[];
  /** Birth-only preparation; an authenticated creation-key rejoin never re-admits drafts. */
  prepareInitialTriggers?: () => Promise<readonly import('@happier-dev/protocol').SessionInitialTriggerAdmissionV1[]>;
  manager?: import('@happier-dev/protocol').SessionManagerV1;
  /** Canonical Action host's resolved snapshot; never accepted from raw public Action input. */
  initialSessionRolesV1?: import('@happier-dev/protocol').SessionRolesV1;
  primaryTeamId?: string | null;
  modelSelection?: SessionModelSelectionV1;
  /** Mutable presentation written only through the fresh create envelope. */
  initialTitle?: string;
  identity?: import('@happier-dev/protocol/sessions/identity/sessionBotV1').SessionIdentityAdditions;
  /** Host-admitted birth facts, deliberately absent from raw Machine spawn RPC. */
  attestedContext?: import('@happier-dev/protocol').SessionAttestedContextV1;
  memoryEnabled?: boolean;
  approvalProfileId?: string | null;
  promptStack?: import('@happier-dev/protocol/sessions/context/sessionContextV1').SessionPromptStackV1;
  /** Fresh birth validates required qualified documents before any runner is dispatched. */
  preparePromptStack?: () => Promise<void>;
  /** Host preparation of committed Session content; never carried over spawn RPC. */
  beforeLaunch?: SessionCreationHostContinuationV1['beforeLaunch'];
  /** The local admitted host signs birth bytes; never serialized to a Machine RPC. */
  authorizeCreationRequest?: Parameters<typeof getOrCreateSessionByTag>[0]['authorizeRequest'];
  templateRequesterAuthorization?: Parameters<typeof getOrCreateSessionByTag>[0]['templateRequesterAuthorization'];
  onCreationAuthorization?: Parameters<typeof getOrCreateSessionByTag>[0]['onCreationAuthorization'];
  authorizeMachineAccessKeyRequest?: Parameters<typeof ensureSessionMachineAccessKeyBinding>[0]['authorizeRequest'];
  /**
   * Private sidecar from a provenance-bounded predecessor approval-artifact
   * replay; never accepted from live Action/RPC ingress or sent as a server
   * Session tag.
   */
  legacyMetadataLabel?: string;
  initialInput?: Readonly<{
    text?: string;
    attachments?: readonly PluginSessionInputAttachmentV1[];
    structuredInput?: RawIngressStructuredInputV1;
    reviewComments?: SessionSpawnNewInitialInputV1['reviewComments'];
  }>;
  buildInitialInputHandoff?: (localId: string) => Readonly<{
    meta?: Record<string, unknown>;
    inputAdmission: NonNullable<Parameters<typeof sendSessionMessage>[0]['inputAdmission']>;
    executionAuthority?: Parameters<typeof sendSessionMessage>[0]['executionAuthority'];
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
   * attach the launched runner to it. Host preparation also uses this committed
   * birth owner; other ordinary authoring lets runner bootstrap create the row.
   */
  replaySeededCreation?: ReplaySeededSessionCreationV1;
  /**
   * A fork-owned projection already minted by the shared child-launch owner.
   * It keeps the committed row and its direct runner attachment on one identity.
   */
  connectedServiceChildLaunch?: ConnectedServiceChildLaunchContext;
  /** Resolve an already-submitted launch attempt without sending another spawn. */
  resumeOnly?: boolean;
  /** Authenticated same-input prior receipt, supplied only by the host's Action operation owner. */
  previousSessionCreationFailure?: Extract<import('@happier-dev/protocol').SessionSpawnNewResultV1, Readonly<{ type: 'error' }>>;
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
  | 'allowedTools'
  | 'unlistedTools'
  | 'workspaceWrites'
  | 'creationAuthorization'
  | 'callerInputConstraints'
  | 'permissionModeUpdatedAt'
  | 'agentModeId'
  | 'agentModeUpdatedAt'
  | 'accountSettingsVersionHint'
  | 'initialTranscriptAfterSeq'
  | 'executionAuthorization'
  | 'sessionConfigOptionOverrides'
  | 'profileId'
  | 'secretReferenceOverlay'
  | 'environmentVariables'
  | 'resume'
  | 'approvedNewDirectoryCreation'
  | 'connectedServices'
  | 'connectedServicesUpdatedAt'
  | 'teamCredentialBindings'
  | 'capabilitySelection'
  | 'transcriptStorage'
  | 'terminal'
  | 'windowsRemoteSessionLaunchMode'
  | 'windowsRemoteSessionConsole'
  | 'windowsTerminalWindowName'
  | 'runtimeDescriptorV1'
  | 'agentSessionStartupInstructionsV1'
  | 'agentTarget'
  | 'managedDirectorySeed'
>> & (
  | Readonly<{ deferLaunch?: false; directory: string }>
  /** Host-private birth only; the selected Machine resolves a managed path on Resume. */
  | Readonly<{ deferLaunch: true; directory: string | undefined }>
)>;

function readForkFilesNotCopied(metadata: unknown): SessionForkFilesNotCopiedV1 | undefined {
  if (!metadata || typeof metadata !== 'object' || !('forkV1' in metadata)) return undefined;
  const fork = metadata.forkV1;
  if (!fork || typeof fork !== 'object' || !('filesNotCopied' in fork)) return undefined;
  const parsed = SessionForkFilesNotCopiedV1Schema.safeParse(fork.filesNotCopied);
  return parsed.success ? parsed.data : undefined;
}

const DEFAULT_SPAWNED_SESSION_FETCH_TIMEOUT_MS = 10_000;
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
  signal?: AbortSignal;
}>): Promise<SpawnedSessionVisibility> {
  const deadlineMs = Date.now() + params.timeoutMs;
  // The account stream is available before the newly created Session is visible.
  const events = openSessionEventSource({ ...params, scope: 'user' });
  try {
    while (true) {
      const revision = events.currentRevision();
      if (params.signal?.aborted) return { type: 'cancelled' };
      let session: Awaited<ReturnType<typeof fetchSessionById>>;
      try {
        session = await fetchSessionById({
          reason: 'session-control',
          token: params.token,
          sessionId: params.sessionId,
          ...(params.signal ? { signal: params.signal } : {}),
        });
      } catch {
        return { type: params.signal?.aborted ? 'cancelled' : 'failed' };
      }
      if (session) return { type: 'visible', session };
      if (!(await events.waitForChange(revision, { deadlineMs, signal: params.signal }))) {
        return { type: params.signal?.aborted ? 'cancelled' : 'unavailable' };
      }
    }
  } catch {
    return { type: params.signal?.aborted ? 'cancelled' : 'failed' };
  } finally {
    await events.close();
  }
}

async function readKnownSessionAccountEncryptionCurrentness(params: Pick<CreateSpawnedSessionParams,
  'credentials' | 'signal' | 'accountEncryptionCurrentness'>): Promise<AccountEncryptionCurrentnessResponse | null> {
  if (params.signal?.aborted) return null;
  if (params.accountEncryptionCurrentness) return params.accountEncryptionCurrentness;
  try {
    return await fetchAccountEncryptionCurrentness({
      token: params.credentials.token,
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

async function prepareCommittedSessionContent(
  params: Pick<CreateSpawnedSessionParams, 'beforeLaunch'>,
  birth: Parameters<NonNullable<CreateSpawnedSessionParams['beforeLaunch']>>[0],
): Promise<void> {
  try {
    await params.beforeLaunch?.(birth);
  } catch (error) {
    // Content preparation may fail after birth. Keep that committed identity
    // visible to the ordinary operation's partial-result and retry owner.
    if (error instanceof Error) {
      const details = 'details' in error && error.details && typeof error.details === 'object'
        ? error.details : {};
      Object.assign(error, { details: { ...details, sessionId: birth.sessionId } });
      throw error;
    }
    throw createCodedError('Session content preparation failed', SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
      { sessionId: birth.sessionId });
  }
}

/**
 * Dispatch the launch for an already-committed row. Only a fresh row plus a
 * known pre-admission rejection proves this creator can archive it.
 */
async function dispatchCommittedSpawn(args: Readonly<{
  token: string;
  sessionId: string;
  createdHere: boolean;
  dispatchSpawnRequest: (request: SpawnDaemonSessionRequest) => Promise<unknown>;
  spawnRequestInput: Record<string, unknown>;
}>): Promise<unknown> {
  const {
    placementOrigin: _creationOwnedPlacementOrigin,
    authoringOrigin: _creationOwnedAuthoringOrigin,
    initialAccess: _creationOwnedInitialAccess,
    initialTriggers: _creationOwnedInitialTriggers,
    manager: _creationOwnedManager,
    initialSessionRolesV1: _creationOwnedRoles,
    identity: _creationOwnedIdentity,
    memoryEnabled: _creationOwnedMemoryEnabled,
    approvalProfileId: _creationOwnedApprovalProfileId,
    promptStack: _creationOwnedPromptStack,
    primaryTeamId: _creationOwnedPrimaryTeamId,
    originKind: _originKind,
    originSessionId: _originSessionId,
    originRunId: _originRunId,
    discussionParticipant: _discussionParticipant,
    discussionParticipantLaunch: _discussionParticipantLaunch,
    workDepth: _workDepth,
    ...attachSpawnRequestInput
  } = args.spawnRequestInput;
  try {
    return await args.dispatchSpawnRequest(
      SpawnDaemonSessionRequestSchema.parse({
        ...attachSpawnRequestInput,
        existingSessionId: args.sessionId,
        freshSessionCreation: args.createdHere,
      }),
    );
  } catch (error) {
    const code = error && typeof error === 'object'
      ? (error as { code?: unknown }).code
      : undefined;
    if (args.createdHere && isDefiniteSpawnPreAdmissionRejection(code)) {
      await archiveSessionOnceInactive({ token: args.token, sessionId: args.sessionId })
        .catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Seeded-row creation, owned by the canonical creator.
 *
 * The row is committed here from resolved birth metadata, the launched
 * runner attaches to it, and one orphan settlement covers a definite launch
 * failure. Each ingress supplies its canonical creation identity in
 * `seededCreation.tag`; this owner never invents or rewrites one.
 */
async function createSeededSpawnedSession(args: Readonly<{
  params: CreateSpawnedSessionParams;
  seededCreation: SeededSessionCreationV1;
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
  filesNotCopied?: SessionForkFilesNotCopiedV1;
  attestedContext?: SessionAttestedContextV1;
}>> {
  const { params, seededCreation } = args;
  const tag = seededCreation.tag.trim();
  if (!tag) {
    throw createCodedError(
      'Seeded Session creation requires a creation tag',
      SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    );
  }
  if (params.resumeOnly === true && !params.deferLaunch) {
    // Resume-only must not submit a new launch. A committed earlier attempt is
    // already answered by the correspondence rejoin above, so reaching here
    // means the attempt is unresolved — report it as retryable with the same
    // creation identity rather than committing a row that nothing will launch.
    throw createCodedError(
      'Seeded creation attempt could not be resolved without submitting a new launch',
      SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      { tag },
    );
  }
  const accountEncryptionCurrentness = await readKnownSessionAccountEncryptionCurrentness(params);
  let connectedServiceChildLaunch = params.connectedServiceChildLaunch
    ?? createConnectedServiceChildLaunchContext({
      spawn: args.spawnRequestInput,
      metadata: seededCreation.metadata,
    });
  // `legacyMetadataLabel` is the predecessor approval-artifact replay's private
  // label and writes the same `tag` metadata field this creation already owns.
  // The two never co-occur: that replay path carries no source recipe.
  const accountSettings = params.accountSettings ?? await resolveAvailableAccountSettings({ credentials: params.credentials });
  const isWorker = Boolean(params.initialSessionRolesV1 || params.manager);
  const replayMetadata = { ...seededCreation.metadata };
  // Workers use their own Profile, including an explicit or implicit no-Profile choice.
  if (isWorker) delete replayMetadata.profileId;
  let filesNotCopied = readForkFilesNotCopied(seededCreation.metadata);
  let organizationPlacement: SessionOrganizationPlacementV1 = params.organizationPlacement
    ?? { folderId: null, tagIds: [] };
  const { birth, initialInput } = await commitPreparedSessionBirthV1({
    commit: async () => {
      const created = await getOrCreateSessionByTag({
        ...(params.signal ? { signal: params.signal } : {}),
        ...(params.authorizeCreationRequest ? { authorizeRequest: params.authorizeCreationRequest } : {}),
        ...(params.templateRequesterAuthorization ? { templateRequesterAuthorization: params.templateRequesterAuthorization } : {}),
        ...(params.onCreationAuthorization ? { onCreationAuthorization: params.onCreationAuthorization } : {}),
        ...(params.creationAuthorization ? { creationAuthorizationToken: params.creationAuthorization.token,
          prepareCreationAuthorizationProof: params.creationAuthorization.prepareRequestProof } : {}),
        ...pickSessionCreateOriginFields(params),
        credentials: params.credentials,
        tag,
        metadata: applyInitialSessionCreationFactsToMetadata({
          tag,
          ...(params.directory !== undefined ? { path: params.directory, host: os.hostname() } : {}),
          ...(seededCreation.flavor ? { flavor: seededCreation.flavor } : {}),
          ...(params.placementOrigin ? { placementOrigin: params.placementOrigin } : {}),
          ...replayMetadata,
          ...connectedServiceChildLaunch.metadata,
          ...(typeof params.profileId === 'string' ? { profileId: params.profileId } : {}),
          ...(params.directoryKind === 'managed' ? { sessionDirectoryV1: { v: 1, kind: 'managed' } } : {}),
          ...(isWorker ? { work: {
            ...Object.fromEntries(Object.entries(migrateRetainedSessionWorkContextV1(replayMetadata.work))
              .filter(([key]) => key !== 'promptStack' && key !== 'disabledInheritedEntryIds')),
            ...(params.initialSessionRolesV1 ? { sessionRolesV1: SessionRolesV1Schema.parse(params.initialSessionRolesV1) } : {}),
          } } : {}),
        }, { ...params, accountSettings: accountSettings ?? undefined }),
        agentState: null,
        ...(params.initialAccess !== undefined ? { initialAccess: params.initialAccess } : {}),
        ...(params.initialTriggers !== undefined ? { initialTriggers: params.initialTriggers } : {}),
        ...(params.manager !== undefined ? { manager: params.manager } : {}),
        ...(params.primaryTeamId !== undefined ? { primaryTeamId: params.primaryTeamId } : {}),
        ...(params.teamCredentialBindings !== undefined ? { teamCredentialBindings: params.teamCredentialBindings } : {}),
        ...(params.organizationPlacement ? { organizationPlacement: params.organizationPlacement } : {}),
        ...(accountEncryptionCurrentness ? { accountEncryptionCurrentness } : {}),
      });
      const sessionId = typeof created.session?.id === 'string' ? created.session.id.trim() : '';
      if (!sessionId) {
        throw createCodedError(
          'Failed to create seeded session (missing id)',
          SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        );
      }
      const ownerMetadata = accountEncryptionCurrentness
        ? tryDecryptSessionOwnerMetadataView({
          credentials: params.credentials,
          accountEncryptionMode: accountEncryptionCurrentness.mode,
          rawSession: created.session,
        })
        : null;
      return { sessionId, disposition: created.created ? 'created' as const : 'rejoined' as const,
        metadataRevision: created.session.metadataVersion, value: { created, ownerMetadata } };
    },
    authenticateRejoin: async ({ sessionId, value: { ownerMetadata } }) => {
      // A reused creation identity must name the same immutable source recipe.
      // Creation is get-or-create, so a reused tag rejoins an existing row, and a
      // rejoin is exactly the sibling correspondence path's rule: the immutable
      // recipe must be authenticated before this branch attaches a seed or input to
      // it. An unreadable candidate is refused rather than silently attached, so
      // neither a transient currentness read nor an undecryptable row can turn a
      // source conflict into a seeded continuation of another Session. A row this
      // call just created cannot conflict with itself and needs no such evidence.
      if (!accountEncryptionCurrentness) {
        throw createCodedError(
          'Existing Session creation candidate could not be authenticated',
          SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
          { sessionId },
        );
      }
      filesNotCopied = readForkFilesNotCopied(ownerMetadata);
      const candidateValidation = validateExistingSessionCreationCandidate({
        ownerMetadata,
        correspondence: params.sessionCreationCorrespondence,
        sourceRecipe: params.sourceContext ?? seededCreation.sourceRecipe,
        validateSourceRecipe: Boolean(params.sourceContext ?? seededCreation.sourceRecipe),
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
    },
    bindMachine: async ({ sessionId }) => {
      // The verified finite birth binds the requester Machine in the same
      // server transaction, including rejoin. Its response settles this phase.
      if (params.templateRequesterAuthorization) return;
      // A reused tag is trusted only after its immutable recipe is authenticated.
      // Bind before dispatch, since its first Message may race Session socket setup.
      await ensureSessionMachineAccessKeyBinding({
        serverUrl: resolveServerHttpBaseUrl(),
        token: params.credentials.token,
        sessionId,
        machineId: params.machineId,
        ...(params.authorizeMachineAccessKeyRequest ? { authorizeRequest: params.authorizeMachineAccessKeyRequest } : {}),
      });
    },
    beforeLaunch: async ({ sessionId, disposition, metadataRevision }) => {
      await params.beforeLaunch?.({ sessionId, disposition, metadataRevision });
    },
    launch: params.deferLaunch ? undefined : async ({ sessionId, value: { created } }) => {
      const spawnResponse = await dispatchCommittedSpawn({
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
          && isDefiniteSpawnPreAdmissionRejection(spawnResponseRecord?.errorCode)
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
    },
    submitInitialInput: async ({ sessionId, value: { created } }) => {
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
        ...(params.serverId ? { serverId: params.serverId } : {}),
        sessionId,
        targetMachineId: params.machineId,
        initialInput: params.initialInput,
        localId: args.initialInputLocalId,
        ...(!created.created ? { rejoinSession: created.session } : {}),
        initialInputHandoff: args.initialInputHandoff ?? (params.templateRequesterAuthorization
          ? params.buildInitialInputHandoff?.(args.initialInputLocalId) : undefined),
        machineAdmissionTransport: params.machineAdmissionTransport,
        ...(params.templateRequesterAuthorization ? { callerInputAuthorization: params.templateRequesterAuthorization.authorization } : {}),
        ...(params.deferLaunch ? { resumeInactiveSession: false as const } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      return initialInput;
    },
  });
  const { sessionId, value: { created, ownerMetadata } } = birth;
  const attestedContext = SessionAttestedContextV1Schema.safeParse(ownerMetadata?.attestedContext);
  return {
    disposition: created.created ? 'created' : 'rejoined',
    sessionId,
    ...(attestedContext.success ? { attestedContext: attestedContext.data } : {}),
    organizationPlacement,
    initialInput,
    ...(filesNotCopied ? { filesNotCopied } : {}),
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
  filesNotCopied?: SessionForkFilesNotCopiedV1;
  attestedContext?: SessionAttestedContextV1;
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
    ? createSessionCreationSpawnNonce(params.sessionCreationTag)
    : null;
  // A public creation key is the durable retry identity. The transport request
  // id only distinguishes otherwise-unkeyed calls and must never change the
  // first-turn local id for a retry of the same creation.
  const spawnNonce = creationOwnedSpawnNonce ?? callerOwnedSpawnNonce ?? randomUUID();
  const hasRetryableSpawnNonce = callerOwnedSpawnNonce !== null || creationOwnedSpawnNonce !== null;
  const initialInputText = typeof params.initialInput?.text === 'string' ? params.initialInput.text : '';
  const initialInputRequested = hasSessionInputContentV1({
    text: initialInputText,
    attachmentCount: (params.initialInput?.attachments?.length ?? 0)
      + (params.initialInput?.structuredInput?.composerAttachments?.length ?? 0),
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
  const initialInputHandoff = initialInputRequested && !params.templateRequesterAuthorization
    ? params.buildInitialInputHandoff?.(initialInputLocalId)
    : undefined;
  if (initialInputRequested && !params.buildInitialInputHandoff) {
    throw createCodedError(
      'Initial input requires Message-owned admission identity',
      SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    );
  }
  const spawnRequestInput = {
    ...pickSessionCreateOriginFields(params),
    directory: params.directory,
    ...(params.directoryKind ? { directoryKind: params.directoryKind } : {}),
    ...(params.managedDirectorySeed ? { managedDirectorySeed: params.managedDirectorySeed } : {}),
    ...(params.initialAccess !== undefined ? { initialAccess: params.initialAccess } : {}),
    ...(params.initialTriggers !== undefined ? { initialTriggers: params.initialTriggers } : {}),
    ...(params.manager !== undefined ? { manager: params.manager } : {}),
    ...(params.initialSessionRolesV1 !== undefined ? { initialSessionRolesV1: params.initialSessionRolesV1 } : {}),
    ...(params.authoringOrigin !== undefined ? { authoringOrigin: params.authoringOrigin } : {}),
    ...(params.primaryTeamId !== undefined ? { primaryTeamId: params.primaryTeamId } : {}),
    ...(params.teamCredentialBindings !== undefined ? { teamCredentialBindings: params.teamCredentialBindings } : {}),
    spawnNonce,
    ...(exactMachineId ? { machineId: exactMachineId } : {}),
    ...(params.agentTarget ? { agentTarget: params.agentTarget } : {}),
    ...(!params.agentTarget && params.backendTarget ? { backendTarget: params.backendTarget } : {}),
    ...(params.sessionCreationTag ? { sessionCreationTag: params.sessionCreationTag } : {}),
    ...(params.sessionCreationCorrespondence
      ? { sessionCreationCorrespondence: params.sessionCreationCorrespondence }
      : {}),
    ...(params.placementOrigin ? { placementOrigin: params.placementOrigin } : {}),
    ...(params.identity !== undefined ? { identity: params.identity } : {}),
    ...(params.memoryEnabled !== undefined ? { memoryEnabled: params.memoryEnabled } : {}),
    ...(params.approvalProfileId !== undefined ? { approvalProfileId: params.approvalProfileId } : {}),
    ...(params.promptStack !== undefined ? { promptStack: params.promptStack } : {}),
    ...(typeof params.initialTitle === 'string' && params.initialTitle.trim().length > 0
      ? { initialTitle: params.initialTitle.trim() }
      : {}),
    ...(params.modelSelection ? { modelSelection: params.modelSelection } : {}),
    ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
    ...(params.allowedTools !== undefined ? { allowedTools: [...params.allowedTools] } : {}),
    ...(params.unlistedTools !== undefined ? { unlistedTools: params.unlistedTools } : {}),
    ...(params.workspaceWrites !== undefined ? { workspaceWrites: params.workspaceWrites } : {}),
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
    ...(params.secretReferenceOverlay ? { secretReferenceOverlay: params.secretReferenceOverlay } : {}),
    ...(params.environmentVariables ? { environmentVariables: params.environmentVariables } : {}),
    ...(params.resume ? { resume: params.resume } : {}),
    ...(typeof params.approvedNewDirectoryCreation === 'boolean'
      ? { approvedNewDirectoryCreation: params.approvedNewDirectoryCreation }
      : {}),
    ...(params.connectedServices ? { connectedServices: params.connectedServices } : {}),
    ...(typeof params.connectedServicesUpdatedAt === 'number' && Number.isFinite(params.connectedServicesUpdatedAt)
      ? { connectedServicesUpdatedAt: params.connectedServicesUpdatedAt }
      : {}),
    ...(params.capabilitySelection ? { capabilitySelection: params.capabilitySelection } : {}),
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
  // Deferred birth is trusted host input, not a daemon spawn request: an asleep
  // Machine has not resolved its managed directory yet. Actual dispatch still
  // goes through the canonical strict daemon parser.
  const spawnRequest = params.deferLaunch ? spawnRequestInput : SpawnDaemonSessionRequestSchema.parse(spawnRequestInput);
  const isProviderBound = spawnRequest.modelSelection?.ref.providerConnectionId != null;
  await assertStoredAuthTokenValidForSpawn(params.credentials.token);
  params.signal?.throwIfAborted();
  const rejoinExistingCreation = async (afterSpawnFailure = false): Promise<Awaited<ReturnType<typeof createSpawnedSession>> | null> => {
    if (!params.sessionCreationTag || !params.sessionCreationCorrespondence || params.templateRequesterAuthorization) return null;
    const lookup = await lookupSessionsByTags({
      token: params.credentials.token,
      tags: [params.sessionCreationTag],
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (lookup.state === 'unavailable') {
      throw createCodedError(
        'Deterministic Session creation requires tag lookup support',
        SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
        { incompatibleTarget: { reason: 'creation_lookup_unavailable' } },
      );
    }
    if (lookup.sessions.length > 1) {
      throw createCodedError(
        'Session creation tag matched more than one Session',
        'creation_conflict',
      );
    }
    let existing = lookup.sessions[0];
    // An archived row left by failed launch cleanup is not evidence that the
    // runner survived its refusal. Preserve that refusal and do not attach
    // initial input. Ordinary same-key preflight retains its identity contract.
    if (afterSpawnFailure && existing?.archivedAt !== null && existing?.archivedAt !== undefined) return null;
    if (existing) {
      const accountEncryptionCurrentness = await readKnownSessionAccountEncryptionCurrentness(params);
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
      const attestedContext = SessionAttestedContextV1Schema.safeParse(ownerMetadata?.attestedContext);
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
      // Only the exact unstarted baseline authorizes automatic launch. A
      // retained same-input refusal prevents runnerless input admission, but
      // cannot establish that a separate Resume has never since succeeded.
      const previousLaunchFailure = params.previousSessionCreationFailure?.code === 'spawn_failed'
        ? params.previousSessionCreationFailure.launchError : undefined;
      const needsInitialRunner = existing.active === false
        && existing.runtimeActivityRevision === 0
        && ownerMetadata?.hostPid === undefined;
      if (existing.active === false && previousLaunchFailure && !needsInitialRunner) {
        // Activity/process identity may precede native startup or survive a
        // later Stop. Preserve the refusal without launching or admitting input.
        throw createCodedError(previousLaunchFailure.message, SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
          { sessionId: existing.id, errorDetail: previousLaunchFailure });
      }
      if (afterSpawnFailure && needsInitialRunner) return null;
      if ((existing.archivedAt !== null && existing.archivedAt !== undefined)
        || params.discussionParticipant || params.sessionCreationCorrespondence.recipe.discussionParticipant) {
        // Authentication proves identity, not a usable carrier or current
        // Discussion membership. Ordinary tag rejoin owns same-id restoration
        // and live-slot validation before input can attach.
        const current = await getOrCreateSessionByTag({
          ...(params.signal ? { signal: params.signal } : {}),
          ...(params.authorizeCreationRequest ? { authorizeRequest: params.authorizeCreationRequest } : {}),
          ...pickSessionCreateOriginFields(params),
          credentials: params.credentials,
          tag: params.sessionCreationTag,
          metadata: buildCommittedLaunchMetadata({ options: spawnRequest, directory: params.directory,
            ...(params.accountSettings ? { accountSettings: params.accountSettings } : {}),
          }),
          agentState: null,
          accountEncryptionCurrentness,
          ...(params.creationAuthorization ? { creationAuthorizationToken: params.creationAuthorization.token,
            prepareCreationAuthorizationProof: params.creationAuthorization.prepareRequestProof } : {}),
        });
        if (current.session.id !== existing.id) {
          throw createCodedError('Session tag rejoin changed its committed Session', 'creation_conflict',
            { sessionId: existing.id });
        }
        existing = current.session;
      }
      await prepareCommittedSessionContent(params, {
        sessionId: existing.id, disposition: 'rejoined', metadataRevision: existing.metadataVersion,
      });
      if (needsInitialRunner && params.resumeOnly !== true && !params.deferLaunch) {
        await ensureSessionMachineAccessKeyBinding({
          serverUrl: resolveServerHttpBaseUrl(), token: params.credentials.token,
          sessionId: existing.id, machineId: params.machineId,
          ...(params.authorizeMachineAccessKeyRequest ? { authorizeRequest: params.authorizeMachineAccessKeyRequest } : {}),
        });
        // Attach through the same launch owner as seeded creation. Its daemon
        // pre-gate also owns any already-pending runner; rejoin adds no launcher.
        const spawnResponse = await dispatchCommittedSpawn({
          token: params.credentials.token, sessionId: existing.id, createdHere: false,
          spawnRequestInput, dispatchSpawnRequest,
        });
        const settled = await awaitSpawnedSessionId({
          result: spawnResponse, spawnNonce, resolveSpawnSessionByNonce,
          ...(params.signal ? { signal: params.signal } : {}),
        });
        if (settled.type === 'error') {
          throw createCodedError(settled.errorMessage, settled.errorCode, {
            sessionId: existing.id, spawnResponse,
            ...(settled.agentId ? { agentId: settled.agentId } : {}),
            ...(settled.errorDetail ? { errorDetail: settled.errorDetail } : {}),
          });
        }
        if (settled.sessionId !== existing.id) {
          throw createCodedError('Session retry changed its committed Session', 'creation_conflict',
            { sessionId: existing.id });
        }
        const current = await fetchSessionById({ reason: 'session-control', token: params.credentials.token, sessionId: existing.id,
          ...(params.signal ? { signal: params.signal } : {}) });
        if (current) existing = current;
      }
      if (params.resumeOnly === true && existing.active === false && initialInputRequested) {
        // Re-entry of an unconfirmed launch observes its existing operation;
        // finding the committed row cannot confirm a runner or admit its input.
        throw createCodedError('Session startup has not been confirmed', SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
          { sessionId: existing.id, spawnNonce });
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
        ...(params.serverId ? { serverId: params.serverId } : {}),
        sessionId: existing.id,
        targetMachineId: params.machineId,
        initialInput: params.initialInput,
        localId: initialInputLocalId,
        rejoinSession: existing,
        initialInputHandoff,
        machineAdmissionTransport: params.machineAdmissionTransport,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      const filesNotCopied = readForkFilesNotCopied(ownerMetadata);
      if (params.replaySeededCreation?.sourceRecipe) await seedForkVisualsBestEffort({
        credentials: params.credentials, sourceSessionId: params.replaySeededCreation.sourceRecipe.sourceSessionId,
        cutoffSeqInclusive: params.replaySeededCreation.sourceRecipe.cutoffSeqInclusive, childSessionId: existing.id,
      });
      return {
        disposition: 'rejoined',
        sessionId: existing.id,
        ...(attestedContext.success ? { attestedContext: attestedContext.data } : {}),
        organizationPlacement,
        initialInput,
        ...(filesNotCopied ? { filesNotCopied } : {}),
        session: summarizeSessionRecord({
          credentials: params.credentials,
          accountEncryptionMode: accountEncryptionCurrentness.mode,
          session: existing,
        }),
      };
    }
    return null;
  };
  const existingCreation = await rejoinExistingCreation();
  if (existingCreation) return existingCreation;
  // Rejoined and nonce-resumed Sessions retain their birth context. Only a
  // genuinely fresh worker captures its lead's current memory attachments.
  let inheritedMemory: Awaited<ReturnType<typeof prepareSessionMemoryInheritance>> | undefined;
  const leadSessionId = readSessionManagerSessionIdV1(params)
    ?? params.initialSessionRolesV1?.inheritedFrom
    ?? (params.originKind === 'run_step' ? params.originSessionId : undefined);
  if (params.resumeOnly !== true && leadSessionId) {
    const lead = await fetchSessionById({ reason: 'session-control', token: params.credentials.token, sessionId: leadSessionId,
      ...(params.signal ? { signal: params.signal } : {}) });
    if (!lead) throw createCodedError('Lead Context is unavailable', 'context_source_unavailable');
    // Reporting membership does not grant access to another Account's Context.
    const leadAccess = readSessionAccessProjectionRoleV1(lead);
    if (leadAccess === 'unavailable') throw createCodedError('Lead Context ownership is unavailable', 'context_source_unavailable');
    if (leadAccess === 'owner') {
      const currentness = await readKnownSessionAccountEncryptionCurrentness(params);
      const metadata = currentness ? tryDecryptSessionOwnerMetadataView({ credentials: params.credentials,
        accountEncryptionMode: currentness.mode, rawSession: lead }) : null;
      if (!metadata) throw createCodedError('Lead Context is unavailable', 'context_source_unavailable');
      inheritedMemory = await prepareSessionMemoryInheritance({ credentials: params.credentials, metadata, serverId: params.serverId,
        ...(params.signal ? { signal: params.signal } : {}) });
    }
  }
  const birthContext = inheritedMemory ? {
    memoryEnabled: params.memoryEnabled ?? inheritedMemory.memoryEnabled,
    ...((inheritedMemory.promptStack.length > 0 || params.promptStack !== undefined) ? {
      promptStack: [...inheritedMemory.promptStack.filter(entry => !params.promptStack?.some(child => child.id === entry.id)),
        ...(params.promptStack ?? [])],
    } : {}),
  } : {};
  if (params.resumeOnly !== true) await params.preparePromptStack?.();
  const preparedInitialTriggers = params.resumeOnly !== true && params.prepareInitialTriggers
    ? await params.prepareInitialTriggers()
    : params.initialTriggers;
  const hasInitialTriggers = (preparedInitialTriggers?.length ?? 0) > 0;
  const hasSessionToolPolicy = params.allowedTools !== undefined || params.unlistedTools !== undefined
    || params.workspaceWrites !== undefined;
  if (params.resumeOnly !== true && (params.initialSessionRolesV1 || hasInitialTriggers || inheritedMemory || hasSessionToolPolicy || params.approvalProfileId !== undefined)
    && !params.directTransport && !params.machineActionTransport) {
    // The moving 0.2 predecessor strips these unknown birth fields. The current
    // spawn protocol is required before dispatch or Replay persistence, but not rejoin.
    const target = await readMachineOperationProtocolCapabilitiesV1({
      credentials: params.credentials, machineId: exactMachineId,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!supportsMachineSessionSpawnProtocolVersionV1(target?.capabilities, 2)) {
      if (hasSessionToolPolicy) throw createCodedError('The selected daemon requires an update to preserve Session tool policy',
        SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, {
          kind: 'update_required', operation: 'session.spawn_new', component: 'daemon',
          reason: 'session_tool_policy_update_required',
        });
      if (hasInitialTriggers) {
        throw createCodedError('The selected daemon requires an update to create a Session with initial triggers',
          SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE, { incompatibleTarget: { reason: 'initial_trigger_protocol_unavailable' } });
      }
      if (inheritedMemory && !params.initialSessionRolesV1) throw createCodedError('The selected daemon requires an update to inherit Session Context memory',
        SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE, { incompatibleTarget: { reason: 'context_memory_protocol_unavailable' } });
      throw createCodedError('The selected daemon requires an update to create a Session with inherited roles',
        SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, {
          kind: 'update_required', operation: 'session.spawn_new', component: 'daemon',
          reason: 'session_roles_snapshot_update_required',
        });
    }
  }
  const birthSpawnRequestInput = { ...spawnRequestInput, ...birthContext,
    ...(preparedInitialTriggers !== undefined ? { initialTriggers: preparedInitialTriggers } : {}) };
  const birthSpawnRequest = params.deferLaunch ? birthSpawnRequestInput : SpawnDaemonSessionRequestSchema.parse(birthSpawnRequestInput);
  async function dispatchSpawnRequest(request: SpawnDaemonSessionRequest): Promise<unknown> {
    try {
      if ((params.creationAuthorization || params.callerInputConstraints) && !params.directTransport) {
        throw new Error('Caller launch authority requires the exact host-private daemon transport');
      }
      return params.directTransport
        ? await params.directTransport.spawn(
          // Released cli-v0.2.1 daemons do not read agentTarget. Keep the
          // caller-supplied exact backend projection only at this version-skew
          // transport seam; remove when those remote readers are unreachable.
          (params.agentTarget && params.backendTarget
            ? { ...request, backendTarget: params.backendTarget }
            : request),
          {
            ...(params.signal ? { signal: params.signal } : {}),
            ...(params.creationAuthorization ? { creationAuthorization: params.creationAuthorization } : {}),
            ...(params.callerInputConstraints ? { callerInputConstraints: params.callerInputConstraints } : {}),
          },
        )
        : params.machineActionTransport
          ? await params.machineActionTransport(
            isProviderBound
              ? RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE
              : RPC_METHODS.SPAWN_HAPPY_SESSION,
            request,
            params.signal ? { signal: params.signal } : undefined,
          )
          : await callExactMachineRpc({
          credentials: params.credentials,
          machineId: exactMachineId,
          method: isProviderBound
            ? RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE
            : RPC_METHODS.SPAWN_HAPPY_SESSION,
          request,
          timeoutMs: DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS,
          ...(params.signal ? { signal: params.signal } : {}),
        });
    } catch (error) {
      if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
        throw createCodedError(
          isProviderBound
            ? 'Provider-bound session creation is unavailable because the selected machine does not support this request'
            : 'Exact-machine session creation is unavailable because the selected machine does not support this request',
          SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
          { incompatibleTarget: { reason: 'spawn_rpc_unavailable' } },
        );
      }
      const requestDisposition = readMachineRpcRequestDisposition(error);
      if (params.signal?.aborted && requestDisposition !== 'notSent') {
        throw createCodedError(
          'Session-spawn submission may have been accepted before caller cancellation',
          SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
          { spawnNonce },
        );
      }
      if (error && typeof error === 'object' && (
        requestDisposition === 'outcomeUnknown'
        || requestDisposition === null && (error as { code?: unknown }).code === 'MACHINE_RPC_TIMEOUT'
      )) {
        const details = (error as { details?: unknown }).details;
        (error as { details?: unknown }).details = {
          ...(details && typeof details === 'object' && !Array.isArray(details) ? details : {}),
          spawnNonce,
        };
      }
      throw error;
    }
  }

  let seededCreation: SeededSessionCreationV1 | undefined = params.replaySeededCreation;
  if ((params.deferLaunch || params.templateRequesterAuthorization || params.attestedContext || params.discussionParticipant || params.beforeLaunch) && !seededCreation) {
    const tag = params.sessionCreationTag;
    if (!tag) throw createCodedError('Session birth provenance requires its canonical creation tag', SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST);
    seededCreation = { tag, metadata: buildCommittedLaunchMetadata({
      options: birthSpawnRequest, directory: params.directory,
      ...(params.agentModeId ? { agentModeId: params.agentModeId, agentModeUpdatedAt: Date.now() } : {}),
      ...(params.accountSettings ? { accountSettings: params.accountSettings } : {}),
    }) };
  }
  if (seededCreation) {
    const result = await createSeededSpawnedSession({
      params: { ...params, ...birthContext, ...(preparedInitialTriggers !== undefined ? { initialTriggers: preparedInitialTriggers } : {}) },
      seededCreation,
      spawnRequestInput: birthSpawnRequestInput,
      dispatchSpawnRequest,
      initialInputLocalId,
      ...(initialInputHandoff ? { initialInputHandoff } : {}),
    });
    if (seededCreation.sourceRecipe) await seedForkVisualsBestEffort({
      credentials: params.credentials, sourceSessionId: seededCreation.sourceRecipe.sourceSessionId,
      cutoffSeqInclusive: seededCreation.sourceRecipe.cutoffSeqInclusive, childSessionId: result.sessionId,
    });
    return result;
  }

  let spawnResponse: unknown;
  if (params.resumeOnly === true) {
    spawnResponse = { success: true as const, status: 'pending' as const, sessionIdStatus: 'pending' as const, spawnNonce };
  } else {
    spawnResponse = await dispatchSpawnRequest(SpawnDaemonSessionRequestSchema.parse(birthSpawnRequest));
  }
  async function resolveSpawnSessionByNonce(
    nonce: string,
    timeoutMs?: number,
    observation?: Parameters<SpawnSessionNonceResolver>[2],
  ): Promise<SpawnSessionNonceResolution> {
    const signal = observation?.signal;
    try {
      if (params.directTransport) {
        return normalizeSpawnSessionNonceResolution(
          await params.directTransport.resolveSpawnSessionByNonce(nonce, { signal, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }),
        );
      }
      const resolved = params.machineActionTransport
        ? await params.machineActionTransport(
          RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
          { spawnNonce: nonce, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
          signal ? { signal } : undefined,
        )
        : await callExactMachineRpc({
          credentials: params.credentials,
          machineId: exactMachineId,
          method: RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
          request: { spawnNonce: nonce, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
          timeoutMs: null,
          reattachOnReconnect: {
            readRequest: () => ({ spawnNonce: nonce,
              timeoutMs: observation?.readRemainingTimeoutMs() ?? timeoutMs }),
          },
          ...(signal ? { signal } : {}),
        });
      return normalizeSpawnSessionNonceResolution(resolved);
    } catch (error) {
      if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
        return { status: 'unsupported' };
      }
      throw error;
    }
  }
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
    // Runtime readiness can fail after the Home committed the Session. Reuse
    // the authenticated creation proof; row existence does not admit a runner.
    // A typed launch refusal is terminal even when the physical launch nonce
    // and committed row succeeded before native startup failed.
    if (normalizeSpawnSessionErrorDetail(spawnResponseRecord?.errorDetail)?.kind !== 'launch_error') {
      const existingCreation = await rejoinExistingCreation(true);
      if (existingCreation) return existingCreation;
    }
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
    resolveSpawnSessionByNonce,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (settledSpawn.type === 'error') {
    if (settledSpawn.errorDetail?.kind !== 'launch_error') {
      const existingCreation = await rejoinExistingCreation(true);
      if (existingCreation) return existingCreation;
    }
    if (
      acceptedWithoutSessionId
      && !hasRetryableSpawnNonce
      && params.resumeOnly !== true
      && settledSpawn.errorCode !== SPAWN_SESSION_ERROR_CODES.UNEXPECTED
    ) {
      abandonSpawnedSessionBestEffort({
        spawnNonce,
        reason: settledSpawn.errorMessage,
        resolveSpawnSessionByNonce,
        stopSession: async (sessionId) => {
          const stopped = await requestSessionStop({ credentials: params.credentials, idOrPrefix: sessionId,
            stopIntent: 'lifecycle_control' });
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
      ...(settledSpawn.agentId ? { agentId: settledSpawn.agentId } : {}),
      ...(settledSpawn.errorDetail ? { errorDetail: settledSpawn.errorDetail } : {}),
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
      { sessionId, incompatibleTarget: { reason: 'creation_settlement_unavailable' } },
    );
  }
  // The Session row is committed and settled here; initial input is submitted
  // through the one Message-owned admission owner only after the settled
  // candidate is authenticated, so the returned disposition is the exact
  // admission outcome, never a fabricated acceptance.
  const submitInitialInput = (rejoinSession?: import('@/session/transport/http/sessionsHttp').RawSessionRecord) => submitSpawnInitialInput({
    credentials: params.credentials,
    ...(params.serverId ? { serverId: params.serverId } : {}),
    sessionId,
    targetMachineId: params.machineId,
    initialInput: params.initialInput,
    localId: initialInputLocalId,
    ...(rejoinSession ? { rejoinSession } : {}),
    initialInputHandoff,
    machineAdmissionTransport: params.machineAdmissionTransport,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const fetchTimeoutMs = resolvePositiveIntFromEnv('HAPPIER_SESSION_SPAWN_FETCH_TIMEOUT_MS', DEFAULT_SPAWNED_SESSION_FETCH_TIMEOUT_MS);
  const visibility = await waitForSpawnedSessionVisibility({
    token: params.credentials.token,
    sessionId,
    timeoutMs: fetchTimeoutMs,
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

  const accountEncryptionCurrentness = await readKnownSessionAccountEncryptionCurrentness(params);
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
  const attestedContext = SessionAttestedContextV1Schema.safeParse(ownerMetadata?.attestedContext);
  const candidateValidation = validateExistingSessionCreationCandidate({
    ownerMetadata,
    // An authenticated fresh-create result already proves the committed Session.
    // Missing optional currentness is not contradictory recipe evidence; rejoin
    // and source-recipe cases were rejected above before reaching this branch.
    correspondence: accountEncryptionCurrentness ? params.sessionCreationCorrespondence : undefined,
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
  const initialInput = await submitInitialInput(sessionCreationOutcome.disposition === 'rejoined' ? rawSession : undefined);
  const filesNotCopied = readForkFilesNotCopied(ownerMetadata);

  return {
    disposition: sessionCreationOutcome.disposition,
    sessionId,
    ...(attestedContext.success ? { attestedContext: attestedContext.data } : {}),
    organizationPlacement: sessionCreationOutcome.organizationPlacement,
    initialInput,
    ...(filesNotCopied ? { filesNotCopied } : {}),
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
