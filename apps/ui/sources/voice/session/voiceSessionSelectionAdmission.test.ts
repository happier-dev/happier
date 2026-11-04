import {
    getStorage,
    loadLocalVoiceEngineWithCompatState,
    localVoiceHomeId,
    localVoiceSpeechOutputBoundary,
    machineRpcWithServerScope,
    registerLocalVoiceEngineHarnessHooks,
    warmLocalVoiceEngineHarnessGraph,
} from '@/voice/local/localVoiceEngine.testHarness';
import { afterAll, describe, expect, it } from 'vitest';
import { readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const restoreModuleLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreModuleLoader());

describe('Voice Start selection admission through the Action executor', () => {
    registerLocalVoiceEngineHarnessHooks();

    it('keeps an unavailable configured Agent refusal and its setup action at dispatch', async () => {
        const state = await getStorage();
        const settings = state.getState().settings;
        const config = readLocalConversationVoiceSettings(settings.voice);
        const targetKey = 'agent:happier.agent.codex/codex';
        state.__setState({ settings: { ...settings,
            backendEnabledByTargetKey: { ...settings.backendEnabledByTargetKey, [targetKey]: false },
            voice: { ...settings.voice, providerId: 'local_conversation',
                executionMachine: { mode: 'fixed', machineId: 'machine-1' },
                providers: { ...settings.voice.providers, local_conversation: { schemaVersion: 1, config: {
                    ...config, conversationMode: 'agent', agent: { ...config.agent,
                        agentSource: 'agent', agentId: 'codex', agentTargetKey: targetKey,
                        agentIdentity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                    },
                } } },
            },
        } });
        await loadLocalVoiceEngineWithCompatState();
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const { setVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
        const { setVoiceSessionSnapshot } = await import('./voiceSessionStore');
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const controller = createVoiceSessionLifecycleController();
        controller.setConfiguredProviderId('local_conversation');
        setVoiceSessionLifecycleController(controller);
        const unsubscribe = controller.subscribe(() => setVoiceSessionSnapshot(controller.getSnapshot()));
        const executor = createDefaultActionExecutor({ presentUserActionConfirmation: async () => true });
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
            expect(machineRpcWithServerScope.mock.calls.filter(([request]) => request.method === RPC_METHODS.SESSION_SPAWN_NEW)).toEqual([]);
            expect(localVoiceSpeechOutputBoundary.fileRecording.start).not.toHaveBeenCalled();
            expect(localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
        } finally {
            unsubscribe();
            setVoiceSessionLifecycleController(null);
            await controller.dispose();
        }
    });
});
