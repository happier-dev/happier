import type { SessionTurnV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { SessionRuntimeIssueV1Schema, type SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { deriveWorkflowSessionInputLocalIdV2, readSessionInputAuthority,
    type SessionInputResultV1, type SessionInputUsageV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { projectTranscriptBodySemanticContent as decodeTranscriptBody } from '@happier-dev/protocol/sessions/messages/transcriptBodySemanticProjection';
import type { SessionStoredMessageContent } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { SessionMessageRefV1Schema, type SessionMessageRefV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageRefV1';
import { extractUsageObservationFromTokenCountMessage } from '../usage/usageObservation.js';
import { createExactTurnUsageAccumulator } from '../usage/exactTurnUsage.js';
import {
    detectSessionTurnLifecycleEvent, isBareSessionReadyEvent, isSessionTurnCompletionProof, isSessionContextOnlyHostInput,
    isSessionAgentThreadTextUserMessage, isMemoryArtifactDecryptedRow, isSessionAgentMessage,
} from './sessionTurnLifecycle.js';

export type AssistantTurnTranscriptReader = Readonly<{
    openContent: (content: SessionStoredMessageContent) => unknown | Promise<unknown>;
    readPage: (input: { afterSeq: number; limit: number }) => Promise<readonly Readonly<{
        seq: number; localId?: string | null | undefined; id?: string | undefined; content: SessionStoredMessageContent;
    }>[]>;
}>;

export function isAssistantTurnCompletionProof(value: unknown): boolean {
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

export function readStructuredIssuePreview(value: unknown): string | null {
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

/** The host's failure writers attach the typed issue; only its schema fields leave the transcript. */
export function readRuntimeIssueV1(value: unknown): Readonly<{ runtimeIssueV1?: SessionRuntimeIssueV1 }> {
  const parsed = SessionRuntimeIssueV1Schema.safeParse(value);
  return parsed.success ? { runtimeIssueV1: parsed.data } : {};
}

function hasTranscriptRuntimeIssue(value: unknown): boolean {
  const record = asRecord(value);
  const meta = asRecord(record?.meta);
  const code = typeof meta?.runtimeIssueCode === 'string' ? meta.runtimeIssueCode.trim() : '';
  return code.length > 0;
}

export function formatStructuredTurnFailureMessage(
  kind: 'failed' | 'cancelled' | 'aborted',
  preview?: string | null,
): string {
  if (kind === 'cancelled') return 'Current turn cancelled';
  if (kind === 'aborted') return 'Current turn aborted';
  const suffix = preview && preview.trim().length > 0 ? `: ${preview.trim()}` : '';
  return `Current turn failed${suffix}`;
}

export function readAssistantTurnFailure(value: unknown): AssistantTurnFailure | null {
  if (!value || isMemoryArtifactDecryptedRow(value) || isSessionAgentThreadTextUserMessage(value)) {
    return null;
  }
  const lifecycleEvent = detectSessionTurnLifecycleEvent(value);
  if (lifecycleEvent === 'turn_failed') {
    return { kind: 'failed', message: formatStructuredTurnFailureMessage('failed'), ...readRuntimeIssueV1(asRecord(asRecord(value)?.meta)?.runtimeIssueV1) };
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
      ...readRuntimeIssueV1(asRecord(asRecord(value)?.meta)?.runtimeIssueV1),
    };
  }
  return null;
}

export type AssistantTurnFailure =
  | Readonly<{ kind: 'failed'; message: string; runtimeIssueV1?: SessionRuntimeIssueV1; usage?: SessionInputUsageV1 }>
  | Readonly<{ kind: 'cancelled'; message: string; partialText?: string; finalAssistantMessageId?: string; usage?: SessionInputUsageV1 }>;

export type AssistantTurnOutcome =
  | Readonly<{ kind: 'missing' }>
  | Readonly<{
      kind: 'completed';
      finalAssistantText: string | null;
      finalAssistantMessageId?: string;
      usage?: SessionInputUsageV1;
    }>
  | AssistantTurnFailure;

export const ASSISTANT_TURN_SCAN_PAGE_LIMIT = 100;

export async function scanAssistantTurnAfterCurrentUserTurn(params: Readonly<{
  transcript: AssistantTurnTranscriptReader;
  localId: string;
  materializedSeq: number;
  signal?: AbortSignal;
  /** Host-owned correspondence takes precedence over transcript adjacency. */
  turn?: SessionTurnV1;
  precedingTurnEndSeq?: number;
  /** Immutable original reply custody may select an explicit committed publication. */
  resultMessageId?: string;
  sidechainId?: string;
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
    params.signal?.throwIfAborted();
    const rows = await params.transcript.readPage({ afterSeq, limit: ASSISTANT_TURN_SCAN_PAGE_LIMIT });
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
      const decrypted = await params.transcript.openContent(row.content);
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

export async function readAssistantTurnOutcomeAfterCurrentUserTurn(params: Readonly<{
  transcript: AssistantTurnTranscriptReader;
  localId: string;
  materializedSeq: number;
  signal?: AbortSignal;
  materializedContent?: SessionStoredMessageContent;
  resultMessageId?: string;
  sidechainId?: string;
  /** Original input custody, never supplied by transcript content. */
  acceptedTurnId?: string;
  /** Exact admitted server snapshot, never a message-authored turn claim. */
  hostTurn?: SessionTurnV1;
  readTurns?: () => Promise<Readonly<{ turns: readonly SessionTurnV1[] }> | null>;
}>): Promise<AssistantTurnOutcome> {
  const projection: Readonly<{ turns: readonly SessionTurnV1[] }> | null = params.hostTurn ? { turns: [params.hostTurn] }
    : params.resultMessageId ? null : await params.readTurns?.() ?? null;
  const input = params.materializedContent
    ? asRecord(await params.transcript.openContent(params.materializedContent)) : null;
  const inputAuthority = readSessionInputAuthority(input?.meta, 'stored');
  const workflowInput = inputAuthority?.producer === 'workflow';
  const matchesWorkflowInput = (candidate: SessionTurnV1) => Boolean(candidate.workflowInvocation && deriveWorkflowSessionInputLocalIdV2({
      purpose: 'invocation', ...candidate.workflowInvocation,
    }) === params.localId);
  const turn = params.hostTurn ?? projection?.turns.find(candidate => params.acceptedTurnId
    ? candidate.turnId === params.acceptedTurnId && (workflowInput || isSessionContextOnlyHostInput(input)
      ? matchesWorkflowInput(candidate) && (inputAuthority?.producer === 'workflow'
        ? deriveWorkflowSessionInputLocalIdV2(inputAuthority.workflow) === params.localId
        : isSessionContextOnlyHostInput(input))
      // An ordinary input's accepted turn is named by its original custody alone.
      : true)
    : candidate.transcriptAnchors?.userMessageSeqs?.includes(params.materializedSeq)
      || candidate.transcriptAnchors?.startUserMessageSeq === params.materializedSeq || matchesWorkflowInput(candidate));
  // A queued input can be materialized before the current provider turn ends.
  // Neither that turn's text nor the next input's transcript position owns it.
  if (!params.resultMessageId && (
    params.acceptedTurnId && !turn
    || !projection && (workflowInput || isSessionContextOnlyHostInput(input))
    || projection && (!turn || turn.status === 'in_progress' || turn.status === 'waiting')
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

export function resultFromAssistantTurnOutcome(
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
