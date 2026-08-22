import {
    SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT,
    SESSION_MESSAGE_USER_ATTENTION_IMPACT,
    SessionMessageAttentionImpactSchema,
    TranscriptRawRecordV1Schema,
    agentEventAttentionImpact,
    type SessionMessageAttentionImpact,
} from '@happier-dev/protocol';

import type { Message } from './messageTypes';
import { isRecoveredHistoryTranscriptObservation } from './transcriptObservationProvenance';

type AgentEventMessage = Extract<Message, { kind: 'agent-event' }>;

type MessageUserAttentionInput = Readonly<
    Partial<Pick<Message, 'kind' | 'localId' | 'transcriptObservationProvenance'>>
    & Partial<Pick<AgentEventMessage, 'event'>>
>;

/**
 * `localId` reaches the shared protocol owner because the Agent-transition
 * divider's attention exemption requires the reserved localId as well as the
 * sidecar. The sidecar key is writable by anything that can post an agent event,
 * so a sidecar-only exemption would let an authorized writer silence their own
 * message. A row with no localId simply is not a divider.
 */
export function messageAttentionImpact(message: MessageUserAttentionInput): SessionMessageAttentionImpact {
    if (isRecoveredHistoryTranscriptObservation(message)) return SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT;
    return message.kind === 'agent-event'
        ? agentEventAttentionImpact(message.event, message.localId ?? null)
        : SESSION_MESSAGE_USER_ATTENTION_IMPACT;
}

export function storedSessionMessageContentAttentionImpact(
    content: unknown,
    localId: unknown,
): SessionMessageAttentionImpact {
    return storedSessionMessageContentAttentionImpactOrNull(content, localId)
        ?? SESSION_MESSAGE_USER_ATTENTION_IMPACT;
}

export function storedSessionMessageContentAttentionImpactOrNull(
    content: unknown,
    localId: unknown,
): SessionMessageAttentionImpact | null {
    if (!content || typeof content !== 'object' || (content as { t?: unknown }).t !== 'plain') {
        return null;
    }

    const parsed = TranscriptRawRecordV1Schema.safeParse((content as { v?: unknown }).v);
    if (!parsed.success) {
        return SESSION_MESSAGE_USER_ATTENTION_IMPACT;
    }

    if (parsed.data.role === 'agent' && parsed.data.content.type === 'event') {
        return agentEventAttentionImpact(parsed.data.content.data, localId);
    }

    return SESSION_MESSAGE_USER_ATTENTION_IMPACT;
}

export function storedSessionMessageAttentionImpactOrNull(message: Readonly<{
    attentionImpact?: unknown;
    content?: unknown;
    localId?: unknown;
    transcriptObservationProvenance?: Message['transcriptObservationProvenance'];
}> | null | undefined): SessionMessageAttentionImpact | null {
    if (isRecoveredHistoryTranscriptObservation(message)) {
        return SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT;
    }
    if (message?.attentionImpact !== undefined) {
        const parsed = SessionMessageAttentionImpactSchema.safeParse(message.attentionImpact);
        if (parsed.success) return parsed.data;
    }

    return storedSessionMessageContentAttentionImpactOrNull(message?.content, message?.localId);
}

export function storedSessionMessageAttentionImpact(message: Readonly<{
    attentionImpact?: unknown;
    content?: unknown;
    localId?: unknown;
}> | null | undefined): SessionMessageAttentionImpact {
    return storedSessionMessageAttentionImpactOrNull(message) ?? SESSION_MESSAGE_USER_ATTENTION_IMPACT;
}
