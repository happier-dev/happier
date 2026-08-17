import { randomUUID } from 'node:crypto';

import {
  parsePermissionIntentAlias,
  resolveMetadataStringOverrideV1,
  resolvePermissionIntentFromSessionMetadata,
  type PermissionIntent,
} from '@happier-dev/agents';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readPendingLocalId, type PendingRequestedActionV1 } from '@happier-dev/protocol';

import { fetchEncryptedTranscriptPageAfterSeq } from '@/api/session/fetchEncryptedTranscriptWindow';
import {
  type PendingQueueDeliveryBlockedReason,
  readBlockedPendingQueueV2DeliveryByLocalIdFromServer,
} from '@/api/session/pendingQueueV2Transport';
import { admitSessionUserMessageToPendingQueue } from './admitSessionUserMessage';
import {
  waitForTranscriptEncryptedMessageByLocalId,
  type TranscriptMessageLookupResult,
} from '@/api/session/transcriptMessageLookup';
import type { Credentials } from '@/persistence';
import {
  detectSessionTurnActivity,
  isMemoryArtifactDecryptedRow,
  isSessionUserMessage,
  type SessionTurnActivity,
} from '@/session/query/detectSessionTurnInFlight';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { waitForIdleViaSocket } from '@/session/transport/socket/sessionSocketAgentState';
import {
  decryptSessionPayload,
  tryDecryptSessionMetadata,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
  detectSessionTurnLifecycleEvent,
  isSessionTurnCompletionProof,
} from '@/session/shared/sessionTurnLifecycle';

import { resolveSessionTransportContext } from './resolveSessionTransportContext';
import { requestInactiveSessionResume } from './requestInactiveSessionResume';

export type SendSessionMessageResult =
  | Readonly<{ ok: true; sessionId: string; localId: string; waited: boolean; suppressed?: true }>
  | Readonly<{
      ok: false;
      code: 'session_not_found' | 'session_id_ambiguous' | 'session_lookup_timeout' | 'session_archived' | 'unsupported' | 'timeout' | 'wait_failed';
      candidates?: string[];
      message?: string;
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

function resolveModelId(params: Readonly<{
  modelOverride?: string | null;
  decryptedMetadata: unknown;
}>): string {
  if (params.modelOverride !== undefined) {
    return params.modelOverride ?? 'default';
  }
  const resolved = resolveMetadataStringOverrideV1(params.decryptedMetadata, 'modelOverrideV1', 'modelId');
  return resolved?.value ?? '';
}

function unknownCurrentUserTurnActivity(): SessionTurnActivity {
  return {
    pendingUserTurns: 1,
    activeTaskInFlight: false,
    turnInFlight: true,
  };
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

function readTranscriptLifecycleIssuePreview(value: unknown): string | null {
  const record = asRecord(value);
  const content = asRecord(record?.content);
  const data = asRecord(content?.data);
  return readStructuredIssuePreview(data?.issue);
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
    return formatStructuredTurnFailureMessage('failed', readTranscriptLifecycleIssuePreview(value));
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
  currentUserCreatedAt: number;
}>): string | null {
  const record = asRecord(params.session);
  if (!record) return null;
  const latestTurnStatus = record.latestTurnStatus;
  if (latestTurnStatus !== 'failed' && latestTurnStatus !== 'cancelled') {
    return null;
  }
  const observedAt = readNonnegativeInteger(record.latestTurnStatusObservedAt);
  if (observedAt === null || observedAt < params.currentUserCreatedAt) {
    return null;
  }
  return formatStructuredTurnFailureMessage(
    latestTurnStatus,
    readStructuredIssuePreview(record.lastRuntimeIssue),
  );
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

type AssistantTurnOutcome =
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'completed' }>
  | Readonly<{ kind: 'failed'; message: string }>;

type CurrentPromptDeliveryOutcome =
  | Readonly<{ kind: 'materialized'; message: TranscriptMessageLookupResult }>
  | Readonly<{ kind: 'blocked'; reason: PendingQueueDeliveryBlockedReason }>
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'missing' }>;

const CURRENT_PROMPT_DELIVERY_POLL_MS = 250;

function formatBlockedPromptDeliveryFailure(reason: PendingQueueDeliveryBlockedReason): string {
  return `Current turn failed: pending delivery blocked (${reason})`;
}

async function readBlockedPromptDeliveryReason(params: Readonly<{
  token: string;
  sessionId: string;
  localId: string;
}>): Promise<
  | Readonly<{ kind: 'available'; reason: PendingQueueDeliveryBlockedReason | null }>
  | Readonly<{ kind: 'unavailable' }>
> {
  try {
    const blocked = await readBlockedPendingQueueV2DeliveryByLocalIdFromServer({
      token: params.token,
      sessionId: params.sessionId,
      localId: params.localId,
    });
    return { kind: 'available', reason: blocked?.reason ?? null };
  } catch {
    return { kind: 'unavailable' };
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

    const blockedProjection = await readBlockedPromptDeliveryReason(params);
    if (blockedProjection.kind === 'available' && blockedProjection.reason) {
      return { kind: 'blocked', reason: blockedProjection.reason };
    }
  }

  const blockedProjection = await readBlockedPromptDeliveryReason(params);
  if (blockedProjection.kind === 'unavailable') {
    return { kind: 'unavailable' };
  }
  if (blockedProjection.reason) {
    return { kind: 'blocked', reason: blockedProjection.reason };
  }
  return { kind: 'missing' };
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
  const afterSeq = Math.max(0, Math.trunc(params.materializedSeq) - 1);
  const rows = await fetchEncryptedTranscriptPageAfterSeq({
    token: params.token,
    sessionId: params.sessionId,
    afterSeq,
    limit: 100,
  });
  const orderedRows = [...rows].sort((a, b) => a.seq - b.seq);
  const currentUserSeq = orderedRows.find((row) => row.localId === params.localId)?.seq ?? params.materializedSeq;
  let sawCompletion = false;

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
      return { kind: 'failed', message: failure };
    }
    if (isAssistantTurnCompletionProof(decrypted)) {
      sawCompletion = true;
    }
  }

  return sawCompletion ? { kind: 'completed' } : { kind: 'missing' };
}

async function waitForAssistantOutcomeAfterCurrentUserTurn(params: Readonly<{
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
    return readAssistantTurnOutcomeAfterCurrentUserTurn(params)
      .catch((): AssistantTurnOutcome => ({ kind: 'missing' }));
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
  modelOverride?: string | null;
  requestedAction?: PendingRequestedActionV1;
  pendingAdmissionMode?: 'continuation_if_no_queued_user_input';
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
    return { ok: false, code: 'session_archived' };
  }

  if (params.localId !== undefined && readPendingLocalId(params.localId) === null) {
    throw new Error('Pending localId must not be blank');
  }
  const localId = readPendingLocalId(params.localId) ?? randomUUID();
  const decryptedMetadata = tryDecryptSessionMetadata({
    credentials: params.credentials,
    rawSession: sessionTarget.rawSession,
  });
  const permissionIntent = resolvePermissionIntent({
    permissionModeOverride: params.permissionModeOverride,
    decryptedMetadata,
  });
  const modelId = resolveModelId({
    modelOverride: params.modelOverride,
    decryptedMetadata,
  });

  const shouldUseRuntimeRpc = sessionTarget.rawSession.active === true;
  const admission = await admitSessionUserMessageToPendingQueue({
    credentials: params.credentials,
    sessionId,
    mode: sessionTarget.mode,
    ctx: sessionTarget.ctx,
    localId,
    text: params.message,
    permissionIntent,
    modelId,
    ...(params.requestedAction ? { requestedAction: params.requestedAction } : {}),
    ...(params.pendingAdmissionMode ? { pendingAdmissionMode: params.pendingAdmissionMode } : {}),
  });

  if (admission.status === 'unconfirmed') {
    return {
      ok: false,
      code: 'timeout',
      message: admission.message,
    };
  }

  if (admission.status === 'suppressed') {
    return { ok: true, sessionId, localId, waited: false, suppressed: true };
  }

  // The server found this exact localId in the terminal transcript. Starting
  // an inactive runtime now would create work without pending custody.
  if (admission.status === 'already_terminal') {
    return { ok: true, sessionId, localId, waited: false };
  }

  if (!shouldUseRuntimeRpc && params.resumeInactiveSession !== false) {
    const resumeResult = await requestInactiveSessionResume({
      credentials: params.credentials,
      sessionId,
      localId,
      rawSession: sessionTarget.rawSession,
      metadata: asRecord(decryptedMetadata) ?? {},
      timeoutMs: params.timeoutMs,
    });
    if (resumeResult.ok) {
      if (!params.wait) {
        return {
          ok: true,
          sessionId,
          localId,
          waited: false,
        };
      }
      // The common wait path below observes exact materialization and terminal
      // evidence; resume acknowledgement alone is never provider acceptance.
    } else {
      return {
        ok: false,
        code: resumeResult.code,
        message: resumeResult.message,
      };
    }
  }

  if (shouldUseRuntimeRpc) {
    // The enqueue event is the durable wake. This direct nudge only reduces latency when the
    // runner is already connected; failure cannot revoke or bypass the canonical Pending row.
    await callSessionRpc({
      token: params.credentials.token,
      sessionId,
      mode: sessionTarget.mode,
      ctx: sessionTarget.ctx,
      method: `${sessionId}:${SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_V1}`,
      request: { protocolVersion: 1 },
      timeoutMs: Math.min(5_000, params.timeoutMs),
    }).catch(() => undefined);
  }

  if (!params.wait) {
    return {
      ok: true,
      sessionId: sessionId,
      localId,
      waited: false,
    };
  }

  const deadlineMs = Date.now() + params.timeoutMs;
  let waitSessionSnapshot = sessionTarget.rawSession;
  let currentTurnAfterSeqExclusive: number | null = null;

  try {
    const promptDelivery = await waitForCurrentPromptDelivery({
      token: params.credentials.token,
      sessionId: sessionId,
      localId,
      maxWaitMs: Math.max(1, deadlineMs - Date.now()),
    });
    if (promptDelivery.kind === 'blocked') {
      return {
        ok: false,
        code: 'wait_failed',
        message: formatBlockedPromptDeliveryFailure(promptDelivery.reason),
      };
    }
    if (promptDelivery.kind === 'unavailable') {
      return {
        ok: false,
        code: 'wait_failed',
      };
    }
    if (promptDelivery.kind !== 'materialized') {
      return {
        ok: false,
        code: 'timeout',
      };
    }
    const materialized = promptDelivery.message;

    try {
      const refreshedSession = await fetchSessionById({
        token: params.credentials.token,
        sessionId: sessionId,
      });
      if (!refreshedSession) {
        throw new Error('Session not found after send');
      }
      waitSessionSnapshot = refreshedSession;
    } catch {
      waitSessionSnapshot = sessionTarget.rawSession;
    }
    currentTurnAfterSeqExclusive = await resolveCurrentTurnAfterSeqExclusive({
      token: params.credentials.token,
      sessionId: sessionId,
      localId,
      materializedSeq: materialized.seq,
      ctx: sessionTarget.ctx,
    });

    let initialTurnActivityRequiresTranscriptIdleEvidence = false;
    let initialTurnActivity: SessionTurnActivity;
    try {
      initialTurnActivity = await detectSessionTurnActivity({
        token: params.credentials.token,
        sessionId: sessionId,
        encryptionMode: sessionTarget.mode,
        encryptionKey: sessionTarget.ctx.encryptionKey,
        encryptionVariant: sessionTarget.ctx.encryptionVariant,
        ...(typeof currentTurnAfterSeqExclusive === 'number' ? { afterSeqExclusive: currentTurnAfterSeqExclusive } : {}),
      });
    } catch {
      initialTurnActivity = unknownCurrentUserTurnActivity();
      initialTurnActivityRequiresTranscriptIdleEvidence = true;
    }

    const agentStateCiphertext =
      typeof waitSessionSnapshot.agentState === 'string' ? String(waitSessionSnapshot.agentState).trim() : null;

    await waitForIdleViaSocket({
      token: params.credentials.token,
      sessionId: sessionId,
      ctx: sessionTarget.ctx,
      sessionEncryptionMode: sessionTarget.mode,
      timeoutMs: Math.max(1, deadlineMs - Date.now()),
      initialTurnActivity,
      initialTurnActivityRequiresTranscriptIdleEvidence,
      recheckTurnActivity: async () =>
        detectSessionTurnActivity({
          token: params.credentials.token,
          sessionId: sessionId,
          encryptionMode: sessionTarget.mode,
          encryptionKey: sessionTarget.ctx.encryptionKey,
          encryptionVariant: sessionTarget.ctx.encryptionVariant,
          ...(typeof currentTurnAfterSeqExclusive === 'number' ? { afterSeqExclusive: currentTurnAfterSeqExclusive } : {}),
        }),
      initialAgentStateCiphertextBase64:
        agentStateCiphertext && agentStateCiphertext.length > 0 ? agentStateCiphertext : null,
    });
    let finalSessionSnapshot = waitSessionSnapshot;
    try {
      const refreshedSession = await fetchSessionById({
        token: params.credentials.token,
        sessionId: sessionId,
      });
      if (refreshedSession) {
        finalSessionSnapshot = refreshedSession;
      }
    } catch {
      finalSessionSnapshot = waitSessionSnapshot;
    }
    const projectedFailure = readProjectedCurrentTurnFailure({
      session: finalSessionSnapshot,
      currentUserCreatedAt: materialized.createdAt,
    });
    if (projectedFailure) {
      return {
        ok: false,
        code: 'wait_failed',
        message: projectedFailure,
      };
    }
    const assistantTurnOutcomeParams = {
      token: params.credentials.token,
      sessionId: sessionId,
      localId,
      materializedSeq: materialized.seq,
      ctx: sessionTarget.ctx,
    };
    const initialAssistantTurnOutcome = await readAssistantTurnOutcomeAfterCurrentUserTurn(assistantTurnOutcomeParams)
      .catch((): AssistantTurnOutcome => ({ kind: 'missing' }));
    if (initialAssistantTurnOutcome.kind === 'failed') {
      return {
        ok: false,
        code: 'wait_failed',
        message: initialAssistantTurnOutcome.message,
      };
    }
    if (initialAssistantTurnOutcome.kind === 'completed') {
      return {
        ok: true,
        sessionId: sessionId,
        localId,
        waited: true,
      };
    }
    const assistantTurnOutcome = await waitForAssistantOutcomeAfterCurrentUserTurn({
      ...assistantTurnOutcomeParams,
      maxWaitMs: Math.max(1, deadlineMs - Date.now()),
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
      sessionId: sessionId,
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
