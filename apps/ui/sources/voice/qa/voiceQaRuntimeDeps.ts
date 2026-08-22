import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { captureAssistantTextMessageBaseline, waitForNextAssistantTextMessage } from '@/voice/runtime/waitForNextAssistantTextMessage';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { voiceAgentSessions } from '@/voice/agent/voiceAgentSessions';
import { voiceConversationBindingResolver } from '@/voice/binding/VoiceConversationBindingResolver';
import { getVoiceAdapterRegistry, resolveVoiceAdapterContextChannel } from '@/voice/session/voiceAdapterRegistry';
import { voiceSessionManager } from '@/voice/session/voiceSession';
import { getVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleControllerStore';
import { localVoiceRuntimeController } from '@/voice/local/localVoiceRuntimeController';
import { installDaemonSpeechStreamQaRouteRequirement } from '@/voice/runtime/daemonInference/daemonSpeechStreamQaRouteRequirement';
import {
    submitDurableVoiceTextTurn,
    voiceTextTurnPendingPort,
} from '@/voice/binding/sendVoiceSessionComposerText';

import type { VoiceQaControllerDeps } from './voiceQaController';
import { ensureDefaultLocalVoiceQaBinding } from './ensureDefaultLocalVoiceQaBinding';
import { useVoiceQaStore } from './voiceQaStore';
import { stopVoiceQaMediaSession } from './stopVoiceQaMediaSession';
import { waitForVoiceQaLifecycleController } from './waitForVoiceQaLifecycleController';

export function createDefaultVoiceQaControllerDeps(): VoiceQaControllerDeps {
    let activeRealtimeAdapterId: string | null = null;
    let activeRealtimeControlSessionId: string | null = null;

    const resolveConfiguredRealtimeAdapter = () => {
        const settings = (storage.getState() as any).settings;
        const providerId = typeof settings?.voice?.providerId === 'string'
            ? settings.voice.providerId.trim()
            : '';
        const adapter = providerId ? getVoiceAdapterRegistry().get(providerId) : null;
        return adapter?.engineKind === 'realtime' ? adapter : null;
    };
    const resolveActiveRealtimeAdapter = () => {
        const active = activeRealtimeAdapterId
            ? getVoiceAdapterRegistry().get(activeRealtimeAdapterId)
            : null;
        return active?.engineKind === 'realtime' ? active : resolveConfiguredRealtimeAdapter();
    };

    return {
        getSettings: () => (storage.getState() as any).settings,
        getVoiceTargetState: () => useVoiceTargetStore.getState(),
        ensureLocalBinding: ensureDefaultLocalVoiceQaBinding,
        getLocalBinding: (controlSessionId) =>
            voiceConversationBindingResolver.resolveByControlSessionId({ controlSessionId, adapterId: 'local_conversation' }),
        ensureLocalRunningAndMaybeWelcome: (sessionId) => voiceAgentSessions.ensureRunningAndMaybeWelcome(sessionId),
        ensureSessionVisibleForMessageRoute: (sessionId, options) =>
            sync.ensureSessionVisibleForMessageRoute(sessionId, options),
        refreshSessionMessages: (sessionId) => sync.refreshSessionMessages(sessionId),
        pendingPort: voiceTextTurnPendingPort,
        commitLocalUserTranscript: (sessionId, prompt, localId) =>
            voiceAgentSessions.commitUserTranscript(sessionId, prompt, localId),
        sendLocalTurn: (sessionId, prompt, options) =>
            voiceAgentSessions.sendTurn(sessionId, prompt, options),
        stopLocal: (sessionId) => voiceAgentSessions.stop(sessionId),
        appendLocalContextUpdate: (sessionId, update) => voiceAgentSessions.appendContextUpdate(sessionId, update),
        startRealtime: async (sessionId, initialContext, options) => {
            const adapter = resolveConfiguredRealtimeAdapter();
            if (!adapter) throw new Error('realtime_voice_session_not_registered');
            activeRealtimeAdapterId = adapter.id;
            activeRealtimeControlSessionId = sessionId;
            try {
                await adapter.start({ sessionId, initialContext, textOnly: options?.textOnly === true });
            } catch (error) {
                activeRealtimeAdapterId = null;
                activeRealtimeControlSessionId = null;
                throw error;
            }
        },
        isRealtimeStarted: () => {
            const snapshot = resolveActiveRealtimeAdapter()?.getSnapshot();
            return snapshot?.status === 'connecting' || snapshot?.status === 'connected';
        },
        stopRealtime: async () => {
            const adapter = resolveActiveRealtimeAdapter();
            if (adapter) {
                const snapshot = adapter.getSnapshot();
                await adapter.stop({ sessionId: snapshot.sessionId ?? activeRealtimeControlSessionId ?? '' });
            }
            activeRealtimeAdapterId = null;
            activeRealtimeControlSessionId = null;
        },
        getRealtimeSession: () => {
            const adapter = resolveActiveRealtimeAdapter();
            const snapshot = adapter?.getSnapshot();
            if (!adapter || (snapshot?.status !== 'connecting' && snapshot?.status !== 'connected')) return null;
            const settings = (storage.getState() as any).settings?.voice;
            return resolveVoiceAdapterContextChannel(adapter.id, settings);
        },
        getRealtimeBinding: (controlSessionId) => {
            const adapter = resolveActiveRealtimeAdapter();
            return adapter
                ? voiceConversationBindingResolver.resolveByControlSessionId({ controlSessionId, adapterId: adapter.id })
                : null;
        },
        sendRealtimeTextTurn: async ({ controlSessionId, conversationSessionId, text }) => {
            const binding = voiceConversationBindingResolver.resolveByConversationSessionId({ conversationSessionId });
            const adapter = binding?.adapterId
                ? getVoiceAdapterRegistry().get(binding.adapterId)
                : resolveActiveRealtimeAdapter();
            if (!adapter?.sendTextTurn) throw new Error('realtime_voice_session_not_registered');
            const result = await submitDurableVoiceTextTurn({
                conversationSessionId,
                text,
                dispatch: async ({ localId, deliveryCommand, onAccepted }) => {
                    await adapter.sendTextTurn!({
                        controlSessionId,
                        conversationSessionId,
                        text,
                        localId,
                        deliveryCommand,
                        onAccepted,
                    });
                },
            });
            if (!result.ok) throw new Error(result.message ?? result.reason);
            if (result.disposition === 'settled') return;
            throw new Error(result.disposition === 'ambiguous' ? 'voice_turn_dispatch_ambiguous' : 'voice_turn_pending');
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
        installMediaTransportRouteRequirement: installDaemonSpeechStreamQaRouteRequirement,
        startMedia: async (sessionId) => {
            const settings = (storage.getState() as any).settings;
            const expectedProviderId = typeof settings?.voice?.providerId === 'string'
                ? settings.voice.providerId.trim()
                : null;
            const lifecycleController = await waitForVoiceQaLifecycleController({
                getController: getVoiceSessionLifecycleController,
                isReady: (controller) => controller.getConfiguredProviderId() === expectedProviderId,
            });
            await lifecycleController.toggle(sessionId);
        },
        stopMedia: async (sessionId, adapterId) => {
            await stopVoiceQaMediaSession({
                sessionId,
                snapshot: { adapterId },
                getSnapshot: () => voiceSessionManager.getSnapshot(),
                resolveEngineKind: (adapterId) => getVoiceAdapterRegistry().get(adapterId)?.engineKind ?? null,
                toggleLocalTurn: async (nextSessionId) => {
                    await localVoiceRuntimeController.toggleTurn(nextSessionId);
                },
                stopSession: async (nextSessionId) => {
                    await voiceSessionManager.stop(nextSessionId);
                },
            });
        },
        getMediaSnapshot: () => voiceSessionManager.getSnapshot(),
        qaStore: useVoiceQaStore,
    };
}
