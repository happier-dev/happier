import { getVoiceSession, isVoiceSessionStarted } from '@/realtime/RealtimeSession';
import { storage } from '@/sync/storage';
import { appendLocalVoiceMediatorContextUpdate, isLocalVoiceMediatorActive } from '@/voice/local/localVoiceEngine';
import type { VoiceContextSink } from './VoiceContextSink';

export function getVoiceContextSinkForSession(sessionId: string): VoiceContextSink | null {
    const voice = getVoiceSession();
    if (voice && isVoiceSessionStarted()) {
        return {
            sendContextualUpdate: (_sessionId, update) => voice.sendContextualUpdate(update),
            sendTextMessage: (_sessionId, update) => voice.sendTextMessage(update),
        };
    }

    const settings = storage.getState().settings as any;
    const providerId = settings.voiceProviderId ?? 'off';
    const conversationMode = settings.voiceLocalConversationMode ?? 'direct_session';
    if (providerId === 'local_openai_stt_tts' && conversationMode === 'mediator' && isLocalVoiceMediatorActive(sessionId)) {
        return {
            sendContextualUpdate: (sid, update) => appendLocalVoiceMediatorContextUpdate(sid, update),
            sendTextMessage: (sid, update) => appendLocalVoiceMediatorContextUpdate(sid, update),
        };
    }

    return null;
}

