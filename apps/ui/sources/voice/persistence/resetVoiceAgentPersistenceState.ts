import { storage } from '@/sync/domains/state/storage';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { voiceConversationBindingResolver } from '@/voice/binding/VoiceConversationBindingResolver';
import { findVoiceConversationSessionId } from '@/voice/persistence/voiceConversationSession';

import { invalidatePersistentVoiceTranscript } from './invalidatePersistentVoiceTranscript';
import { clearVoiceAgentRunMetadataFromSession } from './voiceAgentRunMetadata';

function resolveVoiceAgentRunMetadataSessionId(state: any): string | null {
    const boundConversationSessionId =
        voiceConversationBindingResolver.resolveByControlSessionId({
            controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        })?.conversationSessionId ?? null;
    if (boundConversationSessionId && state?.sessions?.[boundConversationSessionId]) {
        return boundConversationSessionId;
    }
    return findVoiceConversationSessionId(state);
}

export async function resetVoiceAgentPersistenceState(params: Readonly<{
    stop: () => Promise<void>;
}>): Promise<void> {
    await params.stop();
    invalidatePersistentVoiceTranscript();

    const state = storage.getState() as any;
    const conversationSessionId = resolveVoiceAgentRunMetadataSessionId(state);
    if (conversationSessionId) {
        await clearVoiceAgentRunMetadataFromSession({ sessionId: conversationSessionId }).catch(() => {});
    }
}
