import type {
    ConversationTurnOriginV1,
    VoiceTranscriptCanonicalEventV1,
} from '@happier-dev/protocol';

import { voiceTranscriptProjector as projector } from './VoiceTranscriptProjector';
export { deriveCanonicalVoiceTranscriptEntryId } from './VoiceTranscriptProjector';
import type {
    CanonicalVoiceTranscriptItem,
    CanonicalVoiceTranscriptProjectionResult,
} from './canonicalProjector';
import type { VoiceTranscriptTurn } from './voiceTranscriptEvents';

export type { VoiceTranscriptEvent, VoiceTranscriptTurn } from './voiceTranscriptEvents';

function normalizeText(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function appendVoiceConversationUserText(params: Readonly<{
    conversationSessionId: string;
    text: string;
    turn?: VoiceTranscriptTurn | null;
}>): void {
    projector.projectUserText(params);
}

export function appendVoiceConversationAssistantText(params: Readonly<{
    conversationSessionId: string;
    text: string;
    turn?: VoiceTranscriptTurn | null;
}>): string | null {
    const message = projector.projectAssistantText(params);
    return message?.id ?? message?.localId ?? null;
}

export function appendVoiceConversationNoteText(params: Readonly<{
    conversationSessionId: string;
    text: string;
}>): void {
    projector.projectNoteText(params);
}

export function projectCanonicalVoiceTranscriptEvent(params: Readonly<{
    conversationSessionId: string;
    event: VoiceTranscriptCanonicalEventV1;
    source?: NonNullable<Extract<
        ConversationTurnOriginV1,
        { channel: 'realtime_conversation' }
    >['source']>;
}>): CanonicalVoiceTranscriptProjectionResult | null {
    const conversationSessionId = normalizeText(params.conversationSessionId);
    if (!conversationSessionId) return null;
    return projector.projectCanonicalEvent({
        conversationSessionId,
        event: params.event,
        ...(params.source ? { source: params.source } : {}),
    });
}

export function beginCanonicalVoiceTranscriptAttempt(params: Readonly<{
    conversationSessionId: string;
}>): number | null {
    const conversationSessionId = normalizeText(params.conversationSessionId);
    return conversationSessionId ? projector.beginCanonicalAttempt(conversationSessionId) : null;
}

export function resetCanonicalVoiceTranscriptEpoch(params: Readonly<{
    conversationSessionId: string;
    epoch: number;
}>): boolean {
    const conversationSessionId = normalizeText(params.conversationSessionId);
    return conversationSessionId ? projector.resetCanonicalEpoch(conversationSessionId, params.epoch) : false;
}

export function releaseCanonicalVoiceTranscriptConversation(
    conversationSessionIdValue: string,
): void {
    const conversationSessionId = normalizeText(conversationSessionIdValue);
    if (!conversationSessionId) return;
    projector.releaseCanonicalConversation(conversationSessionId);
}

export function readCanonicalVoiceTranscriptSnapshot(
    conversationSessionIdValue: string,
): readonly CanonicalVoiceTranscriptItem[] {
    const conversationSessionId = normalizeText(conversationSessionIdValue);
    return conversationSessionId ? projector.canonicalSnapshot(conversationSessionId) : [];
}

export function subscribeCanonicalVoiceTranscript(
    conversationSessionIdValue: string,
    listener: () => void,
): () => void {
    const conversationSessionId = normalizeText(conversationSessionIdValue);
    return conversationSessionId ? projector.subscribeCanonical(conversationSessionId, listener) : () => {};
}
