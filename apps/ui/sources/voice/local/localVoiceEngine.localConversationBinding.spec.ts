import { afterAll } from 'vitest';
import { warmLocalVoiceEngineHarnessGraph } from './localVoiceEngine.testHarness';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SessionCreationTargetPreparationResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import { buildDeferredDaemonProjectionSections, DaemonContributionRegistryProjectionDescribeResponseSchema, PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/metadata/systemSessionV1';
import { VOICE_CONVERSATION_SYSTEM_SESSION_KEY } from '@/voice/persistence/voiceConversationSystemSessionLookup';
import { createDeferred, createMachineFixture, createSessionFixture, waitForTestEvent } from '@/dev/testkit';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { PartialOptions as ElevenLabsStartOptions } from '@elevenlabs/client';
import {
    getStorage, loadLocalVoiceEngineWithCompatState, registerLocalVoiceEngineHarnessHooks,
    machineRpcWithServerScope, localVoiceHomeId, localVoiceSpeechOutputBoundary, replaceLocalVoiceSessionHttpSeed,
    setLocalVoiceHttpResponder,
    waitForLocalVoiceBoundaryEvent,
    emitSpeechRecEvent, expoSpeechSpeak, localVoiceAgentRpc, localVoicePendingEnqueue,
    sessionRpcWithServerScope, speechRecStart, speechRecStop,
} from './localVoiceEngine.testHarness';

// Only the external SDK carrier is held; generated provider activation,
// preparation, ownership and published runtime transitions remain real.
const elevenLabsSdk = vi.hoisted(() => ({ startSession: vi.fn<(options: ElevenLabsStartOptions) => Promise<unknown>>() }));
vi.mock('@elevenlabs/client', () => ({ Conversation: { startSession: elevenLabsSdk.startSession } }));
// The native provider installs its strategy on this third-party SDK entry
// before calling the held carrier; the actual provider strategy stays real.
vi.mock('@elevenlabs/client/internal', () => ({
    setSetupStrategy: vi.fn(), createConnection: vi.fn(), setupWebRTCSession: vi.fn(),
}));

let localVoiceEngine: Awaited<ReturnType<typeof loadLocalVoiceEngineWithCompatState>>;

async function getLocalConversationSnapshot() {
    const { getVoiceAdapterRegistry } = await import('@/voice/session/voiceAdapterRegistry');
    return getVoiceAdapterRegistry().get('local_conversation')?.getSnapshot();
}

async function configureAgentMode(): Promise<void> {
    const storage = await getStorage();
    const previousServerSeedIds = Object.keys(storage.getState().sessions);
    const config = readLocalConversationVoiceSettings(storage.getState().settings.voice);
    storage.__setState({
        settings: {
            ...storage.getState().settings,
            voice: {
                ...storage.getState().settings.voice,
                providerId: 'local_conversation',
                executionMachine: { mode: 'fixed', machineId: 'machine-1' },
                providers: {
                    ...storage.getState().settings.voice.providers,
                    local_conversation: { schemaVersion: 1, config: {
                        ...config,
                        conversationMode: 'agent',
                        agent: {
                            ...config.agent,
                            prewarmOnConnect: false,
                        },
                    } },
                },
            },
        },
        // Withhold the hidden carrier from the HTTP source so the real binding
        // owner must prepare it through canonical Session creation.
        sessions: { 'session-1': createSessionFixture({ id: 'session-1', serverId: localVoiceHomeId,
            active: true, presence: 'online', metadata: { machineId: 'machine-1', path: '/workspace/project', host: 'voice.test',
                flavor: 'claude', agentRuntimeCapabilitiesV1: { localControl: { supported: true } },
            } }) },
    });
    for (const id of [...previousServerSeedIds, 'session-1']) replaceLocalVoiceSessionHttpSeed(id);
}

type MachineRequest = Readonly<{ method: string; payload: unknown; machineId: string; serverId: string }>;
function interceptVoiceSpawn(beforeReply: (request: MachineRequest) => Promise<void>) {
    const incumbent = machineRpcWithServerScope.getMockImplementation();
    if (!incumbent) throw new Error('Missing canonical machine Socket boundary');
    machineRpcWithServerScope.mockImplementation(async (request: MachineRequest) => {
        if (request.method === RPC_METHODS.SESSION_SPAWN_NEW) {
            SessionSpawnNewInputV2Schema.parse(request.payload);
            await beforeReply(request);
        }
        return incumbent(request);
    });
}

const restoreHarnessModuleLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreHarnessModuleLoader());

describe('local voice engine local conversation binding', () => {
    registerLocalVoiceEngineHarnessHooks();

    beforeEach(async () => {
        localVoiceEngine = await loadLocalVoiceEngineWithCompatState();
    }, 180_000);

    it('uses the configured Voice Machine on Home Start when the last conversation belongs to another Machine on the same Account', async () => {
        await configureAgentMode();
        const storage = await getStorage();
        const voice = storage.getState().settings.voice;
        const config = readLocalConversationVoiceSettings(voice);
        const previousConversation = createSessionFixture({ id: 'previous-voice-conversation', serverId: localVoiceHomeId,
            active: true, meaningfulActivityAt: Date.now(), metadata: {
                ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }),
                machineId: 'previous-machine', path: '/previous/voice-home', host: 'previous.test', flavor: 'claude',
                permissionMode: config.agent.permissionIntent,
            } });
        storage.__setState({
            machines: { ...storage.getState().machines,
                'previous-machine': createMachineFixture({ ...storage.getState().machines['machine-1'], id: 'previous-machine' }),
            },
            sessions: { ...storage.getState().sessions, [previousConversation.id]: previousConversation },
            settings: { ...storage.getState().settings, voice: { ...voice,
                providers: { ...voice.providers, local_conversation: { schemaVersion: 1, config: { ...config,
                    agent: { ...config.agent, rootSessionPolicy: 'continue' },
                } } },
            } },
        });
        replaceLocalVoiceSessionHttpSeed(previousConversation.id, createPlainSessionCurrentProjectionRecordFixture({
            id: previousConversation.id, active: true, metadataVersion: previousConversation.metadataVersion,
            metadata: previousConversation.metadata,
        }));
        const { resolveVoiceExecutionMachineSelectionFromState } = await import('@/voice/settings/executionMachine');
        expect(resolveVoiceExecutionMachineSelectionFromState(storage.getState())).toEqual({ kind: 'resolved', machineId: 'machine-1' });
        const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
        const lifecycle = createVoiceSessionLifecycleController();
        lifecycle.setConfiguredProviderId('local_conversation');
        try {
            let failure: unknown;
            await lifecycle.toggle(null).catch(error => { failure = error; });
            const catalogRequests = machineRpcWithServerScope.mock.calls.map(([request]) => request)
                .filter(request => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
            expect(catalogRequests.length).toBeGreaterThan(0);
            expect([...new Set(catalogRequests.map(request => request.machineId))]).toEqual(['machine-1']);
            const spawns = machineRpcWithServerScope.mock.calls.map(([request]) => request)
                .filter(request => request.method === RPC_METHODS.SESSION_SPAWN_NEW);
            expect(spawns).toHaveLength(1);
            expect(spawns[0]).toMatchObject({ machineId: 'machine-1', payload: { executionTarget: { machineId: 'machine-1' } } });
            expect(failure).toBeUndefined();
            expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
        } finally {
            await lifecycle.dispose();
        }
    }, 60_000);

    it('resolves agent-mode device speech through the hidden global control session despite an offline speech Machine', async () => {
        await configureAgentMode();
        const storage = await getStorage();
        const voice = storage.getState().settings.voice;
        const config = readLocalConversationVoiceSettings(voice);
        storage.__setState({ settings: { ...storage.getState().settings, voice: { ...voice,
            executionMachine: { mode: 'fixed', machineId: 'speech-offline' },
            providers: { ...voice.providers, local_conversation: { schemaVersion: 1, config: { ...config,
                stt: { ...config.stt, provider: 'device' },
                tts: { ...config.tts, provider: 'device' },
            } } },
        } } });

        await localVoiceEngine.toggleLocalVoiceTurn('session-1');

        const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
        await waitForTestEvent(voiceSessionBindingStore.subscribe,
            () => voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID),
            binding => binding?.conversationSessionId === 'voice-home-session');
        expect(voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID)).toMatchObject({
                adapterId: 'local_conversation',
                controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                conversationSessionId: 'voice-home-session',
                targetSessionAddress: { serverId: localVoiceHomeId, sessionId: 'session-1' },
        });
    }, 60_000);

    it('keeps the lifecycle, working binding and permission delivery on the Session opened by Voice', async () => {
        await configureAgentMode();
        const state = await getStorage();
        const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
        const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
        const { setPrimaryActionSessionId } = await import('@/voice/tools/actionImpl/sessionTargets');
        const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
        const { resolveEffectiveVoiceTargetState } = await import('@/voice/context/resolveEffectiveVoiceTargetState');
        const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
        const lifecycle = createVoiceSessionLifecycleController();
        lifecycle.setConfiguredProviderId('local_conversation');
        const first = { serverId: localVoiceHomeId, sessionId: 'session-1' };
        const second = { serverId: localVoiceHomeId, sessionId: 'session-2' };
        try {
            await lifecycle.toggle(first);
            setVoiceSessionSnapshot(lifecycle.getSnapshot());
            state.__setState({ sessions: { ...state.getState().sessions,
                [second.sessionId]: createSessionFixture({ id: second.sessionId, serverId: second.serverId,
                    active: true, presence: 'online', metadata: { machineId: 'machine-1', path: '/second', host: 'voice.test' } }),
            } });
            expect(await setPrimaryActionSessionId({ ...second, updateLastFocused: true })).toMatchObject({ ok: true });
            expect(voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID)?.targetSessionAddress).toEqual(second);
            expect(lifecycle.getAttemptTargetSessionAddress()).toEqual(second);
            // A stale focus projection cannot make two Sessions the current permission target.
            useVoiceTargetStore.getState().setPrimaryActionSessionAddress(first);
            expect(resolveEffectiveVoiceTargetState(first).primaryActionSessionAddress).toEqual(second);
            expect(resolveEffectiveVoiceTargetState(second).primaryActionSessionAddress).toEqual(second);
        } finally {
            await lifecycle.dispose();
        }
    });

    it.each(['stt', 'tts'] as const)('explains an offline daemon %s Machine on Home Start before preparing a carrier on the online root Machine', async (surface) => {
        await configureAgentMode();
        const storage = await getStorage();
        const voice = storage.getState().settings.voice;
        const config = readLocalConversationVoiceSettings(voice);
        storage.__setState({
            machines: { ...storage.getState().machines,
                'speech-offline': createMachineFixture({ id: 'speech-offline', active: false, activeAt: 1 }),
            },
            settings: { ...storage.getState().settings, voice: { ...voice,
                executionMachine: { mode: 'fixed', machineId: 'speech-offline' },
                providers: { ...voice.providers, local_conversation: { schemaVersion: 1, config: { ...config,
                    stt: { ...config.stt, provider: surface === 'stt' ? 'local_neural' : 'device', localNeural: {
                        ...config.stt.localNeural, execution: 'daemon',
                    } },
                    tts: { ...config.tts, provider: surface === 'tts' ? 'local_neural' : 'device',
                        autoSpeakReplies: true, localNeural: { ...config.tts.localNeural, execution: 'daemon' } },
                } } },
            } },
        });
        const { resolveVoiceExecutionMachineSelectionFromState } = await import('@/voice/settings/executionMachine');
        expect(resolveVoiceExecutionMachineSelectionFromState(storage.getState())).toEqual({
            kind: 'selected_unreachable', machineId: 'speech-offline',
        });
        const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
        const { resolveVoiceMachineErrorTranslationKey } = await import('@/voice/runtime/machine/voiceMachineErrorCopy');
        const lifecycle = createVoiceSessionLifecycleController();
        lifecycle.setConfiguredProviderId('local_conversation');
        let failure: unknown;
        try {
            await lifecycle.toggle(null).catch(error => { failure = error; });

            const snapshot = lifecycle.getSnapshot();
            expect(snapshot).toMatchObject({
                status: 'error', canStop: false,
                errorCode: 'execution_machine_unavailable', errorRecoveryAction: 'select_execution_machine',
            });
            expect(resolveVoiceMachineErrorTranslationKey('execution_machine_unavailable', snapshot.errorMessage ?? undefined))
                .toBe('voice.readiness.execution_machine_incompatible');
            expect(failure).toMatchObject({ code: 'VOICE_AGENT_TARGET_MACHINE_OFFLINE' });
            expect(machineRpcWithServerScope.mock.calls.filter(([request]) => request.method === RPC_METHODS.SESSION_SPAWN_NEW)).toEqual([]);
            expect(localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
        } finally {
            await lifecycle.dispose();
        }
    }, 60_000);

    it('settles Global Start with a typed machine refusal without a timer when device speech has no Agent machine', async () => {
        await configureAgentMode();
        const storage = await getStorage();
        const voice = storage.getState().settings.voice;
        const config = readLocalConversationVoiceSettings(voice);
        storage.__setState({ settings: { ...storage.getState().settings, voice: { ...voice,
            executionMachine: { mode: 'fixed', machineId: null },
            providers: { ...voice.providers, local_conversation: { schemaVersion: 1, config: { ...config,
                stt: { ...config.stt, provider: 'device' }, tts: { ...config.tts, provider: 'device' },
            } } },
        } } });
        const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
        const lifecycle = createVoiceSessionLifecycleController();
        lifecycle.setConfiguredProviderId('local_conversation');
        const scheduled = vi.spyOn(globalThis, 'setTimeout');
        let failure: unknown;
        try {
            await lifecycle.toggle(null).catch(error => { failure = error; });
            expect(lifecycle.getSnapshot()).toMatchObject({
                status: 'error', canStop: false,
                errorCode: 'execution_machine_unavailable', errorRecoveryAction: 'select_execution_machine',
            });
            expect(failure).toMatchObject({ code: 'VOICE_CONVERSATION_TARGET_MISSING' });
            expect(scheduled.mock.calls.filter(([, delay]) => delay === 100)).toHaveLength(0);
            expect(machineRpcWithServerScope.mock.calls.filter(([request]) => request.method === RPC_METHODS.SESSION_SPAWN_NEW)).toEqual([]);
            expect(localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
        } finally {
            scheduled.mockRestore();
            await lifecycle.dispose();
        }
    }, 60_000);

    it('publishes connecting for a targetless lifecycle start and admits its host-owned Voice Home creation', async () => {
        await configureAgentMode();
        const storage = await getStorage();
        storage.__setState({ settings: { ...storage.getState().settings,
            actionsSettingsV1: { v: 1, actions: {
                'session.spawn_new': { approvalRequiredSurfaces: ['voice'] },
            } },
        } });
        let resolveBinding!: () => void;
        interceptVoiceSpawn(async () => {
            await new Promise<void>((resolve) => {
                resolveBinding = resolve;
            });
        });

        const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
        const lifecycle = createVoiceSessionLifecycleController();
        lifecycle.setConfiguredProviderId('local_conversation');
        const start = lifecycle.toggle(null);
        await Promise.race([start, waitForLocalVoiceBoundaryEvent(`rpc:${RPC_METHODS.SESSION_SPAWN_NEW}`)]);
        expect(resolveBinding).toBeTypeOf('function');
        const preparingSnapshot = await getLocalConversationSnapshot();
        resolveBinding();
        await start;

        expect(preparingSnapshot).toMatchObject({
            adapterId: 'local_conversation',
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            status: 'connecting',
            canStop: true,
        });
        expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
        await lifecycle.dispose();
    }, 60_000);

    it('starts Home Voice in a managed directory after its native UI confirmation without an approval Artifact', async () => {
        await configureAgentMode();
        const storage = await getStorage();
        storage.__setState({ settings: { ...storage.getState().settings,
            actionsSettingsV1: { v: 1, actions: {
                'session.spawn_new': { approvalRequiredSurfaces: ['ui'] },
            } },
        } });
        const { createArtifactStoreBoundary } = await import('@/dev/testkit/harness/artifactStoreBoundary');
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
        setLocalVoiceHttpResponder(request => artifacts.handle(request.path, {
            method: request.method, headers: request.headers,
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        }) ?? undefined);
        // A fresh Machine has not created the old Voice-specific path. Keep
        // the real Action preflight and policy beneath the Socket boundary.
        const incumbent = machineRpcWithServerScope.getMockImplementation();
        if (!incumbent) throw new Error('Missing canonical machine Socket boundary');
        machineRpcWithServerScope.mockImplementation(async (request: MachineRequest) => {
            const result = await incumbent(request);
            return request.method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT
                ? SessionCreationTargetPreparationResultV1Schema.parse({ ...result, directoryCreationRequired: true })
                : result;
        });
        const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
        const { Modal } = await import('@/modal');
        const shown = createDeferred<Parameters<typeof Modal.show>[0]>();
        const unregister = Modal.registerProvider({
            showModal: config => { shown.resolve(config as Parameters<typeof Modal.show>[0]); return 'home-carrier-confirmation'; },
            hideModal: () => {}, hideAllModals: () => {}, updateCustomModalProps: () => {},
        });
        const lifecycle = createVoiceSessionLifecycleController();
        lifecycle.setConfiguredProviderId('local_conversation');
        try {
            const starting = lifecycle.toggle(null);
            const confirmation = await Promise.race([shown.promise, starting.then(() => {
                throw new Error('Start settled without its native UI confirmation');
            })]);
            expect(confirmation.type).toBe('confirm');
            expect(artifacts.list()).toEqual([]);
            expect(machineRpcWithServerScope.mock.calls.some(([request]) => request.method === RPC_METHODS.SESSION_SPAWN_NEW)).toBe(false);
            Modal.resolveConfirm('home-carrier-confirmation', true);
            await starting;
            expect(lifecycle.getSnapshot()).toMatchObject({
                status: 'connected', mode: 'listening', canStop: true,
            });
            expect(lifecycle.getSnapshot().errorCode).toBeUndefined();
            expect(artifacts.list()).toEqual([]);
            expect(machineRpcWithServerScope.mock.calls.filter(([request]) => request.method === RPC_METHODS.SESSION_SPAWN_NEW))
                .toEqual([[expect.objectContaining({ machineId: 'machine-1', serverId: localVoiceHomeId,
                    payload: expect.objectContaining({ directory: { kind: 'managed' } }),
                })]]);
        } finally {
            await lifecycle.dispose();
            unregister();
        }
    }, 60_000);

    it('keeps the carrier native confirmation visible during Start and stops preparation when declined', async () => {
        await configureAgentMode();
        const { createArtifactStoreBoundary } = await import('@/dev/testkit/harness/artifactStoreBoundary');
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
        setLocalVoiceHttpResponder(request => artifacts.handle(request.path, {
            method: request.method, headers: request.headers,
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        }) ?? undefined);
        const incumbent = machineRpcWithServerScope.getMockImplementation();
        if (!incumbent) throw new Error('Missing canonical machine Socket boundary');
        machineRpcWithServerScope.mockImplementation(async (request: MachineRequest) => {
            const result = await incumbent(request);
            return request.method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT
                ? SessionCreationTargetPreparationResultV1Schema.parse({ ...result, directoryCreationRequired: true })
                : result;
        });
        const { Modal } = await import('@/modal');
        const shown = createDeferred<Parameters<typeof Modal.show>[0]>();
        // Present through the real Modal owner, replacing only its mounted host.
        const unregister = Modal.registerProvider({
            showModal: config => { shown.resolve(config as Parameters<typeof Modal.show>[0]); return 'carrier-review'; },
            hideModal: () => {}, hideAllModals: () => {}, updateCustomModalProps: () => {},
        });
        const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
        const { setVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleControllerStore');
        const lifecycle = createVoiceSessionLifecycleController();
        lifecycle.setConfiguredProviderId('local_conversation');
        setVoiceSessionLifecycleController(lifecycle);
        const starting = lifecycle.toggle({ serverId: localVoiceHomeId, sessionId: 'session-1' });
        try {
            const confirmation = await Promise.race([shown.promise, starting.then(() => {
                throw new Error('Start settled without showing its native UI confirmation');
            })]);
            expect(confirmation.type).toBe('confirm');
            expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connecting', canStop: true });
            expect(lifecycle.getSnapshot().errorCode).toBeUndefined();
            // 02102e614e: present-user product confirmation has no agent approval Artifact.
            expect(artifacts.list()).toEqual([]);
            expect(machineRpcWithServerScope.mock.calls.some(([request]) => request.method === RPC_METHODS.SESSION_SPAWN_NEW)).toBe(false);
            Modal.resolveConfirm('carrier-review', false);
            await starting;
            expect(lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
            expect(lifecycle.getSnapshot().errorCode).toBeUndefined();
            expect(machineRpcWithServerScope.mock.calls.some(([request]) => request.method === RPC_METHODS.SESSION_SPAWN_NEW)).toBe(false);
        } finally {
            await lifecycle.dispose();
            setVoiceSessionLifecycleController(null);
            unregister();
        }
    }, 60_000);

    it.each([false, true])('answers or diagnoses the first spoken turn after End and Continue on the retained carrier (enqueue failure=%s)', async (enqueueFails) => {
        await configureAgentMode();
        const storage = await getStorage();
        const voice = storage.getState().settings.voice;
        const config = readLocalConversationVoiceSettings(voice);
        storage.__setState({ settings: { ...storage.getState().settings, voice: { ...voice,
            providers: { ...voice.providers, local_conversation: { schemaVersion: 1, config: { ...config,
                handsFree: { ...config.handsFree, enabled: false },
                stt: { ...config.stt, provider: 'device' },
                tts: { ...config.tts, provider: 'device', autoSpeakReplies: true },
            } } },
        } } });
        speechRecStart.mockImplementation(() => emitSpeechRecEvent('audiostart'));
        speechRecStop.mockImplementation(() => emitSpeechRecEvent('end'));
        expoSpeechSpeak.mockImplementation((_text, options) => { options.onStart?.(); options.onDone?.(); });
        const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
        const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
        const { voiceAgentSessions } = await import('@/voice/agent/voiceAgentSessions');
        const lifecycle = createVoiceSessionLifecycleController();
        lifecycle.setConfiguredProviderId('local_conversation');
        const target = { serverId: localVoiceHomeId, sessionId: 'session-1' };
        const admissions = () => sessionRpcWithServerScope.mock.calls.filter(([request]) =>
            request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START
            || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1);
        const streams = () => sessionRpcWithServerScope.mock.calls.filter(([request]) =>
            request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START
            || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2);
        try {
            await lifecycle.toggle(target);
            expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
            const binding = voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID);
            expect(binding?.conversationSessionId).toBe('voice-home-session');
            emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'Say number three', confidence: 0.9 }] });
            await lifecycle.commitInput(VOICE_AGENT_GLOBAL_SESSION_ID);
            expect(expoSpeechSpeak.mock.calls.map(([text]) => text)).toContain('Daemon reply');
            expect(admissions()).toHaveLength(1);
            expect(streams()).toHaveLength(1);
            await lifecycle.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
            expect(lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
            expect(voiceAgentSessions.isActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(false);
            expect(localVoiceAgentRpc.readRetainedRun()).toBeNull();
            const continuedStart = waitForLocalVoiceBoundaryEvent('agent-start', 2);
            await lifecycle.toggle(target);
            await continuedStart;
            expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
            const speechBeforeContinue = expoSpeechSpeak.mock.calls.length;
            if (enqueueFails) {
                // RUN112's public HTTP response, without its private database diagnostics.
                setLocalVoiceHttpResponder(request => {
                    if (request.method === 'POST' && request.path === '/v2/sessions/voice-home-session/pending') {
                        return Response.json({ error: 'transaction-unavailable', retryAfterMs: 1000,
                            correlationId: 'PRIVATE_CORRELATION_ID' }, { status: 503 });
                    }
                    return undefined;
                });
            }
            emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'Say number four', confidence: 0.9 }] });
            const continuedTurn = lifecycle.commitInput(VOICE_AGENT_GLOBAL_SESSION_ID);
            if (enqueueFails) {
                // False names native/provider dispatch, never the HTTP persistence outcome.
                await expect(continuedTurn).rejects.toMatchObject({ code: 'voice_turn_pending', effectAttempted: false,
                    failureCause: { phase: 'voice.pending.enqueue', errorClass: 'Error', errorCode: null, httpStatus: 503 } });
                expect(lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected', errorMessage: 'voice_turn_pending',
                    errorEffectAttempted: false, errorFailureCause: { phase: 'voice.pending.enqueue', errorClass: 'Error',
                        errorCode: null, httpStatus: 503 } });
                expect(streams()).toHaveLength(1);
                const { loadPendingOutboxForSession } = await import('@/sync/domains/state/pendingOutboxPersistence');
                const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
                const scope = captureActiveServerAccountScopeLifetime()?.scope;
                if (!scope) throw new Error('Expected continued Voice Account scope');
                expect(await loadPendingOutboxForSession('voice-home-session', scope)).toHaveLength(1);
                expect(admissions()).toHaveLength(2);
                expect(expoSpeechSpeak.mock.calls).toHaveLength(speechBeforeContinue);
                expect(JSON.stringify(lifecycle.getSnapshot())).not.toContain('PRIVATE_CORRELATION_ID');
                expect(voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID)).toEqual(binding);
                return;
            }
            await continuedTurn;
            expect(localVoicePendingEnqueue.mock.calls.map(([request]) => request.sessionId))
                .toEqual(['voice-home-session', 'voice-home-session']);
            expect(streams()).toHaveLength(2);
            expect(streams()[1]?.[0]).toMatchObject({ sessionId: binding?.conversationSessionId,
                payload: { runId: localVoiceAgentRpc.readRetainedRun()?.runId, message: expect.stringContaining('Say number four') } });
            expect(expoSpeechSpeak.mock.calls.slice(speechBeforeContinue).map(([text]) => text)).toContain('Daemon reply');
            expect(admissions()).toHaveLength(2);
            expect(localVoiceAgentRpc.readRetainedRun()?.status).toBe('running');
            expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
            expect(voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID))
                .toEqual(binding);
            expect(machineRpcWithServerScope.mock.calls.filter(([request]) => request.method === RPC_METHODS.SESSION_SPAWN_NEW))
                .toHaveLength(1);
            expect(machineRpcWithServerScope.mock.calls.filter(([request]) => request.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE
                || request.method === RPC_METHODS.SPAWN_HAPPY_SESSION))
                .toEqual([expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({
                    type: 'resume-session', sessionId: binding?.conversationSessionId,
                }) })])]);
            expect(localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBeGreaterThan(0);
        } finally {
            setLocalVoiceHttpResponder(null);
            await lifecycle.dispose();
        }
    }, 60_000);

    it('keeps the typed resume failure when a same-target restart loses its RPC outcome', async () => {
        await configureAgentMode();
        const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
        const lifecycle = createVoiceSessionLifecycleController();
        lifecycle.setConfiguredProviderId('local_conversation');
        const target = { serverId: localVoiceHomeId, sessionId: 'session-1' };
        const incumbent = machineRpcWithServerScope.getMockImplementation();
        if (!incumbent) throw new Error('Missing canonical machine Socket boundary');
        try {
            await lifecycle.toggle(target);
            await lifecycle.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
            machineRpcWithServerScope.mockImplementation(async (request: MachineRequest) => {
                if (request.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE
                    || request.method === RPC_METHODS.SPAWN_HAPPY_SESSION) {
                    throw createRpcCallError({ error: 'Private transport detail at /Users/private/repository',
                        errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
                }
                return incumbent(request);
            });

            await expect(lifecycle.toggle(target)).rejects.toMatchObject({ code: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
            expect(lifecycle.getSnapshot()).toMatchObject({
                status: 'disconnected', canStop: false, errorCode: 'provider_error',
                errorMessage: RPC_ERROR_CODES.OUTCOME_UNKNOWN, errorRecoveryAction: 'retry',
            });
            expect(machineRpcWithServerScope.mock.calls.filter(([request]) => request.method === RPC_METHODS.SESSION_SPAWN_NEW))
                .toHaveLength(1);
            expect(localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
            expect(JSON.stringify(lifecycle.getSnapshot())).not.toContain('/Users/private');
        } finally {
            machineRpcWithServerScope.mockImplementation(incumbent);
            await lifecycle.dispose();
        }
    }, 60_000);

    it.each([
        { scope: 'global', fromHistory: false, unreachable: false },
        { scope: 'scoped', fromHistory: false, unreachable: false },
        { scope: 'global', fromHistory: true, unreachable: false },
        { scope: 'scoped', fromHistory: true, unreachable: false },
        { scope: 'global', fromHistory: false, unreachable: true },
    ] as const)('R43 archived $scope Start (History: $fromHistory; unreachable: $unreachable) waits for a serviceable carrier', async ({ scope, fromHistory, unreachable }) => {
        await configureAgentMode();
        const storage = await getStorage();
        const voice = storage.getState().settings.voice;
        const config = readLocalConversationVoiceSettings(voice);
        storage.__setState({ settings: { ...storage.getState().settings, voice: { ...voice,
            providers: { ...voice.providers, local_conversation: { schemaVersion: 1, config: { ...config,
                agent: { ...config.agent, stayInVoiceHome: false },
            } } },
        } } });
        const incumbent = machineRpcWithServerScope.getMockImplementation();
        if (!incumbent) throw new Error('Missing canonical machine Socket boundary');
        const { readVoiceSessionOwnerMetadataFromState } = await import('@/voice/shared/readVoiceSessionOwnerMetadata');
        const seedArchive = (sessionId: string, archivedAt: number | null) => {
            const session = storage.getState().sessions[sessionId]!;
            replaceLocalVoiceSessionHttpSeed(sessionId, createPlainSessionCurrentProjectionRecordFixture({
                id: sessionId, active: false, archivedAt, metadataVersion: session.metadataVersion,
                metadata: readVoiceSessionOwnerMetadataFromState(storage.getState(), sessionId),
            }));
        };
        const resumeReady = createDeferred<void>();
        const resumeEntered = createDeferred<void>();
        let holdResume = false;
        machineRpcWithServerScope.mockImplementation(async (request: MachineRequest) => {
            if (request.method === RPC_METHODS.SPAWN_HAPPY_SESSION || request.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE) {
                const payload = request.payload as { sessionId: string };
                if (storage.getState().sessions[payload.sessionId]?.archivedAt != null) {
                    return { type: 'error', errorCode: 'target_unavailable', errorMessage: 'target_unavailable' };
                }
                if (holdResume) {
                    resumeEntered.resolve();
                    await resumeReady.promise;
                    if (unreachable) throw createRpcCallError({ error: 'transport unavailable', errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE });
                }
            }
            if (request.method !== RPC_METHODS.SESSION_SPAWN_NEW) return incumbent(request);
            const rejoining = storage.getState().sessions['voice-home-session']?.archivedAt != null;
            const result = SessionSpawnNewResultV1Schema.parse(await incumbent(request));
            if (result.type !== 'success' || !rejoining) return result;
            // The real creation service authenticates the recipe then restores
            // the same tag-owned Session. Its process/HTTP boundary is substituted here.
            const session = storage.getState().sessions[result.sessionId]!;
            storage.__setState({ sessions: { ...storage.getState().sessions,
                [session.id]: { ...session, archivedAt: null, active: false },
            } });
            seedArchive(session.id, null);
            return { ...result, disposition: 'rejoined' };
        });
        setLocalVoiceHttpResponder(request => request.path.endsWith('/unarchive')
            ? Response.json({ success: true, archivedAt: null })
            : request.path.endsWith('/archive') ? Response.json({ success: true, archivedAt: 1234 }) : undefined);
        const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
        const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
        const { sessionArchiveWithServerScope } = await import('@/sync/ops/sessions');
        const lifecycle = createVoiceSessionLifecycleController();
        lifecycle.setConfiguredProviderId('local_conversation');
        const target = scope === 'global' ? null : { serverId: localVoiceHomeId, sessionId: 'session-1' };
        try {
            await lifecycle.toggle(target);
            const first = voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID)!;
            const history = readVoiceSessionOwnerMetadataFromState(storage.getState(), first.conversationSessionId);
            if (!history) throw new Error('Expected admitted Voice conversation metadata');
            await lifecycle.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
            const carrier = storage.getState().sessions[first.conversationSessionId]!;
            storage.__setState({ sessions: { ...storage.getState().sessions,
                [carrier.id]: { ...carrier, active: false },
            } });
            expect(await sessionArchiveWithServerScope(carrier.id, { serverId: localVoiceHomeId })).toMatchObject({ success: true });
            seedArchive(carrier.id, 1234);
            if (fromHistory) {
                // Explicit continuation must retain A even after today's recipe
                // changes and a newer compatible B is available to idle Start.
                const currentVoice = storage.getState().settings.voice;
                const currentConfig = readLocalConversationVoiceSettings(currentVoice);
                const newerMetadata = { machineId: history.machineId, path: history.path, host: 'voice.test',
                    flavor: history.flavor, connectedServices: history.connectedServices,
                    voiceConversationScopeV1: history.voiceConversationScopeV1,
                    systemSessionV1: history.systemSessionV1, permissionMode: 'safe-yolo' } satisfies NonNullable<ReturnType<typeof createSessionFixture>['metadata']>;
                const newer = createSessionFixture({ id: 'voice-current-session', serverId: localVoiceHomeId,
                    active: true, presence: 'online', updatedAt: carrier.updatedAt + 1, metadata: newerMetadata });
                storage.__setState({ sessions: { ...storage.getState().sessions, [newer.id]: newer },
                    settings: { ...storage.getState().settings, voice: { ...currentVoice,
                        providers: { ...currentVoice.providers, local_conversation: { schemaVersion: 1,
                            config: { ...currentConfig, agent: { ...currentConfig.agent, permissionIntent: 'safe-yolo' } } } },
                    } } });
                replaceLocalVoiceSessionHttpSeed(newer.id, createPlainSessionCurrentProjectionRecordFixture({
                    id: newer.id, active: true, archivedAt: null, metadata: newerMetadata,
                }));
            }
            holdResume = true;
            const restart = lifecycle.toggle(fromHistory ? { serverId: localVoiceHomeId, sessionId: carrier.id } : target);
            const outcome = restart.then(() => null, error => error);
            await Promise.race([outcome, resumeEntered.promise]);
            const preparing = lifecycle.getSnapshot();
            const leasesBeforeReady = localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount;
            const createsBeforeResumeReply = machineRpcWithServerScope.mock.calls
                .filter(([request]) => request.method === RPC_METHODS.SESSION_SPAWN_NEW).length;
            resumeReady.resolve();
            const error = await outcome;
            expect(preparing).toMatchObject({ status: 'connecting', canStop: true });
            expect(leasesBeforeReady).toBe(0);
            if (unreachable) {
                // This boundary has already accepted the Resume request. A
                // thrown Socket reply cannot prove the mutation did not run.
                expect(error).toMatchObject({ code: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
                expect(lifecycle.getSnapshot()).toMatchObject({ canStop: false,
                    errorCode: 'provider_error', errorRecoveryAction: 'retry' });
                expect(localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
                expect(machineRpcWithServerScope.mock.calls.filter(([request]) => request.method === RPC_METHODS.SESSION_SPAWN_NEW))
                    .toHaveLength(createsBeforeResumeReply);
                expect(storage.getState().sessions[carrier.id]?.archivedAt).toBeNull();
                return;
            }
            expect(error).toBeNull();
            const next = voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID)!;
            expect(next.conversationSessionId).toBe(first.conversationSessionId);
            expect(next.conversationSessionAddress).toEqual(first.conversationSessionAddress);
            expect(next.targetSessionAddress).toEqual(first.targetSessionAddress);
            expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
            expect(storage.getState().sessions[carrier.id]?.archivedAt).toBeNull();
            expect(readVoiceSessionOwnerMetadataFromState(storage.getState(), carrier.id)?.voiceConversationScopeV1)
                .toEqual(history?.voiceConversationScopeV1);
            expect(storage.getState().sessions[next.conversationSessionId]?.archivedAt).toBeNull();
        } finally {
            resumeReady.resolve();
            await lifecycle.dispose();
            machineRpcWithServerScope.mockImplementation(incumbent);
        }
    }, 60_000);

    it('surfaces a safe retryable error when hidden Voice Home preparation fails', async () => {
        await configureAgentMode();
        const preparationFailure = Object.assign(
            new Error('machine unavailable at /Users/private/repository'),
            { code: 'VOICE_AGENT_BACKEND_TARGET_UNAVAILABLE' },
        );
        interceptVoiceSpawn(async () => { throw preparationFailure; });

        // Producer-declared Action codes survive failure projection (2b34aa788d7);
        // the Voice boundary keeps that typed cause without private error prose.
        await expect(localVoiceEngine.toggleLocalVoiceTurn('')).rejects.toMatchObject({ code: preparationFailure.code });

        expect(await getLocalConversationSnapshot()).toMatchObject({
            adapterId: 'local_conversation',
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            status: 'disconnected',
            errorCode: 'provider_error',
            errorMessage: preparationFailure.code,
            errorRecoveryAction: 'retry',
        });
        const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
        expect(getVoiceConversationRuntimeSnapshot().error).toHaveProperty('cause.code', preparationFailure.code);
        expect(JSON.stringify(getVoiceConversationRuntimeSnapshot().error)).not.toContain(preparationFailure.message);
    }, 60_000);

    it.each(['spawn', 'resume', 'lazy-run'] as const)('refreshes the admitted Agent inventory after a signed-out %s refusal', async ingress => {
        await configureAgentMode();
        const storage = await getStorage();
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
        const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
        const { refreshMachineAgents, readMachineAgentsForScope } = await import('@/agents/machineAgents/useMachineAgents');
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Missing admitted Voice Account');
        const machine = storage.getState().machines['machine-1'];
        if (!machine) throw new Error('Missing admitted Voice Machine');
        await publishMachineInventoryForTest(lifetime.scope, [machine]);
        const projection = buildDeferredDaemonProjectionSections(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1, projectionDigest: 'a'.repeat(64), projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1,
                agentsById: Object.fromEntries(['claude', 'codex'].map(agentId => [agentId, {
                    id: agentId, title: agentId, identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[agentId as 'claude' | 'codex'],
                    capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
                }])),
            }),
        }));
        let signedOut = false;
        let refuseLaunch = ingress !== 'resume';
        const incumbent = machineRpcWithServerScope.getMockImplementation();
        if (!incumbent) throw new Error('Missing canonical machine Socket boundary');
        machineRpcWithServerScope.mockImplementation(async (request: MachineRequest) => {
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                const input = request.payload as { sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] } };
                return input.sectionRead ? projection.read(input.sectionRead.digest, input.sectionRead.offset, input.sectionRead.includeDigests) : projection.manifest;
            }
            if (request.method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1,
                results: Object.fromEntries(['claude', 'codex'].map(agentId => [`cli.${agentId}`, { ok: true, checkedAt: Date.now(), data: {
                    agentId, title: agentId, installed: true, available: true, version: '1', latestVersion: '1',
                    update: { supported: false, command: null }, platform: { supported: true }, dependencies: [],
                    install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null },
                    signIn: { status: signedOut && agentId === 'claude' ? 'signedOut' : 'signedIn', loginSupport: 'login_terminal' },
                } }])) };
            if (refuseLaunch && (ingress === 'spawn' && request.method === RPC_METHODS.SESSION_SPAWN_NEW
                || ingress === 'resume' && (request.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE
                    || request.method === RPC_METHODS.SPAWN_HAPPY_SESSION))) {
                signedOut = true;
                if (ingress === 'resume') return { type: 'error', errorCode: 'agent_signed_out', errorMessage: 'agent_signed_out' };
                SessionSpawnNewInputV2Schema.parse(request.payload);
                return SessionSpawnNewResultV1Schema.parse({
                    type: 'error', code: 'agent_signed_out', agentId: 'claude', retryable: false,
                });
            }
            return incumbent(request);
        });
        const sessionIncumbent = sessionRpcWithServerScope.getMockImplementation();
        if (!sessionIncumbent) throw new Error('Missing canonical Session Socket boundary');
        sessionRpcWithServerScope.mockImplementation(async request => {
            if (ingress === 'lazy-run' && (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START
                || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1)) {
                signedOut = true;
                return { ok: false, errorCode: 'agent_signed_out', error: 'agent_signed_out' };
            }
            return sessionIncumbent(request);
        });
        publishMachineContributionRegistryProjectionInvalidation({ machineId: machine.id, serverId: lifetime.scope.serverId });
        await refreshMachineAgents({ serverId: lifetime.scope.serverId, machineId: machine.id, accountLifetime: lifetime, force: true });
        const readAgent = (agentId: string) => readMachineAgentsForScope(lifetime, machine.id).agents.find(agent => agent.agentId === agentId);
        expect(readAgent('claude')).toMatchObject({ state: 'ready', stale: false });
        const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
        const lifecycle = createVoiceSessionLifecycleController();
        lifecycle.setConfiguredProviderId('local_conversation');
        try {
            const target = { serverId: localVoiceHomeId, sessionId: 'session-1' };
            if (ingress === 'resume') {
                await lifecycle.toggle(target);
                await lifecycle.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
                refuseLaunch = true;
            }
            const { createVoiceExecutionTransport } = await import('@/voice/runtime/execution/VoiceExecutionTransport');
            await expect(ingress === 'lazy-run' ? createVoiceExecutionTransport().ensureRunning(target.sessionId)
                : lifecycle.toggle(ingress === 'resume' ? target : null)).rejects.toMatchObject(
                    ingress === 'lazy-run' ? { rpcErrorCode: 'agent_signed_out' } : { code: 'agent_signed_out' });
            expect(signedOut).toBe(true);
            expect(readAgent('claude')).toMatchObject({ state: 'needsSignIn', stale: false, signIn: { native: { status: 'signedOut' } } });
            expect(readAgent('codex')).toMatchObject({ state: 'ready', stale: false });
            if (ingress !== 'lazy-run') expect(lifecycle.getSnapshot()).toMatchObject({
                status: 'error', canStop: false,
                errorCode: 'authentication_required', errorMessage: 'agent_signed_out',
                errorRecoveryAction: 'connect_agent', errorPresentation: 'error',
            });
            expect(localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
        } finally {
            sessionRpcWithServerScope.mockImplementation(sessionIncumbent);
            machineRpcWithServerScope.mockImplementation(incumbent);
            await lifecycle.dispose();
        }
    }, 60_000);

    it('does not start capture when Voice Home preparation settles after Stop', async () => {
        await configureAgentMode();
        let resolveBinding!: () => void;
        interceptVoiceSpawn(async () => {
            await new Promise<void>((resolve) => {
                resolveBinding = resolve;
            });
        });

        const start = localVoiceEngine.toggleLocalVoiceTurn('');
        await waitForLocalVoiceBoundaryEvent(`rpc:${RPC_METHODS.SESSION_SPAWN_NEW}`);
        expect(resolveBinding).toBeTypeOf('function');
        await localVoiceEngine.stopLocalVoiceSession();
        resolveBinding();
        await start;

        expect(localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);

        expect(await getLocalConversationSnapshot()).toMatchObject({
            adapterId: 'local_conversation',
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            status: 'disconnected',
            canStop: false,
        });
    }, 60_000);

    it('does not overwrite a newer adapter owner when stale Voice Home preparation fails', async () => {
        await configureAgentMode();
        let rejectBinding!: (error: Error) => void;
        interceptVoiceSpawn(async () => {
            await new Promise<void>((_resolve, reject) => {
                rejectBinding = reject;
            });
        });

        const start = localVoiceEngine.toggleLocalVoiceTurn('');
        void start.catch(() => {});
        await waitForLocalVoiceBoundaryEvent(`rpc:${RPC_METHODS.SESSION_SPAWN_NEW}`);
        expect(rejectBinding).toBeTypeOf('function');
        const providerId = 'happier.voice.elevenlabs/realtime-elevenlabs';
        const storage = await getStorage();
        const [{ writeVoiceProviderSettingsConfig }, { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS },
            { createBuiltinVoiceAdapterAssembly }, { createSessionMetadataHttpBoundary },
            { buildVoiceTranscriptHistorySessionMetadata, VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG },
            { SessionLookupByTagsRequestV2Schema, SessionLookupByTagsResponseV2Schema },
            { createSessionOwnerMetadataV1, projectSessionSharedMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1 },
            { answerVoiceRealtimePreparationHttpRequest }, { PROMPT_LIBRARY_ROWS_ROUTE_V1 }] = await Promise.all([
            import('@/sync/domains/settings/voiceSettings'),
            import('../../../../../packages/plugins/elevenlabs/src/protocol/voice/index'),
            import('@/dev/testkit/harness/builtinVoiceAdapters'),
            import('@/dev/testkit/harness/sessionMetadataHttpBoundary'),
            import('@/voice/persistence/voiceTranscriptHistorySession'),
            import('@happier-dev/protocol/sessions/control/contract'),
            import('@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1'),
            import('@/dev/testkit/harness/voiceRealtimePreparationHttpBoundary'),
            import('@happier-dev/protocol/prompts/library/promptLibraryRowsV1'),
        ]);
        const voice = writeVoiceProviderSettingsConfig(storage.getState().settings.voice, providerId,
            ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS);
        storage.__setState({ settings: { ...storage.getState().settings, voice: { ...voice, providerId } } });
        const history = createSessionFixture({ id: 'binding-provider-history', serverId: localVoiceHomeId,
            encryptionMode: 'plain', active: false, metadata: { path: '/voice', host: 'test',
                ...buildVoiceTranscriptHistorySessionMetadata() } });
        const historyHttp = createSessionMetadataHttpBoundary(() => ({ [history.id]: history }));
        const owner = createSessionOwnerMetadataV1({ metadata: history.metadata });
        if (!owner.ok) throw new Error('Expected canonical history metadata owner');
        historyHttp.createSessionFromPost(history.id, { method: 'POST', body: JSON.stringify({
            tag: VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG, metadataLayoutVersion: 1,
            sharedMetadata: { ciphertext: JSON.stringify(projectSessionSharedMetadataV1({ metadata: history.metadata, agentState: null })) },
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata),
            agentState: null, dataEncryptionKey: null, encryptionMode: 'plain',
        }) });
        setLocalVoiceHttpResponder(request => {
            const init = { method: request.method,
                ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) };
            if (request.path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return answerVoiceRealtimePreparationHttpRequest(
                request.url, storage.getState().settings) ?? undefined;
            if (request.path === '/v1/voice/token') return Response.json({ allowed: true, token: 'binding-provider-token',
                leaseId: 'binding-provider-lease', bindingNonce: 'binding-provider-nonce', expiresAtMs: Date.now() + 60_000 });
            if (request.path === '/v1/voice/session/complete' || request.path === '/v1/voice/session/release') return Response.json({ ok: true });
            if (request.path === '/v1/sessions' && request.method === 'POST') return historyHttp.createSessionFromPost(history.id, init);
            if (request.path === '/v2/sessions/lookup-by-tags') {
                const lookup = SessionLookupByTagsRequestV2Schema.parse(request.body);
                if (!lookup.tags.includes(VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG)) return undefined;
                const response = historyHttp.handle(`https://local-voice-actions.example.test/v2/sessions/${history.id}`);
                if (!response) throw new Error('Expected persisted history HTTP response');
                return response.json().then(body => Response.json(SessionLookupByTagsResponseV2Schema.parse({ sessions: [body.session] })));
            }
            if (request.path === `/v2/sessions/${history.id}` || request.path.startsWith(`/v2/sessions/${history.id}/`)) {
                return historyHttp.handle(request.url, init) ?? undefined;
            }
            return undefined;
        });
        let releaseSdk!: () => void;
        const sdkGate = new Promise<void>(resolve => { releaseSdk = resolve; });
        const sdkEntered = createDeferred<void>();
        elevenLabsSdk.startSession.mockImplementation(async () => {
            sdkEntered.resolve();
            await sdkGate;
            return { getId: () => 'binding-provider-conversation', endSession: async () => {},
                setMicMuted() {}, setVolume() {}, sendUserMessage() {}, sendContextualUpdate() {} };
        });
        const assembly = (await createBuiltinVoiceAdapterAssembly());
        const newerAdapter = assembly.adapters.find(adapter => adapter.id === providerId);
        if (!newerAdapter) throw new Error('Expected generated ElevenLabs adapter');
        const { getVoiceAdapterRegistry, registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        const previousAdapters = getVoiceAdapterRegistry().list();
        registerVoiceAdapters(assembly.adapters);
        const { voiceConversationRuntimeMachine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
        const newerStart = newerAdapter.start({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            requestedTargetSessionAddress: null, initialContext: '' });
        void newerStart.catch(() => {});
        try {
            await sdkEntered.promise;
            expect(elevenLabsSdk.startSession).toHaveBeenCalledOnce();
            expect(newerAdapter.getSnapshot()).toMatchObject({ adapterId: providerId, status: 'connecting' });
            rejectBinding(Object.assign(new Error('stale local failure'), {
                code: 'VOICE_AGENT_BACKEND_TARGET_UNAVAILABLE',
            }));
            await start;

            expect(voiceConversationRuntimeMachine.getSnapshot()).toMatchObject({
                adapterId: providerId,
                controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                state: 'connecting',
                error: null,
            });
        } finally {
            rejectBinding(new Error('Binding fixture cleanup'));
            releaseSdk();
            await Promise.allSettled([start, newerStart]);
            await newerAdapter.stop({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
            await assembly.dispose();
            registerVoiceAdapters(previousAdapters);
            setLocalVoiceHttpResponder(null);
        }
    }, 60_000);
});
