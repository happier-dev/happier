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
    Partial<Pick<Message, 'kind' | 'transcriptObservationProvenance'>>
    & Partial<Pick<AgentEventMessage, 'event'>>
>;

export function messageAttentionImpact(message: MessageUserAttentionInput): SessionMessageAttentionImpact {
    if (isRecoveredHistoryTranscriptObservation(message)) return SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT;
    return message.kind === 'agent-event'
        ? agentEventAttentionImpact(message.event)
        : SESSION_MESSAGE_USER_ATTENTION_IMPACT;
}

export function storedSessionMessageContentAttentionImpact(content: unknown): SessionMessageAttentionImpact {
    return storedSessionMessageContentAttentionImpactOrNull(content) ?? SESSION_MESSAGE_USER_ATTENTION_IMPACT;
}

export function storedSessionMessageContentAttentionImpactOrNull(content: unknown): SessionMessageAttentionImpact | null {
    if (!content || typeof content !== 'object' || (content as { t?: unknown }).t !== 'plain') {
        return null;
    }

    const parsed = TranscriptRawRecordV1Schema.safeParse((content as { v?: unknown }).v);
    if (!parsed.success) {
        return SESSION_MESSAGE_USER_ATTENTION_IMPACT;
    }

    if (parsed.data.role === 'agent' && parsed.data.content.type === 'event') {
        return agentEventAttentionImpact(parsed.data.content.data);
    }

    return SESSION_MESSAGE_USER_ATTENTION_IMPACT;
}

export function storedSessionMessageAttentionImpactOrNull(message: Readonly<{
    attentionImpact?: unknown;
    content?: unknown;
    transcriptObservationProvenance?: Message['transcriptObservationProvenance'];
}> | null | undefined): SessionMessageAttentionImpact | null {
    if (isRecoveredHistoryTranscriptObservation(message)) {
        return SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT;
    }
    if (message?.attentionImpact !== undefined) {
        const parsed = SessionMessageAttentionImpactSchema.safeParse(message.attentionImpact);
        if (parsed.success) return parsed.data;
    }

    return storedSessionMessageContentAttentionImpactOrNull(message?.content);
}

export function storedSessionMessageAttentionImpact(message: Readonly<{
    attentionImpact?: unknown;
    content?: unknown;
}> | null | undefined): SessionMessageAttentionImpact {
    return storedSessionMessageAttentionImpactOrNull(message) ?? SESSION_MESSAGE_USER_ATTENTION_IMPACT;
}
