import { randomUUID } from 'node:crypto';

import {
  parsePermissionIntentAlias,
  resolvePermissionIntentFromSessionMetadata,
  type PermissionIntent,
} from '@happier-dev/agents';
import {
  readPendingLocalId,
  withSessionMessageModelSelectionV1,
  type ProviderErrorV1,
} from '@happier-dev/protocol';

import { fetchEncryptedTranscriptPageAfterSeq } from '@/api/session/fetchEncryptedTranscriptWindow';
import {
  enqueuePendingQueueV2MessageViaHttp,
  readBlockedPendingQueueV2DeliveryByLocalIdFromServer,
  type PendingQueueDeliveryBlockedReason,
} from '@/api/session/pendingQueueV2Transport';
import {
  waitForTranscriptEncryptedMessageByLocalId,
  type TranscriptMessageLookupResult,
} from '@/api/session/transcriptMessageLookup';
import type { Credentials } from '@/persistence';
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

export type SendSessionMessageResult =
  | Readonly<{ ok: true; sessionId: string; localId: string; waited: boolean; suppressed?: true }>
  | Readonly<{
      ok: false;
      code: 'session_not_found' | 'session_id_ambiguous' | 'session_archived' | 'session_inactive' | 'unsupported' | 'timeout' | 'wait_failed' | 'provider_switch_unsupported';
      candidates?: string[];
      message?: string;
      providerError?: ProviderErrorV1;
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

async function resolveCurrentTurnAfterSeqExclusive(params: Readonly<{
  token: string;
  sessionId: string;
  localId: string;
  materializedSeq: number;
  ctx: Readonly<{
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
  }>;
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
  }>;
}>): unknown | null {
  if (params.content.t === 'plain') {
    return params.content.v;
  }
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

function readAssistantTurnFailure(value: unknown): string | null {
  if (!value || isMemoryArtifactDecryptedRow(value) || isSessionUserMessage(value)) {
    return null;
  }
  const lifecycleEvent = detectSessionTurnLifecycleEvent(value);
  if (lifecycleEvent === 'turn_failed') {
    return formatStructuredTurnFailureMessage('failed');
  }
  if (lifecycleEvent === 'turn_cancelled') {
    return formatStructuredTurnFailureMessage('cancelled');
  }
  if (lifecycleEvent === 'turn_aborted') {
    return formatStructuredTurnFailureMessage('aborted');
  }
  if (hasTranscriptRuntimeIssue(value)) {
    return formatStructuredTurnFailureMessage('failed', readTranscriptRuntimeIssuePreview(value));
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

type AssistantTurnOutcome =
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'completed' }>
  | Readonly<{ kind: 'failed'; message: string }>;

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
  }>;
}>): Promise<Readonly<{
  failure: string | null;
  sawCompletion: boolean;
}>> {
  let afterSeq = Math.max(0, Math.trunc(params.materializedSeq) - 1);
  let currentUserSeq = Math.max(0, Math.trunc(params.materializedSeq));
  let observedAgentProgress = false;
  let sawCompletion = false;

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
      const failure = readAssistantTurnFailure(decrypted);
      if (failure) {
        return { failure, sawCompletion };
      }
      if (isAssistantTurnCompletionProof(decrypted)) {
        sawCompletion = true;
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
      return { failure: null, sawCompletion };
    }
    const lastRowSeq = orderedRows[orderedRows.length - 1]?.seq ?? null;
    if (!Number.isSafeInteger(lastRowSeq) || lastRowSeq <= afterSeq) {
      return { failure: null, sawCompletion };
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
  }>;
}>): Promise<AssistantTurnOutcome> {
  const scan = await scanAssistantTurnAfterCurrentUserTurn(params);
  if (scan.failure) {
    return { kind: 'failed', message: scan.failure };
  }
  return scan.sawCompletion ? { kind: 'completed' } : { kind: 'missing' };
}

async function findAssistantFailureAfterCurrentUserTurn(params: Readonly<{
  token: string;
  sessionId: string;
  localId: string;
  materializedSeq: number;
  ctx: Readonly<{
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
  }>;
}>): Promise<string | null> {
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
  }>;
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

export async function sendSessionMessage(params: Readonly<{
  credentials: Credentials;
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
}>): Promise<SendSessionMessageResult> {
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
  const sessionId = sessionTarget.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('Resolved session transport context is missing session id');
  }
  const archivedAt = (sessionTarget.rawSession as { archivedAt?: unknown }).archivedAt;
  if (archivedAt !== null && archivedAt !== undefined) {
    return {
      ok: false,
      code: 'session_archived',
    };
  }
  if (params.localId !== undefined && readPendingLocalId(params.localId) === null) {
    throw new Error('Pending localId must not be blank');
  }
  const localId = readPendingLocalId(params.localId) ?? randomUUID();
  const decryptedMetadata = tryDecryptSessionOwnerMetadataView({
    credentials: params.credentials,
    rawSession: sessionTarget.rawSession,
  });
  const permissionIntent = resolvePermissionIntent({
    permissionModeOverride: params.permissionModeOverride,
    decryptedMetadata,
  });
  const modelResolution = resolveSessionMessageModel({
    metadata: decryptedMetadata,
    sessionActive: sessionTarget.rawSession.active === true,
    ...(params.modelSelectionInput !== undefined
      ? { modelSelectionInput: params.modelSelectionInput }
      : params.modelOverride !== undefined
        ? { legacyModelOverride: params.modelOverride }
        : {}),
    nowMs: Date.now(),
  });

  const baseMeta = {
    sentFrom: 'cli',
    // Important: `source: 'cli'` is reserved for CLI-authored transcript traffic that
    // the running agent runtime should treat as "self-sent" (e.g. local provider echoes).
    // A `happier session send` prompt is user intent and must be delivered to the runtime
    // queue even when it is committed by the daemon via session RPC.
    source: 'ui',
    permissionMode: permissionIntent,
    ...(modelResolution.modelId ? { model: modelResolution.modelId } : {}),
  } as const;
  const record = {
    role: 'user',
    content: { type: 'text', text: params.message },
    meta: modelResolution.selection
      ? withSessionMessageModelSelectionV1(baseMeta, modelResolution.selection)
      : baseMeta,
  } as const;

  const content =
    sessionTarget.mode === 'plain'
      ? ({ t: 'plain', v: record } as const)
      : ({
          t: 'encrypted',
          c: encryptSessionPayload({
            ctx: sessionTarget.ctx,
            payload: record,
            ...(params.pendingAdmissionMode ? { idempotencyKey: localId } : {}),
          }),
        } as const);

  let enqueueResult: Awaited<ReturnType<typeof enqueuePendingQueueV2MessageViaHttp>>;
  try {
    enqueueResult = await enqueuePendingQueueV2MessageViaHttp({
      token: params.credentials.token,
      sessionId,
      body: content.t === 'encrypted'
        ? {
            localId,
            ciphertext: content.c,
            messageRole: 'user',
            requestedAction: { v: 1, kind: 'send_now' },
            ...(params.pendingAdmissionMode ? { deliveryMode: params.pendingAdmissionMode } : {}),
          }
        : {
            localId,
            content,
            messageRole: 'user',
            requestedAction: { v: 1, kind: 'send_now' },
            ...(params.pendingAdmissionMode ? { deliveryMode: params.pendingAdmissionMode } : {}),
          },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error ?? '');
    return { ok: false, code: 'timeout', message: errorMessage || 'Pending enqueue acknowledgement was not confirmed' };
  }

  if (enqueueResult?.suppressed === true) {
    return { ok: true, sessionId, localId, waited: false, suppressed: true };
  }

  if (enqueueResult?.terminal === true) {
    return { ok: true, sessionId, localId, waited: false };
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
      return { ok: false, code: resumeResult.code, message: resumeResult.message };
    }
    if (!params.wait) return { ok: true, sessionId, localId, waited: false };
  }

  if (!params.wait) {
    return {
      ok: true,
      sessionId,
      localId,
      waited: false,
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
      };
    }
    if (promptDelivery.kind === 'missing') {
      return {
        ok: false,
        code: 'timeout',
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
          encryptionKey: sessionTarget.ctx.encryptionKey,
          encryptionVariant: sessionTarget.ctx.encryptionVariant,
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
          encryptionKey: sessionTarget.ctx.encryptionKey,
          encryptionVariant: sessionTarget.ctx.encryptionVariant,
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
        message: transcriptFailure,
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
    if (assistantTurnOutcome.kind === 'failed') {
      return {
        ok: false,
        code: 'wait_failed',
        message: assistantTurnOutcome.message,
      };
    }
    if (assistantTurnOutcome.kind !== 'completed') {
      return {
        ok: false,
        code: 'timeout',
      };
    }
    return {
      ok: true,
      sessionId,
      localId,
      waited: true,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error ?? '');
    if (errorMessage === 'timeout') {
      return {
        ok: false,
        code: 'timeout',
      };
    }
    return {
      ok: false,
      code: 'wait_failed',
      message: errorMessage || 'Wait for idle failed',
    };
  }
}
