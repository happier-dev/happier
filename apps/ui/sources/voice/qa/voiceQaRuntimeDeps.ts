import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { storage } from '@/sync/domains/state/storage';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
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
    createDurableVoiceTextTurnError,
    submitDurableVoiceTextTurn,
    voiceTextTurnPendingPort,
} from '@/voice/binding/sendVoiceSessionComposerText';

import type { VoiceQaControllerDeps } from './voiceQaController';
import { ensureDefaultLocalVoiceQaBinding } from './ensureDefaultLocalVoiceQaBinding';
import { useVoiceQaStore } from './voiceQaStore';
import { waitForVoiceQaLifecycleController } from './waitForVoiceQaLifecycleController';

/**
 * The realtime adapter, the media lifecycle controller and the speech transport all address a
 * Session by its Home-local id through the Home this client has mounted. This is the one place a
 * qualified target may collapse to that id: a target in another Home shares nothing but its id
 * with the Session those runtimes would actually attach to, so it is refused instead.
 */
function resolveMountedHomeRuntimeSessionId(target: SessionAddress | null): string {
    if (!target) return VOICE_AGENT_GLOBAL_SESSION_ID;
    if (!areServerProfileIdentifiersEquivalent(target.serverId, getActiveServerSnapshot().serverId)) {
        throw new Error('voice_qa_target_home_not_mounted');
    }
    return target.sessionId;
}

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
        ensureSessionVisibleForMessageRoute: (address, options) =>
            sync.ensureSessionVisibleForMessageRoute(address.sessionId, { ...options, serverId: address.serverId }),
        refreshSessionMessages: (address) => {
            // This incumbent transcript refresh writes the active Home cache.
            // Remote hydration above may supply session facts, but cannot admit that write.
            if (address.serverId !== getActiveServerSnapshot().serverId) return;
            return sync.refreshSessionMessages(address.sessionId);
        },
        pendingPort: voiceTextTurnPendingPort,
        commitLocalUserTranscript: (sessionId, prompt, localId) =>
            voiceAgentSessions.commitUserTranscript(sessionId, prompt, localId),
        sendLocalTurn: (sessionId, prompt, options) =>
            voiceAgentSessions.sendTurn(sessionId, prompt, options),
        stopLocal: (sessionId) => voiceAgentSessions.stop(sessionId),
        appendLocalContextUpdate: (sessionId, update) => voiceAgentSessions.appendAttemptContextUpdate(sessionId, update),
        startRealtime: async (target, initialContext, options) => {
            const sessionId = resolveMountedHomeRuntimeSessionId(target);
            const adapter = resolveConfiguredRealtimeAdapter();
            if (!adapter) throw new Error('realtime_voice_session_not_registered');
            activeRealtimeAdapterId = adapter.id;
            activeRealtimeControlSessionId = sessionId;
            try {
                await adapter.start({
                    sessionId,
                    requestedTargetSessionAddress: target,
                    initialContext,
                    textOnly: options?.textOnly === true,
                });
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
            const channel = resolveVoiceAdapterContextChannel(adapter.id, settings);
            if (!channel) return null;
            return {
                sendTextMessage: (message: string) => channel.sendTextMessage(message),
                sendContextualUpdate: (update: string) => channel.sendContextualUpdate(update, 'current_ui'),
            };
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
            if (!adapter?.prepareTextTurn) throw new Error('realtime_voice_session_not_registered');
            const dispatch = adapter.prepareTextTurn({
                controlSessionId,
                conversationSessionId,
                text,
            });
            const result = await submitDurableVoiceTextTurn({
                conversationSessionId,
                text,
                dispatch: async ({ localId, deliveryCommand, onAccepted }) => {
                    await dispatch({
                        localId,
                        deliveryCommand,
                        onAccepted,
                    });
                },
            });
            if (!result.ok) throw createDurableVoiceTextTurnError(result);
            if (result.disposition === 'settled' || result.disposition === 'accepted_unsettled') return;
            throw createDurableVoiceTextTurnError(result);
        },
        waitForInterruptedLocalAssistantTurn: async ({ conversationSessionId, timeoutMs, baseline }) => {
            const currentBaseline = baseline ?? captureAssistantTextMessageBaseline(conversationSessionId);
            // This deadline belongs to the QA observation, not the Voice turn.
            const observation = new AbortController();
            const timeout = setTimeout(() => observation.abort(), timeoutMs);
            try {
                return await waitForNextAssistantTextMessage(
                    conversationSessionId,
                    currentBaseline.baselineIds,
                    currentBaseline.baselineCount,
                    observation.signal,
                );
            } finally {
                clearTimeout(timeout);
            }
        },
        installMediaTransportRouteRequirement: ({ target, routeKind }) =>
            installDaemonSpeechStreamQaRouteRequirement({
                sessionId: resolveMountedHomeRuntimeSessionId(target),
                routeKind,
            }),
        startMedia: async (target) => {
            resolveMountedHomeRuntimeSessionId(target);
            const settings = (storage.getState() as any).settings;
            const expectedProviderId = typeof settings?.voice?.providerId === 'string'
                ? settings.voice.providerId.trim()
                : null;
            const lifecycleController = await waitForVoiceQaLifecycleController({
                getController: getVoiceSessionLifecycleController,
                isReady: (controller) => controller.getConfiguredProviderId() === expectedProviderId,
            });
            await lifecycleController.toggle(target);
        },
        stopMedia: async (sessionId) => await voiceSessionManager.stop(sessionId),
        getMediaSnapshot: () => voiceSessionManager.getSnapshot(),
        qaStore: useVoiceQaStore,
    };
}
