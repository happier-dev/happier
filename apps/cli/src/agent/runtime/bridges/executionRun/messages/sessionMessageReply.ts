import {
    SessionMessageReplyMutationResultV1Schema,
    type SessionMessageReplyMutationResultV1,
    type SessionMessageReplyOutcomeV1,
} from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';

import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { CommittedTranscriptMessageOptions } from '@/api/session/transcriptPort';
import type { NativeAgentSessionInteractionHostBinding } from '@/agent/runtime/registry/engineRegistryTypes';

type ReplyRefusal = Extract<SessionMessageReplyMutationResultV1, { ok: false }>;

export const EXECUTION_RUN_REPLY_REFUSALS_META_KEY = 'happierExecutionRunReplyRefusalsV1';

export function readExecutionRunReplyRefusal(value: unknown): ReplyRefusal | undefined {
    const parsed = SessionMessageReplyMutationResultV1Schema.safeParse(value);
    return parsed.success && !parsed.data.ok ? parsed.data : undefined;
}

export function isExecutionRunCommittedAssistantResult(body: ACPMessageData, options: CommittedTranscriptMessageOptions): boolean {
    if (body.type !== 'message') return false;
    const segment = options.meta?.happierStreamSegmentV1;
    return options.meta?.runtimeEventKind === 'transcript-message-committed' || (segment !== null && typeof segment === 'object'
        && Reflect.get(segment, 'segmentKind') === 'assistant' && Reflect.get(segment, 'segmentState') === 'complete');
}

/** Result identity is captured at the incumbent durable transcript writer, never by a result scanner. */
export async function observeExecutionRunCommittedReply(args: Readonly<{
    controller: ExecutionRunBackendController;
    runId: string;
    session: NativeAgentSessionInteractionHostBinding['session'];
    sidechainId: string;
    body: ACPMessageData;
    options: CommittedTranscriptMessageOptions;
    /** Only the canonical host completion publisher can supply this process-local fact. */
    source?: 'host_structured_completion';
    isCurrent(): boolean;
}>): Promise<Readonly<Record<string, ReplyRefusal>> | undefined> {
    const { controller, session, body, options } = args;
    const turnId = options.meta?.runtimeTurnId;
    if (typeof turnId !== 'string' || !args.isCurrent()) return;
    const turn = [controller.currentInputTurn, controller.lastInputTurn].find(candidate => candidate?.turnId === turnId);
    if (!turn || (body.sidechainId !== undefined && body.sidechainId !== args.sidechainId)) return;
    if (body.type === 'message' || body.type === 'tool-call') {
        if (body.type === 'message' && args.source !== 'host_structured_completion'
            && !isExecutionRunCommittedAssistantResult(body, options)) return;
        const { committedResultLocalId: _previousResult, ...facts } = turn;
        const updated = { ...facts, ...(body.type === 'message' && body.message.trim().length > 0
            ? { committedResultLocalId: options.localId, committedPartialResultLocalId: options.localId } : {}) };
        if (controller.currentInputTurn?.turnId === turnId) controller.currentInputTurn = updated;
        else if (controller.lastInputTurn?.turnId === turnId) controller.lastInputTurn = updated;
        return;
    }
    if (body.type !== 'task_complete' && body.type !== 'turn_failed' && body.type !== 'turn_cancelled') return;
    const outcome: SessionMessageReplyOutcomeV1 = { kind: body.type === 'turn_failed' ? 'failed'
        : body.type === 'turn_cancelled' ? 'cancelled' : 'terminal_no_result' };
    const localId = body.type === 'task_complete' ? turn.committedResultLocalId
        : body.type === 'turn_cancelled' ? turn.committedPartialResultLocalId : undefined;
    return fulfillExecutionRunInputReply({ session, turnId, inputIds: turn.inputIds, outcome,
        ...(localId ? { nativeResult: { runId: args.runId, sidechainId: args.sidechainId, localId } } : {}), isCurrent: args.isCurrent });
}

/** Shared by committed native terminal evidence and the host's authoritative Stop. */
export async function fulfillExecutionRunInputReply(args: Readonly<{
    session: NativeAgentSessionInteractionHostBinding['session'];
    turnId: string;
    inputIds: readonly string[];
    outcome: SessionMessageReplyOutcomeV1 | undefined;
    nativeResult?: Readonly<{ runId: string; sidechainId: string; localId: string }>;
    isCurrent(): boolean;
}>): Promise<Readonly<Record<string, ReplyRefusal>> | undefined> {
    const { session, turnId, nativeResult } = args;
    let outcome = args.outcome;
    if (nativeResult) {
        if (!args.isCurrent()) return;
        const committed = await session.readCommittedTranscriptMessageByLocalId?.(nativeResult.localId);
        if (!args.isCurrent()) return;
        // A local id is only a lookup key. Keep an unreadable/uncommitted result
        // pending rather than replacing a known partial with bare cancellation.
        outcome = committed?.type === 'found' && committed.message.sidechainId === nativeResult.sidechainId
            && committed.message.localId === nativeResult.localId
            ? (() => {
                const result = { sessionId: session.sessionId, messageId: committed.message.id };
                return args.outcome?.kind === 'cancelled' ? { kind: 'cancelled' as const, result } : { kind: 'answer' as const, result };
            })() : undefined;
    }
    const refusals: [string, ReplyRefusal][] = [];
    for (const localId of args.inputIds) {
        if (!args.isCurrent()) return;
        try {
            if (outcome && session.mutateSessionMessageReply) {
                const result = await session.mutateSessionMessageReply({ requestSessionId: session.sessionId, requestLocalId: localId,
                    operation: { kind: 'fulfill', turnId, outcome, ...(nativeResult ? { nativeResult } : {}) } });
                if (!result.ok) refusals.push([localId, result]);
            }
        } catch {
            refusals.push([localId, { v: 1, ok: false, error: 'unavailable' }]);
        } finally {
            if (args.isCurrent()) await session.releaseSessionMessageReplySourceTurn?.({ sourceTurnId: turnId, sourceInputId: localId });
        }
    }
    return refusals.length ? Object.fromEntries(refusals) : undefined;
}
