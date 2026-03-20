import { getVoiceSession, isVoiceSessionStarted, startRealtimeSession, stopRealtimeSession } from '@/realtime/RealtimeSession';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { captureAssistantTextMessageBaseline, waitForNextAssistantTextMessage } from '@/voice/runtime/waitForNextAssistantTextMessage';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { voiceAgentSessions } from '@/voice/agent/voiceAgentSessions';
import { getVoiceAdapterRegistry } from '@/voice/session/voiceAdapterRegistry';
import { resolveVoiceSessionBindingByControlSessionId } from '@/voice/sessionBinding/resolveVoiceSessionBinding';

import type { VoiceQaControllerDeps } from './voiceQaController';
import { ensureDefaultLocalVoiceQaBinding } from './ensureDefaultLocalVoiceQaBinding';
import { useVoiceQaStore } from './voiceQaStore';

export function createDefaultVoiceQaControllerDeps(): VoiceQaControllerDeps {
    return {
        getSettings: () => (storage.getState() as any).settings,
        getVoiceTargetState: () => useVoiceTargetStore.getState(),
        ensureLocalBinding: ensureDefaultLocalVoiceQaBinding,
        getLocalBinding: (controlSessionId) =>
            resolveVoiceSessionBindingByControlSessionId({ controlSessionId, adapterId: 'local_conversation' }),
        ensureLocalRunningAndMaybeWelcome: (sessionId) => voiceAgentSessions.ensureRunningAndMaybeWelcome(sessionId),
        ensureSessionVisibleForMessageRoute: (sessionId) => sync.ensureSessionVisibleForMessageRoute(sessionId),
        refreshSessionMessages: (sessionId) => sync.refreshSessionMessages(sessionId),
        sendLocalTurn: (sessionId, prompt) => voiceAgentSessions.sendTurn(sessionId, prompt),
        stopLocal: (sessionId) => voiceAgentSessions.stop(sessionId),
        appendLocalContextUpdate: (sessionId, update) => voiceAgentSessions.appendContextUpdate(sessionId, update),
        startRealtime: (sessionId, initialContext, options) => startRealtimeSession(sessionId, initialContext, false, options),
        isRealtimeStarted: () => isVoiceSessionStarted(),
        stopRealtime: () => stopRealtimeSession(),
        getRealtimeSession: () => getVoiceSession(),
        getRealtimeBinding: (controlSessionId) =>
            resolveVoiceSessionBindingByControlSessionId({ controlSessionId, adapterId: 'realtime_elevenlabs' }),
        sendRealtimeTextTurn: async ({ controlSessionId, conversationSessionId, text }) => {
            const adapter = getVoiceAdapterRegistry().get('realtime_elevenlabs');
            if (!adapter?.sendTextTurn) {
                throw new Error('realtime_voice_session_not_registered');
            }
            await adapter.sendTextTurn({ controlSessionId, conversationSessionId, text });
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
