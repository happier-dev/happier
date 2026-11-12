import {
    getStorage,
    loadLocalVoiceEngineWithCompatState,
    localVoiceHomeId,
    localVoiceSpeechOutputBoundary,
    machineRpcWithServerScope,
    registerLocalVoiceEngineHarnessHooks,
    setPlatformOs,
    warmLocalVoiceEngineHarnessGraph,
} from '@/voice/local/localVoiceEngine.testHarness';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const restoreModuleLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreModuleLoader());
// Warm the real Action graph outside the interaction deadline.
const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
const { setVoiceSessionLifecycleController, acknowledgeVoiceSessionRuntimeReady } = await import('./voiceSessionLifecycleControllerStore');
const { setVoiceSessionSnapshot, getVoiceSessionPresentedAttemptId } = await import('./voiceSessionStore');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');

describe('Voice Start selection admission through the Action executor', () => {
    registerLocalVoiceEngineHarnessHooks();

    it.each([
        { agentId: 'codex', enabled: false },
        { agentId: 'opencode', enabled: true },
    ])('keeps a configured $agentId refusal and its setup action before capture (enabled=$enabled)', async ({ agentId, enabled }) => {
        setPlatformOs('web');
        const state = await getStorage();
        const settings = state.getState().settings;
        const config = readLocalConversationVoiceSettings(settings.voice);
        const targetKey = `agent:happier.agent.${agentId}/${agentId}`;
        state.__setState({ settings: { ...settings,
            backendEnabledByTargetKey: { ...settings.backendEnabledByTargetKey, [targetKey]: enabled },
            voice: { ...settings.voice, providerId: 'local_conversation',
                executionMachine: { mode: 'fixed', machineId: 'machine-1' },
                providers: { ...settings.voice.providers, local_conversation: { schemaVersion: 1, config: {
                    ...config, conversationMode: 'agent', agent: { ...config.agent,
                        agentSource: 'agent', agentId, agentTargetKey: targetKey,
                        agentIdentity: { pluginId: `happier.agent.${agentId}`, localId: agentId },
                    },
                } } },
            },
        } });
        await loadLocalVoiceEngineWithCompatState();
        const controller = createVoiceSessionLifecycleController();
        controller.setConfiguredProviderId('local_conversation');
        setVoiceSessionLifecycleController(controller);
        acknowledgeVoiceSessionRuntimeReady(true);
        const unsubscribe = controller.subscribe(() => setVoiceSessionSnapshot(controller.getSnapshot()));
        const openRoute = vi.fn();
        const executor = createDefaultActionExecutor({ presentUserActionConfirmation: async () => true, openRoute });
        try {
            const result = await executor.execute('ui.voice_global.start', { target: { kind: 'global' }, expectedAttempt: null }, {
                surface: 'ui', serverId: localVoiceHomeId, authority: 'present_user', actionCaller: { kind: 'host' },
            });
            expect(controller.getSnapshot(), JSON.stringify(result)).toMatchObject({ errorCode: 'provider_setup_required' });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: {
                status: 'unavailable', code: 'VOICE_AGENT_SELECTION_UNAVAILABLE',
                voice: { canStop: false, recoveryAction: 'open_settings', presentation: {
                    failureKind: 'provider_setup_required', recovery: { action: 'open_settings' },
                } },
            } });
            if (!enabled) {
                expect(machineRpcWithServerScope.mock.calls.filter(([request]) => request.method === RPC_METHODS.SESSION_SPAWN_NEW)).toEqual([]);
            }
            expect(localVoiceSpeechOutputBoundary.fileRecording.start).not.toHaveBeenCalled();
            expect(localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
            const expectedAttempt = getVoiceSessionPresentedAttemptId();
            expect(expectedAttempt).not.toBeNull();
            const recovered = await executor.execute('ui.voice_global.recover', { expectedAttempt }, {
                surface: 'ui', serverId: localVoiceHomeId, authority: 'present_user', actionCaller: { kind: 'host' },
            });
            expect(recovered, JSON.stringify(recovered)).toMatchObject({ ok: true });
            expect(openRoute).toHaveBeenCalledExactlyOnceWith('/settings/voice/conversations?setting=voiceConversations.agent');
        } finally {
            unsubscribe();
            setVoiceSessionLifecycleController(null);
            await controller.dispose();
        }
    });
});
