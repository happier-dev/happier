import type { Message } from '@happier-dev/session-core/messages';
import type { SessionTurnV1, SessionTurnsProjectionV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import type { SessionMessageRefV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageRefV1';
import type { SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';
import { buildActivityPreviewText } from '@/activity/attention/buildActivityPreviewText';
import { readableMessageText } from '@/components/sessions/transcript/messageDisplayText';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';

export type InboxReadySessionResult = Readonly<{
    preview: Readonly<{ state: 'available'; text: string }> | Readonly<{ state: 'unavailable' }>;
    workflowInvocation: (NonNullable<SessionTurnV1['workflowInvocation']> & Readonly<{ label?: string }>) | null;
    completedAt: number | null;
    /** Preserve the completed reply's evidence links and next steps beyond its ambient preview. */
    output?: Readonly<{ text: string; messageRef: SessionMessageRefV1 }>;
}>;

/** Match provenance to Inbox's admitted completion, never to the newest loaded Run. */
export function readInboxReadySessionTurn(
    candidate: SessionActivityAttention,
    turns: SessionTurnsProjectionV1 | null | undefined,
    /** Receipts show only the latest Turn's completed output, never an older delivery or partial reply. */
    selection?: 'latestTurn',
): SessionTurnV1 | null {
    if (!isSessionAwarenessContentReadableV1(candidate.awareness.encryption)
        || candidate.session.access?.capabilities.readTranscript === false) return null;
    const turnId = selection === 'latestTurn' ? candidate.session.latestTurnId
        : candidate.session.viewer?.follow.onceDelivery?.turnId ?? candidate.session.latestTurnId;
    const turn = turns?.sessionId === candidate.sessionId ? turns.turns.find(turn => turn.turnId === turnId) ?? null : null;
    return selection === 'latestTurn' && turn?.status !== 'completed' ? null : turn;
}

/** Only assistant output anchored to this Turn can describe its result. */
export function readInboxReadySessionMessage(turn: SessionTurnV1 | null, messages: readonly Message[] | undefined): Message | null {
    const anchors = turn?.transcriptAnchors;
    if (!anchors) return null;
    let selected: Message | null = null;
    for (const message of messages ?? []) {
        if (message.kind !== 'agent-text' || message.isThinking || typeof message.seq !== 'number') continue;
        const matches = typeof anchors.finalAssistantMessageSeq === 'number'
            ? message.seq === anchors.finalAssistantMessageSeq
            : typeof anchors.startSeqInclusive === 'number' && typeof anchors.endSeqInclusive === 'number'
                && message.seq >= anchors.startSeqInclusive && message.seq <= anchors.endSeqInclusive;
        if (matches && (!selected || message.createdAt >= selected.createdAt)) selected = message;
    }
    return selected;
}

export function buildInboxReadySessionResult(params: Readonly<{
    candidate: SessionActivityAttention;
    turns?: SessionTurnsProjectionV1 | null;
    messages?: readonly Message[];
    resolveWorkflowName?: (invocation: NonNullable<SessionTurnV1['workflowInvocation']>) => string | undefined;
    selection?: 'latestTurn';
}>): InboxReadySessionResult {
    const turn = readInboxReadySessionTurn(params.candidate, params.turns, params.selection);
    const invocation = turn?.workflowInvocation;
    const label = invocation ? params.resolveWorkflowName?.(invocation) : undefined;
    // An unavailable Turn must not even inspect an admitted caller's private messages.
    const message = turn ? readInboxReadySessionMessage(turn, params.messages) : null;
    const text = buildActivityPreviewText({ messages: message ? [message] : undefined });
    const address = normalizeSessionAddress(params.candidate.address?.serverId ?? params.candidate.serverId, params.candidate.sessionId);
    return {
        preview: text ? { state: 'available', text } : { state: 'unavailable' },
        workflowInvocation: invocation ? { ...invocation, ...(label ? { label } : {}) } : null,
        completedAt: turn?.terminalAt ?? params.candidate.lastTurnCompletedAt,
        ...(message?.kind === 'agent-text' && text && address ? { output: {
            text: readableMessageText(message.text),
            messageRef: { kind: 'session' as const, session: address, messageId: message.id },
        } } : {}),
    };
}
