import { randomUUID } from 'node:crypto';

import {
  parsePermissionIntentAlias,
  resolvePermissionIntentFromSessionMetadata,
  type PermissionIntent,
} from '@happier-dev/agents';
import { readPendingLocalId } from '@happier-dev/protocol/sessions/pending/pendingLocalId';
import { resolveLinkedExternalSessionAuthorityV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';
import { SESSION_MESSAGE_PROVENANCE_META_KEY, SessionInputRequestSchema, SessionMessageProvenanceSchema, stripSessionInputProtectedMeta } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { withSessionMessageModelSelectionV1 } from '@happier-dev/protocol/providers/model-selection';
import type { ProviderErrorV1, SessionInputRequest, SessionMessageProvenance, SessionInputAdmissionRejectionCodeV1, SessionInputAdmissionResultV1, SessionMessageSendResultV1, SessionPendingEnqueueByMachineRequestV1, SessionPendingExecutionRunEnqueueByMachineRequestV2, PendingRequestedActionV1, ParticipantRecipientV1, ExecutionRunInputTurnV1, ExecutionRunPublicState } from '@happier-dev/protocol';
import { SessionInputAdmissionRejectionCodeV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmissionRejectionV1';
import { SessionCreationCorrespondenceV1ReadSchema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { normalizeParticipantRecipientRoutingIdentityV1, withParticipantRecipientV1 } from '@happier-dev/protocol/messages/structured/participantMessageV1';
import { ExecutionRunGetResponseSchema, ExecutionRunInputTurnV1Schema } from '@happier-dev/protocol/execution/runs/responseSchemas';

import { fetchEncryptedTranscriptPageAfterSeq } from '@/api/session/fetchEncryptedTranscriptWindow';
import {
  enqueuePendingQueueV2MessageViaHttp,
  enqueuePendingExecutionRunMessageViaHttp,
  listPendingQueueV2DeliveryStatusesFromServer,
  readPendingQueueV2DeliveryFailureByLocalIdFromServer,
  type PendingQueueDeliveryFailure,
  type PendingQueueDeliveryBlockedReason,
} from '@/api/session/pendingQueueV2Transport';
import {
  findTranscriptEncryptedMessageByLocalId,
  waitForTranscriptEncryptedMessageByLocalId,
  type TranscriptMessageLookupResult,
} from '@/api/session/transcriptMessageLookup';
import type { StoredCredentials } from '@/persistence';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import {
  detectSessionTurnActivity,
  isSessionAgentThreadTextUserMessage,
  isMemoryArtifactDecryptedRow,
  isSessionAgentMessage,
  readSessionProjectedTurnStatus,
  type SessionTurnActivity,
} from '@/session/query/detectSessionTurnInFlight';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { openSessionEventSource, waitForIdleViaSocket } from '@/session/transport/socket/sessionSocketAgentState';
import {
  decryptSessionPayload,
  deriveSessionInputEqualityTagV1,
  sealSessionStoredContent,
  tryDecryptSessionOwnerMetadataView,
  type SessionStoredContentCryptoContext,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { getExecutionRun } from '@/session/services/executionRuns';
import { extractUsageObservationFromTokenCountMessage } from '@/usage/usageObservation';
import { createExactTurnUsageAccumulator } from '@/usage/exactTurnUsage';
import {
  detectSessionTurnLifecycleEvent,
  isBareSessionReadyEvent,
  isSessionTurnCompletionProof,
  isSessionContextOnlyHostInput,
} from '@/session/shared/sessionTurnLifecycle';

import { resolveSessionTransportContext } from './resolveSessionTransportContext';
import { requiresMachineAdmissionForSessionInput } from './sessionInputAdmissionIdentity';
import { MachineAdmissionTransportUnavailableError } from '@/daemon/machineAdmissionTransport';
import {
  resolveSessionMessageModel,
  type SessionMessageModelSelectionInput,
} from './resolveSessionMessageModel';
import { requestInactiveSessionResume } from './requestInactiveSessionResume';
import { resolveSessionUserMessageRequestedAction } from './resolveSessionUserMessageRequestedAction';
import { buildImmutableSessionInputEqualityEnvelopeV1 } from './sessionInputEqualityEnvelope';
import { decodeTranscriptBody } from './transcript/transcriptBodyDecoder';
import { configuration } from '@/configuration';

export type SendSessionMessageResult =
  | Readonly<{
      ok: true;
      sessionId: string;
      localId: string;
      waited: boolean;
      suppressed?: true;
      /** The exact localId is already terminal, so there is no Pending work to start. */
      terminal?: true;
      admissionResult?: SessionInputAdmissionResultV1;
    }>
  | Readonly<{
      ok: false;
      /**
       * `resume_failed` comes from the inactive-session resume seam and means the
       * machine took the request and did not start the Session. It is distinct
       * from `unsupported`, which claims this Session or daemon cannot do it at
       * all — see `InactiveSessionResumeResult`.
       */
      code: 'session_not_found' | 'session_id_ambiguous' | 'session_lookup_timeout' | 'session_archived' | 'session_inactive' | 'takeover_required' | 'unsupported' | 'resume_failed' | 'encryption_material_unavailable' | 'timeout' | 'wait_failed' | 'provider_switch_unsupported' | 'admission_rejected' | 'cancelled' | 'machine_admission_transport_unavailable';
      candidates?: string[];
      message?: string;
      providerError?: ProviderErrorV1;
      admissionResult?: SessionInputAdmissionResultV1;
      /** Proven terminal settlement for one exact admitted Execution Run input. */
      settlementResult?: Extract<SessionMessageSendResultV1, { status: 'failed' | 'cancelled' }>;
    }>;

/**
 * The terminal outcome for one already-admitted Session input. This Session
 * service returns the canonical final text and does not invent a
 * consumer-specific result ceiling.
 */
export type SessionInputUsageV1 = Readonly<{
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}>;

export type SessionInputResultV1 =
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'final_text'; text: string; usage?: SessionInputUsageV1 }>
  | Readonly<{
      kind: 'terminal_no_result';
      reason: 'missing_final_assistant_text';
      usage?: SessionInputUsageV1;
    }>
  | Readonly<{ kind: 'failed'; message: string; usage?: SessionInputUsageV1 }>
  | Readonly<{ kind: 'cancelled'; message: string; usage?: SessionInputUsageV1 }>;

export type WaitForSessionInputResult =
  | Readonly<{
      ok: true;
      sessionId: string;
      localId: string;
      result: SessionInputResultV1;
    }>
  | Readonly<{
      ok: false;
      code:
        | 'session_not_found'
        | 'session_id_ambiguous'
        | 'session_lookup_timeout'
        | 'unsupported'
        | 'encryption_material_unavailable'
        | 'invalid_local_id'
        | 'cancelled'
        | 'result_read_failed';
      candidates?: string[];
    }>;

export type SessionInputResultObservationV1 =
  | Readonly<{ kind: 'no_deadline' }>
  | Readonly<{ kind: 'after_input'; timeoutMs: number }>
  | Readonly<{ kind: 'absolute_deadline'; deadlineMs: number }>;

type ResolveSessionMessageAuthorizationHeaders = (request: Readonly<{
  method: string;
  path: string;
  body?: unknown;
}>) => Readonly<Record<string, string>> | null;

export type WaitForSessionInputResultParams = Readonly<{
  credentials: StoredCredentials;
  idOrPrefix: string;
  localId: string;
  signal?: AbortSignal;
  serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
  /** Workflow custody may close while this exact input waits for host dispatch. */
  beforeInputObservation?: () => Promise<void>;
  /** The input owner's committed transcript timestamp is the accepted fact. */
  onInputMaterialized?: (acceptedAtMs: number) => Promise<void>;
}> & (
  | Readonly<{
      /** Incumbent bounded observer contract retained for Automation V1. */
      timeoutMs: number;
      observation?: never;
    }>
  | Readonly<{
      /** Workflow budgets are absolute, absent, or anchored on the committed input. */
      observation: SessionInputResultObservationV1;
      timeoutMs?: never;
    }>
);

type SendSessionMessageParams = Readonly<{
  /** Verified host-only root proof; never read from authored message metadata. */
  callerInputAuthorization?: import('@happier-dev/protocol').ExternalActionExecutionAuthorizationV1;
  credentials: StoredCredentials;
  idOrPrefix: string;
  message: string;
  wait: boolean;
  timeoutMs: number;
  localId?: string;
  recipient?: ParticipantRecipientV1;
  resumeInactiveSession?: boolean;
  permissionModeOverride?: string;
  modelSelectionInput?: SessionMessageModelSelectionInput;
  modelSelectionUpdatedAt?: number;
  incomingResumeOptions?: Parameters<typeof requestInactiveSessionResume>[0]['incomingOptions'];
  pendingAdmissionMode?: 'continuation_if_no_queued_user_input';
  /** Deployed CLI compatibility only; new action callers pass modelSelectionInput. */
  modelOverride?: string | null;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: ResolveSessionMessageAuthorizationHeaders;
  machineResumeTransport?: (
    method: string,
    request: unknown,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<unknown>;
  /**
   * Already-sanitized presentation/attachment metadata for this host-built
   * human input. Admission metadata is stripped and recreated below.
   */
  messageMeta?: Record<string, unknown>;
  /** Ordinary custody preserves this action; runtime bootstrap resolves to send-now. */
  requestedAction?: PendingRequestedActionV1;
  /** Host-built protected facts. Never populated from caller-controlled message metadata. */
  inputAdmission?: Readonly<{
    provenance: SessionMessageProvenance;
    request: SessionInputRequest;
  }>;
  /** Authenticated daemon transport. Machine-only assertions never fall back to Account admission. */
  machineAdmissionTransport?: (
    request: SessionPendingEnqueueByMachineRequestV1 | SessionPendingExecutionRunEnqueueByMachineRequestV2,
    options?: Readonly<{ signal?: AbortSignal; callerInputAuthorization?: import('@happier-dev/protocol').ExternalActionExecutionAuthorizationV1 }>,
  ) => Promise<SessionInputAdmissionResultV1>;
  /** Exact creation target when admission precedes the Session metadata projection. */
  targetMachineId?: string;
  serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
}>;

type SendProtectedSessionMessageParams = SendSessionMessageParams & Readonly<{
  inputAdmission: NonNullable<SendSessionMessageParams['inputAdmission']>;
}>;

type SendProtectedSessionMessageResult = SendSessionMessageResult & Readonly<{
  admissionResult: SessionInputAdmissionResultV1;
}>;

function parsePermissionIntentOrThrow(raw: string): PermissionIntent {
  const parsed = parsePermissionIntentAlias(raw);
  if (!parsed) {
    const err = new Error(`Invalid permission mode: ${raw}`);
    (err as any).code = 'invalid_arguments';
    throw err;
  }
  return parsed;
}

function cancelledBeforeAdmission(
  signal: AbortSignal | undefined,
  protectedInput: boolean,
): SendSessionMessageResult | null {
  return signal?.aborted
    ? {
        ok: false,
        code: 'cancelled',
        message: 'Session send was cancelled before admission',
        ...(protectedInput
          ? { admissionResult: { status: 'rejected' as const, code: 'session_input_cancelled' as const } }
          : {}),
      }
    : null;
}

function rejectedProtectedInputBeforeAdmission(
  code: Extract<SendSessionMessageResult, Readonly<{ ok: false }>>['code'],
): SessionInputAdmissionResultV1 {
  if (code === 'session_archived') {
    return { status: 'rejected', code: 'session_input_archived' };
  }
  if (code === 'unsupported') {
    return { status: 'rejected', code: 'session_input_target_update_required' };
  }
  if (code === 'encryption_material_unavailable') {
    return { status: 'rejected', code: 'session_input_encryption_mode_mismatch' };
  }
  return { status: 'rejected', code: 'session_input_target_unavailable' };
}

function readHttpResponseStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return null;
  const status = (response as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) ? status : null;
}

function readHttpAdmissionRejectionCode(error: unknown): SessionInputAdmissionRejectionCodeV1 | null {
  if (!error || typeof error !== 'object') return null;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return null;
  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const parsed = SessionInputAdmissionRejectionCodeV1Schema.safeParse(
    (data as Record<string, unknown>).code,
  );
  return parsed.success ? parsed.data : null;
}

function isExactRequestedActionConflictHttpResponse(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return false;
  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  return Object.keys(record).length === 1
    && record.error === 'requested-action-conflict';
}

function readProvenPreWriteHttpAdmissionRejectionCode(
  error: unknown,
  status: number,
): SessionInputAdmissionRejectionCodeV1 | null {
  const exactCode = readHttpAdmissionRejectionCode(error);
  if (status === 400) return exactCode ?? 'session_input_invalid';
  if (status === 401 || status === 403) return exactCode ?? 'session_input_unauthorized';
  if (status === 404) return exactCode ?? 'session_input_target_unavailable';
  if (status === 405 || status === 501) return exactCode;
  if (status === 409 && isExactRequestedActionConflictHttpResponse(error)) {
    return 'session_input_idempotency_conflict';
  }
  return null;
}

function resolvePermissionIntent(params: Readonly<{
  permissionModeOverride?: string;
  decryptedMetadata: unknown;
}>): PermissionIntent {
  if (params.permissionModeOverride) {
    return parsePermissionIntentOrThrow(params.permissionModeOverride);
  }
  const resolved = resolvePermissionIntentFromSessionMetadata(params.decryptedMetadata);
  return resolved?.intent ?? 'default';
}

function resolveSessionInputTargetMachineId(params: Readonly<{
  decryptedMetadata: Record<string, unknown> | null;
  rawSession: Readonly<Record<string, unknown>>;
  targetMachineId?: string;
}>): string | null {
  const correspondence = SessionCreationCorrespondenceV1ReadSchema.safeParse(
    params.decryptedMetadata?.sessionCreationCorrespondenceV1,
  );
  const observedMachineId = correspondence.success
    ? correspondence.data.recipe.execution.machineId
    : typeof params.rawSession.machineId === 'string'
      ? params.rawSession.machineId.trim()
      : typeof params.decryptedMetadata?.machineId === 'string'
        ? params.decryptedMetadata.machineId.trim()
        : '';
  const suppliedMachineId = params.targetMachineId?.trim() ?? '';
  if (observedMachineId && suppliedMachineId && observedMachineId !== suppliedMachineId) return null;
  if (observedMachineId) return observedMachineId;
  return suppliedMachineId || null;
}

function resolveCanonicalMessageSource(params: Readonly<{
  protectedAdmission: Readonly<{ request: SessionInputRequest }> | null;
}>): 'automation' | 'ui' {
  return params.protectedAdmission?.request.producer === 'automation'
    ? 'automation'
    : 'ui';
}

async function resolveCurrentTurnAfterSeqExclusive(params: Readonly<{
  token: string;
  sessionId: string;
  localId: string;
  materializedSeq: number;
  ctx: Readonly<{
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
  }> | null;
  resolveAuthorizationHeaders?: ResolveSessionMessageAuthorizationHeaders;
}>): Promise<number> {
  const materializedSeq = Math.max(0, Math.trunc(params.materializedSeq));
  const fallbackAfterSeqExclusive = Math.max(0, materializedSeq - 1);

  try {
    const windowSize = 50;
    const rows = await fetchEncryptedTranscriptPageAfterSeq({
      token: params.token,
      sessionId: params.sessionId,
      afterSeq: Math.max(0, materializedSeq - windowSize),
      limit: windowSize + 1,
      ...(params.resolveAuthorizationHeaders
        ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
        : {}),
    });
    const orderedRows = [...rows].sort((a, b) => a.seq - b.seq);
    for (let index = orderedRows.length - 1; index >= 0; index -= 1) {
      const row = orderedRows[index];
      if (row?.localId === params.localId) {
        return Math.max(0, row.seq - 1);
      }
    }

    for (let index = orderedRows.length - 1; index >= 0; index -= 1) {
      const row = orderedRows[index];
      if (!row) {
        continue;
      }
      if (row.content.t === 'plain') {
        if (isSessionAgentThreadTextUserMessage(row.content.v)) {
          return Math.max(0, row.seq - 1);
        }
        continue;
      }
      try {
        if (!params.ctx) {
          continue;
        }
        if (isSessionAgentThreadTextUserMessage(decryptSessionPayload({
          ctx: params.ctx,
          ciphertextBase64: row.content.c,
        }))) {
          return Math.max(0, row.seq - 1);
        }
      } catch {
        continue;
      }
    }

    return fallbackAfterSeqExclusive;
  } catch {
    return fallbackAfterSeqExclusive;
  }
}


function decryptTranscriptRowContent(params: Readonly<{
  content: { t: 'encrypted'; c: string } | { t: 'plain'; v: unknown };
  ctx: Readonly<{
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
  }> | null;
}>): unknown | null {
  if (params.content.t === 'plain') {
    return params.content.v;
  }
  if (!params.ctx) return null;
  try {
    return decryptSessionPayload({
      ctx: params.ctx,
      ciphertextBase64: params.content.c,
    });
  } catch {
    return null;
  }
}

function isAssistantTurnCompletionProof(value: unknown): boolean {
  if (!value || isMemoryArtifactDecryptedRow(value) || isSessionAgentThreadTextUserMessage(value)) {
    return false;
  }
  return isSessionTurnCompletionProof(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonnegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function readStructuredIssuePreview(value: unknown): string | null {
  const record = asRecord(value);
  const preview = typeof record?.sanitizedPreview === 'string' ? record.sanitizedPreview.trim() : '';
  return preview.length > 0 ? preview : null;
}

function readTranscriptRuntimeIssuePreview(value: unknown): string | null {
  const record = asRecord(value);
  const content = asRecord(record?.content);
  const data = asRecord(content?.data);
  const message = typeof data?.message === 'string' ? data.message.trim() : '';
  return message.length > 0 ? message : null;
}

function hasTranscriptRuntimeIssue(value: unknown): boolean {
  const record = asRecord(value);
  const meta = asRecord(record?.meta);
  const code = typeof meta?.runtimeIssueCode === 'string' ? meta.runtimeIssueCode.trim() : '';
  return code.length > 0;
}

function formatStructuredTurnFailureMessage(
  kind: 'failed' | 'cancelled' | 'aborted',
  preview?: string | null,
): string {
  if (kind === 'cancelled') return 'Current turn cancelled';
  if (kind === 'aborted') return 'Current turn aborted';
  const suffix = preview && preview.trim().length > 0 ? `: ${preview.trim()}` : '';
  return `Current turn failed${suffix}`;
}

function readAssistantTurnFailure(value: unknown): AssistantTurnFailure | null {
  if (!value || isMemoryArtifactDecryptedRow(value) || isSessionAgentThreadTextUserMessage(value)) {
    return null;
  }
  const lifecycleEvent = detectSessionTurnLifecycleEvent(value);
  if (lifecycleEvent === 'turn_failed') {
    return { kind: 'failed', message: formatStructuredTurnFailureMessage('failed') };
  }
  if (lifecycleEvent === 'turn_cancelled') {
    return { kind: 'cancelled', message: formatStructuredTurnFailureMessage('cancelled') };
  }
  if (lifecycleEvent === 'turn_aborted') {
    return { kind: 'failed', message: formatStructuredTurnFailureMessage('aborted') };
  }
  if (hasTranscriptRuntimeIssue(value)) {
    return {
      kind: 'failed',
      message: formatStructuredTurnFailureMessage('failed', readTranscriptRuntimeIssuePreview(value)),
    };
  }
  return null;
}

function readProjectedCurrentTurnFailure(params: Readonly<{
  session: unknown;
  currentUserCreatedAt: number | null;
}>): string | null {
  const latestTurnStatus = readProjectedCurrentTurnStatus(params);
  if (latestTurnStatus !== 'failed' && latestTurnStatus !== 'cancelled') {
    return null;
  }
  const record = asRecord(params.session);
  return formatStructuredTurnFailureMessage(
    latestTurnStatus,
    readStructuredIssuePreview(record?.lastRuntimeIssue),
  );
}

function readProjectedCurrentTurnStatus(params: Readonly<{
  session: unknown;
  currentUserCreatedAt: number | null;
}>): ReturnType<typeof readSessionProjectedTurnStatus> {
  if (params.currentUserCreatedAt === null) return null;
  const record = asRecord(params.session);
  if (!record) return null;
  const latestTurnStatus = readSessionProjectedTurnStatus(record.latestTurnStatus);
  if (!latestTurnStatus) return null;
  const observedAt = readNonnegativeInteger(record.latestTurnStatusObservedAt);
  if (
    observedAt === null
    || observedAt < params.currentUserCreatedAt
    || (observedAt === params.currentUserCreatedAt && latestTurnStatus !== 'in_progress')
  ) {
    return null;
  }
  return latestTurnStatus;
}

function turnActivityFromProjectedCurrentTurnStatus(
  status: NonNullable<ReturnType<typeof readSessionProjectedTurnStatus>>,
): SessionTurnActivity {
  const activeTaskInFlight = status === 'in_progress';
  return {
    pendingUserTurns: 0,
    activeTaskInFlight,
    turnInFlight: activeTaskInFlight,
  };
}

type AssistantTurnFailure =
  | Readonly<{ kind: 'failed'; message: string; usage?: SessionInputUsageV1 }>
  | Readonly<{ kind: 'cancelled'; message: string; usage?: SessionInputUsageV1 }>;

type AssistantTurnOutcome =
  | Readonly<{ kind: 'missing' }>
  | Readonly<{
      kind: 'completed';
      finalAssistantText: string | null;
      usage?: SessionInputUsageV1;
    }>
  | AssistantTurnFailure;

const ASSISTANT_TURN_SCAN_PAGE_LIMIT = 100;

type CurrentPromptDeliveryOutcome =
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'materialized'; message: TranscriptMessageLookupResult }>
  | Readonly<{ kind: 'blocked'; reason: PendingQueueDeliveryBlockedReason }>
  | Readonly<{ kind: 'cancelled' }>;

function formatBlockedPromptDeliveryFailure(reason: PendingQueueDeliveryBlockedReason): string {
  return `Current turn failed: pending delivery blocked (${reason})`;
}

async function readPromptDeliveryFailureReason(params: Readonly<{
  token: string;
  sessionId: string;
  localId: string;
  resolveAuthorizationHeaders?: ResolveSessionMessageAuthorizationHeaders;
}>): Promise<PendingQueueDeliveryFailure['reason'] | null> {
  try {
    return (await readPendingQueueV2DeliveryFailureByLocalIdFromServer(params))?.reason ?? null;
  } catch {
    return null;
  }
}

async function waitForCurrentPromptDelivery(params: Readonly<{
  token: string;
  sessionId: string;
  localId: string;
  deadlineMs: number | null;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: ResolveSessionMessageAuthorizationHeaders;
  beforeInputObservation?: () => Promise<void>;
}>): Promise<CurrentPromptDeliveryOutcome> {
  const events = openSessionEventSource(params);
  try {
    while (!params.signal?.aborted) {
      const revision = events.currentRevision();
      await params.beforeInputObservation?.();
      params.signal?.throwIfAborted();
      const remainingMs = params.deadlineMs === null ? null : params.deadlineMs - Date.now();
      const materialized = await findTranscriptEncryptedMessageByLocalId({
        token: params.token, sessionId: params.sessionId, localId: params.localId,
        // Preserve the one baseline read even when transport resolution consumed the deadline.
        timeoutMs: remainingMs !== null && remainingMs > 0
          ? Math.min(configuration.transcriptLookupRequestTimeoutMs, remainingMs)
          : configuration.transcriptLookupRequestTimeoutMs,
        ...(params.signal ? { signal: params.signal } : {}),
        ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
      });
      params.signal?.throwIfAborted();
      if (materialized) return { kind: 'materialized', message: materialized };
      const failureReason = await readPromptDeliveryFailureReason(params);
      if (failureReason === 'session_input_cancelled') return { kind: 'cancelled' };
      if (failureReason) return { kind: 'blocked', reason: failureReason };
      if (!(await events.waitForChange(revision, params))) break;
    }
    return { kind: 'missing' };
  } finally {
    await events.close();
  }
}

async function scanAssistantTurnAfterCurrentUserTurn(params: Readonly<{
  token: string;
  sessionId: string;
  localId: string;
  materializedSeq: number;
  ctx: Readonly<{
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
  }> | null;
  resolveAuthorizationHeaders?: ResolveSessionMessageAuthorizationHeaders;
}>): Promise<Readonly<{
  failure: AssistantTurnFailure | null;
  sawCompletion: boolean;
  finalAssistantText: string | null;
  usage?: SessionInputUsageV1;
}>> {
  let afterSeq = Math.max(0, Math.trunc(params.materializedSeq) - 1);
  let currentUserSeq = Math.max(0, Math.trunc(params.materializedSeq));
  let observedAgentProgress = false;
  let sawCompletion = false;
  let finalAssistantText: string | null = null;
  const exactTurnUsage = createExactTurnUsageAccumulator();

  const addTurnUsage = (value: unknown): void => {
    const row = asRecord(value);
    const content = asRecord(row?.content) ?? row;
    const data = asRecord(content?.data);
    if (!content || !data || (data.type !== 'token_count' && data.type !== 'token-count')) return;
    const provider = typeof content.agentId === 'string' && content.agentId.trim()
      ? content.agentId
      : typeof content.provider === 'string' && content.provider.trim()
        ? content.provider
        : content.type === 'codex'
          ? 'codex'
          : 'unknown';
    const observation = extractUsageObservationFromTokenCountMessage({
      provider,
      body: data,
      defaultScope: 'turn_delta',
    });
    if (observation) exactTurnUsage.observe(observation);
  };

  const currentUsage = (): SessionInputUsageV1 | undefined => exactTurnUsage.current();

  while (true) {
    const rows = await fetchEncryptedTranscriptPageAfterSeq({
      token: params.token,
      sessionId: params.sessionId,
      afterSeq,
      limit: ASSISTANT_TURN_SCAN_PAGE_LIMIT,
      ...(params.resolveAuthorizationHeaders
        ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
        : {}),
    });
    const orderedRows = [...rows].sort((a, b) => a.seq - b.seq);
    const matchedCurrentUserSeq = orderedRows.find((row) => row.localId === params.localId)?.seq;
    if (typeof matchedCurrentUserSeq === 'number' && matchedCurrentUserSeq >= 0) {
      currentUserSeq = matchedCurrentUserSeq;
    }

    for (const row of orderedRows) {
      if (row.seq <= currentUserSeq) {
        continue;
      }
      const decrypted = decryptTranscriptRowContent({
        content: row.content,
        ctx: params.ctx,
      });
      // The exact input's terminal proof closes this scan. A later input
      // starts another turn and must not become a fallback result for this
      // input when a legacy transcript lacks an explicit turn anchor.
      if (isSessionAgentThreadTextUserMessage(decrypted) || isSessionContextOnlyHostInput(decrypted)) {
        const usage = currentUsage();
        return { failure: null, sawCompletion, finalAssistantText, ...(usage ? { usage } : {}) };
      }
      const failure = readAssistantTurnFailure(decrypted);
      if (failure) {
        const usage = currentUsage();
        return {
          failure: usage ? { ...failure, usage } : failure,
          sawCompletion,
          finalAssistantText,
          ...(usage ? { usage } : {}),
        };
      }
      const decoded = decodeTranscriptBody(decrypted);
      addTurnUsage(decrypted);
      if (decoded?.semanticRole === 'assistant' && decoded.sidechainId === undefined && decoded.text) {
        finalAssistantText = decoded.text;
      }
      if (isAssistantTurnCompletionProof(decrypted)) {
        sawCompletion = true;
        // Completion can precede a terminal runtime issue in the same
        // transcript window. Keep scanning this exact turn so the later
        // authoritative failure wins without crossing the next user input.
        continue;
      }
      if (isBareSessionReadyEvent(decrypted)) {
        if (observedAgentProgress) {
          sawCompletion = true;
        }
        continue;
      }
      if (isSessionAgentMessage(decrypted)) {
        observedAgentProgress = true;
      }
    }

    if (orderedRows.length < ASSISTANT_TURN_SCAN_PAGE_LIMIT) {
      const usage = currentUsage();
      return { failure: null, sawCompletion, finalAssistantText, ...(usage ? { usage } : {}) };
    }
    const lastRowSeq = orderedRows[orderedRows.length - 1]?.seq ?? null;
    if (!Number.isSafeInteger(lastRowSeq) || lastRowSeq <= afterSeq) {
      const usage = currentUsage();
      return { failure: null, sawCompletion, finalAssistantText, ...(usage ? { usage } : {}) };
    }
    afterSeq = lastRowSeq;
  }
}

async function readAssistantTurnOutcomeAfterCurrentUserTurn(params: Readonly<{
  token: string;
  sessionId: string;
  localId: string;
  materializedSeq: number;
  ctx: Readonly<{
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
  }> | null;
  resolveAuthorizationHeaders?: ResolveSessionMessageAuthorizationHeaders;
}>): Promise<AssistantTurnOutcome> {
  const scan = await scanAssistantTurnAfterCurrentUserTurn(params);
  if (scan.failure) {
    return scan.failure;
  }
  return scan.sawCompletion
    ? {
        kind: 'completed',
        finalAssistantText: scan.finalAssistantText,
        ...(scan.usage ? { usage: scan.usage } : {}),
      }
    : { kind: 'missing' };
}

async function findAssistantFailureAfterCurrentUserTurn(params: Readonly<{
  token: string;
  sessionId: string;
  localId: string;
  materializedSeq: number;
  ctx: Readonly<{
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
  }> | null;
  resolveAuthorizationHeaders?: ResolveSessionMessageAuthorizationHeaders;
}>): Promise<AssistantTurnFailure | null> {
  return (await scanAssistantTurnAfterCurrentUserTurn(params)).failure;
}

async function waitForAssistantCompletionAfterCurrentUserTurn(params: Readonly<{
  token: string;
  sessionId: string;
  localId: string;
  materializedSeq: number;
  ctx: Readonly<{
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
  }> | null;
  deadlineMs: number | null;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: ResolveSessionMessageAuthorizationHeaders;
}>): Promise<AssistantTurnOutcome> {
  const events = openSessionEventSource(params);
  try {
    while (!params.signal?.aborted) {
      const revision = events.currentRevision();
      try {
        const outcome = await readAssistantTurnOutcomeAfterCurrentUserTurn(params);
        if (outcome.kind !== 'missing') return outcome;
      } catch {
        // An unavailable transcript is not completion. Reobserve on change or reconnect.
      }
      if (!(await events.waitForChange(revision, params))) break;
    }
    return { kind: 'missing' };
  } finally {
    await events.close();
  }
}

function resultFromAssistantTurnOutcome(outcome: AssistantTurnOutcome): SessionInputResultV1 {
  if (outcome.kind === 'missing') {
    return { kind: 'pending' };
  }
  if (outcome.kind === 'failed' || outcome.kind === 'cancelled') {
    return outcome;
  }
  if (!outcome.finalAssistantText) {
    return {
      kind: 'terminal_no_result',
      reason: 'missing_final_assistant_text',
      ...(outcome.usage ? { usage: outcome.usage } : {}),
    };
  }
  return {
    kind: 'final_text',
    text: outcome.finalAssistantText,
    ...(outcome.usage ? { usage: outcome.usage } : {}),
  };
}

/**
 * Reads one admitted input's exact retained-runtime turn state from the run's
 * public projection. The projection exposes only the current occurrence's
 * current/last native turn witness, so a terminal state on a turn whose
 * `inputIds` contain this exact localId is settle evidence; a sibling turn's
 * terminal state (or the run's generic status) is never evidence for this
 * input and returns null.
 */
function readExecutionRunInputTurnOutcome(params: Readonly<{
  run: ExecutionRunPublicState;
  localId: string;
}>): ExecutionRunInputTurnV1['state'] | null {
  const current = params.run.inputTurns?.current;
  if (current?.inputIds.includes(params.localId)) {
    return current.state;
  }
  const last = params.run.inputTurns?.last;
  if (last?.inputIds.includes(params.localId)) {
    return last.state;
  }
  return null;
}

async function readExecutionRunInputTranscriptOutcome(params: Readonly<{
  token: string;
  sessionId: string;
  localId: string;
  sidechainId: string;
  materializedSeq: number;
  ctx: Readonly<{
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
  }> | null;
  deadlineMs: number;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: ResolveSessionMessageAuthorizationHeaders;
}>): Promise<ExecutionRunInputTurnV1['state'] | null> {
  let afterSeq = Math.max(0, Math.trunc(params.materializedSeq) - 1);
  while (true) {
    if (params.signal?.aborted) return null;
    const remainingMs = params.deadlineMs - Date.now();
    if (remainingMs <= 0) return null;
    const rows = await fetchEncryptedTranscriptPageAfterSeq({
      token: params.token,
      sessionId: params.sessionId,
      afterSeq,
      limit: ASSISTANT_TURN_SCAN_PAGE_LIMIT,
      timeoutMs: Math.max(1, Math.trunc(remainingMs)),
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.resolveAuthorizationHeaders
        ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
        : {}),
    });
    const orderedRows = [...rows].sort((left, right) => left.seq - right.seq);
    for (const row of orderedRows) {
      if (row.seq <= params.materializedSeq) continue;
      const decrypted = decryptTranscriptRowContent({ content: row.content, ctx: params.ctx });
      const decoded = decodeTranscriptBody(decrypted);
      if (decoded?.sidechainId !== params.sidechainId) continue;
      const record = asRecord(decrypted);
      const meta = asRecord(record?.meta);
      const inputTurn = ExecutionRunInputTurnV1Schema.safeParse(meta?.happierExecutionRunInputTurnV1);
      if (!inputTurn.success || !inputTurn.data.inputIds.includes(params.localId)) continue;
      const failure = readAssistantTurnFailure(decrypted);
      if (failure?.kind === 'failed') return 'failed';
      if (failure?.kind === 'cancelled') return 'cancelled';
      if (isAssistantTurnCompletionProof(decrypted)) return 'completed';
    }
    if (orderedRows.length < ASSISTANT_TURN_SCAN_PAGE_LIMIT) return null;
    const lastSeq = orderedRows[orderedRows.length - 1]?.seq;
    if (!Number.isSafeInteger(lastSeq) || (lastSeq ?? 0) <= afterSeq) return null;
    afterSeq = lastSeq!;
  }
}

/**
 * Observes one admitted Execution Run input's exact retained-runtime turn by
 * its durable `(sessionId, runId, localId)` identity through the existing run
 * read owner. Completion means that exact turn completed, failed, or was
 * cancelled — never parent-Session idle, a sibling target's queue, or the
 * run's generic terminal status. Missing, unavailable, or unmatchable run
 * evidence is not success: observation waits until the wait budget expires and
 * the caller then reports the existing typed outcome-unknown result. The wait
 * never retries or cancels the admitted input itself.
 */
async function waitForExecutionRunInputTurnOutcome(params: Readonly<{
  credentials: StoredCredentials;
  crypto: SessionStoredContentCryptoContext;
  sessionId: string;
  runId: string;
  localId: string;
  timeoutMs: number;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: ResolveSessionMessageAuthorizationHeaders;
}>): Promise<ExecutionRunInputTurnV1['state'] | 'observation_cancelled' | null> {
  const deadlineMs = Date.now() + Math.max(1, Math.trunc(params.timeoutMs));
  // The accepted transcript anchor is shared Session storage, but Pending
  // status is target-scoped. Do not call the main Pending reader here: a
  // nested wait must never borrow main-Session blocked/settled evidence.
  const materialized = await waitForTranscriptEncryptedMessageByLocalId({
    token: params.credentials.token,
    sessionId: params.sessionId,
    localId: params.localId,
    maxWaitMs: Math.max(1, deadlineMs - Date.now()),
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.resolveAuthorizationHeaders
      ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
      : {}),
  });
  if (params.signal?.aborted) return 'observation_cancelled';
  if (!materialized) return null;
  const events = openSessionEventSource({ token: params.credentials.token, sessionId: params.sessionId });
  try {
    while (true) {
      const revision = events.currentRevision();
      if (params.signal?.aborted) return 'observation_cancelled';
      let turnState: ExecutionRunInputTurnV1['state'] | null = null;
      try {
        if (params.resolveAuthorizationHeaders) {
          turnState = materialized.sidechainId
            ? await readExecutionRunInputTranscriptOutcome({
                token: params.credentials.token,
                sessionId: params.sessionId,
                localId: params.localId,
                sidechainId: materialized.sidechainId,
                materializedSeq: materialized.seq,
                ctx: params.crypto.ctx,
                deadlineMs,
                ...(params.signal ? { signal: params.signal } : {}),
                resolveAuthorizationHeaders: params.resolveAuthorizationHeaders,
              })
            : null;
        } else {
          const readResult = await getExecutionRun({
            ...params.crypto,
            token: params.credentials.token,
            sessionId: params.sessionId,
            request: { runId: params.runId },
            ...(params.signal ? { signal: params.signal } : {}),
          });
          if (readResult.ok) {
            const parsed = ExecutionRunGetResponseSchema.safeParse(readResult.data);
            if (parsed.success) {
              turnState = readExecutionRunInputTurnOutcome({ run: parsed.data.run, localId: params.localId });
              if (
                turnState === null
                && materialized.sidechainId === parsed.data.run.sidechainId
              ) {
                turnState = await readExecutionRunInputTranscriptOutcome({
                  token: params.credentials.token,
                  sessionId: params.sessionId,
                  localId: params.localId,
                  sidechainId: parsed.data.run.sidechainId,
                  materializedSeq: materialized.seq,
                  ctx: params.crypto.ctx,
                  deadlineMs,
                  ...(params.signal ? { signal: params.signal } : {}),
                });
              }
            }
          }
        }
      } catch {
        if (params.signal?.aborted) return 'observation_cancelled';
        // Missing run evidence is not success. Re-observe on change or reconnect.
      }
      if (params.signal?.aborted) return 'observation_cancelled';
      if (turnState === 'completed' || turnState === 'failed' || turnState === 'cancelled') {
        return turnState;
      }
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        return null;
      }
      if (!(await events.waitForChange(revision, { deadlineMs, signal: params.signal }))) {
        return params.signal?.aborted ? 'observation_cancelled' : null;
      }
    }
  } finally {
    await events.close();
  }
}

/**
 * Rejoins one durable input by its stable localId and waits only for that
 * input's terminal transcript evidence. It never enqueues or redispatches a
 * prompt, so callers can safely retry after a daemon restart or wait budget.
 */
export async function waitForSessionInputResult(
  params: WaitForSessionInputResultParams,
): Promise<WaitForSessionInputResult> {
  const localId = readPendingLocalId(params.localId);
  if (localId === null) {
    return { ok: false, code: 'invalid_local_id' };
  }
  const observation = params.observation;
  const deadlineMs = observation !== undefined
    ? observation.kind === 'absolute_deadline'
      ? observation.deadlineMs
      : null
    : Date.now() + (Number.isFinite(params.timeoutMs)
        ? Math.max(1, Math.trunc(params.timeoutMs))
        : 1);

  try {
    const sessionTarget = await resolveSessionTransportContext({
      credentials: params.credentials,
      idOrPrefix: params.idOrPrefix,
      ...(params.serverFeaturesSnapshot ? { serverFeaturesSnapshot: params.serverFeaturesSnapshot } : {}),
    });
    if (!sessionTarget.ok) {
      return {
        ok: false,
        code: sessionTarget.code,
        ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}),
      };
    }

    const promptDelivery = await waitForCurrentPromptDelivery({
      token: params.credentials.token,
      sessionId: sessionTarget.sessionId,
      localId,
      deadlineMs,
      ...(params.beforeInputObservation ? { beforeInputObservation: params.beforeInputObservation } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (promptDelivery.kind === 'cancelled') {
      return { ok: true, sessionId: sessionTarget.sessionId, localId,
        result: { kind: 'cancelled', message: formatStructuredTurnFailureMessage('cancelled') } };
    }
    if (promptDelivery.kind === 'blocked') {
      return {
        ok: true,
        sessionId: sessionTarget.sessionId,
        localId,
        result: {
          kind: 'failed',
          message: formatBlockedPromptDeliveryFailure(promptDelivery.reason),
        },
      };
    }
    if (promptDelivery.kind === 'missing') {
      if (params.signal?.aborted) return { ok: false, code: 'cancelled' };
      return {
        ok: true,
        sessionId: sessionTarget.sessionId,
        localId,
        result: { kind: 'pending' },
      };
    }

    await params.onInputMaterialized?.(promptDelivery.message.createdAt);
    const acceptedDeadlineMs = observation?.kind === 'after_input'
      ? promptDelivery.message.createdAt + observation.timeoutMs : deadlineMs;

    const outcome = await waitForAssistantCompletionAfterCurrentUserTurn({
      token: params.credentials.token,
      sessionId: sessionTarget.sessionId,
      localId,
      materializedSeq: promptDelivery.message.seq,
      ctx: sessionTarget.ctx,
      deadlineMs: acceptedDeadlineMs,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (outcome.kind === 'missing' && params.signal?.aborted) return { ok: false, code: 'cancelled' };
    return {
      ok: true,
      sessionId: sessionTarget.sessionId,
      localId,
      result: resultFromAssistantTurnOutcome(outcome),
    };
  } catch {
    if (params.signal?.aborted) return { ok: false, code: 'cancelled' };
    return { ok: false, code: 'result_read_failed' };
  }
}

export function sendSessionMessage(
  params: SendProtectedSessionMessageParams,
): Promise<SendProtectedSessionMessageResult>;
export function sendSessionMessage(
  params: SendSessionMessageParams,
): Promise<SendSessionMessageResult>;
export async function sendSessionMessage(
  params: SendSessionMessageParams,
): Promise<SendSessionMessageResult> {
  const cancelledAtStart = cancelledBeforeAdmission(params.signal, params.inputAdmission !== undefined);
  if (cancelledAtStart) return cancelledAtStart;
  const sessionTarget = await resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
    ...(params.resolveAuthorizationHeaders
      ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
      : {}),
    ...(params.serverFeaturesSnapshot ? { serverFeaturesSnapshot: params.serverFeaturesSnapshot } : {}),
  });
  const cancelledAfterResolution = cancelledBeforeAdmission(params.signal, params.inputAdmission !== undefined);
  if (cancelledAfterResolution) return cancelledAfterResolution;
  if (!sessionTarget.ok) {
    return {
      ok: false,
      code: sessionTarget.code,
      ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}),
      ...(params.inputAdmission
        ? { admissionResult: rejectedProtectedInputBeforeAdmission(sessionTarget.code) }
        : {}),
    };
  }
  const sessionId = sessionTarget.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('Resolved session transport context is missing session id');
  }
  const archivedAt = (sessionTarget.rawSession as { archivedAt?: unknown }).archivedAt;
  if (archivedAt !== null && archivedAt !== undefined) {
    return {
      ok: false,
      code: 'session_archived',
      ...(params.inputAdmission
        ? { admissionResult: rejectedProtectedInputBeforeAdmission('session_archived') }
        : {}),
    };
  }
  if (params.localId !== undefined && readPendingLocalId(params.localId) === null) {
    throw new Error('Pending localId must not be blank');
  }
  const localId = readPendingLocalId(params.localId) ?? randomUUID();
  const recipient = params.recipient === undefined
    ? undefined : normalizeParticipantRecipientRoutingIdentityV1(params.recipient);
  const executionRunRecipient = recipient?.kind === 'execution_run' ? recipient : undefined;
  if (executionRunRecipient) {
    if (params.pendingAdmissionMode) {
      return { ok: false, code: 'admission_rejected', admissionResult: { status: 'rejected', code: 'session_input_invalid' } };
    }
  }
  const decryptedMetadata = tryDecryptSessionOwnerMetadataView({
    credentials: params.credentials,
    rawSession: sessionTarget.rawSession,
    accountEncryptionMode: sessionTarget.accountEncryptionCurrentness.mode,
  });
  // Externally linked Sessions receive Agent-visible input only after External
  // Sessions takeover. This is the canonical pre-admission refusal for every
  // caller — plugin `sessions.current.send`, `session.message.send`, CLI/MCP
  // send, and contributed Actions — so admission happens at this owner rather
  // than as a per-Action UI gate. Unlinked inactive sessions keep the
  // canonical enqueue-then-resume behavior below.
  if (sessionTarget.rawSession.active !== true) {
    const linkAuthority = resolveLinkedExternalSessionAuthorityV1(
      decryptedMetadata && typeof decryptedMetadata === 'object' && !Array.isArray(decryptedMetadata)
        ? decryptedMetadata
        : {},
    );
    if (!linkAuthority.ok || linkAuthority.transcriptStorage === 'direct') {
      return {
        ok: false,
        code: 'takeover_required',
        message: 'This session is linked to an external agent; complete External Sessions takeover before sending input',
        ...(params.inputAdmission
          ? { admissionResult: rejectedProtectedInputBeforeAdmission('takeover_required') }
          : {}),
      };
    }
  }
  const protectedAdmission = params.inputAdmission
    ? {
        provenance: SessionMessageProvenanceSchema.parse(params.inputAdmission.provenance),
        request: SessionInputRequestSchema.parse(params.inputAdmission.request),
      }
    : null;
  const shouldProjectTargetDefaults = protectedAdmission === null && executionRunRecipient === undefined;
  const hasExplicitPermissionMode = typeof params.permissionModeOverride === 'string'
    && params.permissionModeOverride.trim().length > 0;
  const hasExplicitModelSelection = params.modelSelectionInput !== undefined
    || params.modelOverride !== undefined;
  const permissionIntent = shouldProjectTargetDefaults || hasExplicitPermissionMode
    ? resolvePermissionIntent({
        permissionModeOverride: params.permissionModeOverride,
        decryptedMetadata,
      })
    : null;
  const modelResolution = shouldProjectTargetDefaults || hasExplicitModelSelection
    ? resolveSessionMessageModel({
        metadata: decryptedMetadata,
        sessionActive: sessionTarget.rawSession.active === true,
        ...(params.modelSelectionInput !== undefined
          ? { modelSelectionInput: params.modelSelectionInput }
          : params.modelOverride !== undefined
            ? { legacyModelOverride: params.modelOverride }
            : {}),
        // A structured override under a caller-supplied localId is part of one
        // retryable transport identity. Keep that authored payload stable;
        // sends whose identity is minted here retain a meaningful timestamp.
        nowMs: params.modelSelectionUpdatedAt ?? (params.localId !== undefined && params.modelSelectionInput !== undefined
          ? 0
          : Date.now()),
      })
    : { modelId: '', selection: null };
  const callerMeta = stripSessionInputProtectedMeta(params.messageMeta);
  delete callerMeta[SESSION_MESSAGE_PROVENANCE_META_KEY];
  const baseMeta = {
    ...callerMeta,
    sentFrom: 'cli',
    // Important: `source: 'cli'` is reserved for CLI-authored transcript traffic that
    // the running agent runtime should treat as "self-sent" (e.g. local provider echoes).
    // A `happier session send` prompt is user intent and must be delivered to the runtime
    // queue even when it is committed by the daemon via session RPC.
    source: resolveCanonicalMessageSource({ protectedAdmission }),
    ...(permissionIntent ? { permissionMode: permissionIntent } : {}),
    ...(modelResolution.modelId ? { model: modelResolution.modelId } : {}),
    ...(protectedAdmission
      ? {
          happierProvenanceV1: protectedAdmission.provenance,
          happierInputRequestV1: protectedAdmission.request,
        }
      : {}),
  } as const;
  const record = {
    role: 'user',
    content: { type: 'text', text: params.message },
    meta: withParticipantRecipientV1(modelResolution.selection
      ? withSessionMessageModelSelectionV1(baseMeta, modelResolution.selection)
      : baseMeta, recipient),
  } as const;

  const shouldResumeInactiveSession = executionRunRecipient === undefined
    && sessionTarget.rawSession.active !== true
    && params.resumeInactiveSession !== false;
  const requestedAction: PendingRequestedActionV1 = resolveSessionUserMessageRequestedAction({
    deliveryIntent: shouldResumeInactiveSession ? 'runtime_bootstrap' : 'ordinary',
    ...(params.requestedAction ? { requestedAction: params.requestedAction } : {}),
  });
  const requiresMachineAdmission = requiresMachineAdmissionForSessionInput({
    request: protectedAdmission?.request ?? null,
    mode: sessionTarget.mode,
    ...(params.callerInputAuthorization ? { callerInputAuthorization: params.callerInputAuthorization } : {}),
  });
  const requestEqualityEvidenceV1 = requiresMachineAdmission && sessionTarget.mode === 'e2ee'
    ? {
        kind: 'e2eeTag' as const,
        tag: deriveSessionInputEqualityTagV1({
          ctx: sessionTarget.ctx,
          sessionId,
          requestEnvelope: buildImmutableSessionInputEqualityEnvelopeV1({
            localId,
            record,
            ...(params.pendingAdmissionMode ? { pendingAdmissionMode: params.pendingAdmissionMode } : {}),
          }),
          requestedAction,
        }),
      }
    : undefined;

  const content = sealSessionStoredContent({
    ...sessionTarget,
    payload: record,
    // Protected E2EE machine admission carries the purpose-separated equality
    // tag above, so its ciphertext remains randomized. Routes without that
    // equality evidence retain byte-stable ciphertext for Pending replay.
    ...(requestEqualityEvidenceV1
      ? {}
      : { idempotencyKey: `session-input:v1:${sessionId}:${localId}` }),
  });

  let enqueueResult: Awaited<ReturnType<typeof enqueuePendingQueueV2MessageViaHttp>>;
  let admissionResult: SessionInputAdmissionResultV1 | undefined;
  let machineAdmissionInvoked = false;
  try {
    if (requiresMachineAdmission) {
      const targetMachineId = resolveSessionInputTargetMachineId({
        decryptedMetadata,
        rawSession: sessionTarget.rawSession as Readonly<Record<string, unknown>>,
        ...(params.targetMachineId ? { targetMachineId: params.targetMachineId } : {}),
      });
      if (params.signal?.aborted) {
        return {
          ok: false,
          code: 'cancelled',
          message: 'Session send was cancelled before admission',
          admissionResult: { status: 'rejected', code: 'session_input_cancelled' },
        };
      }
      if (!params.machineAdmissionTransport || !targetMachineId) {
        const transportError = !params.machineAdmissionTransport
          ? new MachineAdmissionTransportUnavailableError()
          : null;
        return {
          ok: false,
          code: transportError?.code ?? 'admission_rejected',
          message: transportError?.message ?? 'Protected Session input target is unavailable',
          admissionResult: {
            status: 'rejected',
            code: 'session_input_target_unavailable',
          },
        };
      }
      machineAdmissionInvoked = true;
      const machineAdmissionRequest = {
        ...(executionRunRecipient ? { v: 2 as const, recipient: executionRunRecipient } : { v: 1 as const }),
        sessionId,
        targetMachineId,
        localId,
        content,
        requestedAction,
        ...(requestEqualityEvidenceV1 ? { requestEqualityEvidenceV1 } : {}),
      } satisfies SessionPendingEnqueueByMachineRequestV1 | SessionPendingExecutionRunEnqueueByMachineRequestV2;
      const result = params.signal || params.callerInputAuthorization
        ? await params.machineAdmissionTransport(machineAdmissionRequest, {
            ...(params.signal ? { signal: params.signal } : {}),
            ...(params.callerInputAuthorization ? { callerInputAuthorization: params.callerInputAuthorization } : {}),
          })
        : await params.machineAdmissionTransport(machineAdmissionRequest);
      if (result.status === 'rejected') {
        return {
          ok: false,
          code: 'admission_rejected',
          message: 'Protected Session input was rejected before durable admission',
          admissionResult: result,
        };
      }
      if (result.status === 'outcomeUnknown') {
        return {
          ok: false,
          code: 'timeout',
          message: result.code,
          admissionResult: result,
        };
      }
      if (result.localId !== localId) {
        return {
          ok: false,
          code: 'timeout',
          message: 'Machine admission returned a mismatched Session input identity',
          admissionResult: {
            status: 'outcomeUnknown',
            localId,
            code: 'session_input_admission_identity_mismatch',
          },
        };
      }
      let terminal = false;
      if (result.status === 'alreadyAccepted' && !executionRunRecipient) {
        try {
          const pendingStatuses = await listPendingQueueV2DeliveryStatusesFromServer({
            token: params.credentials.token,
            sessionId,
            ...(params.resolveAuthorizationHeaders
              ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
              : {}),
          });
          terminal = !pendingStatuses.some((entry) => entry.localId === localId);
        } catch {
          return {
            ok: false,
            code: 'timeout',
            message: 'Could not confirm whether the exact pending Session input remains in custody',
            admissionResult: {
              status: 'outcomeUnknown',
              localId,
              code: 'machine_admission_pending_custody_unconfirmed',
            },
          };
        }
      }
      admissionResult = result;
      enqueueResult = {
        didWrite: result.status === 'accepted',
        terminal,
        suppressed: false,
      };
    } else if (executionRunRecipient) {
      const targetMachineId = resolveSessionInputTargetMachineId({
        decryptedMetadata,
        rawSession: sessionTarget.rawSession as Readonly<Record<string, unknown>>,
        ...(params.targetMachineId ? { targetMachineId: params.targetMachineId } : {}),
      });
      if (!targetMachineId) {
        return { ok: false, code: 'admission_rejected', admissionResult: { status: 'rejected', code: 'session_input_target_unavailable' } };
      }
      enqueueResult = await enqueuePendingExecutionRunMessageViaHttp({
        token: params.credentials.token, sessionId, recipient: executionRunRecipient,
        body: { v: 1, localId, targetMachineId, content, messageRole: 'user', requestedAction },
        ...(params.resolveAuthorizationHeaders
          ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
          : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      });
    } else {
      const targetMachineId = resolveSessionInputTargetMachineId({ decryptedMetadata,
        rawSession: sessionTarget.rawSession as Readonly<Record<string, unknown>>,
        ...(params.targetMachineId ? { targetMachineId: params.targetMachineId } : {}) });
      if (!targetMachineId && params.targetMachineId) return { ok: false, code: 'admission_rejected',
        admissionResult: { status: 'rejected', code: 'session_input_target_unavailable' } };
      enqueueResult = await enqueuePendingQueueV2MessageViaHttp({
        token: params.credentials.token,
        sessionId,
        body: content.t === 'encrypted'
          ? {
              localId,
              ciphertext: content.c,
              ...(targetMachineId ? { targetMachineId } : {}),
              messageRole: 'user',
              requestedAction,
              ...(requestEqualityEvidenceV1 ? { requestEqualityEvidenceV1 } : {}),
              ...(params.pendingAdmissionMode ? { deliveryMode: params.pendingAdmissionMode } : {}),
            }
          : {
              localId,
              content,
              ...(targetMachineId ? { targetMachineId } : {}),
              messageRole: 'user',
              requestedAction,
              ...(params.pendingAdmissionMode ? { deliveryMode: params.pendingAdmissionMode } : {}),
            },
        ...(params.resolveAuthorizationHeaders
          ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
          : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      });
    }
  } catch (error) {
    const status = readHttpResponseStatus(error);
    const admissionRejectionCode = status !== null && !machineAdmissionInvoked
      ? readProvenPreWriteHttpAdmissionRejectionCode(error, status)
      : null;
    if (admissionRejectionCode !== null) {
      return {
        ok: false,
        code: 'admission_rejected',
        message: `Pending enqueue was rejected before admission (HTTP ${status})`,
        admissionResult: { status: 'rejected', code: admissionRejectionCode },
      };
    }
    const errorMessage = error instanceof Error ? error.message : String(error ?? '');
    return {
      ok: false,
      code: 'timeout',
      message: status !== null
        ? `Pending enqueue acknowledgement was not confirmed (HTTP ${status})`
        : errorMessage || 'Pending enqueue acknowledgement was not confirmed',
      admissionResult: machineAdmissionInvoked
              ? {
                  status: 'outcomeUnknown' as const,
                  localId,
                  code: 'machine_admission_acknowledgement_failed',
                }
              : params.signal?.aborted
                ? { status: 'outcomeUnknown' as const, localId, code: 'account_admission_cancelled_after_request' }
                : { status: 'outcomeUnknown' as const, localId, code: 'account_admission_acknowledgement_failed' },
    };
  }

  if (enqueueResult.didWrite === null) {
    return {
      ok: false,
      code: 'timeout',
      message: 'Pending enqueue returned an invalid admission acknowledgement',
      admissionResult: { status: 'outcomeUnknown', localId, code: 'account_admission_result_malformed' },
    };
  }

  if (!admissionResult) {
    admissionResult = {
      status: enqueueResult.didWrite === false ? 'alreadyAccepted' : 'accepted',
      localId,
    };
  }

  if (enqueueResult?.suppressed === true) {
    return {
      ok: true,
      sessionId,
      localId,
      waited: false,
      suppressed: true,
      ...(admissionResult ? { admissionResult } : {}),
    };
  }

  const terminalAdmissionReplay = enqueueResult?.terminal === true;
  // A terminal replay proves the exact input is already committed; it does not
  // report the outcome of the turn that carries it. When the caller asked to
  // wait and the input names an exact Execution Run target, the exact-turn
  // observer below rejoins by the committed local-id anchor and settles it, so
  // only a caller that did not ask to wait takes the shortcut.
  const observesTerminalTargetTurn = params.wait === true && executionRunRecipient !== undefined;
  // A replay whose exact Pending row is already gone has reached a terminal
  // owner state. Resuming an inactive parent Session cannot redeliver that
  // exact input and would create an unrelated lifecycle effect on retry — and
  // the exact-turn observer is never reached for an untargeted send, so that
  // shortcut stays unconditional there.
  if (terminalAdmissionReplay && !observesTerminalTargetTurn) {
    return {
      ok: true,
      sessionId,
      localId,
      waited: false,
      terminal: true,
      ...(admissionResult ? { admissionResult } : {}),
    };
  }

  if (shouldResumeInactiveSession) {
    const resumeResult = await requestInactiveSessionResume({
      credentials: params.credentials,
      sessionId,
      localId,
      rawSession: sessionTarget.rawSession,
      ...(params.incomingResumeOptions ? { incomingOptions: params.incomingResumeOptions } : {}),
      metadata: decryptedMetadata && typeof decryptedMetadata === 'object' && !Array.isArray(decryptedMetadata)
        ? decryptedMetadata as Record<string, unknown>
        : {},
      timeoutMs: params.timeoutMs,
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.machineResumeTransport
        ? { machineRpcTransport: params.machineResumeTransport }
        : {}),
    });
    if (!resumeResult.ok) {
      return {
        ok: false,
        code: resumeResult.code === 'SESSION_DIRECTORY_MISSING' ? 'resume_failed' : resumeResult.code,
        message: resumeResult.message,
        ...(admissionResult ? { admissionResult } : {}),
      };
    }
    if (!params.wait) {
      return {
        ok: true,
        sessionId,
        localId,
        waited: false,
        ...(terminalAdmissionReplay ? { terminal: true } : {}),
        ...(admissionResult ? { admissionResult } : {}),
      };
    }
  }

  if (!params.wait) {
    return {
      ok: true,
      sessionId,
      localId,
      waited: false,
      ...(admissionResult ? { admissionResult } : {}),
    };
  }

  if (executionRunRecipient) {
    // The exact-turn observation shares the Session's already-resolved
    // encryption context; it never re-resolves transport or falls back to
    // main-Session reads. The target Run owns turn settlement through its
    // public input-turn projection, so a parent Session's idle state cannot
    // settle a nested turn.
    const crypto: SessionStoredContentCryptoContext = sessionTarget.mode === 'plain'
      ? { mode: 'plain', ctx: null }
      : { mode: 'e2ee', ctx: sessionTarget.ctx };
    const turnOutcome = await waitForExecutionRunInputTurnOutcome({
      credentials: params.credentials,
      crypto,
      sessionId,
      runId: executionRunRecipient.runId,
      localId,
      timeoutMs: params.timeoutMs,
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.resolveAuthorizationHeaders
        ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
        : {}),
    });
    if (turnOutcome === 'observation_cancelled') {
      return {
        ok: false,
        code: 'cancelled',
        message: 'Execution Run turn observation was cancelled after admission',
        ...(admissionResult ? { admissionResult } : {}),
      };
    }
    if (turnOutcome === 'completed') {
      return {
        ok: true,
        sessionId,
        localId,
        waited: true,
        ...(admissionResult ? { admissionResult } : {}),
      };
    }
    if (turnOutcome === 'failed' || turnOutcome === 'cancelled') {
      // A proven exact-turn failure is a wait outcome, not an admission
      // result. No admissionResult is attached so a known failed/cancelled
      // turn can never be projected as an accepted input.
      return {
        ok: false,
        code: 'wait_failed',
        message: turnOutcome === 'failed'
          ? 'Execution Run turn failed'
          : 'Execution Run turn cancelled',
        settlementResult: turnOutcome === 'failed'
          ? { status: 'failed', localId, code: 'session_input_turn_failed' }
          : { status: 'cancelled', localId, code: 'session_input_turn_cancelled' },
      };
    }
    return {
      ok: false,
      code: 'wait_failed',
      admissionResult: { status: 'outcomeUnknown', localId, code: 'session_input_turn_outcome_unknown' },
    };
  }

  const deadlineMs = Date.now() + params.timeoutMs;
  const remainingTimeoutMs = () => Math.max(1, deadlineMs - Date.now());
  let waitSessionSnapshot = sessionTarget.rawSession;
  let currentTurnAfterSeqExclusive: number | null = null;

  try {
    const promptDelivery = await waitForCurrentPromptDelivery({
      token: params.credentials.token,
      sessionId,
      localId,
      deadlineMs,
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.resolveAuthorizationHeaders
        ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
        : {}),
    });
    if (promptDelivery.kind === 'cancelled') {
      return { ok: false, code: 'cancelled', message: formatStructuredTurnFailureMessage('cancelled'),
        ...(admissionResult ? { admissionResult } : {}) };
    }
    if (promptDelivery.kind === 'blocked') {
      return {
        ok: false,
        code: 'wait_failed',
        message: formatBlockedPromptDeliveryFailure(promptDelivery.reason),
        // The canonical queue proved that this input cannot reach the runtime.
        // Preserve that evidence through Action output instead of reporting
        // the earlier enqueue acknowledgement as a successful delivery.
        admissionResult: { status: 'rejected', code: 'session_input_target_unavailable' },
      };
    }
    if (promptDelivery.kind === 'missing') {
      return {
        ok: false,
        code: 'timeout',
        ...(admissionResult ? { admissionResult } : {}),
      };
    }
    const materialized = promptDelivery.message;
    const currentUserCreatedAt = readNonnegativeInteger(materialized.createdAt);

    if (params.resolveAuthorizationHeaders) {
      const assistantTurnOutcome = await waitForAssistantCompletionAfterCurrentUserTurn({
        token: params.credentials.token,
        sessionId,
        localId,
        materializedSeq: materialized.seq,
        ctx: sessionTarget.ctx,
        deadlineMs,
        ...(params.signal ? { signal: params.signal } : {}),
        resolveAuthorizationHeaders: params.resolveAuthorizationHeaders,
      });
      if (assistantTurnOutcome.kind === 'failed' || assistantTurnOutcome.kind === 'cancelled') {
        return {
          ok: false,
          code: 'wait_failed',
          message: assistantTurnOutcome.message,
          ...(admissionResult ? { admissionResult } : {}),
        };
      }
      return assistantTurnOutcome.kind === 'completed'
        ? { ok: true, sessionId, localId, waited: true, ...(admissionResult ? { admissionResult } : {}) }
        : { ok: false, code: 'timeout', ...(admissionResult ? { admissionResult } : {}) };
    }

    currentTurnAfterSeqExclusive = await resolveCurrentTurnAfterSeqExclusive({
      token: params.credentials.token,
      sessionId,
      localId,
      materializedSeq: materialized.seq,
      ctx: sessionTarget.ctx,
      ...(params.resolveAuthorizationHeaders
        ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
        : {}),
    });

    try {
      const refreshedSession = await fetchSessionById({
        token: params.credentials.token,
        sessionId,
      });
      if (refreshedSession) {
        waitSessionSnapshot = refreshedSession;
      }
    } catch {
      waitSessionSnapshot = sessionTarget.rawSession;
    }

    const initialProjectedCurrentTurnStatus = readProjectedCurrentTurnStatus({
      session: waitSessionSnapshot,
      currentUserCreatedAt,
    });
    const initialTurnActivity = initialProjectedCurrentTurnStatus
      ? turnActivityFromProjectedCurrentTurnStatus(initialProjectedCurrentTurnStatus)
      : await detectSessionTurnActivity({
          token: params.credentials.token,
          sessionId,
          encryptionMode: sessionTarget.mode,
          encryptionKey: sessionTarget.ctx?.encryptionKey ?? null,
          encryptionVariant: sessionTarget.ctx?.encryptionVariant ?? null,
          ...(typeof currentTurnAfterSeqExclusive === 'number' ? { afterSeqExclusive: currentTurnAfterSeqExclusive } : {}),
          readyCompletesPendingUserTurns: false,
          transcriptFetchTimeoutMs: remainingTimeoutMs(),
        });

    const agentStateCiphertext =
      typeof waitSessionSnapshot.agentState === 'string' ? String(waitSessionSnapshot.agentState).trim() : null;

    await waitForIdleViaSocket({
      token: params.credentials.token,
      sessionId,
      ctx: sessionTarget.ctx,
      sessionEncryptionMode: sessionTarget.mode,
      timeoutMs: remainingTimeoutMs(),
      initialTurnActivity,
      recheckTurnActivity: async () => {
        try {
          const refreshedSession = await fetchSessionById({
            token: params.credentials.token,
            sessionId,
          });
          const projectedCurrentTurnStatus = readProjectedCurrentTurnStatus({
            session: refreshedSession,
            currentUserCreatedAt,
          });
          if (projectedCurrentTurnStatus) {
            return turnActivityFromProjectedCurrentTurnStatus(projectedCurrentTurnStatus);
          }
        } catch {
          // Fall through to transcript evidence when the current projection is unavailable.
        }
        return detectSessionTurnActivity({
          token: params.credentials.token,
          sessionId,
          encryptionMode: sessionTarget.mode,
          encryptionKey: sessionTarget.ctx?.encryptionKey ?? null,
          encryptionVariant: sessionTarget.ctx?.encryptionVariant ?? null,
          ...(typeof currentTurnAfterSeqExclusive === 'number' ? { afterSeqExclusive: currentTurnAfterSeqExclusive } : {}),
          readyCompletesPendingUserTurns: false,
          transcriptFetchTimeoutMs: remainingTimeoutMs(),
        });
      },
      preferProjectionUpdates: false,
      readyCompletesPendingUserTurns: false,
      initialAgentStateCiphertextBase64:
        agentStateCiphertext && agentStateCiphertext.length > 0 ? agentStateCiphertext : null,
    });
    let finalSessionSnapshot = waitSessionSnapshot;
    try {
      const refreshedSession = await fetchSessionById({
        token: params.credentials.token,
        sessionId,
      });
      if (refreshedSession) {
        finalSessionSnapshot = refreshedSession;
      }
    } catch {
      finalSessionSnapshot = waitSessionSnapshot;
    }
    const projectedFailure = readProjectedCurrentTurnFailure({
      session: finalSessionSnapshot,
      currentUserCreatedAt,
    });
    if (projectedFailure) {
      return {
        ok: false,
        code: 'wait_failed',
        message: projectedFailure,
        ...(admissionResult ? { admissionResult } : {}),
      };
    }
    const transcriptFailure = await findAssistantFailureAfterCurrentUserTurn({
      token: params.credentials.token,
      sessionId,
      localId,
      materializedSeq: materialized.seq,
      ctx: sessionTarget.ctx,
    });
    if (transcriptFailure) {
      return {
        ok: false,
        code: 'wait_failed',
        message: transcriptFailure.message,
        ...(admissionResult ? { admissionResult } : {}),
      };
    }
    if (readProjectedCurrentTurnStatus({
      session: finalSessionSnapshot,
      currentUserCreatedAt,
    }) === 'completed') {
      return {
        ok: true,
        sessionId,
        localId,
        waited: true,
        ...(admissionResult ? { admissionResult } : {}),
      };
    }
    const assistantTurnOutcome = await waitForAssistantCompletionAfterCurrentUserTurn({
      token: params.credentials.token,
      sessionId,
      localId,
      materializedSeq: materialized.seq,
      ctx: sessionTarget.ctx,
      deadlineMs,
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.resolveAuthorizationHeaders
        ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
        : {}),
    });
    if (assistantTurnOutcome.kind === 'failed' || assistantTurnOutcome.kind === 'cancelled') {
      return {
        ok: false,
        code: 'wait_failed',
        message: assistantTurnOutcome.message,
        ...(admissionResult ? { admissionResult } : {}),
      };
    }
    if (assistantTurnOutcome.kind !== 'completed') {
      return {
        ok: false,
        code: 'timeout',
        ...(admissionResult ? { admissionResult } : {}),
      };
    }
    return {
      ok: true,
      sessionId,
      localId,
      waited: true,
      ...(admissionResult ? { admissionResult } : {}),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error ?? '');
    if (errorMessage === 'timeout') {
      return {
        ok: false,
        code: 'timeout',
        ...(admissionResult ? { admissionResult } : {}),
      };
    }
    return {
      ok: false,
      code: 'wait_failed',
      message: errorMessage || 'Wait for idle failed',
      ...(admissionResult ? { admissionResult } : {}),
    };
  }
}
