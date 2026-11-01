import { randomUUID } from 'node:crypto';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { materializeActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionSessionAddressV1 } from '@happier-dev/protocol/actions/sessionTargetV1';
import { FILE_REVIEW_NOTE_KIND, readFileReviewNoteV1 } from '@happier-dev/protocol/messages/structured/fileReviewNoteV1';

import {
  parsePermissionIntentAlias,
  resolvePermissionIntentFromSessionMetadata,
  type PermissionIntent,
} from '@happier-dev/agents';
import { readPendingLocalId } from '@happier-dev/protocol/sessions/pending/pendingLocalId';
import { resolveLinkedExternalSessionAuthorityV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';
import { SESSION_MESSAGE_PROVENANCE_META_KEY, SessionInputRequestSchema, SessionMessageProvenanceSchema, stripSessionInputProtectedMeta, readSessionInputAuthority, readSessionInputSenderSessionIdV1, deriveWorkflowSessionInputLocalIdV2, buildTrustedHostSessionInputAdmissionV1, type SessionInputReplyIntentV1, type SessionInputEnqueueResultV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { withSessionMessageModelSelectionV1 } from '@happier-dev/protocol/providers/model-selection';
import type { ProviderErrorV1, SessionInputRequest, SessionMessageProvenance, SessionInputAdmissionRejectionCodeV1, SessionMessageSendResultV1, SessionPendingEnqueueByMachineRequestV1, SessionPendingExecutionRunEnqueueByMachineRequestV2, PendingRequestedActionV1, ParticipantRecipientV1, ExecutionRunInputTurnV1, ExecutionRunPublicState } from '@happier-dev/protocol';
import { SessionInputAdmissionRejectionCodeV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmissionRejectionV1';
import { normalizeParticipantRecipientRoutingIdentityV1, withParticipantRecipientV1 } from '@happier-dev/protocol/messages/structured/participantMessageV1';
import { ExecutionRunGetResponseSchema, ExecutionRunInputTurnV1Schema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { SessionMessageRefV1Schema, type SessionMessageRefV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageRefV1';
import type { SessionMessageReplyOutcomeV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { resolveSessionReceiverDeliveryV1, type SessionReceiverDeliveryDecisionV1 } from '@happier-dev/protocol/sessions/follow/sessionReceiverDeliveryV1';
import { readSessionExplicitStopV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { isFollowDeliveryMutedV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';

import { fetchEncryptedTranscriptPageAfterSeq } from '@/api/session/fetchEncryptedTranscriptWindow';
import { readSessionDeliveryMutedScopes } from '@/api/sessionDeliveryMuteTransport';
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
import { fetchServerFeaturesSnapshot, type CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { PENDING_INPUT_PROTOCOL_VERSION_V5 } from '@happier-dev/protocol/clientCompatibility/primitives';
import {
  detectSessionTurnActivity,
  detectSessionTurnActivityFromProjection,
  isSessionAgentThreadTextUserMessage,
  isMemoryArtifactDecryptedRow,
  isSessionAgentMessage,
  readSessionProjectedTurnStatus,
  type SessionTurnActivity,
} from '@/session/query/detectSessionTurnInFlight';
import { fetchSessionById, fetchSessionTurnsProjection, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import type { SessionTurnV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
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
import { requiresMachineAdmissionForSessionInput, resolveSessionInputTargetMachineId } from './sessionInputAdmissionIdentity';
import { MachineAdmissionTransportUnavailableError } from '@/daemon/machineAdmissionTransport';
import {
  resolveSessionMessageModel,
  type SessionMessageModelSelectionInput,
} from './resolveSessionMessageModel';
import { requestInactiveSessionResume, type InactiveSessionResumeResult } from './requestInactiveSessionResume';
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
      admissionResult?: SessionInputEnqueueResultV1;
      /** Admission intent only: Pending custody does not prove provider consumption. */
      receiverDelivery?: SessionReceiverDeliveryDecisionV1;
      receiverResumeFailure?: Extract<InactiveSessionResumeResult, { ok: false }>;
    }>
  | Readonly<{
      ok: false;
      /**
       * `resume_failed` comes from the inactive-session resume seam and means the
       * machine took the request and did not start the Session. It is distinct
       * from `unsupported`, which claims this Session or daemon cannot do it at
       * all — see `InactiveSessionResumeResult`.
       */
      code: 'session_not_found' | 'session_id_ambiguous' | 'session_lookup_timeout' | 'session_archived' | 'session_inactive' | 'held_by_person' | 'authority_unavailable' | 'machine_target_not_current' | 'takeover_required' | 'unsupported' | 'resume_failed' | 'plugin_disabled' | 'encryption_material_unavailable' | 'timeout' | 'wait_failed' | 'provider_switch_unsupported' | 'admission_rejected' | 'cancelled' | 'machine_admission_transport_unavailable';
      candidates?: string[];
      message?: string;
      providerError?: ProviderErrorV1;
      admissionResult?: SessionInputEnqueueResultV1;
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
  | Readonly<{ kind: 'final_text'; text: string; usage?: SessionInputUsageV1; messageRef?: SessionMessageRefV1 }>
  | Readonly<{
      kind: 'terminal_no_result';
      reason: 'missing_final_assistant_text';
      usage?: SessionInputUsageV1;
    }>
  | Readonly<{ kind: 'failed'; message: string; runtimeIssueV1?: SessionRuntimeIssueV1; usage?: SessionInputUsageV1 }>
  | Readonly<{ kind: 'cancelled'; message: string; partialText?: string; messageRef?: SessionMessageRefV1; usage?: SessionInputUsageV1 }>;

export type WaitForSessionInputResult =
  | Readonly<{
      ok: true;
      sessionId: string;
      localId: string;
      result: SessionInputResultV1;
      /** Actual committed input identity; absent while the input remains Pending. */
      inputMessageRef?: SessionMessageRefV1;
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

export type WaitForSessionInputReplyResult = Exclude<WaitForSessionInputResult, { ok: true }> | Readonly<{
  ok: true; sessionId: string; localId: string; inputMessageRef?: SessionMessageRefV1;
  result: SessionInputResultV1 | Readonly<{ kind: 'fulfilled'; outcome: SessionMessageReplyOutcomeV1 }>;
  replyOutcome?: SessionMessageReplyOutcomeV1;
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
  /** Captured qualified Home of the authorized transport, not a message-authored value. */
  serverId?: string;
  idOrPrefix: string;
  localId: string;
  signal?: AbortSignal;
  serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
  /** Canonical ask waits on this original input's immutable fulfillment, not just text. */
  observeReply?: boolean;
  resolveAuthorizationHeaders?: ResolveSessionMessageAuthorizationHeaders;
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
  /** Captured sending Home; direct local callers retain the active Home default. */
  serverId?: string;
  /** Existing host-admitted routing tuple; never message metadata or a wire option. */
  expectedSessionAddress?: ActionSessionAddressV1;
  message: string;
  wait: boolean;
  timeoutMs: number;
  localId?: string;
  recipient?: ParticipantRecipientV1;
  resumeInactiveSession?: boolean;
  /** Host result owner only. Never populated from authored Action or message metadata. */
  informationDelivery?: 'returned_answer' | 'session_follow' | 'file_review_note';
  /** Source host match proof; native admission custody only, never encrypted message metadata. */
  followSources?: readonly import('@happier-dev/protocol/sessions/follow/sessionFollowSourceOccurrenceV1').SessionFollowSourceOccurrenceWitnessV1[];
  followRelations?: SessionPendingEnqueueByMachineRequestV1['followRelations'];
  /** Non-ignorable host intent; authored message metadata never supplies it. */
  replyIntent?: SessionInputReplyIntentV1;
  /** Captured Action authority; automatic callers cannot clear a person's Stop. */
  executionAuthority?: import('@happier-dev/protocol').ActionExecutorContext['authority'];
  permissionModeOverride?: string;
  modelSelectionInput?: SessionMessageModelSelectionInput;
  modelSelectionUpdatedAt?: number;
  incomingResumeOptions?: Parameters<typeof requestInactiveSessionResume>[0]['incomingOptions'];
  pendingAdmissionMode?: 'continuation_if_no_queued_user_input';
  /** Host recovery qualification against the fresh Session used for authoring. */
  canAdmitPendingInput?: (input: Readonly<{
    rawSession: RawSessionRecord;
    metadata: Record<string, unknown> | null;
  }>) => boolean | Promise<boolean>;
  /** Deployed CLI compatibility only; new action callers pass modelSelectionInput. */
  modelOverride?: string | null;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: ResolveSessionMessageAuthorizationHeaders;
  machineResumeTransport?: (
    method: string,
    request: unknown,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<unknown>;
  /** Hosting daemon only; automatic delivery still passes the common resume admission. */
  spawnSession?: Parameters<typeof requestInactiveSessionResume>[0]['spawnSession'];
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
    options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number; callerInputAuthorization?: import('@happier-dev/protocol').ExternalActionExecutionAuthorizationV1 }>,
  ) => Promise<SessionInputEnqueueResultV1>;
  /** Exact creation target when admission precedes the Session metadata projection. */
  targetMachineId?: string;
  serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
}>;

type SendProtectedSessionMessageParams = SendSessionMessageParams & Readonly<{
  inputAdmission: NonNullable<SendSessionMessageParams['inputAdmission']>;
}>;

type SendProtectedSessionMessageResult = SendSessionMessageResult & Readonly<{
  admissionResult: SessionInputEnqueueResultV1;
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
): SessionInputEnqueueResultV1 {
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
  | Readonly<{ kind: 'failed'; message: string; runtimeIssueV1?: SessionRuntimeIssueV1; usage?: SessionInputUsageV1 }>
  | Readonly<{ kind: 'cancelled'; message: string; partialText?: string; finalAssistantMessageId?: string; usage?: SessionInputUsageV1 }>;

type AssistantTurnOutcome =
  | Readonly<{ kind: 'missing' }>
  | Readonly<{
      kind: 'completed';
      finalAssistantText: string | null;
      finalAssistantMessageId?: string;
      usage?: SessionInputUsageV1;
    }>
  | AssistantTurnFailure;

const ASSISTANT_TURN_SCAN_PAGE_LIMIT = 100;

type CurrentPromptDeliveryOutcome =
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'materialized'; message: TranscriptMessageLookupResult }>
  | Readonly<{ kind: 'blocked'; reason: PendingQueueDeliveryBlockedReason }>
  | Readonly<{ kind: 'cancelled' }>;

type FulfilledReplyObservation = Readonly<{ kind: 'fulfilled'; outcome: SessionMessageReplyOutcomeV1 }>;

async function readOriginalReply(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  localId: string;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: ResolveSessionMessageAuthorizationHeaders;
}>) {
  const { readSessionMessageReply } = await import('./sessionMessageReply');
  return readSessionMessageReply(params);
}

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

type CurrentPromptDeliveryObservationParams = Readonly<{
  token: string;
  sessionId: string;
  localId: string;
  deadlineMs: number | null;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: ResolveSessionMessageAuthorizationHeaders;
  beforeInputObservation?: () => Promise<void>;
}>;
function waitForCurrentPromptDelivery(params: CurrentPromptDeliveryObservationParams & { replyCredentials: StoredCredentials }): Promise<CurrentPromptDeliveryOutcome | FulfilledReplyObservation>;
function waitForCurrentPromptDelivery(params: CurrentPromptDeliveryObservationParams): Promise<CurrentPromptDeliveryOutcome>;
async function waitForCurrentPromptDelivery(params: CurrentPromptDeliveryObservationParams & { replyCredentials?: StoredCredentials }): Promise<CurrentPromptDeliveryOutcome | FulfilledReplyObservation> {
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
      if (params.replyCredentials) {
        try {
          const original = await readOriginalReply({ ...params, credentials: params.replyCredentials });
          const outcome = original.status === 'available' ? original.progress.outcome : undefined;
          params.signal?.throwIfAborted();
          // Pre-provider failure/cancellation can settle original Pending custody
          // without ever producing a committed transcript input or answer.
          if (outcome && !('result' in outcome)) return { kind: 'fulfilled', outcome };
        } catch {
          // Unavailable custody is not completion; reuse the input change wait.
          params.signal?.throwIfAborted();
        }
      }
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
  /** Host-owned correspondence takes precedence over transcript adjacency. */
  turn?: SessionTurnV1;
  precedingTurnEndSeq?: number;
  /** Immutable original reply custody may select an explicit committed publication. */
  resultMessageId?: string;
  ctx: Readonly<{
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
  }> | null;
  resolveAuthorizationHeaders?: ResolveSessionMessageAuthorizationHeaders;
}>): Promise<Readonly<{
  failure: AssistantTurnFailure | null;
  sawCompletion: boolean;
  finalAssistantText: string | null;
  finalAssistantMessageId?: string;
  usage?: SessionInputUsageV1;
}>> {
  const readCommittedTurnText = params.turn?.status === 'completed'
    && typeof params.turn.transcriptAnchors?.finalAssistantMessageSeq !== 'number';
  let afterSeq = Math.max(0, Math.trunc(params.materializedSeq) - 1,
    readCommittedTurnText ? 0 : params.precedingTurnEndSeq ?? 0);
  let currentUserSeq = Math.max(0, Math.trunc(params.materializedSeq));
  let observedAgentProgress = false;
  let sawCompletion = params.turn?.transcriptAnchors?.finalAssistantMessageSeq === null;
  let finalAssistantText: string | null = null;
  let finalAssistantMessageId: string | undefined;
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
      if (params.resultMessageId && row.id !== params.resultMessageId) continue;
      const endSeq = readCommittedTurnText ? undefined : params.turn?.transcriptAnchors?.endSeqInclusive;
      if (typeof endSeq === 'number' && row.seq > endSeq) break;
      const decrypted = decryptTranscriptRowContent({
        content: row.content,
        ctx: params.ctx,
      });
      const meta = asRecord(asRecord(decrypted)?.meta);
      // Retained terminal projections can predate their complete anchors.
      // Only the host's exact native turn tag can fill that correspondence;
      // transcript adjacency and later turns cannot supply it.
      if (readCommittedTurnText && meta?.runtimeTurnId !== params.turn?.turnId) continue;
      // The exact input's terminal proof closes this scan. A later input
      // starts another turn and must not become a fallback result for this
      // input when a legacy transcript lacks an explicit turn anchor.
      if (!params.resultMessageId && !params.turn && (isSessionAgentThreadTextUserMessage(decrypted) || isSessionContextOnlyHostInput(decrypted))) {
        const usage = currentUsage();
        return { failure: null, sawCompletion, finalAssistantText,
          ...(finalAssistantMessageId ? { finalAssistantMessageId } : {}), ...(usage ? { usage } : {}) };
      }
      const failure = params.turn || params.resultMessageId ? null : readAssistantTurnFailure(decrypted);
      if (failure) {
        const usage = currentUsage();
        return {
          failure: usage ? { ...failure, usage } : failure,
          sawCompletion,
          finalAssistantText,
          ...(finalAssistantMessageId ? { finalAssistantMessageId } : {}),
          ...(usage ? { usage } : {}),
        };
      }
      const decoded = decodeTranscriptBody(decrypted);
      addTurnUsage(decrypted);
      const segment = asRecord(meta?.happierStreamSegmentV1);
      const committedTurnText = readCommittedTurnText && (meta?.runtimeEventKind === 'transcript-message-committed'
        || segment?.segmentKind === 'assistant' && segment.segmentState === 'complete');
      if (decoded?.semanticRole === 'assistant' && (params.resultMessageId || decoded.sidechainId === undefined) && decoded.text
        && (!params.turn || row.seq === params.turn.transcriptAnchors?.finalAssistantMessageSeq || committedTurnText)) {
        finalAssistantText = decoded.text;
        finalAssistantMessageId = row.id || undefined;
        if (params.turn || params.resultMessageId) sawCompletion = true;
      }
      if (params.turn) continue;
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

    const endSeq = readCommittedTurnText ? undefined : params.turn?.transcriptAnchors?.endSeqInclusive;
    if (orderedRows.length < ASSISTANT_TURN_SCAN_PAGE_LIMIT
      || (typeof endSeq === 'number' && (orderedRows.at(-1)?.seq ?? 0) >= endSeq)) {
      const usage = currentUsage();
      return { failure: null, sawCompletion, finalAssistantText,
        ...(finalAssistantMessageId ? { finalAssistantMessageId } : {}), ...(usage ? { usage } : {}) };
    }
    const lastRowSeq = orderedRows[orderedRows.length - 1]?.seq ?? null;
    if (!Number.isSafeInteger(lastRowSeq) || lastRowSeq <= afterSeq) {
      const usage = currentUsage();
      return { failure: null, sawCompletion, finalAssistantText,
        ...(finalAssistantMessageId ? { finalAssistantMessageId } : {}), ...(usage ? { usage } : {}) };
    }
    afterSeq = lastRowSeq;
  }
}

async function readAssistantTurnOutcomeAfterCurrentUserTurn(params: Readonly<{
  token: string;
  sessionId: string;
  localId: string;
  materializedSeq: number;
  materializedContent?: TranscriptMessageLookupResult['content'];
  resultMessageId?: string;
  /** Original input custody, never supplied by transcript content. */
  acceptedTurnId?: string;
  ctx: Readonly<{
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
  }> | null;
  resolveAuthorizationHeaders?: ResolveSessionMessageAuthorizationHeaders;
}>): Promise<AssistantTurnOutcome> {
  const projection = params.resultMessageId ? null : await fetchSessionTurnsProjection(params);
  const input = params.materializedContent
    ? asRecord(decryptTranscriptRowContent({ content: params.materializedContent, ctx: params.ctx })) : null;
  const inputAuthority = readSessionInputAuthority(input?.meta, 'stored');
  const workflowInput = inputAuthority?.producer === 'workflow';
  const matchesWorkflowInput = (candidate: SessionTurnV1) => Boolean(candidate.workflowInvocation && deriveWorkflowSessionInputLocalIdV2({
      purpose: 'invocation', ...candidate.workflowInvocation,
    }) === params.localId);
  const turn = projection?.turns.find(candidate => params.acceptedTurnId
    ? candidate.turnId === params.acceptedTurnId && matchesWorkflowInput(candidate)
      && (inputAuthority?.producer === 'workflow'
        ? deriveWorkflowSessionInputLocalIdV2(inputAuthority.workflow) === params.localId
        : isSessionContextOnlyHostInput(input))
    : candidate.transcriptAnchors?.userMessageSeqs?.includes(params.materializedSeq)
      || candidate.transcriptAnchors?.startUserMessageSeq === params.materializedSeq || matchesWorkflowInput(candidate));
  // A queued input can be materialized before the current provider turn ends.
  // Neither that turn's text nor the next input's transcript position owns it.
  if (!params.resultMessageId && (
    params.acceptedTurnId && !turn
    || !projection && (workflowInput || isSessionContextOnlyHostInput(input))
    || projection && (!turn || turn.status === 'in_progress')
  )) return { kind: 'missing' };
  const precedingTurnEndSeq = turn && projection ? projection.turns.reduce((latest, candidate) => {
    const end = candidate.transcriptAnchors?.endSeqInclusive;
    const currentEnd = turn.transcriptAnchors?.endSeqInclusive;
    return candidate.status !== 'in_progress' && typeof end === 'number' && typeof currentEnd === 'number' && end < currentEnd
      ? Math.max(latest, end) : latest;
  }, 0) : undefined;
  const scan = await scanAssistantTurnAfterCurrentUserTurn({ ...params, ...(turn ? { turn, precedingTurnEndSeq } : {}) });
  if (turn?.status === 'failed' || turn?.status === 'cancelled') {
    return { kind: turn.status, message: formatStructuredTurnFailureMessage(turn.status,
      readStructuredIssuePreview(turn.lastRuntimeIssue)),
      ...(turn.status === 'failed' && turn.lastRuntimeIssue ? { runtimeIssueV1: turn.lastRuntimeIssue } : {}),
      ...(scan.usage ? { usage: scan.usage } : {}) };
  }
  if (scan.failure) {
    return scan.failure;
  }
  return scan.sawCompletion
    ? {
        kind: 'completed',
        finalAssistantText: scan.finalAssistantText,
        ...(scan.finalAssistantMessageId ? { finalAssistantMessageId: scan.finalAssistantMessageId } : {}),
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

type AssistantCompletionObservationParams = Readonly<{
  token: string;
  sessionId: string;
  localId: string;
  materializedSeq: number;
  materializedContent?: TranscriptMessageLookupResult['content'];
  ctx: Readonly<{
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
  }> | null;
  deadlineMs: number | null;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: ResolveSessionMessageAuthorizationHeaders;
}>;
type ReplyObservation = Readonly<{
  credentials: StoredCredentials;
  onOutcome: (outcome: SessionMessageReplyOutcomeV1) => void;
}>;
function waitForAssistantCompletionAfterCurrentUserTurn(params: AssistantCompletionObservationParams & { reply: ReplyObservation }): Promise<AssistantTurnOutcome | FulfilledReplyObservation>;
function waitForAssistantCompletionAfterCurrentUserTurn(params: AssistantCompletionObservationParams): Promise<AssistantTurnOutcome>;
async function waitForAssistantCompletionAfterCurrentUserTurn(params: AssistantCompletionObservationParams & { reply?: ReplyObservation }): Promise<AssistantTurnOutcome | FulfilledReplyObservation> {
  const events = openSessionEventSource(params);
  try {
    while (!params.signal?.aborted) {
      const revision = events.currentRevision();
      try {
        let replyOutcome: SessionMessageReplyOutcomeV1 | undefined;
        let originalHasNoReply = false;
        let requiresDiscussionReplyOutcome = false;
        let publishedDiscussionAnswer = false;
        let acceptedTurnId: string | undefined;
        if (params.reply) {
          const original = await readOriginalReply({ credentials: params.reply.credentials,
            sessionId: params.sessionId, localId: params.localId, ...(params.signal ? { signal: params.signal } : {}),
            ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}) });
          // Historical inputs have no obligation; unavailable custody never
          // authorizes falling back to an unrelated or merely later final.
          originalHasNoReply = original.status === 'none';
          requiresDiscussionReplyOutcome = original.status === 'available'
            && Boolean(original.progress.workflow && original.progress.discussion);
          replyOutcome = original.status === 'available' ? original.progress.outcome : undefined;
          publishedDiscussionAnswer = requiresDiscussionReplyOutcome
            && replyOutcome?.kind === 'answer' && 'publicationRef' in replyOutcome;
          acceptedTurnId = original.status === 'available' && (!replyOutcome || publishedDiscussionAnswer)
            ? original.progress.acceptedTurnId : undefined;
          if (replyOutcome) {
            params.reply.onOutcome(replyOutcome);
            if (!('result' in replyOutcome) && !publishedDiscussionAnswer) {
              return { kind: 'fulfilled', outcome: replyOutcome };
            }
          }
        }
        const outcome = await readAssistantTurnOutcomeAfterCurrentUserTurn({ ...params,
          ...(acceptedTurnId ? { acceptedTurnId } : {}),
          ...(replyOutcome && 'result' in replyOutcome
            && replyOutcome.result.sessionId === params.sessionId
            ? { resultMessageId: replyOutcome.result.messageId } : {}) });
        if ((!params.reply || originalHasNoReply) && outcome.kind !== 'missing') return outcome;
        // Ordinary retained Workflow turns can recover from exact native
        // completion without reply custody. Discussion Workflow success must
        // carry C2's independent fact into the immutable terminal invocation;
        // its existing custody wake reopens the original before completion.
        // Reclaim can first see an already-published C2 answer. Keep that fact
        // while recovering text only from this original's accepted native turn.
        if (acceptedTurnId && (outcome.kind === 'failed' || outcome.kind === 'cancelled'
          || outcome.kind === 'completed' && outcome.finalAssistantText !== null
            && (!requiresDiscussionReplyOutcome || publishedDiscussionAnswer))) return outcome;
        if (replyOutcome && 'result' in replyOutcome
          && replyOutcome.result.sessionId === params.sessionId
          && outcome.kind === 'completed' && outcome.finalAssistantMessageId === replyOutcome.result.messageId) {
          return replyOutcome.kind === 'cancelled' ? { kind: 'cancelled', message: formatStructuredTurnFailureMessage('cancelled'),
            ...(outcome.finalAssistantText !== null ? { partialText: outcome.finalAssistantText } : {}),
            finalAssistantMessageId: outcome.finalAssistantMessageId, ...(outcome.usage ? { usage: outcome.usage } : {}) } : outcome;
        }
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

function resultFromAssistantTurnOutcome(
  outcome: AssistantTurnOutcome,
  session: SessionMessageRefV1['session'],
): SessionInputResultV1 {
  if (outcome.kind === 'missing') {
    return { kind: 'pending' };
  }
  if (outcome.kind === 'cancelled') {
    const { finalAssistantMessageId, ...cancelled } = outcome;
    return { ...cancelled, ...(finalAssistantMessageId ? { messageRef: SessionMessageRefV1Schema.parse({
      kind: 'session', session, messageId: finalAssistantMessageId,
    }) } : {}) };
  }
  if (outcome.kind === 'failed') {
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
    ...(outcome.finalAssistantMessageId ? { messageRef: SessionMessageRefV1Schema.parse({
      kind: 'session', session, messageId: outcome.finalAssistantMessageId,
    }) } : {}),
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
      const inputTurn = createStoredReadSchema(ExecutionRunInputTurnV1Schema).safeParse(meta?.happierExecutionRunInputTurnV1);
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
export function waitForSessionInputResult(params: WaitForSessionInputResultParams & { observeReply: true }): Promise<WaitForSessionInputReplyResult>;
export function waitForSessionInputResult(params: WaitForSessionInputResultParams): Promise<WaitForSessionInputResult>;
export async function waitForSessionInputResult(params: WaitForSessionInputResultParams): Promise<WaitForSessionInputReplyResult> {
  const serverId = params.serverId ?? configuration.activeServerId;
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
      ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.serverFeaturesSnapshot ? { serverFeaturesSnapshot: params.serverFeaturesSnapshot } : {}),
    });
    if (!sessionTarget.ok) {
      return {
        ok: false,
        code: sessionTarget.code,
        ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}),
      };
    }

    const deliveryParams = {
      token: params.credentials.token,
      sessionId: sessionTarget.sessionId,
      localId,
      deadlineMs,
      ...(params.beforeInputObservation ? { beforeInputObservation: params.beforeInputObservation } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
    };
    const promptDelivery = params.observeReply
      ? await waitForCurrentPromptDelivery({ ...deliveryParams, replyCredentials: params.credentials })
      : await waitForCurrentPromptDelivery(deliveryParams);
    if (promptDelivery.kind === 'fulfilled') {
      return { ok: true, sessionId: sessionTarget.sessionId, localId,
        result: promptDelivery, replyOutcome: promptDelivery.outcome };
    }
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

    const completionParams = {
      token: params.credentials.token,
      sessionId: sessionTarget.sessionId,
      localId,
      materializedSeq: promptDelivery.message.seq,
      materializedContent: promptDelivery.message.content,
      ctx: sessionTarget.ctx,
      deadlineMs: acceptedDeadlineMs,
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
    };
    let replyOutcome: SessionMessageReplyOutcomeV1 | undefined;
    const outcome = params.observeReply
      ? await waitForAssistantCompletionAfterCurrentUserTurn({ ...completionParams,
          reply: { credentials: params.credentials, onOutcome: value => { replyOutcome = value; } } })
      : await waitForAssistantCompletionAfterCurrentUserTurn(completionParams);
    if (outcome.kind === 'missing' && params.signal?.aborted) return { ok: false, code: 'cancelled' };
    return {
      ok: true,
      sessionId: sessionTarget.sessionId,
      localId,
      inputMessageRef: SessionMessageRefV1Schema.parse({ kind: 'session',
        session: { serverId, sessionId: sessionTarget.sessionId }, messageId: promptDelivery.message.id }),
      ...(replyOutcome ? { replyOutcome } : {}),
      result: outcome.kind === 'fulfilled' ? outcome
        : resultFromAssistantTurnOutcome(outcome, { serverId, sessionId: sessionTarget.sessionId }),
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
  let sessionTarget: Awaited<ReturnType<typeof resolveSessionTransportContext>>;
  try {
    sessionTarget = await resolveSessionTransportContext({
      credentials: params.credentials,
      idOrPrefix: params.idOrPrefix,
      ...(params.resolveAuthorizationHeaders
        ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
        : {}),
      ...(params.serverFeaturesSnapshot ? { serverFeaturesSnapshot: params.serverFeaturesSnapshot } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    });
  } catch (error) {
    const cancelled = cancelledBeforeAdmission(params.signal, params.inputAdmission !== undefined);
    if (cancelled) return cancelled;
    throw error;
  }
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
  let localId = readPendingLocalId(params.localId) ?? randomUUID();
  const recipient = params.recipient === undefined
    ? undefined : normalizeParticipantRecipientRoutingIdentityV1(params.recipient);
  const executionRunRecipient = recipient?.kind === 'execution_run' ? recipient : undefined;
  const nextTurnNote = params.informationDelivery === 'file_review_note' ? FILE_REVIEW_NOTE_KIND : undefined;
  if (nextTurnNote && (executionRunRecipient || !readFileReviewNoteV1(params.messageMeta))) {
    return { ok: false, code: 'unsupported', message: 'Invalid file review note' };
  }
  if (nextTurnNote) {
    const snapshot = params.serverFeaturesSnapshot ?? await fetchServerFeaturesSnapshot({
      serverUrl: resolveServerHttpBaseUrl(), token: params.credentials.token, timeoutMs: params.timeoutMs,
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
    });
    if (snapshot.status !== 'ready'
      || (snapshot.features.capabilities.session.pendingInput?.protocolVersion ?? 0) < PENDING_INPUT_PROTOCOL_VERSION_V5) {
      return { ok: false, code: 'unsupported', message: 'File review notes require current Pending input support' };
    }
  }
  const participantMeta = params.messageMeta?.happier;
  if (!executionRunRecipient && (recipient !== undefined || participantMeta !== null
    && typeof participantMeta === 'object' && 'kind' in participantMeta
    && participantMeta.kind === 'participant_message.v1')) {
    // Native Session input has no team-recipient transport. Metadata cannot
    // turn that route into primary input; exact Run input uses its own Pending target.
    return {
      ok: false,
      code: 'unsupported',
      message: 'This runtime does not support the selected native recipient',
      admissionResult: rejectedProtectedInputBeforeAdmission('unsupported'),
    };
  }
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
  const originalAdmission = params.inputAdmission ?? (params.replyIntent ? buildTrustedHostSessionInputAdmissionV1('cli') : undefined);
  let protectedAdmission: NonNullable<typeof originalAdmission> | null;
  try {
    protectedAdmission = originalAdmission ? {
      provenance: SessionMessageProvenanceSchema.parse(originalAdmission.provenance),
      request: SessionInputRequestSchema.parse({ ...originalAdmission.request,
        ...(params.replyIntent ? { replyIntent: params.replyIntent } : {}) }),
    } : null;
  } catch {
    return { ok: false, code: 'admission_rejected', admissionResult: { status: 'rejected', code: 'session_input_invalid' } };
  }
  const requiresMachineAdmission = requiresMachineAdmissionForSessionInput({
    request: protectedAdmission?.request ?? null,
    mode: sessionTarget.mode,
    ...(params.callerInputAuthorization ? { callerInputAuthorization: params.callerInputAuthorization } : {}),
  });
  if (requiresMachineAdmission
    && protectedAdmission?.request.v === 1 && protectedAdmission.request.producer === 'cli') {
    // The preceding Home reads authenticate this credential. A routed send also
    // retains Home's admitted Account binding; the Machine custodian is never
    // the requester. Paired terminals retain that Account identity without
    // upgrading their automation authority; API-token roots do not establish it.
    const credentialAccountId = readAccountIdFromToken(params.credentials.token);
    const binding = params.callerInputAuthorization?.binding;
    const accountId = binding
      ? 'authentication' in binding && (binding.authentication?.kind === 'account'
        || binding.authentication?.kind === 'terminal') ? binding.accountId : null
      : credentialAccountId;
    const serverId = params.expectedSessionAddress?.serverId ?? params.serverId
      ?? params.callerInputAuthorization?.requesterAccountProjection?.serverId
      ?? params.callerInputAuthorization?.requesterHttpProjection?.serverId ?? configuration.activeServerId;
    const attribution = accountId && serverId ? materializeActionRequestAttributionV1({
      requestRef: localId, requester: { serverId, accountId }, persona: { serverId, sessionId }, origin: null,
    }) : undefined;
    if (binding && credentialAccountId && binding.accountId !== credentialAccountId
      || protectedAdmission.request.actionRequestAttributionV1 && (!attribution
        || !sameStrictJsonValue(protectedAdmission.request.actionRequestAttributionV1, attribution))) {
      return { ok: false, code: 'admission_rejected',
        admissionResult: { status: 'rejected', code: 'session_input_untrusted_assertion' } };
    }
    if (attribution) protectedAdmission = { ...protectedAdmission,
      request: { ...protectedAdmission.request, actionRequestAttributionV1: attribution } };
  }
  const replyIntent = protectedAdmission?.request.replyIntent;
  if (replyIntent) {
    const { readSessionMessageReplyCapability } = await import('./sessionMessageReply');
    const capability = await readSessionMessageReplyCapability({ credentials: params.credentials, sessionId,
      ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
      ...(params.signal ? { signal: params.signal } : {}) });
    const cancelled = cancelledBeforeAdmission(params.signal, protectedAdmission !== null);
    if (cancelled) return cancelled;
    if (capability === 'unavailable') return { ok: false, code: 'authority_unavailable',
      admissionResult: { status: 'outcomeUnknown', localId, code: 'session_input_reply_capability_unavailable' } };
    if (capability === 'unsupported') return { ok: false, code: 'unsupported',
        admissionResult: { status: 'rejected', code: 'session_input_target_update_required' } };
  }
  const replyAdmission = replyIntent ? { ...replyIntent,
    ...(protectedAdmission?.request.discussionAddressing
      ? { discussion: protectedAdmission.request.discussionAddressing } : {}),
    ...(protectedAdmission?.request.v === 2 && protectedAdmission.request.discussionAddressing
      ? { workflow: protectedAdmission.request.workflow } : {}),
    ...(protectedAdmission?.request.actionRequestAttributionV1
      ? { actionRequestAttributionV1: protectedAdmission.request.actionRequestAttributionV1 } : {}),
    ...(protectedAdmission?.request.sourceSession ? { sourceSession: protectedAdmission.request.sourceSession } : {}) } : undefined;
  // Completed returns carry an actual protected sender without inventing a live
  // causal turn. Display-only answer attribution never selects receiver policy.
  const senderSessionId = protectedAdmission ? readSessionInputSenderSessionIdV1(protectedAdmission.request) : undefined;
  const discussionAddressing = protectedAdmission?.request.discussionAddressing;
  let receiverPolicyAvailable = true;
  if (senderSessionId || discussionAddressing) {
    const scopes = await readSessionDeliveryMutedScopes({
      receiver: { kind: 'session', sessionId }, token: params.credentials.token,
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.resolveAuthorizationHeaders ? { authorizeRequest: params.resolveAuthorizationHeaders } : {}),
    });
    // A source runtime need not have access to the receiver's private scopes.
    // It can still create original Pending custody, but cannot wake from an
    // unknown policy. The target owner rechecks after opening protected input.
    receiverPolicyAvailable = scopes !== null;
    if (scopes !== null && isFollowDeliveryMutedV1(scopes, { ...(senderSessionId ? { senderSessionId } : {}),
      source: discussionAddressing ? { kind: 'discussion', discussionId: discussionAddressing.discussionId }
        : { kind: 'session', sessionId: senderSessionId! } })) {
      return { ok: true, sessionId, localId, waited: false, suppressed: true,
        receiverDelivery: { disposition: 'drop', reason: 'muted' },
        admissionResult: { status: 'rejected', code: 'session_input_muted' } };
    }
  }
  // CLI admission adds immutable authority without changing the ordinary
  // human-send contract: absent overrides still inherit the target defaults.
  const shouldProjectTargetDefaults = (protectedAdmission === null || protectedAdmission.request.producer === 'cli')
    && executionRunRecipient === undefined;
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

  const informationDelivery = params.informationDelivery !== undefined;
  // Exact Execution Runs retain their own lifecycle and turn availability;
  // their input does not enter Session check-in accounting. Parent Session
  // turns are counted separately, so its receiver projection is not a Run gate.
  const receiverControlled = executionRunRecipient === undefined
    && (informationDelivery || senderSessionId !== undefined || discussionAddressing !== undefined);
  const stop = receiverControlled ? readSessionExplicitStopV1FromMetadata(decryptedMetadata) : null;
  const activity = receiverControlled ? detectSessionTurnActivityFromProjection(sessionTarget.rawSession) : null;
  const receiverDelivery = receiverControlled ? resolveSessionReceiverDeliveryV1({
    facts: {
      archived: false,
      explicitStop: stop === null ? 'clear' : 'status' in stop ? 'unavailable' : 'held',
      // An inactive runtime needs an exact-machine resume attempt. Its success
      // is not inferred from this projection; the existing resume owner decides.
      availability: !receiverPolicyAvailable ? 'unavailable' : sessionTarget.rawSession.active !== true ? 'idle'
        : activity === null ? 'unavailable' : activity.turnInFlight ? 'busy' : 'idle',
      // Transport resolution already opened current mode/key material; the
      // exact sender's mute policy was checked above. Root check-in authority
      // is rechecked by protected Pending admission immediately before effect.
      sourceMaterial: 'available', muted: false, exchange: 'open',
    },
    intent: nextTurnNote || params.resumeInactiveSession === false ? 'next_turn' : 'wake',
    returnedAnswer: params.informationDelivery === 'returned_answer',
  }) : undefined;
  const shouldResumeInactiveSession = executionRunRecipient === undefined
    && sessionTarget.rawSession.active !== true
    && params.resumeInactiveSession !== false
    && (receiverDelivery === undefined || receiverDelivery.disposition === 'wake');
  const requestedAction: PendingRequestedActionV1 = resolveSessionUserMessageRequestedAction({
    deliveryIntent: shouldResumeInactiveSession ? 'runtime_bootstrap' : 'ordinary',
    ...(receiverControlled ? { requestedAction: { v: 1, kind: 'enqueue' } as const }
      : params.requestedAction ? { requestedAction: params.requestedAction } : {}),
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

  if (params.canAdmitPendingInput && !(await params.canAdmitPendingInput({
    rawSession: sessionTarget.rawSession,
    metadata: decryptedMetadata,
  }))) {
    return { ok: true, sessionId, localId, waited: false, suppressed: true };
  }

  let enqueueResult: Awaited<ReturnType<typeof enqueuePendingQueueV2MessageViaHttp>>;
  let admissionResult: SessionInputEnqueueResultV1 | undefined;
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
        ...(nextTurnNote ? { nextTurnNote } : {}),
        ...(replyAdmission ? { reply: replyAdmission } : {}),
        ...(protectedAdmission?.request.v === 1 && protectedAdmission.request.followDeliveryV1
          ? { followDeliveryV1: protectedAdmission.request.followDeliveryV1,
            ...(params.followSources ? { followSources: [...params.followSources] } : {}) } : {}),
        ...(protectedAdmission?.request.v === 1 && protectedAdmission.request.followDeliveryV1 && params.followRelations
          ? { followRelations: params.followRelations } : {}),
        ...(requestEqualityEvidenceV1 ? { requestEqualityEvidenceV1 } : {}),
      } satisfies SessionPendingEnqueueByMachineRequestV1 | SessionPendingExecutionRunEnqueueByMachineRequestV2;
      const result = await params.machineAdmissionTransport(machineAdmissionRequest, {
        timeoutMs: params.timeoutMs,
        ...(params.signal ? { signal: params.signal } : {}),
        ...(params.callerInputAuthorization ? { callerInputAuthorization: params.callerInputAuthorization } : {}),
      });
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
      if (result.localId !== localId && result.status === 'alreadyAccepted'
        && protectedAdmission?.request.v === 1 && protectedAdmission.request.followDeliveryV1) {
        // The accepted-input owner rejoined this original's earlier input.
        localId = result.localId;
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
        timeoutMs: params.timeoutMs,
        body: { v: 1, localId, targetMachineId, content, messageRole: 'user', requestedAction,
          ...(replyAdmission ? { reply: replyAdmission } : {}) },
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
        timeoutMs: params.timeoutMs,
        body: content.t === 'encrypted'
          ? {
              localId,
              ciphertext: content.c,
              ...(targetMachineId ? { targetMachineId } : {}),
              messageRole: 'user',
              requestedAction,
              ...(nextTurnNote ? { nextTurnNote } : {}),
              ...(protectedAdmission?.request.v === 1 && protectedAdmission.request.followDeliveryV1 ? {
                followDeliveryV1: protectedAdmission.request.followDeliveryV1,
                ...(params.followSources ? { followSources: [...params.followSources] } : {}),
                ...(params.followRelations ? { followRelations: params.followRelations } : {}),
              } : {}),
              ...(replyAdmission ? { reply: replyAdmission } : {}),
              ...(requestEqualityEvidenceV1 ? { requestEqualityEvidenceV1 } : {}),
              ...(params.pendingAdmissionMode ? { deliveryMode: params.pendingAdmissionMode } : {}),
            }
          : {
              localId,
              content,
              ...(targetMachineId ? { targetMachineId } : {}),
              messageRole: 'user',
              requestedAction,
              ...(nextTurnNote ? { nextTurnNote } : {}),
              ...(protectedAdmission?.request.v === 1 && protectedAdmission.request.followDeliveryV1 ? {
                followDeliveryV1: protectedAdmission.request.followDeliveryV1,
                ...(params.followSources ? { followSources: [...params.followSources] } : {}),
                ...(params.followRelations ? { followRelations: params.followRelations } : {}),
              } : {}),
              ...(replyAdmission ? { reply: replyAdmission } : {}),
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
    if (enqueueResult.didWrite === false && enqueueResult.terminal && enqueueResult.acceptedLocalId
      && protectedAdmission?.request.v === 1 && protectedAdmission.request.followDeliveryV1) {
      localId = enqueueResult.acceptedLocalId;
    }
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

  if (receiverDelivery?.disposition === 'hold' || receiverDelivery?.disposition === 'next_turn') {
    return { ok: true, sessionId, localId, waited: false, admissionResult, receiverDelivery };
  }

  if (shouldResumeInactiveSession) {
    const resumeResult = await requestInactiveSessionResume({
      credentials: params.credentials,
      sessionId,
      localId,
      rawSession: sessionTarget.rawSession,
      ...((params.executionAuthority ?? (receiverControlled ? 'account_automation' : undefined))
        ? { executionAuthority: params.executionAuthority ?? 'account_automation' as const } : {}),
      ...(params.incomingResumeOptions ? { incomingOptions: params.incomingResumeOptions } : {}),
      metadata: decryptedMetadata && typeof decryptedMetadata === 'object' && !Array.isArray(decryptedMetadata)
        ? decryptedMetadata as Record<string, unknown>
        : {},
      timeoutMs: params.timeoutMs,
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.machineResumeTransport
        ? { machineRpcTransport: params.machineResumeTransport }
        : {}),
      ...(params.spawnSession ? { spawnSession: params.spawnSession } : {}),
    });
    if (!resumeResult.ok) {
      if (informationDelivery) {
        return { ok: true, sessionId, localId, waited: false, admissionResult,
          receiverDelivery: { disposition: 'hold', reason: resumeResult.code === 'held_by_person' ? 'explicit_stop' : 'receiver_unavailable' },
          receiverResumeFailure: resumeResult };
      }
      return {
        ok: false,
        code: resumeResult.code === 'SESSION_DIRECTORY_MISSING' ? 'resume_failed' : resumeResult.code,
        message: resumeResult.message,
        ...(admissionResult ? { admissionResult } : {}),
        ...(receiverDelivery ? { receiverDelivery } : {}),
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
        ...(receiverDelivery ? { receiverDelivery } : {}),
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
      ...(receiverDelivery ? { receiverDelivery } : {}),
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
        materializedContent: materialized.content,
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
      materializedContent: materialized.content,
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
