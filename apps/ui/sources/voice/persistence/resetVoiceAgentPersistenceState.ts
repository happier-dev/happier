import { storage } from '@/sync/domains/state/storage';
import { voiceActivityController } from '@/voice/activity/voiceActivityController';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { findVoiceConversationSessionId } from '@/voice/sessionBinding/voiceConversationSession';

import { invalidatePersistentVoiceTranscript } from './invalidatePersistentVoiceTranscript';
import { clearVoiceAgentRunMetadataFromSession } from './voiceAgentRunMetadata';

export async function resetVoiceAgentPersistenceState(params: Readonly<{
    stop: () => Promise<void>;
}>): Promise<void> {
    await params.stop();
    invalidatePersistentVoiceTranscript();
    voiceActivityController.clearSession(VOICE_AGENT_GLOBAL_SESSION_ID);

    const conversationSessionId = findVoiceConversationSessionId(storage.getState() as any);
    if (conversationSessionId) {
        await clearVoiceAgentRunMetadataFromSession({ sessionId: conversationSessionId }).catch(() => {});
    }
}
