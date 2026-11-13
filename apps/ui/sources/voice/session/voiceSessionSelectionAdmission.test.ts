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
import { buildSessionCreationCorrespondence } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { buildCommittedLaunchMetadata, projectCurrentAgentSessionView } from '@happier-dev/agents/session/state/metadataWriters';
import { resolveVoiceIdleTarget } from '@/voice/runtime/voiceTargetStore';
import { SessionActiveModelSelectionSchema } from '@happier-dev/protocol/providers/selection/v2';
import { createSessionRunnerRuntimeStatusFixture } from '@/dev/testkit/fixtures/sessionRunnerRuntimeFixtures';
import { resolveVoiceSessionModelSelection } from '@/voice/agent/resolveVoiceSessionModelSelection';

const restoreModuleLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreModuleLoader());
// Warm the real Action graph outside the interaction deadline.
const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
const { setVoiceSessionLifecycleController, acknowledgeVoiceSessionRuntimeReady } = await import('./voiceSessionLifecycleControllerStore');
const { setVoiceSessionSnapshot, getVoiceSessionPresentedAttemptId } = await import('./voiceSessionStore');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');

describe('Voice Start selection admission through the Action executor', () => {
    registerLocalVoiceEngineHarnessHooks();

    it.each(['canonical', 'legacy'] as const)('starts from the focused configured ACP Session through the public Action target (%s)', async (shape) => {
        setPlatformOs('ios');
        const state = await getStorage();
        const current = state.getState();
        const config = readLocalConversationVoiceSettings(current.settings.voice);
        const agentTarget = { kind: 'agent' as const,
            identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'qa-foldseed-acp' };
        const committed = buildCommittedLaunchMetadata({ options: {
            sessionCreationCorrespondence: buildSessionCreationCorrespondence({
                identity: { callerCreationNamespace: 'user', creationKey: 'voice-configured-acp-root' },
                recipe: { execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/project' } },
                    organization: { folderId: null, tagIds: [] }, agentTarget },
            }), runtimeDescriptorV1: { v: 1, agentId: 'custom-acp', agent: {} },
        }, directory: '/project' });
        const targetKey = 'agent:happier.agent.custom-acp/custom-acp:definition:qa-foldseed-acp';
        const ownerMetadata = { ...projectCurrentAgentSessionView(committed, { agentId: 'custom-acp',
            runtimeDescriptor: { v: 1, agentId: 'custom-acp', agent: {} },
            ...(shape === 'legacy' ? { configuredBackend: { v: 1 as const, backendId: 'qa-foldseed-acp', title: 'QA Voice OpenCode ACP', updatedAt: 1 } } : {}),
        }), sessionModelsV1: { v: 1, agentId: 'custom-acp', updatedAt: 1, currentModelId: 'opencode/big-pickle',
            availableModels: [{ id: 'opencode/big-pickle', name: 'Big Pickle' }],
            activeSelectionV1: SessionActiveModelSelectionSchema.parse({ v: 1, source: 'runtime_apply',
                selection: { agentTargetKey: targetKey, providerConnectionId: null, modelId: 'opencode/big-pickle' },
                runner: { pid: 123, processStartTimeMs: 1000 } }),
        } };
        state.__setState({ sessions: { ...current.sessions, s1: { ...current.sessions.s1,
            metadataLayoutVersion: 1, metadata: { v: 1, agentPresentation: { agentId: 'custom-acp' } }, ownerMetadataView: ownerMetadata,
        } }, settings: { ...current.settings, voice: { ...current.settings.voice, providerId: 'local_conversation',
            ui: { ...current.settings.voice.ui, scopeDefault: 'session' },
            providers: { ...current.settings.voice.providers, local_conversation: { schemaVersion: 1, config: {
                ...config, conversationMode: 'agent', agent: { ...config.agent, agentSource: 'session', stayInVoiceHome: false,
                    chatModelSource: 'session', commitModelSource: 'chat' },
            } } },
        } } });
        const respond = machineRpcWithServerScope.getMockImplementation();
        if (!respond) throw new Error('Expected the canonical Machine RPC boundary');
        machineRpcWithServerScope.mockImplementation(async (request) => request.method === RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET
            ? createSessionRunnerRuntimeStatusFixture({ sessionId: request.payload.sessionId, machineId: request.machineId }) : respond(request));
        await loadLocalVoiceEngineWithCompatState();
        await expect(resolveVoiceSessionModelSelection({ sessionAddress: { serverId: localVoiceHomeId, sessionId: 's1' },
            agentId: 'custom-acp', agentTargetKey: targetKey })).resolves.toMatchObject({ ref: { modelId: 'opencode/big-pickle' } });
        const controller = createVoiceSessionLifecycleController();
        controller.setConfiguredProviderId('local_conversation');
        setVoiceSessionLifecycleController(controller);
        acknowledgeVoiceSessionRuntimeReady(true);
        const unsubscribe = controller.subscribe(() => setVoiceSessionSnapshot(controller.getSnapshot()));
        const target = resolveVoiceIdleTarget({ intent: { kind: 'default' }, scopeDefault: 'session', allowsGlobalStart: true,
            focusedSessionAddress: { serverId: localVoiceHomeId, sessionId: 's1' }, lastFocusedSessionAddress: null });
        const executor = createDefaultActionExecutor({ presentUserActionConfirmation: async () => true });
        try {
            const result = await executor.execute('ui.voice_global.start', { target, expectedAttempt: null }, {
                surface: 'ui', serverId: localVoiceHomeId, authority: 'present_user', actionCaller: { kind: 'host' },
            });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'completed' } });
            expect(controller.getSnapshot()).toMatchObject({ status: 'connected' });
            const spawns = machineRpcWithServerScope.mock.calls.filter(([request]) => request.method === RPC_METHODS.SESSION_SPAWN_NEW);
            expect(spawns).toHaveLength(1);
            expect(spawns[0]![0].payload).toMatchObject({ agentTarget });
        } finally {
            unsubscribe();
            setVoiceSessionLifecycleController(null);
            await controller.dispose();
        }
    });

    it.each([
        { agentId: 'codex', enabled: false },
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
