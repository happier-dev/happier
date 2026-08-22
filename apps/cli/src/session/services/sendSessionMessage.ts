import { randomUUID } from 'node:crypto';

import {
  parsePermissionIntentAlias,
  resolvePermissionIntentFromSessionMetadata,
  type PermissionIntent,
} from '@happier-dev/agents';
import {
  readPendingLocalId,
  requiresAuthenticatedMachineAdmissionForSessionInputV1,
  SESSION_MESSAGE_PROVENANCE_META_KEY,
  SessionInputRequestV1Schema,
  SessionMessageProvenanceV1Schema,
  stripSessionInputProtectedMeta,
  withSessionMessageModelSelectionV1,
  type ProviderErrorV1,
  type SessionInputRequestV1,
  type SessionMessageProvenanceV1,
  SessionInputAdmissionRejectionCodeV1Schema,
  SessionCreationCorrespondenceV1Schema,
  type SessionInputAdmissionRejectionCodeV1,
  type SessionInputAdmissionResultV1,
  type SessionPendingEnqueueByMachineRequestV1,
  type PendingRequestedActionV1,
} from '@happier-dev/protocol';

import { fetchEncryptedTranscriptPageAfterSeq } from '@/api/session/fetchEncryptedTranscriptWindow';
import {
  enqueuePendingQueueV2MessageViaHttp,
  listPendingQueueV2DeliveryStatusesFromServer,
  readBlockedPendingQueueV2DeliveryByLocalIdFromServer,
  type PendingQueueDeliveryBlockedReason,
} from '@/api/session/pendingQueueV2Transport';
import {
  waitForTranscriptEncryptedMessageByLocalId,
  type TranscriptMessageLookupResult,
} from '@/api/session/transcriptMessageLookup';
import type { StoredCredentials } from '@/persistence';
import {
  detectSessionTurnActivity,
  isMemoryArtifactDecryptedRow,
  isSessionAgentMessage,
  isSessionUserMessage,
  readSessionProjectedTurnStatus,
  type SessionTurnActivity,
} from '@/session/query/detectSessionTurnInFlight';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { waitForIdleViaSocket } from '@/session/transport/socket/sessionSocketAgentState';
import {
  decryptSessionPayload,
  deriveSessionInputEqualityTagV1,
  encryptSessionPayload,
  tryDecryptSessionOwnerMetadataView,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
  detectSessionTurnLifecycleEvent,
  isBareSessionReadyEvent,
  isSessionTurnCompletionProof,
} from '@/session/shared/sessionTurnLifecycle';

import { resolveSessionTransportContext } from './resolveSessionTransportContext';
import {
  resolveSessionMessageModel,
  type SessionMessageModelSelectionInput,
} from './resolveSessionMessageModel';
import { requestInactiveSessionResume } from './requestInactiveSessionResume';
import { decodeTranscriptBody } from './transcript/transcriptBodyDecoder';

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
      code: 'session_not_found' | 'session_id_ambiguous' | 'session_lookup_timeout' | 'session_archived' | 'session_inactive' | 'unsupported' | 'resume_failed' | 'encryption_material_unavailable' | 'timeout' | 'wait_failed' | 'provider_switch_unsupported' | 'admission_rejected' | 'cancelled';
      candidates?: string[];
      message?: string;
      providerError?: ProviderErrorV1;
      admissionResult?: SessionInputAdmissionResultV1;
    }>;

/**
 * The terminal outcome for one already-admitted Session input. The caller owns
 * its output ceiling so this Session service does not acquire an Automation or
 * other consumer-specific result limit.
 */
export type SessionInputResultV1 =
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'final_text'; text: string }>
  | Readonly<{
      kind: 'terminal_no_result';
      reason: 'missing_final_assistant_text' | 'final_assistant_text_exceeds_utf8_byte_limit';
    }>
  | Readonly<{ kind: 'failed'; message: string }>
  | Readonly<{ kind: 'cancelled'; message: string }>;

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
        | 'invalid_result_text_utf8_byte_limit'
        | 'result_read_failed';
      candidates?: string[];
    }>;

export type WaitForSessionInputResultParams = Readonly<{
  credentials: StoredCredentials;
  idOrPrefix: string;
  localId: string;
  timeoutMs: number;
  maxResultTextUtf8Bytes: number;
}>;

type SendSessionMessageParams = Readonly<{
  credentials: StoredCredentials;
  idOrPrefix: string;
  message: string;
  wait: boolean;
  timeoutMs: number;
  localId?: string;
  resumeInactiveSession?: boolean;
  permissionModeOverride?: string;
  modelSelectionInput?: SessionMessageModelSelectionInput;
  pendingAdmissionMode?: 'continuation_if_no_queued_user_input';
  /** Deployed CLI compatibility only; new action callers pass modelSelectionInput. */
  modelOverride?: string | null;
  signal?: AbortSignal;
  /**
   * Already-sanitized presentation/attachment metadata for this host-built
   * human input. Admission metadata is stripped and recreated below.
   */
  messageMeta?: Record<string, unknown>;
  /** Preserves the existing queue-vs-send semantic at each real entry point. */
  requestedAction?: PendingRequestedActionV1;
  /** Host-built protected facts. Never populated from caller-controlled message metadata. */
  inputAdmission?: Readonly<{
    provenance: SessionMessageProvenanceV1;
    request: SessionInputRequestV1;
  }>;
  /** Authenticated daemon transport. Machine-only assertions never fall back to Account admission. */
  machineAdmissionTransport?: (
    request: SessionPendingEnqueueByMachineRequestV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<SessionInputAdmissionResultV1>;
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

function resolveProtectedInputTargetMachineId(params: Readonly<{
  decryptedMetadata: Record<string, unknown> | null;
  rawSession: Readonly<Record<string, unknown>>;
}>): string | null {
  const correspondence = SessionCreationCorrespondenceV1Schema.safeParse(
    params.decryptedMetadata?.sessionCreationCorrespondenceV1,
  );
  if (correspondence.success) return correspondence.data.recipe.execution.machineId;
  const predecessorMachineId = typeof params.rawSession.machineId === 'string'
    ? params.rawSession.machineId.trim()
    : '';
  return predecessorMachineId || null;
}

/**
 * Equality identifies immutable caller intent, not target-derived defaults.
 * Protected records therefore carry only caller-selected overrides; the
 * current target re-evaluates its Session policy/model when it admits them.
 */
function buildImmutableSessionInputEqualityEnvelopeV1(params: Readonly<{
  localId: string;
  record: Readonly<{
    role: 'user';
    content: Readonly<{ type: 'text'; text: string }>;
    meta: Record<string, unknown>;
  }>;
  pendingAdmissionMode?: 'continuation_if_no_queued_user_input';
}>): Record<string, unknown> {
  return {
    v: 1,
    kind: 'sessionInputRequest',
    localId: params.localId,
    // This is the same immutable plaintext record that would be persisted for
    // a plain Session. It intentionally includes caller presentation metadata
    // and the protected request facts, while target-derived defaults were
    // already excluded when the record was built above.
    content: { t: 'plain', v: params.record },
    ...(params.pendingAdmissionMode ? { pendingAdmissionMode: params.pendingAdmissionMode } : {}),
  };
}

function resolveCanonicalMessageSource(params: Readonly<{
  protectedAdmission: Readonly<{ request: SessionInputRequestV1 }> | null;
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
        if (isSessionUserMessage(row.content.v)) {
          return Math.max(0, row.seq - 1);
        }
        continue;
      }
      try {
        if (!params.ctx) {
          continue;
        }
        if (isSessionUserMessage(decryptSessionPayload({
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.trunc(ms))));
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
  if (!value || isMemoryArtifactDecryptedRow(value) || isSessionUserMessage(value)) {
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
  if (!value || isMemoryArtifactDecryptedRow(value) || isSessionUserMessage(value)) {
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
  | Readonly<{ kind: 'failed'; message: string }>
  | Readonly<{ kind: 'cancelled'; message: string }>;

type AssistantTurnOutcome =
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'completed'; finalAssistantText: string | null }>
  | AssistantTurnFailure;

const ASSISTANT_TURN_SCAN_PAGE_LIMIT = 100;
const CURRENT_PROMPT_DELIVERY_POLL_MS = 250;

type CurrentPromptDeliveryOutcome =
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'materialized'; message: TranscriptMessageLookupResult }>
  | Readonly<{ kind: 'blocked'; reason: PendingQueueDeliveryBlockedReason }>;

function formatBlockedPromptDeliveryFailure(reason: PendingQueueDeliveryBlockedReason): string {
  return `Current turn failed: pending delivery blocked (${reason})`;
}

async function readBlockedPromptDeliveryReason(params: Readonly<{
  token: string;
  sessionId: string;
  localId: string;
}>): Promise<PendingQueueDeliveryBlockedReason | null> {
  try {
    return (await readBlockedPendingQueueV2DeliveryByLocalIdFromServer(params))?.reason ?? null;
  } catch {
    return null;
  }
}

async function waitForCurrentPromptDelivery(params: Readonly<{
  token: string;
  sessionId: string;
  localId: string;
  maxWaitMs: number;
}>): Promise<CurrentPromptDeliveryOutcome> {
  const deadlineMs = Date.now() + Math.max(1, Math.trunc(params.maxWaitMs));

  while (Date.now() <= deadlineMs) {
    const remainingMs = deadlineMs - Date.now();
    const materialized = await waitForTranscriptEncryptedMessageByLocalId({
      token: params.token,
      sessionId: params.sessionId,
      localId: params.localId,
      maxWaitMs: Math.max(1, Math.min(CURRENT_PROMPT_DELIVERY_POLL_MS, remainingMs)),
    });
    if (materialized) {
      return { kind: 'materialized', message: materialized };
    }

    const blockedReason = await readBlockedPromptDeliveryReason(params);
    if (blockedReason) {
      return { kind: 'blocked', reason: blockedReason };
    }
  }

  const blockedReason = await readBlockedPromptDeliveryReason(params);
  if (blockedReason) {
    return { kind: 'blocked', reason: blockedReason };
  }
  return { kind: 'missing' };
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
}>): Promise<Readonly<{
  failure: AssistantTurnFailure | null;
  sawCompletion: boolean;
  finalAssistantText: string | null;
}>> {
  let afterSeq = Math.max(0, Math.trunc(params.materializedSeq) - 1);
  let currentUserSeq = Math.max(0, Math.trunc(params.materializedSeq));
  let observedAgentProgress = false;
  let sawCompletion = false;
  let finalAssistantText: string | null = null;

  while (true) {
    const rows = await fetchEncryptedTranscriptPageAfterSeq({
      token: params.token,
      sessionId: params.sessionId,
      afterSeq,
      limit: ASSISTANT_TURN_SCAN_PAGE_LIMIT,
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
      // The exact input's terminal proof closes this scan. A later user row
      // starts another turn and must not become a fallback result for this
      // input when a legacy transcript lacks an explicit turn anchor.
      if (isSessionUserMessage(decrypted)) {
        return { failure: null, sawCompletion, finalAssistantText };
      }
      const failure = readAssistantTurnFailure(decrypted);
      if (failure) {
        return { failure, sawCompletion, finalAssistantText };
      }
      const decoded = decodeTranscriptBody(decrypted);
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
      return { failure: null, sawCompletion, finalAssistantText };
    }
    const lastRowSeq = orderedRows[orderedRows.length - 1]?.seq ?? null;
    if (!Number.isSafeInteger(lastRowSeq) || lastRowSeq <= afterSeq) {
      return { failure: null, sawCompletion, finalAssistantText };
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
}>): Promise<AssistantTurnOutcome> {
  const scan = await scanAssistantTurnAfterCurrentUserTurn(params);
  if (scan.failure) {
    return scan.failure;
  }
  return scan.sawCompletion
    ? { kind: 'completed', finalAssistantText: scan.finalAssistantText }
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
  maxWaitMs: number;
}>): Promise<AssistantTurnOutcome> {
  const deadlineMs = Date.now() + Math.max(1, Math.trunc(params.maxWaitMs));
  let lastAttempt = false;

  while (Date.now() <= deadlineMs) {
    lastAttempt = true;
    try {
      const outcome = await readAssistantTurnOutcomeAfterCurrentUserTurn(params);
      if (outcome.kind !== 'missing') {
        return outcome;
      }
    } catch {
      // Missing proof is not success. Keep polling until the caller's wait budget expires.
    }

    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(100, remainingMs));
  }

  if (!lastAttempt) {
    return readAssistantTurnOutcomeAfterCurrentUserTurn(params).catch(() => ({ kind: 'missing' }));
  }
  return { kind: 'missing' };
}

function isValidResultTextUtf8ByteLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isWithinResultTextUtf8ByteLimit(text: string, maxBytes: number): boolean {
  return new TextEncoder().encode(text).byteLength <= maxBytes;
}

function resultFromAssistantTurnOutcome(params: Readonly<{
  outcome: AssistantTurnOutcome;
  maxResultTextUtf8Bytes: number;
}>): SessionInputResultV1 {
  if (params.outcome.kind === 'missing') {
    return { kind: 'pending' };
  }
  if (params.outcome.kind === 'failed' || params.outcome.kind === 'cancelled') {
    return params.outcome;
  }
  if (!params.outcome.finalAssistantText) {
    return { kind: 'terminal_no_result', reason: 'missing_final_assistant_text' };
  }
  if (!isWithinResultTextUtf8ByteLimit(
    params.outcome.finalAssistantText,
    params.maxResultTextUtf8Bytes,
  )) {
    return {
      kind: 'terminal_no_result',
      reason: 'final_assistant_text_exceeds_utf8_byte_limit',
    };
  }
  return { kind: 'final_text', text: params.outcome.finalAssistantText };
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
  if (!isValidResultTextUtf8ByteLimit(params.maxResultTextUtf8Bytes)) {
    return { ok: false, code: 'invalid_result_text_utf8_byte_limit' };
  }

  const timeoutMs = Number.isFinite(params.timeoutMs)
    ? Math.max(1, Math.trunc(params.timeoutMs))
    : 1;
  const deadlineMs = Date.now() + timeoutMs;
  const remainingTimeoutMs = () => Math.max(1, deadlineMs - Date.now());

  try {
    const sessionTarget = await resolveSessionTransportContext({
      credentials: params.credentials,
      idOrPrefix: params.idOrPrefix,
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
      maxWaitMs: remainingTimeoutMs(),
    });
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
      return {
        ok: true,
        sessionId: sessionTarget.sessionId,
        localId,
        result: { kind: 'pending' },
      };
    }

    const outcome = await waitForAssistantCompletionAfterCurrentUserTurn({
      token: params.credentials.token,
      sessionId: sessionTarget.sessionId,
      localId,
      materializedSeq: promptDelivery.message.seq,
      ctx: sessionTarget.ctx,
      maxWaitMs: remainingTimeoutMs(),
    });
    return {
      ok: true,
      sessionId: sessionTarget.sessionId,
      localId,
      result: resultFromAssistantTurnOutcome({
        outcome,
        maxResultTextUtf8Bytes: params.maxResultTextUtf8Bytes,
      }),
    };
  } catch {
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
  const decryptedMetadata = tryDecryptSessionOwnerMetadataView({
    credentials: params.credentials,
    rawSession: sessionTarget.rawSession,
    accountEncryptionMode: sessionTarget.accountEncryptionCurrentness.mode,
  });
  const protectedAdmission = params.inputAdmission
    ? {
        provenance: SessionMessageProvenanceV1Schema.parse(params.inputAdmission.provenance),
        request: SessionInputRequestV1Schema.parse(params.inputAdmission.request),
      }
    : null;
  const shouldProjectTargetDefaults = protectedAdmission === null;
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
        // A protected structured override is caller intent. Its timestamp is
        // transport identity, not a fresh target-default resolution.
        nowMs: protectedAdmission !== null && params.modelSelectionInput !== undefined
          ? 0
          : Date.now(),
      })
    : { modelId: '', selection: null };
  const machineOnlyAdmission = protectedAdmission
    ? requiresAuthenticatedMachineAdmissionForSessionInputV1(protectedAdmission.request)
    : false;
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
    meta: modelResolution.selection
      ? withSessionMessageModelSelectionV1(baseMeta, modelResolution.selection)
      : baseMeta,
  } as const;

  const requestedAction: PendingRequestedActionV1 = params.requestedAction
    ?? { v: 1, kind: 'steer_if_active' };
  // An E2EE protected request must carry host-derived terminal equality. The
  // Account route cannot safely carry that assertion, including for ordinary
  // host/UI provenance, so every protected E2EE request uses the authenticated
  // machine admission seam. Plain protected requests retain Account admission
  // unless their facts themselves require machine authentication.
  const requiresMachineAdmission = protectedAdmission !== null
    && (machineOnlyAdmission || sessionTarget.mode === 'e2ee');
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

  const content =
    sessionTarget.mode === 'plain'
      ? ({ t: 'plain', v: record } as const)
      : ({
          t: 'encrypted',
          c: encryptSessionPayload({
            ctx: sessionTarget.ctx,
            payload: record,
          }),
        } as const);

  let enqueueResult: Awaited<ReturnType<typeof enqueuePendingQueueV2MessageViaHttp>>;
  let admissionResult: SessionInputAdmissionResultV1 | undefined;
  let machineAdmissionInvoked = false;
  try {
    if (requiresMachineAdmission) {
      const targetMachineId = resolveProtectedInputTargetMachineId({
        decryptedMetadata,
        rawSession: sessionTarget.rawSession as Readonly<Record<string, unknown>>,
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
        return {
          ok: false,
          code: 'admission_rejected',
          message: 'Protected Session input requires the authenticated machine admission transport',
          admissionResult: {
            status: 'rejected',
            code: 'session_input_target_update_required',
          },
        };
      }
      machineAdmissionInvoked = true;
      const machineAdmissionRequest = {
        v: 1,
        sessionId,
        targetMachineId,
        localId,
        content,
        requestedAction,
        ...(requestEqualityEvidenceV1 ? { requestEqualityEvidenceV1 } : {}),
      } satisfies SessionPendingEnqueueByMachineRequestV1;
      const result = params.signal
        ? await params.machineAdmissionTransport(machineAdmissionRequest, { signal: params.signal })
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
      if (result.status === 'alreadyAccepted') {
        try {
          const pendingStatuses = await listPendingQueueV2DeliveryStatusesFromServer({
            token: params.credentials.token,
            sessionId,
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
    } else {
      enqueueResult = await enqueuePendingQueueV2MessageViaHttp({
        token: params.credentials.token,
        sessionId,
        body: content.t === 'encrypted'
          ? {
              localId,
              ciphertext: content.c,
              messageRole: 'user',
              requestedAction,
              ...(requestEqualityEvidenceV1 ? { requestEqualityEvidenceV1 } : {}),
              ...(params.pendingAdmissionMode ? { deliveryMode: params.pendingAdmissionMode } : {}),
            }
          : {
              localId,
              content,
              messageRole: 'user',
              requestedAction,
              ...(params.pendingAdmissionMode ? { deliveryMode: params.pendingAdmissionMode } : {}),
            },
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
        ...(protectedAdmission
          ? {
              admissionResult: {
                status: 'rejected' as const,
                code: admissionRejectionCode,
              },
            }
          : {}),
      };
    }
    const errorMessage = error instanceof Error ? error.message : String(error ?? '');
    return {
      ok: false,
      code: 'timeout',
      message: status !== null
        ? `Pending enqueue acknowledgement was not confirmed (HTTP ${status})`
        : errorMessage || 'Pending enqueue acknowledgement was not confirmed',
      ...(protectedAdmission
        ? {
            admissionResult: machineAdmissionInvoked
              ? {
                  status: 'outcomeUnknown' as const,
                  localId,
                  code: 'machine_admission_acknowledgement_failed',
                }
              : params.signal?.aborted
                ? { status: 'outcomeUnknown' as const, localId, code: 'account_admission_cancelled_after_request' }
                : { status: 'outcomeUnknown' as const, localId, code: 'account_admission_acknowledgement_failed' },
          }
        : {}),
    };
  }

  if (enqueueResult.didWrite === null) {
    return {
      ok: false,
      code: 'timeout',
      message: 'Pending enqueue returned an invalid admission acknowledgement',
      ...(protectedAdmission
        ? {
            admissionResult: {
              status: 'outcomeUnknown' as const,
              localId,
              code: 'account_admission_result_malformed',
            },
          }
        : {}),
    };
  }

  if (protectedAdmission && !admissionResult) {
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

  if (enqueueResult?.terminal === true) {
    return {
      ok: true,
      sessionId,
      localId,
      waited: false,
      terminal: true,
      ...(admissionResult ? { admissionResult } : {}),
    };
  }

  if (sessionTarget.rawSession.active !== true && params.resumeInactiveSession !== false) {
    const resumeResult = await requestInactiveSessionResume({
      credentials: params.credentials,
      sessionId,
      localId,
      rawSession: sessionTarget.rawSession,
      metadata: decryptedMetadata && typeof decryptedMetadata === 'object' && !Array.isArray(decryptedMetadata)
        ? decryptedMetadata as Record<string, unknown>
        : {},
      timeoutMs: params.timeoutMs,
    });
    if (!resumeResult.ok) {
      return {
        ok: false,
        code: resumeResult.code,
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

  const deadlineMs = Date.now() + params.timeoutMs;
  const remainingTimeoutMs = () => Math.max(1, deadlineMs - Date.now());
  let waitSessionSnapshot = sessionTarget.rawSession;
  let currentTurnAfterSeqExclusive: number | null = null;

  try {
    const promptDelivery = await waitForCurrentPromptDelivery({
      token: params.credentials.token,
      sessionId,
      localId,
      maxWaitMs: remainingTimeoutMs(),
    });
    if (promptDelivery.kind === 'blocked') {
      return {
        ok: false,
        code: 'wait_failed',
        message: formatBlockedPromptDeliveryFailure(promptDelivery.reason),
        ...(admissionResult ? { admissionResult } : {}),
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

    currentTurnAfterSeqExclusive = await resolveCurrentTurnAfterSeqExclusive({
      token: params.credentials.token,
      sessionId,
      localId,
      materializedSeq: materialized.seq,
      ctx: sessionTarget.ctx,
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
      maxWaitMs: remainingTimeoutMs(),
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
