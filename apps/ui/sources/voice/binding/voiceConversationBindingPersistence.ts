import { storage } from '@/sync/domains/state/storage';
import {
    readSessionRuntimePublicationState,
    type SessionRuntimePublicationState,
} from '@/sync/domains/runtimePublication/readSessionRuntimePublicationState';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { readVoiceAgentRunMetadataFromSession, type VoiceAgentRunMetadataV1 } from '@/voice/persistence/voiceAgentRunMetadata';
import { findReusableVoiceConversationRuntimeSessionId, findVoiceConversationSessionId } from '@/voice/persistence/voiceConversationSession';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';

import { voiceConversationBindingResolver } from './VoiceConversationBindingResolver';
import type { VoiceConversationTranscriptMode, VoiceSessionBinding } from './voiceConversationBindingTypes';

type ResolvePersistedVoiceConversationParams = Readonly<{
    managedSessionId: string;
    conversationSessionId?: string | null;
}>;

export type PersistedVoiceConversationRuntimeState = Readonly<{
    metadataSessionId: string;
    runMetadata: VoiceAgentRunMetadataV1 | null;
    runtimePublication: SessionRuntimePublicationState;
}>;

function pickPersistedBinding(
    controlSessionId: string,
    explicitConversationSessionId: string | null,
): VoiceSessionBinding | null {
    if (explicitConversationSessionId) {
        const byConversation = voiceConversationBindingResolver.resolveByConversationSessionId({
            conversationSessionId: explicitConversationSessionId,
        });
        if (byConversation) return byConversation;
    }

    const byControl = voiceConversationBindingResolver.resolveByControlSessionId({
        controlSessionId,
        adapterId: 'local_conversation',
    });
    if (byControl) return byControl;

    if (controlSessionId !== VOICE_AGENT_GLOBAL_SESSION_ID) return null;
    return voiceConversationBindingResolver.resolveLatest({
        adapterId: 'local_conversation',
        controlSessionIds: [controlSessionId],
    });
}

export function resolvePersistedDaemonConversationSessionId(): string | null {
    const boundConversationSessionId = normalizeNonEmptyString(
        pickPersistedBinding(VOICE_AGENT_GLOBAL_SESSION_ID, null)?.conversationSessionId,
    );
    if (boundConversationSessionId) {
        return boundConversationSessionId;
    }

    const state = storage.getState() as any;
    return (
        findReusableVoiceConversationRuntimeSessionId(state)
        ?? findVoiceConversationSessionId(state)
        ?? null
    );
}

function readRuntimePublicationForSession(metadataSessionId: string): SessionRuntimePublicationState {
    const state = storage.getState() as any;
    const metadata = readVoiceSessionOwnerMetadataFromState(state, metadataSessionId);
    return readSessionRuntimePublicationState(metadata);
}

export function resolvePersistedVoiceConversationMetadataSessionId(
    params: ResolvePersistedVoiceConversationParams,
): string | null {
    const managedSessionId = normalizeNonEmptyString(params.managedSessionId);
    if (!managedSessionId) return null;

    const explicitConversationSessionId = normalizeNonEmptyString(params.conversationSessionId);
    const binding = pickPersistedBinding(managedSessionId, explicitConversationSessionId);
    return normalizeNonEmptyString(
        explicitConversationSessionId
            ?? binding?.conversationSessionId
            ?? (managedSessionId === VOICE_AGENT_GLOBAL_SESSION_ID ? resolvePersistedDaemonConversationSessionId() : managedSessionId),
    );
}

export function readPersistedVoiceConversationRuntimePublication(
    params: ResolvePersistedVoiceConversationParams,
): SessionRuntimePublicationState | null {
    return readPersistedVoiceConversationRuntimeState(params)?.runtimePublication ?? null;
}

export function readPersistedVoiceConversationRuntimeState(
    params: ResolvePersistedVoiceConversationParams,
): PersistedVoiceConversationRuntimeState | null {
    const metadataSessionId = resolvePersistedVoiceConversationMetadataSessionId(params);
    if (!metadataSessionId) return null;
    return {
        metadataSessionId,
        runMetadata: readVoiceAgentRunMetadataFromSession({ sessionId: metadataSessionId }),
        runtimePublication: readRuntimePublicationForSession(metadataSessionId),
    };
}
