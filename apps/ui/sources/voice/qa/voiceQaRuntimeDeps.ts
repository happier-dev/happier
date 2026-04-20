import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { captureAssistantTextMessageBaseline, waitForNextAssistantTextMessage } from '@/voice/runtime/waitForNextAssistantTextMessage';
import { realtimeTransport } from '@/voice/runtime/realtime/RealtimeTransport';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { voiceAgentSessions } from '@/voice/agent/voiceAgentSessions';
import { voiceConversationBindingResolver } from '@/voice/binding/VoiceConversationBindingResolver';
import { getVoiceAdapterRegistry } from '@/voice/session/voiceAdapterRegistry';

import type { VoiceQaControllerDeps } from './voiceQaController';
import { ensureDefaultLocalVoiceQaBinding } from './ensureDefaultLocalVoiceQaBinding';
import { useVoiceQaStore } from './voiceQaStore';

export function createDefaultVoiceQaControllerDeps(): VoiceQaControllerDeps {
    return {
        getSettings: () => (storage.getState() as any).settings,
        getVoiceTargetState: () => useVoiceTargetStore.getState(),
        ensureLocalBinding: ensureDefaultLocalVoiceQaBinding,
        getLocalBinding: (controlSessionId) =>
            voiceConversationBindingResolver.resolveByControlSessionId({ controlSessionId, adapterId: 'local_conversation' }),
        ensureLocalRunningAndMaybeWelcome: (sessionId) => voiceAgentSessions.ensureRunningAndMaybeWelcome(sessionId),
        ensureSessionVisibleForMessageRoute: (sessionId) => sync.ensureSessionVisibleForMessageRoute(sessionId),
        refreshSessionMessages: (sessionId) => sync.refreshSessionMessages(sessionId),
        sendLocalTurn: (sessionId, prompt) => voiceAgentSessions.sendTurn(sessionId, prompt),
        stopLocal: (sessionId) => voiceAgentSessions.stop(sessionId),
        appendLocalContextUpdate: (sessionId, update) => voiceAgentSessions.appendContextUpdate(sessionId, update),
        startRealtime: (sessionId, initialContext, options) =>
            realtimeTransport.startRealtimeSession(sessionId, initialContext, false, options),
        isRealtimeStarted: () => realtimeTransport.isVoiceSessionStarted(),
        stopRealtime: () => realtimeTransport.stopRealtimeSession(),
        getRealtimeSession: () => realtimeTransport.getVoiceSession(),
        getRealtimeBinding: (controlSessionId) =>
            voiceConversationBindingResolver.resolveByControlSessionId({ controlSessionId, adapterId: 'realtime_elevenlabs' }),
        sendRealtimeTextTurn: async ({ controlSessionId, conversationSessionId, text }) => {
            const adapter = getVoiceAdapterRegistry().get('realtime_elevenlabs');
            if (!adapter?.sendTextTurn) {
                throw new Error('realtime_voice_session_not_registered');
            }
            await adapter.sendTextTurn({
                controlSessionId,
                conversationSessionId,
                text,
            });
        },
        waitForInterruptedLocalAssistantTurn: async ({ conversationSessionId, timeoutMs, baseline }) => {
            const currentBaseline = baseline ?? captureAssistantTextMessageBaseline(conversationSessionId);
            return await waitForNextAssistantTextMessage(
                conversationSessionId,
                currentBaseline.baselineIds,
                currentBaseline.baselineCount,
                timeoutMs,
            );
        },
        qaStore: useVoiceQaStore,
    };
}
