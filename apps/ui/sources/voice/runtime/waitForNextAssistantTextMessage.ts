import { storage } from '@/sync/domains/state/storage';
import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import type { Message } from '@/sync/domains/messages/messageTypes';
import {
  deriveSessionRuntimePresentationState,
  isTerminalPrimaryTurnStatus,
} from '@/sync/domains/session/attention/deriveSessionRuntimePresentationState';
import type { Session } from '@/sync/domains/state/storageTypes';
import { settleReceivedSessionMessages } from '@/sync/engine/sessions/sessionMessageMaterializationBarrier';

/**
 * Legacy turn-projection fields captured at baseline. Producers with transcript anchors instead
 * bind the submitted input to its own turn, which may already be running at baseline.
 */
type SessionTurnMarker = Readonly<{
  latestTurnId: string | null;
  latestTurnStatus: string | null;
  latestTurnStatusObservedAt: number | null;
}>;

export type AssistantTextMessageBaseline = Readonly<{
  baselineIds: Set<string>;
  baselineCount: number;
}>;

export type SessionTurnBaseline = AssistantTextMessageBaseline & Readonly<{
  turnMarker: SessionTurnMarker | null;
}>;

function getSessionMessages(sessionId: string): Message[] {
  return readStoredSessionMessages(storage.getState(), sessionId);
}

function getSession(sessionId: string): Session | null {
  return storage.getState().sessions[sessionId] ?? null;
}

function readSessionTurnMarker(session: Session | null): SessionTurnMarker | null {
  if (!session) return null;
  return {
    latestTurnId: session.latestTurnId ?? null,
    latestTurnStatus: session.latestTurnStatus ?? null,
    latestTurnStatusObservedAt: session.latestTurnStatusObservedAt ?? null,
  };
}

function isSessionTurnWorking(session: Session): boolean {
  return deriveSessionRuntimePresentationState({
    active: session.active,
    activeAt: session.activeAt,
    archivedAt: session.archivedAt,
    presence: session.presence,
    thinking: session.thinking,
    thinkingAt: session.thinkingAt,
    latestTurnStatus: session.latestTurnStatus,
    latestTurnStatusObservedAt: session.latestTurnStatusObservedAt,
  }, Date.now()).working;
}

export function captureAssistantTextMessageBaseline(sessionId: string): AssistantTextMessageBaseline {
  const messages = getSessionMessages(sessionId);
  return {
    baselineCount: messages.length,
    baselineIds: new Set<string>(
      messages
        .map((message) => message.id),
    ),
  };
}

/** Baseline for waiting on the session turn started after this point (messages + turn lifecycle). */
export function captureSessionTurnBaseline(sessionId: string): SessionTurnBaseline {
  return {
    ...captureAssistantTextMessageBaseline(sessionId),
    turnMarker: readSessionTurnMarker(getSession(sessionId)),
  };
}

function readAssistantReplyText(message: Message | undefined): string | null {
  if (message?.kind !== 'agent-text' || message.peer || message.isThinking === true
    || typeof message.text !== 'string') return null;
  return message.text.trim() || null;
}

/** Assistant reply texts after the baseline, excluding thinking and peer input. */
export function collectAssistantTextMessagesSinceBaseline(
  sessionId: string,
  baselineIds: Set<string>,
  baselineCount: number,
): string[] {
  const messages = getSessionMessages(sessionId);
  const startIndex = messages.length >= baselineCount ? baselineCount : 0;
  const out: string[] = [];
  for (let idx = startIndex; idx < messages.length; idx += 1) {
    const message = messages[idx];
    if (typeof message?.id === 'string' && baselineIds.has(message.id)) continue;
    const text = readAssistantReplyText(message);
    if (text) out.push(text);
  }
  return out;
}

type StorageConditionResult = Readonly<{ done: false }> | Readonly<{ done: true; value: string | null }>;

function waitForStorageCondition(
  evaluate: () => StorageConditionResult,
  opts: Readonly<{ timeoutMs?: number; signal?: AbortSignal }>,
): Promise<string | null> {
  const { signal } = opts;
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: null | (() => void) = null;
    const abortListener = () => done(null);

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      timeout = null;
      try {
        unsubscribe?.();
      } catch {
        // Best-effort cleanup; ignore unsubscribe errors.
      }
      unsubscribe = null;
      signal?.removeEventListener('abort', abortListener);
    };

    function done(value: string | null) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }

    const check = () => {
      try {
        const result = evaluate();
        if (result.done) done(result.value);
      } catch {
        done(null);
      }
    };

    if (typeof opts.timeoutMs === 'number') {
      timeout = setTimeout(() => done(null), opts.timeoutMs);
    }
    signal?.addEventListener('abort', abortListener, { once: true });
    try {
      unsubscribe = storage.subscribe(check);
    } catch {
      done(null);
      return;
    }
    check();
  });
}

export async function waitForNextAssistantTextMessage(
  sessionId: string,
  baselineIds: Set<string>,
  baselineCount: number,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string | null> {
  return await waitForStorageCondition(() => {
    const matches = collectAssistantTextMessagesSinceBaseline(sessionId, baselineIds, baselineCount);
    return matches.length > 0 ? { done: true, value: matches[0] ?? null } : { done: false };
  }, { timeoutMs, signal });
}

/**
 * The reply to speak for a turn: every non-thinking assistant text after the last tool call or user
 * message, in order. Earlier texts are progress narration before tool work, or replies to an earlier
 * user message (the turn our message started begins after it), not the answer.
 */
type SubmittedReplyBoundary = Readonly<{ localId: string; endSeqInclusive?: number | null }>;

export function collectFinalAssistantReplySinceBaseline(
  sessionId: string,
  baseline: AssistantTextMessageBaseline,
  submitted?: SubmittedReplyBoundary,
): string | null {
  const messages = getSessionMessages(sessionId);
  const submittedIndex = submitted
    ? messages.findIndex((message) => message.kind === 'user-text' && message.localId === submitted.localId)
    : -1;
  if (submitted && submittedIndex < 0) return null;
  const startIndex = submitted
    ? submittedIndex + 1
    : messages.length >= baseline.baselineCount ? baseline.baselineCount : 0;
  const submittedSeq = submittedIndex >= 0 ? messages[submittedIndex]?.seq : undefined;
  let trailing: string[] = [];
  let beforePeer: string[] = [];
  for (let idx = startIndex; idx < messages.length; idx += 1) {
    const message = messages[idx];
    if (typeof submitted?.endSeqInclusive === 'number' && (
      typeof message.seq !== 'number'
      || message.seq > submitted.endSeqInclusive
      || (typeof submittedSeq === 'number' && message.seq <= submittedSeq)
    )) continue;
    if (typeof message?.id === 'string' && baseline.baselineIds.has(message.id)) continue;
    if (message?.kind === 'tool-call' || message?.kind === 'user-text') {
      trailing = [];
      beforePeer = [];
      continue;
    }
    // Peer input is never spoken. Keep the prior answer if no later reply replaces it.
    if (message?.kind === 'agent-text' && message.peer) {
      if (trailing.length > 0) beforePeer = trailing;
      trailing = [];
      continue;
    }
    const text = readAssistantReplyText(message);
    if (text) trailing.push(text);
  }
  const reply = trailing.length > 0 ? trailing : beforePeer;
  return reply.length > 0 ? reply.join('\n\n') : null;
}

function hasTurnProjection(marker: SessionTurnMarker | null): boolean {
  return marker !== null && (marker.latestTurnId !== null || marker.latestTurnStatus !== null);
}

/**
 * Resolves with the final assistant reply of the turn started after `baseline`.
 *
 * Input transcript anchors bind the submitted message to its actual turn, including steering into
 * a turn already running at baseline. A different client's latest turn never supplies this binding.
 * Producers without input anchors retain the historical latest-turn/working compatibility path.
 * With that legacy session turn projection, the turn has ended when a terminal `latestTurnStatus` is
 * reported for a turn other than the one current at baseline. Sessions from producers without the
 * projection fall back to the canonical runtime `working` signal (observed working, then idle).
 * Before reading the reply, messages this client already received are settled through the
 * materialization barrier, because the socket apply coalescer may still hold the final text when
 * the turn status (applied immediately) lands. The wait is bounded only by the turn lifecycle and
 * the caller's abort signal. Without a session record the latest reply is used as-is.
 */
export async function waitForTurnFinalAssistantText(params: Readonly<{
  sessionId: string;
  baseline: SessionTurnBaseline;
  signal?: AbortSignal;
  submittedUserLocalId?: string;
}>): Promise<string | null> {
  const { sessionId, baseline, signal, submittedUserLocalId } = params;
  let sawWorking = false;
  let submittedReply: SubmittedReplyBoundary | undefined;
  const ended = await waitForStorageCondition(() => {
    const session = getSession(sessionId);
    if (submittedUserLocalId) {
      const submitted = getSessionMessages(sessionId).find((message) => message.kind === 'user-text' && message.localId === submittedUserLocalId);
      // Submission acknowledgement and transcript materialization are independent. Do not speak
      // another client's reply while our admitted input is still pending or being materialized.
      if (!submitted) return { done: false };
      const turns = session?.sessionTurns?.turns ?? [];
      const submittedSeq = submitted.seq;
      const boundTurn = typeof submittedSeq === 'number' ? turns.find((turn) => (
        turn.transcriptAnchors?.startUserMessageSeq === submittedSeq
        || turn.transcriptAnchors?.userMessageSeqs?.includes(submittedSeq)
      )) : undefined;
      if (boundTurn) {
        if (!isTerminalPrimaryTurnStatus(boundTurn.status)) return { done: false };
        const endSeqInclusive = boundTurn.transcriptAnchors?.endSeqInclusive;
        // Codex publishes completion before its final transcript anchors. A terminal status
        // alone cannot bound the reply; cancellation/failure may never publish an end anchor.
        if (typeof endSeqInclusive !== 'number') {
          return boundTurn.status === 'completed' ? { done: false } : { done: true, value: null };
        }
        submittedReply = { localId: submittedUserLocalId, endSeqInclusive };
        return { done: true, value: 'ended' };
      }
      if (session?.sessionTurns && session.latestTurnId
        && session.sessionTurns.latestTurnId !== session.latestTurnId) {
        return { done: false };
      }
      const latestTurn = turns.find(turn => turn.turnId === session?.latestTurnId);
      // A session can change producers. Historical input anchors do not establish support
      // in the current producer; its latest turn owns that compatibility decision.
      if (latestTurn?.transcriptAnchors?.startUserMessageSeq !== undefined || Boolean(latestTurn?.transcriptAnchors?.userMessageSeqs?.length)) {
        return { done: false };
      }
      submittedReply = { localId: submittedUserLocalId };
    }
    if (!session) {
      return collectFinalAssistantReplySinceBaseline(sessionId, baseline) ? { done: true, value: 'ended' } : { done: false };
    }
    const current = readSessionTurnMarker(session);
    if (hasTurnProjection(current) || hasTurnProjection(baseline.turnMarker)) {
      const isNewTurn = current?.latestTurnId !== null || baseline.turnMarker?.latestTurnId != null
        ? current?.latestTurnId !== (baseline.turnMarker?.latestTurnId ?? null)
        : current?.latestTurnStatusObservedAt !== (baseline.turnMarker?.latestTurnStatusObservedAt ?? null);
      const isTerminal = isTerminalPrimaryTurnStatus(session.latestTurnStatus ?? null);
      return isNewTurn && isTerminal ? { done: true, value: 'ended' } : { done: false };
    }
    if (isSessionTurnWorking(session)) {
      sawWorking = true;
      return { done: false };
    }
    return sawWorking ? { done: true, value: 'ended' } : { done: false };
  }, { signal });
  if (ended === null || signal?.aborted) return null;

  await settleReceivedSessionMessages(sessionId);
  if (signal?.aborted) return null;
  return collectFinalAssistantReplySinceBaseline(sessionId, baseline, submittedReply);
}
