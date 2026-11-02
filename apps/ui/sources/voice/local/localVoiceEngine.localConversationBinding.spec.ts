import { afterAll } from 'vitest';
import { warmLocalVoiceEngineHarnessGraph } from './localVoiceEngine.testHarness';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { createDeferred, createMachineFixture, createSessionFixture, waitForTestEvent } from '@/dev/testkit';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { PartialOptions as ElevenLabsStartOptions } from '@elevenlabs/client';
import {
    getStorage, loadLocalVoiceEngineWithCompatState, registerLocalVoiceEngineHarnessHooks,
    machineRpcWithServerScope, localVoiceHomeId, localVoiceSpeechOutputBoundary, replaceLocalVoiceSessionHttpSeed,
    setLocalVoiceHttpResponder,
    waitForLocalVoiceBoundaryEvent,
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

    it.each(['stt', 'tts'] as const)('refuses an offline daemon %s Machine before preparing a carrier on the online root Machine', async (surface) => {
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
        let failure: unknown;
        try { await localVoiceEngine.toggleLocalVoiceTurn('session-1'); } catch (error) { failure = error; }

        expect(await getLocalConversationSnapshot()).toMatchObject({
            status: 'error', canStop: false,
            errorCode: 'execution_machine_unavailable', errorRecoveryAction: 'select_execution_machine',
        });
        expect(failure).toMatchObject({ code: 'VOICE_AGENT_TARGET_MACHINE_OFFLINE' });
        expect(machineRpcWithServerScope.mock.calls.filter(([request]) => request.method === RPC_METHODS.SESSION_SPAWN_NEW)).toEqual([]);
        expect(localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
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

    it('retains explicit UI approval custody as a typed Start refusal instead of parsing it as a spawned Session', async () => {
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
        const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
        const lifecycle = createVoiceSessionLifecycleController();
        lifecycle.setConfiguredProviderId('local_conversation');
        try {
            await expect(lifecycle.toggle(null)).rejects.toMatchObject({ code: 'approval_request_created' });
            expect(lifecycle.getSnapshot()).toMatchObject({
                status: 'disconnected', errorMessage: 'approval_request_created', canStop: false,
            });
            expect(artifacts.list()).toHaveLength(1);
            expect(machineRpcWithServerScope.mock.calls.filter(([request]) => request.method === RPC_METHODS.SESSION_SPAWN_NEW)).toEqual([]);
        } finally {
            await lifecycle.dispose();
        }
    }, 60_000);

    it('restarts capture after End on the same root and retained carrier without another Session or Agent run', async () => {
        await configureAgentMode();
        const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
        const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
        const lifecycle = createVoiceSessionLifecycleController();
        lifecycle.setConfiguredProviderId('local_conversation');
        const target = { serverId: localVoiceHomeId, sessionId: 'session-1' };
        try {
            await lifecycle.toggle(target);
            expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
            const binding = voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID);
            expect(binding?.conversationSessionId).toBe('voice-home-session');
            await lifecycle.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
            expect(lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
            await lifecycle.toggle(target);
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

        // The real Session creation Action sanitizes a transport exception to
        // its public action_failed code; it does not forward a private backend
        // code injected below the strict daemon response boundary.
        await expect(localVoiceEngine.toggleLocalVoiceTurn('')).rejects.toMatchObject({ code: 'action_failed' });

        expect(await getLocalConversationSnapshot()).toMatchObject({
            adapterId: 'local_conversation',
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            status: 'disconnected',
            errorCode: 'provider_error',
            errorMessage: 'action_failed',
            errorRecoveryAction: 'retry',
        });
        const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
        expect(getVoiceConversationRuntimeSnapshot().error).toHaveProperty('cause.code', 'action_failed');
        expect(JSON.stringify(getVoiceConversationRuntimeSnapshot().error)).not.toContain(preparationFailure.message);
    }, 60_000);

    it('keeps a signed-out Agent refusal visible and offers authentication recovery before capture', async () => {
        await configureAgentMode();
        const incumbent = machineRpcWithServerScope.getMockImplementation();
        if (!incumbent) throw new Error('Missing canonical machine Socket boundary');
        machineRpcWithServerScope.mockImplementation(async (request: MachineRequest) => {
            if (request.method === RPC_METHODS.SESSION_SPAWN_NEW) {
                SessionSpawnNewInputV2Schema.parse(request.payload);
                return SessionSpawnNewResultV1Schema.parse({
                    type: 'error', code: 'agent_signed_out', agentId: 'claude', retryable: false,
                });
            }
            return incumbent(request);
        });

        const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
        const lifecycle = createVoiceSessionLifecycleController();
        lifecycle.setConfiguredProviderId('local_conversation');
        try {
            await expect(lifecycle.toggle(null)).rejects.toMatchObject({ code: 'agent_signed_out' });
            expect(lifecycle.getSnapshot()).toMatchObject({
                status: 'error', canStop: false,
                errorCode: 'authentication_required', errorMessage: 'agent_signed_out',
                errorRecoveryAction: 'connect_agent', errorPresentation: 'error',
            });
            expect(localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
        } finally {
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
            import('@happier-dev/protocol'),
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
