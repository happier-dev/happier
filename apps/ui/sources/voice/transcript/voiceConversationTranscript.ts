import type {
    ConversationTurnOriginV1,
    VoiceTranscriptCanonicalEventV1,
} from '@happier-dev/protocol';

import {
    voiceTranscriptProjector as projector,
} from './VoiceTranscriptProjector';
export {
    buildRealtimeConversationTurnMeta,
    deriveCanonicalVoiceTranscriptEntryId,
} from './VoiceTranscriptProjector';
export type {
    AdmittedCanonicalVoiceTranscriptPersistenceEvent,
    RealtimeConversationTurnSource,
} from './VoiceTranscriptProjector';
import type {
    AdmittedCanonicalVoiceTranscriptPersistenceEvent,
} from './VoiceTranscriptProjector';
import type {
    CanonicalVoiceTranscriptAttempt,
    CanonicalVoiceTranscriptItem,
    CanonicalVoiceTranscriptProjectionResult,
} from './canonicalProjector';
import {
    isCanonicalVoiceTranscriptPersistenceEvent,
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

/**
 * Reserve one exact canonical persistence event before an external ordering barrier. The
 * opaque result may only be committed or released; it never accepts a later
 * caller-supplied text/event payload.
 */
export function admitCanonicalVoiceTranscriptPersistenceEvent(params: Readonly<{
    conversationSessionId: string;
    event: VoiceTranscriptCanonicalEventV1;
    source?: NonNullable<Extract<
        ConversationTurnOriginV1,
        { channel: 'realtime_conversation' }
    >['source']>;
}>): AdmittedCanonicalVoiceTranscriptPersistenceEvent | null {
    const conversationSessionId = normalizeText(params.conversationSessionId);
    if (!conversationSessionId || !isCanonicalVoiceTranscriptPersistenceEvent(params.event)) return null;
    return projector.admitCanonicalPersistenceEvent({
        conversationSessionId,
        event: params.event,
        ...(params.source ? { source: params.source } : {}),
    });
}

export function commitAdmittedCanonicalVoiceTranscriptPersistenceEvent(
    admission: AdmittedCanonicalVoiceTranscriptPersistenceEvent,
): string | null {
    return projector.commitAdmittedCanonicalPersistenceEvent(admission);
}

export function releaseAdmittedCanonicalVoiceTranscriptPersistenceEvent(
    admission: AdmittedCanonicalVoiceTranscriptPersistenceEvent,
): boolean {
    return projector.releaseAdmittedCanonicalPersistenceEvent(admission);
}

export { isCanonicalVoiceTranscriptPersistenceEvent } from './canonicalProjector';

export function beginCanonicalVoiceTranscriptAttempt(params: Readonly<{
    conversationSessionId: string;
}>): CanonicalVoiceTranscriptAttempt | null {
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

export async function releaseCanonicalVoiceTranscriptConversation(params: Readonly<{
    conversationSessionId: string;
    attemptIdentity: string;
}>): Promise<boolean> {
    const conversationSessionId = normalizeText(params.conversationSessionId);
    const attemptIdentity = normalizeText(params.attemptIdentity);
    if (!conversationSessionId || !attemptIdentity) return false;
    return await projector.releaseCanonicalConversation(
        conversationSessionId,
        attemptIdentity,
    );
}

export async function settleAdmittedCanonicalVoiceTranscriptPersistence(params: Readonly<{
    conversationSessionId: string;
    attemptIdentity: string;
}>): Promise<void> {
    const conversationSessionId = normalizeText(params.conversationSessionId);
    const attemptIdentity = normalizeText(params.attemptIdentity);
    if (!conversationSessionId || !attemptIdentity) return;
    await projector.settleAdmittedCanonicalPersistence({
        conversationSessionId,
        attemptIdentity,
    });
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
