import { getVoiceSession, isVoiceSessionStarted } from '@/realtime/RealtimeSession';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { storage } from '@/sync/domains/state/storage';
import { resolveActiveLocalVoiceAgentBinding } from './resolveActiveLocalVoiceAgentBinding';
import type { VoiceContextSink } from './VoiceContextSink';

export function getVoiceContextSinkForSession(_sessionId: string): VoiceContextSink | null {
    const voice = getVoiceSession();
    if (voice && isVoiceSessionStarted()) {
        return {
            sendContextualUpdate: (_sessionId, update) => voice.sendContextualUpdate(update),
            sendTextMessage: (_sessionId, update) => voice.sendTextMessage(update),
        };
    }

    const settings = storage.getState().settings as any;
    const providerId = settings?.voice?.providerId ?? 'off';
    const conversationMode = settings?.voice?.adapters?.local_conversation?.conversationMode ?? 'direct_session';
    const activeLocalVoiceAgent =
        providerId === 'local_conversation' && conversationMode === 'agent'
            ? resolveActiveLocalVoiceAgentBinding()
            : null;
    if (activeLocalVoiceAgent) {
        return {
            sendContextualUpdate: (_sid, update) =>
                activeLocalVoiceAgent.sendContextualUpdate(update),
            sendTextMessage: (_sid, update) =>
                fireAndForget(activeLocalVoiceAgent.sendTextUpdate(update), {
                    tag: 'local_voice_agent_text_update',
                }),
            announceAssistantText: (_sid, text) =>
                activeLocalVoiceAgent.announceAssistantText(text),
        };
    }

    return null;
}
