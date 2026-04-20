import { fireAndForget } from '@/utils/system/fireAndForget';
import { storage } from '@/sync/domains/state/storage';
import { realtimeTransport } from '@/voice/runtime/realtime/RealtimeTransport';
import { getVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import { resolveActiveLocalVoiceAgentBinding } from './resolveActiveLocalVoiceAgentBinding';
import type { VoiceContextSink } from './VoiceContextSink';

function createLocalAgentSink(): VoiceContextSink | null {
    const activeLocalVoiceAgent = resolveActiveLocalVoiceAgentBinding();
    if (!activeLocalVoiceAgent) {
        return null;
    }

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

function createRealtimeSink(): VoiceContextSink | null {
    const voice = realtimeTransport.getVoiceSession();
    if (!voice || !realtimeTransport.isVoiceSessionStarted()) {
        return null;
    }

    return {
        sendContextualUpdate: (_sessionId, update) => voice.sendContextualUpdate(update),
        sendTextMessage: (_sessionId, update) => voice.sendTextMessage(update),
    };
}

function resolveActiveOwnerAdapterId(): string | null {
    const snapshot = getVoiceSessionSnapshot();
    if (snapshot.status !== 'connected' && snapshot.status !== 'connecting') {
        return null;
    }
    return snapshot.adapterId;
}

export function getVoiceContextSinkForSession(_sessionId: string): VoiceContextSink | null {
    const activeOwnerAdapterId = resolveActiveOwnerAdapterId();
    if (activeOwnerAdapterId === 'local_conversation') {
        return createLocalAgentSink();
    }
    if (activeOwnerAdapterId === 'realtime_elevenlabs') {
        return createRealtimeSink();
    }

    const settings = storage.getState().settings as any;
    const providerId = settings?.voice?.providerId ?? 'off';
    const conversationMode = settings?.voice?.adapters?.local_conversation?.conversationMode ?? 'direct_session';
    if (providerId === 'local_conversation' && conversationMode === 'agent') {
        return createLocalAgentSink();
    }

    return null;
}
