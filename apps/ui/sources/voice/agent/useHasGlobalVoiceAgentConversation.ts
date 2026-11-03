import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { useVoiceSessionSnapshot } from '@/voice/session/voiceSession';
import { useVoiceHomeConversationAddress } from '@/voice/persistence/useVoiceHomeConversationAddress';

export function useHasGlobalVoiceAgentConversation(): boolean {
    const snapshot = useVoiceSessionSnapshot();
    const conversation = useVoiceHomeConversationAddress();
    return conversation !== null || snapshot.adapterId === 'local_conversation'
        && snapshot.sessionId === VOICE_AGENT_GLOBAL_SESSION_ID;
}
