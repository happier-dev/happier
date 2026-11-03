import { storage } from '@/sync/domains/state/storage';
import {
    readSessionRuntimePublicationState,
    type SessionRuntimePublicationState,
} from '@/sync/domains/runtimePublication/readSessionRuntimePublicationState';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { readVoiceAgentRunMetadataFromSession, type VoiceAgentRunMetadataV1 } from '@/voice/persistence/voiceAgentRunMetadata';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';

import { voiceSessionBindingStore } from './voiceConversationBindingStore';
import { readLastVoiceConversationAddress } from './resolveVoiceConversationSelection';

type ResolvePersistedVoiceConversationParams = Readonly<{
    managedSessionId: string;
    conversationSessionId?: string | null;
}>;

export type PersistedVoiceConversationRuntimeState = Readonly<{
    metadataSessionId: string;
    runMetadata: VoiceAgentRunMetadataV1 | null;
    runtimePublication: SessionRuntimePublicationState;
}>;

export function resolvePersistedDaemonConversationSessionId(): string | null {
    return readLastVoiceConversationAddress()?.sessionId ?? null;
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
    return normalizeNonEmptyString(
        explicitConversationSessionId
            ?? (managedSessionId === VOICE_AGENT_GLOBAL_SESSION_ID
                ? resolvePersistedDaemonConversationSessionId()
                : voiceSessionBindingStore.getState().getByControlSessionId(managedSessionId)?.conversationSessionId ?? managedSessionId),
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
