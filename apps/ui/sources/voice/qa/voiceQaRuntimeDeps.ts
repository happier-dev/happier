import { getVoiceSession, isVoiceSessionStarted, startRealtimeSession, stopRealtimeSession } from '@/realtime/RealtimeSession';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { captureAssistantTextMessageBaseline, waitForNextAssistantTextMessage } from '@/voice/runtime/waitForNextAssistantTextMessage';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { voiceAgentSessions } from '@/voice/agent/voiceAgentSessions';
import { getVoiceAdapterRegistry } from '@/voice/session/voiceAdapterRegistry';
import { resolveVoiceSessionBindingByControlSessionId } from '@/voice/sessionBinding/resolveVoiceSessionBinding';
import {
    sendVoiceSessionComposerText,
    voiceTextTurnPendingPort,
} from '@/voice/sessionBinding/sendVoiceSessionComposerText';

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
        pendingPort: voiceTextTurnPendingPort,
        commitLocalUserTranscript: (sessionId, prompt, localId) =>
            voiceAgentSessions.commitUserTranscript(sessionId, prompt, localId),
        sendLocalTurn: (sessionId, prompt, options) =>
            voiceAgentSessions.sendTurn(sessionId, prompt, options),
        stopLocal: (sessionId) => voiceAgentSessions.stop(sessionId),
        appendLocalContextUpdate: (sessionId, update) => voiceAgentSessions.appendContextUpdate(sessionId, update),
        startRealtime: (sessionId, initialContext, options) => startRealtimeSession(sessionId, initialContext, options),
        isRealtimeStarted: () => isVoiceSessionStarted(),
        stopRealtime: () => stopRealtimeSession(),
        getRealtimeSession: () => getVoiceSession(),
        getRealtimeBinding: (controlSessionId) =>
            resolveVoiceSessionBindingByControlSessionId({ controlSessionId, adapterId: 'realtime_elevenlabs' }),
        sendRealtimeTextTurn: async ({ conversationSessionId, text }) => {
            const result = await sendVoiceSessionComposerText({
                conversationSessionId,
                text,
                getAdapter: (adapterId) => getVoiceAdapterRegistry().get(adapterId),
            });
            if (!result.ok) throw new Error(result.message ?? result.reason);
            if (result.disposition === 'settled') return;
            if (result.disposition !== 'handoff_acknowledged') {
                throw new Error(
                    result.disposition === 'ambiguous'
                        ? 'voice_turn_dispatch_ambiguous'
                        : 'voice_turn_pending',
                );
            }
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
