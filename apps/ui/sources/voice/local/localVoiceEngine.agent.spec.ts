import { readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { afterAll } from 'vitest';
import { localVoiceHomeId, warmLocalVoiceEngineHarnessGraph } from './localVoiceEngine.testHarness';
import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { createDeferred, createSessionFixture, renderScreen } from '@/dev/testkit';
import { createReadyMachineAgentInventoryFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { t } from '@/text';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { withExecutionRunStartFailureDetails } from '@happier-dev/protocol/execution/runs/responseSchemas';

import {
    emitSpeechRecEvent,
    expoSpeechSpeak,
    flushMicrotasks,
    getStorage,
    loadLocalVoiceEngineWithCompatState,
    registerLocalVoiceEngineHarnessHooks,
    sessionRpcWithServerScope,
    speechRecStart,
    speechRecStop,
    audioSessionRelease,
    machineRpcWithServerScope,
    localVoicePendingEnqueue,
    localVoiceSpeechTranscription,
    localVoiceSpeechOutputBoundary,
    localVoiceRouteState,
    switchLocalVoiceAccount,
    readLocalVoiceMachinePrerequisites,
    waitForLocalVoiceBoundaryEvent,
    waitForLocalVoiceState,
} from './localVoiceEngine.testHarness';
import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonVoiceInferenceModelsWarmResponseSchema } from '@happier-dev/protocol/daemon/voiceInference';
import { VOICE_TOOL_RESULTS_JSON_PREFIX} from '@happier-dev/protocol/voice/toolResultsChannel';
import { type VoiceAssistantAction } from '@happier-dev/protocol/voice/actions';
import { ExecutionRunEnsureOrStartRequestSchema, ExecutionRunEnsureOrStartResponseSchema, ExecutionRunActionResponseSchema } from '@happier-dev/protocol/execution/runs/index';
import { ExecutionRunTurnStreamReadRequestSchema, ExecutionRunTurnStreamReadResponseSchema } from '@happier-dev/protocol/execution/runs/streaming';
import { VoiceAssistantActionSchema } from '@happier-dev/protocol/voice/actions';
import type { CurrentUiContextMountedEnrichment } from '@/components/appShell/currentUiContext/currentUiContextModel';
import type { CurrentUiContextVoiceToolPort } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import {
    attachVoiceAgentActionEffectId,
} from '@/voice/agent/types';

type SessionRequest = Parameters<typeof sessionRpcWithServerScope>[0];
type VoiceRunStartAck = ReturnType<typeof ExecutionRunEnsureOrStartResponseSchema.parse>;
const ensureAgentRpc = vi.fn<(request: SessionRequest) => Promise<unknown>>();
const startTurnRpc = vi.fn<(request: SessionRequest) => Promise<unknown>>();
const readTurnRpc = vi.fn<(request: SessionRequest) => Promise<unknown>>();
const cancelTurnRpc = vi.fn<(request: SessionRequest) => Promise<unknown>>();
const welcomeActionRpc = vi.fn<(request: SessionRequest) => Promise<unknown>>();

// The genuine Socket responder receives full wire requests. No private client
// methods, streaming parser, run cache, acceptance or lifecycle owner is replaced.
function configureSessionRpcObservers() {
  const incumbent = sessionRpcWithServerScope.getMockImplementation();
  if (!incumbent) throw new Error('Missing local Voice Socket RPC boundary');
  for (const responder of [ensureAgentRpc, startTurnRpc, readTurnRpc, cancelTurnRpc, welcomeActionRpc]) {
    responder.mockReset();
    responder.mockImplementation(incumbent);
  }
  ensureAgentRpc.mockResolvedValue(undefined);
  sessionRpcWithServerScope.mockImplementation(async request => {
    if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START
      || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1) {
      const override = await ensureAgentRpc(request);
      if (override !== undefined) {
        const response = ExecutionRunEnsureOrStartResponseSchema.parse(override);
        // A daemon refusal precedes run creation; do not secretly create a
        // retained run beneath an externally supplied negative wire reply.
        if (!response.ok) return { ...response,
          details: withExecutionRunStartFailureDetails(response.details, 'noRunCreated') };
      }
      const admitted = await incumbent(request);
      return override === undefined ? admitted : ExecutionRunEnsureOrStartResponseSchema.parse({
        ...ExecutionRunEnsureOrStartResponseSchema.parse(admitted),
        ...ExecutionRunEnsureOrStartResponseSchema.parse(override),
      });
    }
    if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START
      || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2) return startTurnRpc(request);
    if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) return readTurnRpc(request);
    if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL) return cancelTurnRpc(request);
    if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ACTION) return welcomeActionRpc(request);
    return incumbent(request);
  });
}

function holdNextAgentStartAtDaemon() {
    const reached = createDeferred<void>();
    const reply = createDeferred<unknown>();
    ensureAgentRpc.mockImplementationOnce(() => {
        reached.resolve();
        return reply.promise;
    });
    return { reached: reached.promise, reply };
}

function createTurnReadReply(reply: { assistantText: string; actions?: readonly VoiceAssistantAction[] }) {
  return ExecutionRunTurnStreamReadResponseSchema.parse({ streamId: 'stream-1',
    events: [{ t: 'done', assistantText: reply.assistantText,
      actions: reply.actions?.map(action => VoiceAssistantActionSchema.parse(action)) ?? [] }], nextCursor: 1, done: true });
}

type MachineRequest = Parameters<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc')['machineRpcWithServerScope']>[0];

function readWarmRequests(): MachineRequest[] {
    return machineRpcWithServerScope.mock.calls
        .map(([request]) => request as MachineRequest)
        .filter(request => request.method === RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM);
}

function configureWarmTransport(reply: (request: MachineRequest) => Promise<unknown>) {
    const incumbent = machineRpcWithServerScope.getMockImplementation();
    machineRpcWithServerScope.mockImplementation((request: MachineRequest) => {
        if (request.method === RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM) return reply(request);
        if (!incumbent) throw new Error('Missing local Voice machine RPC fixture');
        return incumbent(request);
    });
}

type VoiceAgentTurnStreamReadResult = ReturnType<typeof ExecutionRunTurnStreamReadResponseSchema.parse>;

let localVoiceEngine: Awaited<ReturnType<typeof loadLocalVoiceEngineWithCompatState>>;
let useVoiceTargetStore: typeof import('@/voice/runtime/voiceTargetStore').useVoiceTargetStore;

const restoreHarnessModuleLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreHarnessModuleLoader());
// These are the mounted AppShell owners used by the application. Warm their
// graph during collection; test leaves publish only their authored UI content.
const [
    { InjectedAuthProvider },
    { MainAppTabStateProvider },
    { AppPaneProvider },
    { CurrentUiContextProvider, usePublishCurrentUiContext },
    { PluginSurfaceFocusEligibilityProvider },
    { useCurrentUiContextVoiceToolPort },
    { TokenStorage },
    { getActiveServerSnapshot },
    { voiceAgentSessions },
] = await Promise.all([
    import('@/auth/context/AuthContext'),
    import('@/components/navigation/mobile/chrome/MainAppTabStateProvider'),
    import('@/components/appShell/panes/AppPaneProvider'),
    import('@/components/appShell/currentUiContext/CurrentUiContextProvider'),
    import('@/components/ui/presentation/PluginSurfaceFocusEligibility'),
    import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort'),
    import('@/auth/storage/tokenStorage'),
    import('@/sync/domains/server/serverRuntime'),
    import('@/voice/agent/voiceAgentSessions'),
]);
const mountedUiScreens = new Set<Awaited<ReturnType<typeof renderScreen>>>();

async function mountCurrentUi(enrichment: CurrentUiContextMountedEnrichment) {
    localVoiceRouteState.pathname = '/settings/voice';
    localVoiceRouteState.segments = ['(app)', 'settings', 'voice'];
    const credentials = await TokenStorage.getCredentialsForServerUrl(getActiveServerSnapshot().serverUrl);
    if (!credentials) throw new Error('Mounted AppShell requires restored Account credentials');
    const mountedPort: { current: CurrentUiContextVoiceToolPort | null } = { current: null };
    function Publication(props: { enrichment: CurrentUiContextMountedEnrichment }) {
        usePublishCurrentUiContext(props.enrichment);
        mountedPort.current = useCurrentUiContextVoiceToolPort();
        return null;
    }
    const tree = (next: CurrentUiContextMountedEnrichment, auth = credentials) => {
        const publication = React.createElement(Publication, { enrichment: next });
        const focused = React.createElement(PluginSurfaceFocusEligibilityProvider, {
            active: true, currentUiContextActive: true, children: publication,
        });
        const context = React.createElement(CurrentUiContextProvider, { children: focused });
        const panes = React.createElement(AppPaneProvider, { children: context });
        const tabs = React.createElement(MainAppTabStateProvider, { children: panes });
        return React.createElement(InjectedAuthProvider, { credentials: auth, children: tabs });
    };
    const screen = await renderScreen(tree(enrichment));
    mountedUiScreens.add(screen);
    const admittedPort = mountedPort.current;
    if (!admittedPort) throw new Error('Actual mounted Current UI port unavailable');
    return {
        port: admittedPort,
        update: (next: CurrentUiContextMountedEnrichment) => screen.update(tree(next)),
        async switchAccount(accountId: string, next: CurrentUiContextMountedEnrichment) {
            await switchLocalVoiceAccount(accountId);
            const nextCredentials = await TokenStorage.getCredentialsForServerUrl(getActiveServerSnapshot().serverUrl);
            if (!nextCredentials) throw new Error('Switched AppShell credentials unavailable');
            await screen.update(tree(next, nextCredentials));
        },
        async unmount() { await screen.unmount(); mountedUiScreens.delete(screen); },
    };
}

describe('local voice engine agent behavior', () => {
    registerLocalVoiceEngineHarnessHooks();

    beforeEach(async () => {
        configureSessionRpcObservers();
        configureWarmTransport(async () => DaemonVoiceInferenceModelsWarmResponseSchema.parse({ ok: true, models: [] }));
        ({ useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore'));
        localVoiceEngine = await loadLocalVoiceEngineWithCompatState();
    }, 180_000);

    afterEach(async () => {
        for (const screen of mountedUiScreens) await screen.unmount();
        mountedUiScreens.clear();
        await localVoiceEngine.stopLocalVoiceSession();
        await localVoiceEngine.stopLocalVoiceAgent('s1');
        await localVoiceEngine.stopLocalVoiceAgent(VOICE_AGENT_GLOBAL_SESSION_ID);

        const [
            { voiceConversationRuntimeMachine },
            { resetVoiceSessionRuntimeStateForTests },
            { voiceSessionBindingStore },
        ] = await Promise.all([
            import('@/voice/runtime/machine/VoiceConversationRuntimeMachine'),
            import('@/voice/session/voiceSessionStore'),
            import('@/voice/binding/voiceConversationBindingStore'),
        ]);
        voiceConversationRuntimeMachine.reset();
        await resetVoiceSessionRuntimeStateForTests();

        for (const binding of voiceSessionBindingStore.getState().list()) {
            voiceSessionBindingStore.getState().unbind(binding.conversationSessionId);
        }
        voiceSessionBindingStore.getState().replacePersistedBindings([]);

        const targetState = useVoiceTargetStore.getState();
        targetState.setScope('global');
        targetState.setPrimaryActionSessionAddress(null);
        targetState.setVoiceLiveContextSessionAddresses([]);
        targetState.setLastFocusedSessionAddress(null);
        vi.restoreAllMocks();
    });









    it('keeps the selected daemon owner retryable when its execution run is unsupported', async () => {
        const storage = await getStorage();
        const readyMachine = {
            ...storage.getState().machines['machine-1'],
            active: true,
            activeAt: Date.now(),
        };
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...readLocalConversationVoiceSettings(storage.getState().settings.voice),
                            conversationMode: 'agent',
                            stt: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).tts,
                                autoSpeakReplies: false,
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'session-model', metadata: { flavor: 'claude', agentRuntimeCapabilitiesV1: { localControl: { supported: true } } } },
            },
            machines: {
                ...storage.getState().machines,
                'machine-1': readyMachine,
            },
            machineListByServerId: {
                ...storage.getState().machineListByServerId,
                [localVoiceHomeId]: [readyMachine],
            },
        });

        const unsupported = ExecutionRunEnsureOrStartResponseSchema.parse({
            ok: false, error: 'unsupported', errorCode: 'VOICE_AGENT_UNSUPPORTED',
        });
        ensureAgentRpc.mockResolvedValue(unsupported);
        const prewarm = holdNextAgentStartAtDaemon();

        const { toggleLocalVoiceTurn, getLocalVoiceState } = localVoiceEngine;
        const beforeCapture = await readLocalVoiceMachinePrerequisites();
        try {
            await toggleLocalVoiceTurn('s1');
            await prewarm.reached;
            // Join the real initializer while its daemon reply is held, then
            // observe the explicit Start refusal before the person retries.
            const settlement = expect(voiceAgentSessions.ensureRunning(VOICE_AGENT_GLOBAL_SESSION_ID))
                .rejects.toMatchObject({ rpcErrorCode: 'VOICE_AGENT_UNSUPPORTED' });
            prewarm.reply.resolve(unsupported);
            await settlement;
        } finally {
            prewarm.reply.resolve(unsupported);
        }
        await waitForLocalVoiceState(state => state.status === 'idle' && state.error === 'VOICE_AGENT_UNSUPPORTED');
        const afterCapture = await readLocalVoiceMachinePrerequisites();
        await toggleLocalVoiceTurn('s1');
        await waitForLocalVoiceState(state => state.status === 'idle' && state.error === 'VOICE_AGENT_UNSUPPORTED');

        expect(ensureAgentRpc, JSON.stringify({ beforeCapture, afterCapture,
            afterRetry: await readLocalVoiceMachinePrerequisites(), runtime: getLocalVoiceState(),
        })).toHaveBeenCalledTimes(2);
        // Start admission fails before any spoken input is transcribed.
        expect(localVoiceSpeechTranscription).not.toHaveBeenCalled();
        expect(localVoicePendingEnqueue.mock.calls.filter(([request]) => request.sessionId === 's1')).toEqual([]);
        expect(readLocalConversationVoiceSettings(storage.getState().settings.voice).conversationMode).toBe('agent');
        expect(getLocalVoiceState()).toMatchObject({
            status: 'idle',
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            error: 'VOICE_AGENT_UNSUPPORTED',
        });
    });

    it('recreates daemon agent handle when daemon reports VOICE_AGENT_NOT_FOUND', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...readLocalConversationVoiceSettings(storage.getState().settings.voice),
                            conversationMode: 'agent',
                            stt: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).tts,
                                autoSpeakReplies: false,
                            },
                            agent: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).agent,
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude', agentRuntimeCapabilitiesV1: { localControl: { supported: true } } } },
            },
        });

        ensureAgentRpc
            .mockResolvedValueOnce({ ok: true, runId: 'local-agent-run', created: true })
            .mockResolvedValueOnce({ ok: true, runId: 'local-agent-run', created: true });
        readTurnRpc
            .mockRejectedValueOnce(Object.assign(new Error('not found'), { rpcErrorCode: 'VOICE_AGENT_NOT_FOUND' }))
            .mockResolvedValueOnce(createTurnReadReply({ assistantText: 'Recovered reply' }));

        localVoiceSpeechTranscription.mockResolvedValueOnce('hello world');

        const { toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        await toggleLocalVoiceTurn('s1');

        expect(ensureAgentRpc).toHaveBeenCalledTimes(2);
        expect(readTurnRpc).toHaveBeenCalledTimes(2);
    });

    it('delivers automatic bounded current UI metadata through the active local agent attempt only', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    privacy: {
                        ...storage.getState().settings.voice.privacy,
                        currentUiContextMode: 'automatic',
                    },
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...readLocalConversationVoiceSettings(storage.getState().settings.voice),
                            conversationMode: 'agent',
                            stt: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).tts,
                                autoSpeakReplies: false,
                            },
                            agent: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).agent,
                                prewarmOnConnect: true,
                            },
                            streaming: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).streaming,
                                enabled: false,
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude', agentRuntimeCapabilitiesV1: { localControl: { supported: true } } } },
            },
        });

        const agentStart = {
            resolve: null as ((value: VoiceRunStartAck) => void) | null,
        };
        ensureAgentRpc.mockImplementationOnce(
            () => new Promise<VoiceRunStartAck>((resolve) => {
                agentStart.resolve = resolve;
            }),
        );
        const currentUi = await mountCurrentUi({
            entity: { kind: 'issue', label: 'PRIVATE_ENTITY_SENTINEL' },
            detail: { secret: 'PRIVATE_DETAIL_SENTINEL' },
            commands: [],
        });
        const authoredNavigation = currentUi.port.readCurrentUiContext()?.navigation;
        expect(authoredNavigation).toMatchObject({ area: 'settings', screen: 'settings/voice' });
        expect(authoredNavigation?.title).toBeTruthy();

        const setCurrentUiContextMode = (mode: 'automatic' | 'on_demand' | 'off') => {
            const state = storage.getState();
            storage.__setState({
                settings: {
                    ...state.settings,
                    voice: {
                        ...state.settings.voice,
                        privacy: {
                            ...state.settings.voice.privacy,
                            currentUiContextMode: mode,
                        },
                    },
                },
            });
        };
        const readLastProviderUserText = () => String(
            (startTurnRpc.mock.calls.at(-1)?.[0]?.payload as { message?: unknown } | undefined)?.message ?? '',
        );

        const { voiceSessionBindingManager } = await import('@/voice/binding/voiceConversationBindingRuntime');
        await expect(voiceSessionBindingManager.ensureBound({
            adapterId: 'local_conversation',
            controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            requestedTargetSessionId: null,
        })).resolves.toMatchObject({
            controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            conversationSessionId: 'voice-home-session',
        });

        const toggle = localVoiceEngine.toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID, currentUi.port);
        await waitForLocalVoiceBoundaryEvent('agent-start');
        await toggle;
        expect(startTurnRpc).not.toHaveBeenCalled();

        const resolveAgentStart = agentStart.resolve;
        if (!resolveAgentStart) throw new Error('missing local voice agent start resolver');
        resolveAgentStart({ ok: true, runId: 'local-agent-run', created: true });
        await voiceAgentSessions.ensureRunning(VOICE_AGENT_GLOBAL_SESSION_ID);
        expect(voiceAgentSessions.isActive(VOICE_AGENT_GLOBAL_SESSION_ID), 'actual local Agent start').toBe(true);

        await localVoiceEngine.sendLocalVoiceAgentTextTurn(
            VOICE_AGENT_GLOBAL_SESSION_ID,
            'What can you see?',
            { localId: 'automatic-current-ui-turn', deliveryCommand: 'interrupt_and_send' },
        );
        const automaticProviderText = readLastProviderUserText();
        expect(automaticProviderText).toContain('CURRENT UI CONTEXT');
        expect(automaticProviderText).toContain('"area":"settings"');
        expect(automaticProviderText).toContain('"screen":"settings/voice"');
        expect(automaticProviderText).toContain(authoredNavigation!.title!);
        expect(automaticProviderText).not.toContain('PRIVATE_ENTITY_SENTINEL');
        expect(automaticProviderText).not.toContain('PRIVATE_DETAIL_SENTINEL');

        // The real mounted owner withdraws its snapshot and publishes retirement.
        await currentUi.unmount();
        expect(currentUi.port.readCurrentUiContext()).toBeNull();
        await localVoiceEngine.sendLocalVoiceAgentTextTurn(
            VOICE_AGENT_GLOBAL_SESSION_ID,
            'Has the screen retired?',
            { localId: 'automatic-current-ui-retirement', deliveryCommand: 'interrupt_and_send' },
        );
        const retirementProviderText = readLastProviderUserText();
        expect(retirementProviderText).toContain('"state":"unavailable"');
        expect(retirementProviderText.match(/CURRENT UI CONTEXT/g)).toHaveLength(1);
        expect(retirementProviderText).not.toContain('PRIVATE_ENTITY_SENTINEL');
        expect(retirementProviderText).not.toContain('PRIVATE_DETAIL_SENTINEL');

        setCurrentUiContextMode('on_demand');
        await localVoiceEngine.sendLocalVoiceAgentTextTurn(
            VOICE_AGENT_GLOBAL_SESSION_ID,
            'Read only when I ask.',
            { localId: 'on-demand-current-ui-turn', deliveryCommand: 'interrupt_and_send' },
        );
        expect(readLastProviderUserText()).toBe('Read only when I ask.');

        setCurrentUiContextMode('off');
        await localVoiceEngine.sendLocalVoiceAgentTextTurn(
            VOICE_AGENT_GLOBAL_SESSION_ID,
            'No current UI context.',
            { localId: 'off-current-ui-turn', deliveryCommand: 'interrupt_and_send' },
        );
        expect(readLastProviderUserText()).toBe('No current UI context.');

        const pendingNativeAudio = {
            release: null as (() => void) | null,
        };
        audioSessionRelease.mockImplementationOnce(
            () => new Promise<void>((resolve) => {
                pendingNativeAudio.release = resolve;
            }),
        );
        const stop = localVoiceEngine.stopLocalVoiceSession();
        await waitForLocalVoiceBoundaryEvent('audio-release');
        expect(currentUi.port.readCurrentUiContext()).toBeNull();
        const releasePendingNativeAudio = pendingNativeAudio.release;
        if (!releasePendingNativeAudio) throw new Error('missing pending native audio release');
        releasePendingNativeAudio();
        await stop;
        const providerCallsAfterStop = readTurnRpc.mock.calls.length;
        setCurrentUiContextMode('automatic');
        expect(readTurnRpc).toHaveBeenCalledTimes(providerCallsAfterStop);

        const retiringAgentStart = {
            resolve: null as ((value: VoiceRunStartAck) => void) | null,
        };
        ensureAgentRpc.mockImplementationOnce(
            () => new Promise<VoiceRunStartAck>((resolve) => {
                retiringAgentStart.resolve = resolve;
            }),
        );
        const retiringCurrentUi = await mountCurrentUi({ detail: { secret: 'LATE_START_CONTEXT_SENTINEL' } });
        const retiringToggle = localVoiceEngine.toggleLocalVoiceTurn(
            VOICE_AGENT_GLOBAL_SESSION_ID,
            retiringCurrentUi.port,
        );
        await waitForLocalVoiceBoundaryEvent('agent-start', 2);
        await retiringToggle;
        const retiringAgentSettled = voiceAgentSessions.ensureRunning(VOICE_AGENT_GLOBAL_SESSION_ID)
            .then(() => undefined, () => undefined);
        const providerCallsBeforeRetiringStart = startTurnRpc.mock.calls.length;

        const retiringNativeAudio = {
            release: null as (() => void) | null,
        };
        audioSessionRelease.mockImplementationOnce(
            () => new Promise<void>((resolve) => {
                retiringNativeAudio.release = resolve;
            }),
        );
        const retiringStop = localVoiceEngine.stopLocalVoiceSession();
        await waitForLocalVoiceBoundaryEvent('audio-release', 2);
        const resolveRetiringAgentStart = retiringAgentStart.resolve;
        if (!resolveRetiringAgentStart) throw new Error('missing retiring local voice agent start resolver');
        resolveRetiringAgentStart({ ok: true, runId: 'local-agent-run', created: true });
        await retiringAgentSettled;
        await retiringCurrentUi.update({ detail: { secret: 'LATE_START_CONTEXT_SENTINEL' } });
        expect(startTurnRpc).toHaveBeenCalledTimes(providerCallsBeforeRetiringStart);
        const releaseRetiringNativeAudio = retiringNativeAudio.release;
        if (!releaseRetiringNativeAudio) throw new Error('missing retiring native audio release');
        releaseRetiringNativeAudio();
        await retiringStop;
        expect(localVoiceEngine.getLocalVoiceState()).toMatchObject({ status: 'idle' });
        expect(voiceAgentSessions.isActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(false);
    });

    it('does not read or invoke Account B after Account A capture retires during transcription', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    executionMachine: { mode: 'fixed', machineId: 'machine-1' },
                    privacy: {
                        ...storage.getState().settings.voice.privacy,
                        currentUiContextMode: 'on_demand',
                    },
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...readLocalConversationVoiceSettings(storage.getState().settings.voice),
                            conversationMode: 'agent',
                            stt: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).stt,
                                provider: 'happier.voice.openai-compat/stt',
                            },
                            tts: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).tts,
                                autoSpeakReplies: false,
                            },
                            streaming: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).streaming,
                                enabled: false,
                            },
                        } },
                    },
                },
            },
        });
        // This keeper deliberately holds recorded-provider transcription.
        // Provider URL/consent are already authored in the canonical root
        // provider config; an obsolete inline URL is not an STT selection.
        expect(readLocalConversationVoiceSettings(storage.getState().settings.voice).stt.provider)
            .toBe('happier.voice.openai-compat/stt');

        const invokedAccounts: string[] = [];
        const uiForAccount = (accountId: string): CurrentUiContextMountedEnrichment => ({
            entity: { kind: 'issue', label: `${accountId}_CURRENT_UI_SENTINEL` },
            commands: [{ title: `${accountId} visible command`, command: { kind: 'hostLocal',
                invoke: () => { invokedAccounts.push(accountId); return { ok: true }; },
            } }],
        });
        const currentUi = await mountCurrentUi(uiForAccount('account-a'));

        let resolveTranscription!: (value: string) => void;
        let markTranscriptionStarted!: () => void;
        const transcriptionStarted = new Promise<void>(resolve => { markTranscriptionStarted = resolve; });
        localVoiceSpeechTranscription.mockImplementationOnce(() => (
            new Promise<string>((resolve) => {
                resolveTranscription = resolve;
                markTranscriptionStarted();
            })
        ));
        ensureAgentRpc.mockResolvedValue({ ok: true, runId: 'local-agent-run', created: true });
        await act(async () => { await localVoiceEngine.toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID, currentUi.port); });
        expect(localVoiceEngine.getLocalVoiceState()).toMatchObject({ status: 'recording' });
        let pendingTurn!: Promise<void>;
        await act(async () => { pendingTurn = localVoiceEngine.toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID); });
        // Await the genuine held daemon acknowledgement admission. The outer
        // case budget owns this composed operation, not a one-second observer.
        await transcriptionStarted;
        const daemonTurnsBeforeEnd = readTurnRpc.mock.calls.length;
        const providerTurnsBeforeEnd = startTurnRpc.mock.calls.length;

        // VoiceSessionRuntime invokes this exact local stop when Account A's
        // active-scope lifetime retires. The raw AppShell port then follows the
        // next render and would otherwise expose Account B after transcription.
        await act(async () => { await localVoiceEngine.stopLocalVoiceSession(); });
        await currentUi.switchAccount('account-b', uiForAccount('account-b'));
        const accountBSnapshot = currentUi.port.readCurrentUiContext();
        expect(accountBSnapshot?.entity?.label).toBe('account-b_CURRENT_UI_SENTINEL');
        const accountBCommand = accountBSnapshot?.commands.find(command => command.title === 'account-b visible command');
        if (!accountBCommand) throw new Error('Mounted Account B command unavailable');
        readTurnRpc.mockResolvedValueOnce(createTurnReadReply({
            assistantText: 'Checking the current interface.',
            actions: [{ t: 'readCurrentUiContext', args: {} }, attachVoiceAgentActionEffectId({
                t: 'invokeCurrentUiCommand', args: { commandId: accountBCommand.id },
            }, 'account-retired-current-ui-effect')],
        }));
        resolveTranscription('What is on the screen now?');
        await pendingTurn;

        expect(readTurnRpc).toHaveBeenCalledTimes(daemonTurnsBeforeEnd);
        expect(startTurnRpc).toHaveBeenCalledTimes(providerTurnsBeforeEnd);
        expect(invokedAccounts).toEqual([]);
        // Positive control: B's real mounted command is reachable now, but the
        // old captured/transcribing attempt was unable to read or invoke it.
        await act(async () => {
            await expect(currentUi.port.invokeCurrentUiCommand?.({ commandId: accountBCommand.id })).resolves.toMatchObject({ ok: true });
        });
        expect(invokedAccounts).toEqual(['account-b']);
    });

    it('suppresses expected daemon-unavailable prewarm errors while still starting the local recording flow', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...readLocalConversationVoiceSettings(storage.getState().settings.voice),
                            conversationMode: 'agent',
                            stt: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).tts,
                                autoSpeakReplies: false,
                            },
                            agent: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).agent,
                                prewarmOnConnect: true,
                            },
                            streaming: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).streaming,
                                enabled: false,
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude', agentRuntimeCapabilitiesV1: { localControl: { supported: true } } } },
            },
        });

        // fireAndForget reports background failures through console.info.
        const consoleInfoSpy = vi.spyOn(console, 'info');
        const prewarm = holdNextAgentStartAtDaemon();
        const unavailable = Object.assign(new Error('RPC method not available'), {
            rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });

        const { getLocalVoiceState, toggleLocalVoiceTurn } = localVoiceEngine;
        try {
            await toggleLocalVoiceTurn('s1');
            await prewarm.reached;
            const settlement = expect(voiceAgentSessions.ensureRunning(VOICE_AGENT_GLOBAL_SESSION_ID))
                .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
            prewarm.reply.resolve({ ok: false, error: unavailable.message, errorCode: unavailable.rpcErrorCode });
            await settlement;
        } finally {
            prewarm.reply.resolve(undefined);
        }

        expect(ensureAgentRpc).toHaveBeenCalledTimes(1);
        expect(consoleInfoSpy.mock.calls.filter(([tag]) =>
            tag === '[fireAndForget] localVoiceEngine.startLocalVoiceAgentOnConnect',
        )).toEqual([]);
        expect(getLocalVoiceState().status).toBe('recording');
    });

    it.each([
        { mode: 'immediate', prewarmOnConnect: false },
        { mode: 'immediate', prewarmOnConnect: true },
        { mode: 'on_first_turn', prewarmOnConnect: false },
        { mode: 'on_first_turn', prewarmOnConnect: true },
        { mode: 'off', prewarmOnConnect: false },
        { mode: 'off', prewarmOnConnect: true },
    ] as const)('explicit Start acquires one Run and keeps welcome and readiness work opt-in (mode=$mode, prewarm=$prewarmOnConnect)', async ({ mode, prewarmOnConnect }) => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    welcome: { enabled: mode !== 'off', mode: mode === 'on_first_turn' ? mode : 'immediate', templateId: null },
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...readLocalConversationVoiceSettings(storage.getState().settings.voice),
                            conversationMode: 'agent',
                            stt: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).stt,
                                provider: 'happier.voice.openai-compat/stt',
                            },
                            tts: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).tts,
                                provider: 'device',
                                autoSpeakReplies: true,
                            },
                            agent: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).agent,
                                prewarmOnConnect,
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude', agentRuntimeCapabilitiesV1: { localControl: { supported: true } } } },
            },
        });
        expect(readLocalConversationVoiceSettings(storage.getState().settings.voice).stt.provider)
            .toBe('happier.voice.openai-compat/stt');

        ensureAgentRpc.mockResolvedValueOnce({ ok: true, runId: 'local-agent-run', created: true });
        welcomeActionRpc.mockImplementationOnce(async request => {
            const { buildRealtimeConversationRawRecord } = await import('@/voice/transcript/VoiceTranscriptProjector');
            const { sync } = await import('@/sync/sync');
            await sync.persistSessionTranscriptMessage({ sessionId: request.sessionId,
                localId: 'earlier-native-answer', createdAt: Date.now(), messageRole: 'agent',
                rawRecord: buildRealtimeConversationRawRecord({ id: 'earlier-native-answer',
                    role: 'assistant', text: 'Earlier native answer.' }) });
            return ExecutionRunActionResponseSchema.parse({ ok: true, result: { assistantText: 'Welcome!' } });
        });

        const currentUi = await mountCurrentUi({ commands: [] });
        expect(ensureAgentRpc).not.toHaveBeenCalled();
        expect(startTurnRpc).not.toHaveBeenCalled();
        expect(welcomeActionRpc).not.toHaveBeenCalled();

        const { toggleLocalVoiceTurn } = localVoiceEngine;
        const welcomePlayback = mode === 'immediate'
            ? localVoiceSpeechOutputBoundary.holdNextPlayback('device') : null;
        await act(async () => { await toggleLocalVoiceTurn('s1', currentUi.port); });

        if (mode === 'immediate') {
            await welcomePlayback!.started;
            expect(localVoiceEngine.getLocalVoiceState().status).toBe('speaking');
            welcomePlayback!();
            await vi.waitFor(() => expect(localVoiceEngine.getLocalVoiceState().status).toBe('recording'));
            const { readStoredSessionMessages } = await import('@happier-dev/session-core/messages');
            const conversationSessionId = welcomeActionRpc.mock.calls[0]?.[0].sessionId;
            expect(conversationSessionId).toBeTypeOf('string');
            const messages = readStoredSessionMessages(storage.getState(), conversationSessionId!);
            expect(messages.filter(message => message.kind === 'agent-text' && message.text === 'Welcome!'))
                .toEqual([expect.objectContaining({ seq: expect.any(Number) })]);
            expect(messages.filter(message => message.kind === 'agent-text' && message.text === 'Earlier native answer.'))
                .toEqual([expect.objectContaining({ seq: expect.any(Number) })]);
        } else {
            await waitForLocalVoiceBoundaryEvent('agent-start');
        }
        await flushMicrotasks();

        expect(ensureAgentRpc).toHaveBeenCalledTimes(1);
        const acquisition = ExecutionRunEnsureOrStartRequestSchema.parse(ensureAgentRpc.mock.calls[0]?.[0].payload);
        expect(acquisition.start?.bootstrapMode).toBe(prewarmOnConnect && mode !== 'immediate' ? 'ready_handshake' : 'none');
        expect(startTurnRpc).not.toHaveBeenCalled();
        expect(welcomeActionRpc).toHaveBeenCalledTimes(mode === 'immediate' ? 1 : 0);
        expect(expoSpeechSpeak).toHaveBeenCalledTimes(mode === 'immediate' ? 1 : 0);

        if (!prewarmOnConnect && mode !== 'immediate') {
            localVoiceSpeechTranscription.mockResolvedValueOnce('hello world');
            await act(async () => { await toggleLocalVoiceTurn('s1'); });
            expect(startTurnRpc).toHaveBeenCalledTimes(1);
            expect(startTurnRpc.mock.calls[0]?.[0].payload).toMatchObject({
                runId: 'local-agent-run',
                message: expect.stringContaining('hello world'),
            });
            expect(ensureAgentRpc).toHaveBeenCalledTimes(1);
        }
    });

    it('retains a delayed welcome transcript without replacing newer Say playback', async () => {
        const storage = await getStorage();
        const local = readLocalConversationVoiceSettings(storage.getState().settings.voice);
        storage.__setState({ settings: { ...storage.getState().settings, voice: {
            ...storage.getState().settings.voice, providerId: 'local_conversation',
            welcome: { ...storage.getState().settings.voice.welcome, enabled: true, mode: 'immediate' },
            providers: { ...storage.getState().settings.voice.providers,
                local_conversation: { schemaVersion: 1, config: { ...local, conversationMode: 'agent',
                    stt: { ...local.stt, provider: 'device' },
                    tts: { ...local.tts, provider: 'device', autoSpeakReplies: true },
                } },
            },
        } } });
        speechRecStart.mockImplementation(() => { emitSpeechRecEvent('start'); emitSpeechRecEvent('audiostart'); });
        speechRecStop.mockImplementation(() => emitSpeechRecEvent('end'));
        const welcomeEntered = createDeferred<void>();
        const releaseWelcome = createDeferred<void>();
        welcomeActionRpc.mockImplementationOnce(async () => {
            welcomeEntered.resolve(); await releaseWelcome.promise;
            return ExecutionRunActionResponseSchema.parse({ ok: true, result: { assistantText: 'Retain this delayed welcome.' } });
        });
        await localVoiceEngine.toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
        await welcomeEntered.promise;
        const { executeVoiceSpeechAction } = await import('@/sync/ops/actions/voiceSpeechAction');
        const { localVoiceTtsController } = await import('@/voice/backends/tts/localVoiceTtsController');
        const { localVoiceSpeechOutputBoundary } = await import('./localVoiceEngine.testHarness');
        const playback = localVoiceSpeechOutputBoundary.holdNextPlayback('device');
        const saying = executeVoiceSpeechAction('ui.voice_global.say.start', { text: 'Keep the selected answer playing.' },
            storage.getState().settings);
        try {
            await playback.started;
            releaseWelcome.resolve();
            const { readStoredSessionMessages } = await import('@happier-dev/session-core/messages');
            const conversationSessionId = welcomeActionRpc.mock.calls[0]?.[0].sessionId;
            if (!conversationSessionId) throw new Error('Welcome conversation boundary missing');
            await vi.waitFor(() => expect(readStoredSessionMessages(storage.getState(), conversationSessionId)
                .some(message => message.kind === 'agent-text' && message.text === 'Retain this delayed welcome.')).toBe(true));
            await flushMicrotasks();
            expect(expoSpeechSpeak.mock.calls.map(([text]) => text)).toEqual(['Keep the selected answer playing.']);
            expect(localVoiceTtsController.readSay()).toBe('speaking');
        } finally { releaseWelcome.resolve(); playback(); localVoiceTtsController.stopSay(); await saying; }
    });

    it.each([false, true])('retains an explicit Start runtime refusal and releases capture (welcome=%s)', async welcome => {
        const storage = await getStorage();
        const voice = storage.getState().settings.voice;
        const config = readLocalConversationVoiceSettings(voice);
        storage.__setState({ settings: { ...storage.getState().settings, voice: {
            ...voice, providerId: 'local_conversation',
            welcome: { ...voice.welcome, enabled: welcome, mode: 'immediate' },
            providers: { ...voice.providers, local_conversation: { schemaVersion: 1, config: {
                ...config, conversationMode: 'agent',
                agent: { ...config.agent, prewarmOnConnect: false },
                tts: { ...config.tts, provider: 'device', autoSpeakReplies: true },
            } } },
        } } });
        const startup = holdNextAgentStartAtDaemon();
        try {
            await localVoiceEngine.toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
            await startup.reached;
            expect(localVoiceEngine.getLocalVoiceState().status).toBe('recording');
            startup.reply.resolve(ExecutionRunEnsureOrStartResponseSchema.parse({
                ok: false, errorCode: 'SOURCE_RUNTIME_RELOAD_REQUIRED', error: 'PRIVATE_SOURCE_PATH closure_changed',
            }));
            const { voiceConversationRuntimeMachine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
            await vi.waitFor(() => expect(voiceConversationRuntimeMachine.getSnapshot().error).toMatchObject({
                kind: 'provider_error', reason: 'SOURCE_RUNTIME_RELOAD_REQUIRED',
            }));
            const { deriveLocalVoiceSessionSnapshot } = await import('@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot');
            expect(deriveLocalVoiceSessionSnapshot('local_conversation', 'local', voiceConversationRuntimeMachine.getSnapshot()))
                .toMatchObject({ errorCode: 'provider_error', errorMessage: 'SOURCE_RUNTIME_RELOAD_REQUIRED', errorRecoveryAction: 'retry' });
            const { voiceCaptureAdmissionController } = await import('@/voice/runtime/input/VoiceCaptureAdmissionController');
            const dictation = voiceCaptureAdmissionController.acquire('dictation');
            if (dictation.status === 'acquired') dictation.lease.release();
            expect(dictation.status).toBe('acquired');
            expect(startTurnRpc).not.toHaveBeenCalled();
            expect(expoSpeechSpeak).not.toHaveBeenCalled();
        } finally {
            startup.reply.resolve(undefined);
        }
    });

    it('prewarmOnConnect warms daemon inference when voice home becomes active', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...readLocalConversationVoiceSettings(storage.getState().settings.voice),
                            conversationMode: 'agent',
                            stt: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).stt,
                                provider: 'local_neural',
                                localNeural: {
                                    assetId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
                                    language: 'en',
                                    execution: 'daemon',
                                },
                            },
                            tts: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).tts,
                                provider: 'local_neural',
                                autoSpeakReplies: false,
                                localNeural: {
                                    model: 'kokoro',
                                    assetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
                                    voiceId: 'af_heart',
                                    speed: 1,
                                    execution: 'daemon',
                                },
                            },
                            agent: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).agent,
                                prewarmOnConnect: true,
                            },
                            streaming: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).streaming,
                                enabled: false,
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude', agentRuntimeCapabilitiesV1: { localControl: { supported: true } } } },
            },
        });

        ensureAgentRpc.mockResolvedValueOnce({ ok: true, runId: 'local-agent-run', created: true });

        const { toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');

        await waitForLocalVoiceBoundaryEvent(`rpc:${RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM}`);
        expect(readWarmRequests()).toHaveLength(1);
        expect(readWarmRequests()[0]).toMatchObject({
            machineId: 'machine-1',
            payload: { packIds: [
                'kokoro-82m-v1.0-onnx-q8-wasm',
                'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
            ] },
        });
    }, 60_000);

    it.each([429, 503])('surfaces an attach-time daemon model warm failure with cause status %s', async status => {
        let rejectWarm!: (error: unknown) => void;
        configureWarmTransport(() =>
            new Promise<unknown>((_resolve, reject) => {
                rejectWarm = reject;
            }),
        );
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...readLocalConversationVoiceSettings(storage.getState().settings.voice),
                            conversationMode: 'agent',
                            tts: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).tts,
                                provider: 'local_neural',
                                autoSpeakReplies: false,
                                localNeural: {
                                    model: 'kokoro',
                                    assetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
                                    voiceId: 'af_heart',
                                    speed: 1,
                                    execution: 'daemon',
                                },
                            },
                        } },
                    },
                },
            },
        });

        const { getLocalVoiceState, toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
        expect(getLocalVoiceState().status).toBe('recording');
        await waitForLocalVoiceBoundaryEvent(`rpc:${RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM}`);
        expect(rejectWarm).toBeTypeOf('function');

        const failureCause = projectActionFailureCauseV1(Object.assign(new TypeError('private warm response'), { status }), 'voice.prewarm');
        rejectWarm(Object.assign(
            new Error('daemon_voice_inference_model_not_installed'),
            { code: 'model_not_installed', failureCause },
        ));
        await waitForLocalVoiceState(state => state.status === 'idle'
            && state.error === 'daemon_voice_inference_model_not_installed');
        expect(getLocalVoiceState()).toMatchObject({
            status: 'idle',
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            error: 'daemon_voice_inference_model_not_installed',
        });
        const { voiceConversationRuntimeMachine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
        expect(voiceConversationRuntimeMachine.getSnapshot().error).toMatchObject({ failureCause });
    }, 60_000);

    it('does not revive a stopped Voice session when its attach-time warm fails late', async () => {
        let rejectWarm!: (error: unknown) => void;
        configureWarmTransport(() =>
            new Promise<unknown>((_resolve, reject) => {
                rejectWarm = reject;
            }),
        );

        const storage = await getStorage();
        const voice = storage.getState().settings.voice;
        const config = readLocalConversationVoiceSettings(voice);
        storage.__setState({ settings: { ...storage.getState().settings, voice: {
            ...voice, providerId: 'local_conversation', providers: { ...voice.providers,
                local_conversation: { schemaVersion: 1, config: { ...config,
                    conversationMode: 'agent',
                    tts: { ...config.tts, provider: 'local_neural', autoSpeakReplies: false,
                        localNeural: { ...config.tts.localNeural, execution: 'daemon',
                            assetId: 'kokoro-82m-v1.0-onnx-q8-wasm' } },
                } },
            },
        } }, sessions: { ...storage.getState().sessions,
            'voice-warm-cancelled': createSessionFixture({
                id: 'voice-warm-cancelled', serverId: localVoiceHomeId, active: true,
                metadata: { machineId: 'machine-1', path: '/workspace/voice-warm-cancelled', host: 'voice.test', flavor: 'claude',
                    agentRuntimeCapabilitiesV1: { localControl: { supported: true } } },
            }),
        } });

        const {
            getLocalVoiceState,
            stopLocalVoiceSession,
            toggleLocalVoiceTurn,
        } = localVoiceEngine;
        await toggleLocalVoiceTurn('voice-warm-cancelled');
        await waitForLocalVoiceBoundaryEvent(`rpc:${RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM}`);
        expect(readWarmRequests()).toHaveLength(1);
        // Stop must settle while the real RPC acknowledgement remains held;
        // its private AbortSignal is not part of the daemon's wire contract.
        await stopLocalVoiceSession();

        rejectWarm(Object.assign(
            new Error('daemon_voice_inference_runtime_unavailable'),
            { code: 'runtime_unavailable' },
        ));
        await flushMicrotasks(4);

        expect(getLocalVoiceState()).toMatchObject({
            status: 'idle',
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            error: null,
        });
    }, 60_000);

    it.each([true, false])('rejects a text turn and publishes its typed daemon cause without private prose (already admitted: %s)', async (admitted) => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...readLocalConversationVoiceSettings(storage.getState().settings.voice),
                            conversationMode: 'agent',
                            stt: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).tts,
                                autoSpeakReplies: false,
                            },
                            agent: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).agent,
                            },
                            streaming: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).streaming,
                                enabled: true,
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude', agentRuntimeCapabilitiesV1: { localControl: { supported: true } } } },
            },
        });

        ensureAgentRpc.mockResolvedValueOnce({ ok: true, runId: 'local-agent-run', created: true });
        startTurnRpc.mockRejectedValueOnce(
            Object.assign(new Error('Private provider response at /Users/private/repository'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );

        localVoiceSpeechTranscription.mockResolvedValueOnce('hello world');

        const { getLocalVoiceState, toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        const onAccepted = vi.fn(async () => {});
        const turn = localVoiceEngine.sendLocalVoiceAgentTextTurn('s1', 'hello world', admitted ? {
            localId: 'typed-text-failure', deliveryCommand: 'interrupt_and_send',
        } : undefined, onAccepted);
        await expect(turn).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });

        expect(startTurnRpc, JSON.stringify({
            runtime: getLocalVoiceState(),
            settings: readLocalConversationVoiceSettings(storage.getState().settings.voice).streaming,
            start: ensureAgentRpc.mock.calls,
            send: readTurnRpc.mock.calls,
        })).toHaveBeenCalledTimes(1);
        expect(readTurnRpc).not.toHaveBeenCalled();
        expect(getLocalVoiceState()).toMatchObject({
            status: 'idle',
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            error: RPC_ERROR_CODES.METHOD_NOT_FOUND,
        });
        expect(onAccepted).not.toHaveBeenCalled();
        const { voiceCaptureAdmissionController } = await import('@/voice/runtime/input/VoiceCaptureAdmissionController');
        const dictation = voiceCaptureAdmissionController.acquire('dictation');
        if (dictation.status === 'acquired') dictation.lease.release();
        expect(dictation.status).toBe('acquired');
    });

    it('offers the existing account reconnect action for the RUN62H R2 failed startup Run', async () => {
        const { ConnectedServiceUxDiagnosticV1Schema } = await import('@happier-dev/protocol/connect/connectedServiceUxDiagnostics');
        const { ExecutionRunGetResponseSchema } = await import('@happier-dev/protocol/execution/runs/responseSchemas');
        const { voiceConversationRuntimeMachine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
        const { deriveLocalVoiceSessionSnapshot } = await import('@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot');
        const { projectVoiceAttemptPresentation } = await import('@/components/voice/attempt/projectVoiceAttemptPresentation');
        const { resolveConnectedServiceUxDiagnosticPresentation } = await import('@/components/sessions/connectedServices/diagnostics/connectedServiceUxDiagnostics');
        const { t } = await import('@/text');
        // final62h/r-proof.json records a failed Run with code/message/uxDiagnostic.
        // Its collector omits diagnostic values; complete them using the owner's schema.
        const uxDiagnostic = ConnectedServiceUxDiagnosticV1Schema.parse({
            code: 'connected_service_credential_reconnect_required', source: 'spawn_resume',
            failurePhase: 'materialization', serviceId: 'happier.agent.codex/openai-codex',
            profileId: '705530f2-81e8-4ba2-bc7b-7929a4b95b5a', retryable: false,
            suggestedActions: ['reconnect_profile', 'open_connected_accounts'],
            diagnostics: { reconnectCause: 'listed_needs_reauth' },
        });
        const storage = await getStorage();
        const voice = storage.getState().settings.voice;
        storage.__setState({ settings: { ...storage.getState().settings, voice: {
            ...voice, providerId: 'local_conversation', providers: { ...voice.providers,
                local_conversation: { schemaVersion: 1, config: {
                    ...readLocalConversationVoiceSettings(voice), conversationMode: 'agent',
                    tts: { ...readLocalConversationVoiceSettings(voice).tts, autoSpeakReplies: false },
                } },
            },
        } } });
        await localVoiceEngine.toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
        const incumbent = sessionRpcWithServerScope.getMockImplementation();
        if (!incumbent) throw new Error('Missing daemon transport');
        sessionRpcWithServerScope.mockImplementation(async request => {
            const response = await incumbent(request);
            if (request.method !== SESSION_RPC_METHODS.EXECUTION_RUN_GET) return response;
            const parsed = ExecutionRunGetResponseSchema.safeParse(response);
            if (!parsed.success) return response;
            return ExecutionRunGetResponseSchema.parse({ run: { ...parsed.data.run, status: 'failed',
                error: { code: uxDiagnostic.code, message: 'PRIVATE_PROVIDER_BODY', uxDiagnostic } } });
        });
        // No durableDispatch argument: take the actual enqueue/block/result conversion path.
        await expect(localVoiceEngine.sendLocalVoiceAgentTextTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello'))
            .rejects.toMatchObject({ uxDiagnostic });
        const snapshot = deriveLocalVoiceSessionSnapshot('local_conversation', 'local', voiceConversationRuntimeMachine.getSnapshot());
        expect(snapshot).toMatchObject({ errorConnectedServiceDiagnostic: uxDiagnostic, errorRecoveryAction: 'connect_agent' });
        expect(snapshot.errorProviderError).toMatchObject({ code: uxDiagnostic.code, action: 'review_connection' });
        const { resolveVoiceConnectRecoveryTarget } = await import('@/components/voice/surface/resolveVoiceConnectRecoveryTarget');
        const { executeVoiceAttemptRecovery, resolveVoiceAttemptRecoveryAvailable } = await import('@/components/voice/attempt/voiceAttemptRecovery');
        const { resolveVoiceSurfaceRecovery } = await import('@/components/voice/surface/resolveVoiceSurfaceRecovery');
        const { resolveVoiceAttemptControl } = await import('@/components/voice/attempt/resolveVoiceAttemptControl');
        const { buildConnectedServiceSetupRoute } = await import('@/sync/domains/connectedServices/connectedAccountSettingsRoute');
        const recoveryContext = { providerError: snapshot.errorProviderError, connectRecoveryTarget: resolveVoiceConnectRecoveryTarget({
            uxDiagnostic: snapshot.errorConnectedServiceDiagnostic, agentRuntime: null, bindingScope: 'global',
            runtimeTarget: null, provider: null, providerConfig: null, sessionMetadata: null, connectedServiceEntries: [],
        }), runtimeRecoveryTarget: null, attemptSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            startSessionId: VOICE_AGENT_GLOBAL_SESSION_ID, globalStartAuthorized: false };
        // R2 has no admitted Start; reconnect must still be an actionable recovery.
        const control = resolveVoiceAttemptControl({ status: 'disconnected', startAdmitted: false,
            canStop: false, muted: false, capturing: false, surfaceState: 'error', tone: 'error',
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, canDismissFailedAttempt: true,
            hasRecovery: resolveVoiceAttemptRecoveryAvailable(resolveVoiceSurfaceRecovery(snapshot.errorRecoveryAction), recoveryContext) });
        expect(control).toMatchObject({ canStart: false, recoveryAvailable: true, primaryAction: 'recover' });
        const presentation = projectVoiceAttemptPresentation({
            control,
            attemptId: 'run62h', ended: false, ...snapshot, recoveryAction: snapshot.errorRecoveryAction ?? null,
            recoveryContext, serviceTitle: 'Voice', agentTitle: 'Codex', agentMachineLabel: 'Dev machine',
        });
        expect(presentation.failureMessage).toBe(t(resolveConnectedServiceUxDiagnosticPresentation(uxDiagnostic)!.bodyKey));
        expect(presentation.recovery).toMatchObject({ action: 'connect_agent', label: t('connectedServices.detail.actions.reconnect') });
        const destinations: unknown[] = [];
        await expect(executeVoiceAttemptRecovery({ recoveryAction: presentation.recovery!.action,
            setupIncomplete: false, context: recoveryContext, navigate: href => { destinations.push(href); } })).resolves.toBe(true);
        expect(destinations).toEqual([buildConnectedServiceSetupRoute({ kind: 'reconnect',
            serviceKey: uxDiagnostic.serviceId!, accountId: uxDiagnostic.profileId! })]);
        expect(JSON.stringify(presentation)).not.toContain('PRIVATE_PROVIDER_BODY');
    });

    it('rethrows a known before-effect streamed-turn rejection for durable delivery', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...readLocalConversationVoiceSettings(storage.getState().settings.voice),
                            conversationMode: 'agent',
                            tts: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).tts,
                                autoSpeakReplies: false,
                            },
                            agent: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).agent,
                            },
                            streaming: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).streaming,
                                enabled: true,
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude', agentRuntimeCapabilitiesV1: { localControl: { supported: true } } } },
            },
        });

        ensureAgentRpc.mockResolvedValueOnce({ ok: true, runId: 'local-agent-run', created: true });
        startTurnRpc.mockRejectedValueOnce(
            Object.assign(new Error('Method not found'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );
        const onAccepted = vi.fn(async () => {});

        await expect(localVoiceEngine.sendLocalVoiceAgentTextTurn(
            's1',
            'durable turn',
            { localId: 'voice-local-before-effect', deliveryCommand: 'interrupt_and_send' },
            onAccepted,
        )).rejects.toMatchObject({
            message: 'Method not found',
            code: 'VOICE_TEXT_TURN_REJECTED_BEFORE_EFFECT',
            pendingDeliveryBlockedReason: 'provider_unavailable_before_acceptance',
        });

        expect(startTurnRpc).toHaveBeenCalledTimes(1);
        expect(readTurnRpc).not.toHaveBeenCalled();
        expect(onAccepted).not.toHaveBeenCalled();
        const { voiceConversationRuntimeMachine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
        expect(voiceConversationRuntimeMachine.getSnapshot().error).toHaveProperty('cause', expect.objectContaining({
            code: 'VOICE_TEXT_TURN_REJECTED_BEFORE_EFFECT',
            cause: expect.objectContaining({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        }));
    });

    it('cancels the stream and rejects the text caller with the typed read failure', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...readLocalConversationVoiceSettings(storage.getState().settings.voice),
                            conversationMode: 'agent',
                            stt: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).tts,
                                autoSpeakReplies: false,
                            },
                            agent: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).agent,
                            },
                            streaming: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).streaming,
                                enabled: true,
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude', agentRuntimeCapabilitiesV1: { localControl: { supported: true } } } },
            },
        });

        ensureAgentRpc.mockResolvedValueOnce({ ok: true, runId: 'local-agent-run', created: true });
        startTurnRpc.mockResolvedValueOnce({ streamId: 'stream-1' });
        readTurnRpc.mockRejectedValueOnce(
            Object.assign(new Error('Method not found'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );

        localVoiceSpeechTranscription.mockResolvedValueOnce('hello world');

        const { getLocalVoiceState, toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        await expect(localVoiceEngine.sendLocalVoiceAgentTextTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello world', {
            localId: 'typed-read-failure', deliveryCommand: 'interrupt_and_send',
        }, async () => {})).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });

        expect(cancelTurnRpc).toHaveBeenCalledTimes(1);
        expect(getLocalVoiceState()).toMatchObject({
            status: 'idle',
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            error: RPC_ERROR_CODES.METHOD_NOT_FOUND,
        });
    });

    it.each([
        { code: 'acp_turn_failed', message: 'Cannot connect to API: Unable to connect. https://user:PRIVATE_PASSWORD@example.test/v1?api_key=PRIVATE_API_KEY token=PRIVATE_TOKEN /home/alice/private/model',
            reason: 'Cannot connect to API', recovery: 'retry' },
        { code: 'usage_limit', message: 'Codex usage limit reached. Try another connected account or try again after your limit resets.',
            reason: 'usage limit', recovery: 'none' },
    ])('shows the $code reason and recovery from the live turn stream without leaking provider credentials', async ({ code, message, reason, recovery }) => {
        const storage = await getStorage();
        const voice = storage.getState().settings.voice;
        const local = readLocalConversationVoiceSettings(voice);
        storage.__setState({ settings: { ...storage.getState().settings, voice: {
            ...voice, providerId: 'local_conversation', providers: { ...voice.providers,
                local_conversation: { schemaVersion: 1, config: {
                    ...local, conversationMode: 'agent',
                    tts: { ...local.tts, autoSpeakReplies: false },
                } },
            },
        } } });
        await localVoiceEngine.toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
        readTurnRpc.mockResolvedValueOnce(ExecutionRunTurnStreamReadResponseSchema.parse({
            streamId: 'stream-1', nextCursor: 1, done: true,
            events: [{ t: 'error', errorCode: code, error: message }],
        }));
        await expect(localVoiceEngine.sendLocalVoiceAgentTextTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'SAY READY', {
            localId: 'run71-acp-failure', deliveryCommand: 'interrupt_and_send',
        }, async () => {})).rejects.toMatchObject({ rpcErrorCode: code });
        const { voiceConversationRuntimeMachine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
        const { deriveLocalVoiceSessionSnapshot } = await import('@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot');
        const { projectVoiceAttemptPresentation } = await import('@/components/voice/attempt/projectVoiceAttemptPresentation');
        const { resolveVoiceAttemptControl } = await import('@/components/voice/attempt/resolveVoiceAttemptControl');
        const snapshot = deriveLocalVoiceSessionSnapshot('local_conversation', 'local', voiceConversationRuntimeMachine.getSnapshot());
        const presentation = projectVoiceAttemptPresentation({
            ...snapshot, attemptId: 'run71-acp', ended: false,
            control: resolveVoiceAttemptControl({ status: snapshot.status, startAdmitted: false,
                canStop: snapshot.canStop, muted: false, capturing: false, surfaceState: 'error', tone: 'error',
                sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, hasRecovery: true }),
            recoveryAction: snapshot.errorRecoveryAction ?? null,
            recoveryContext: { connectRecoveryTarget: { kind: 'default' }, runtimeRecoveryTarget: null,
                attemptSessionId: VOICE_AGENT_GLOBAL_SESSION_ID, startSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                globalStartAuthorized: false },
            serviceTitle: 'Voice', agentTitle: 'ACP agent', agentMachineLabel: 'Dev machine',
        });
        expect(snapshot.errorMessage).toBe(code);
        expect(presentation.failureMessage).toContain(reason);
        expect(presentation.recovery?.action).toBe(recovery);
        expect(presentation.failureMessage).not.toBe('Voice provider failed.');
        expect(JSON.stringify(presentation)).not.toMatch(/PRIVATE_PASSWORD|PRIVATE_API_KEY|PRIVATE_TOKEN|\/home\/alice/);
    });

    it('interrupts an in-flight local agent text update and surfaces the follow-up assistant reply', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...readLocalConversationVoiceSettings(storage.getState().settings.voice),
                            conversationMode: 'agent',
                            tts: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).tts,
                                autoSpeakReplies: false,
                            },
                            agent: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).agent,
                            },
                            streaming: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).streaming,
                                enabled: true,
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude', agentRuntimeCapabilitiesV1: { localControl: { supported: true } } } },
            },
        });

        ensureAgentRpc.mockResolvedValueOnce({ ok: true, runId: 'local-agent-run', created: true });

        let resolveFirstRead: (value: VoiceAgentTurnStreamReadResult) => void = () => {
            throw new Error('Expected first stream read resolver');
        };
        const firstReadPromise = new Promise<VoiceAgentTurnStreamReadResult>((resolve) => {
            resolveFirstRead = resolve;
        });
        startTurnRpc
            .mockResolvedValueOnce({ streamId: 'stream-1' })
            .mockResolvedValueOnce({ streamId: 'stream-2' });
        readTurnRpc.mockImplementation(async ({ payload }: SessionRequest) => {
            const { streamId } = ExecutionRunTurnStreamReadRequestSchema.parse(payload);
            if (streamId === 'stream-1') {
                return await firstReadPromise;
            }
            return {
                streamId,
                events: [{ t: 'done', assistantText: 'Permission summary', actions: [] }],
                nextCursor: 1,
                done: true,
            };
        });

        const { voiceSessionBindingManager } = await import('@/voice/binding/voiceConversationBindingRuntime');
        await expect(voiceSessionBindingManager.ensureBound({
            adapterId: 'local_conversation',
            controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            requestedTargetSessionId: null,
        })).resolves.toMatchObject({
            controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            conversationSessionId: 'voice-home-session',
        });

        const { sendLocalVoiceAgentTextUpdate } = localVoiceEngine;

        const first = sendLocalVoiceAgentTextUpdate('s1', 'Initial coding request');
        await waitForLocalVoiceBoundaryEvent('stream-start');
        expect(startTurnRpc.mock.calls.length).toBeGreaterThanOrEqual(1);
        // The start request's ingress precedes its ACK and owned stream. Join
        // read admission before asking a second update to interrupt that stream.
        await waitForLocalVoiceBoundaryEvent(`rpc:${SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ}`);

        const second = sendLocalVoiceAgentTextUpdate('s1', 'Permission required. Ask the human whether to allow it.');
        await waitForLocalVoiceBoundaryEvent(`rpc:${SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL}`);
        expect(cancelTurnRpc.mock.calls.length).toBeGreaterThanOrEqual(1);

        resolveFirstRead({
            streamId: 'stream-1',
            events: [],
            nextCursor: 0,
            done: false,
        });

        await expect(first).resolves.toBeUndefined();
        await expect(second).resolves.toBeUndefined();

        expect(cancelTurnRpc).toHaveBeenCalledWith({
            sessionId: 'voice-home-session',
            serverId: localVoiceHomeId,
            method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL,
            payload: { streamId: 'stream-1', runId: 'local-agent-run' },
        });
        expect(startTurnRpc).toHaveBeenCalledTimes(2);
    });

    it.each(['signed-out', 'created'] as const)('speaks the Session create outcome after an empty streamed follow-up (%s)', async outcome => {
        const storage = await getStorage();
        const settings = storage.getState().settings;
        const config = readLocalConversationVoiceSettings(settings.voice);
        storage.__setState({ settings: { ...settings, voice: { ...settings.voice,
            providers: { ...settings.voice.providers, local_conversation: { schemaVersion: 1, config: {
                ...config, conversationMode: 'agent',
                agent: { ...config.agent, agentSource: 'session', prewarmOnConnect: false },
                tts: { ...config.tts, autoSpeakReplies: true, provider: 'device' },
                streaming: { ...config.streaming, enabled: true, ttsEnabled: true },
            } } },
        } } });
        const { rememberLastUsedBackendSelection } = await import('@/sync/domains/state/newSessionTargetUiState');
        rememberLastUsedBackendSelection(storage.getState().settingsScope, {
            lastUsedBackendTarget: null, lastUsedAgent: 'claude',
        });
        expoSpeechSpeak.mockImplementation((_text, options) => {
            options?.onStart?.();
            queueMicrotask(() => options?.onDone?.());
        });
        localVoiceSpeechTranscription.mockResolvedValueOnce('Create a new Session in this project.');
        // Let the real binding create its separate Voice conversation before
        // replacing only the subsequent coding-Session daemon response.
        await localVoiceEngine.toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
        const inventory = createReadyMachineAgentInventoryFixture([
            { agentId: 'claude', title: 'Claude' }, { agentId: 'codex', title: 'Codex' },
        ]);
        // Admission selects the ready default. The daemon may then report that
        // its credentials changed before launch; that actual outcome owns speech.
        const incumbent = machineRpcWithServerScope.getMockImplementation();
        const creationInputs: Array<ReturnType<typeof SessionSpawnNewInputV2Schema.parse>> = [];
        machineRpcWithServerScope.mockImplementation(async (request: MachineRequest) => {
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { protocolVersion: 1, projection: inventory.projection };
            }
            if (request.method === RPC_METHODS.CAPABILITIES_DETECT) return inventory.capabilities;
            if (request.method === RPC_METHODS.DAEMON_AGENTS_INSTALL_LIST) return { jobs: [] };
            if (request.method !== RPC_METHODS.SESSION_SPAWN_NEW) {
                if (!incumbent) throw new Error('Expected Machine daemon boundary');
                return incumbent(request);
            }
            const input = SessionSpawnNewInputV2Schema.parse(request.payload);
            creationInputs.push(input);
            if (outcome === 'signed-out') return SessionSpawnNewResultV1Schema.parse({
                type: 'error', code: 'spawn_failed', retryable: false,
                launchError: { kind: 'launch_error', code: 'agent_startup_failed', message: 'Agent startup failed',
                    failureCause: { phase: 'client_start', failureReason: 'unclassified_provider_error',
                        providerErrorMessage: 'Claude is signed out on the selected machine' } },
            });
            storage.getState().applySessions([createSessionFixture({ id: 'created-coding-session', serverId: localVoiceHomeId,
                active: true, activeAt: Date.now(),
                metadata: { machineId: 'machine-1', path: '/project', host: 'test', flavor: 'claude' },
            })]);
            return SessionSpawnNewResultV1Schema.parse({ type: 'success', disposition: 'created',
                sessionId: 'created-coding-session', executionTarget: input.executionTarget,
                organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' },
            });
        });
        const { publishMachineContributionRegistryProjectionInvalidation } =
            await import('@/sync/ops/machineContributionRegistryProjectionRevision');
        publishMachineContributionRegistryProjectionInvalidation({ serverId: localVoiceHomeId, machineId: 'machine-1' }, 'authority');
        startTurnRpc.mockResolvedValueOnce({ streamId: 'create-session-action' })
            .mockResolvedValueOnce({ streamId: 'create-session-followup' });
        readTurnRpc.mockImplementation(async request => {
            const { streamId } = ExecutionRunTurnStreamReadRequestSchema.parse(request.payload);
            return ExecutionRunTurnStreamReadResponseSchema.parse({ streamId, events: streamId === 'create-session-action' ? [
                { t: 'voice_output', output: { v: 1, kind: 'side_effect', turnId: streamId, seq: 0,
                    effectId: 'create-session-outcome', action: { t: 'spawnSession', args: {
                        executionTarget: { serverId: localVoiceHomeId, machineId: 'machine-1' },
                        directory: { kind: 'path', path: '/project' },
                    } } } },
                { t: 'voice_output', output: { v: 1, kind: 'turn_final', turnId: streamId, seq: 1, text: '' } },
            ] : [{ t: 'voice_output', output: { v: 1, kind: 'turn_final', turnId: streamId, seq: 0, text: '' } }],
                nextCursor: streamId === 'create-session-action' ? 2 : 1, done: true });
        });

        await localVoiceEngine.toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);

        expect(creationInputs).toHaveLength(1);
        expect(creationInputs[0]?.agentTarget).toEqual({ kind: 'agent',
            identity: { pluginId: 'happier.agent.claude', localId: 'claude' } });
        const spoken = expoSpeechSpeak.mock.calls.map(([text]) => text).join(' ');
        if (outcome === 'signed-out') {
            expect(spoken).toMatch(/Claude.*signed out/i);
            expect(spoken).toContain('Codex');
        } else {
            expect(spoken).toBe(t('newSession.sessionStartedMessage'));
        }
    });

    it('Say discards duplex input and suppresses old live output without cancelling the Agent or Current UI', async () => {
        const storage = await getStorage();
        const local = readLocalConversationVoiceSettings(storage.getState().settings.voice);
        storage.__setState({ settings: { ...storage.getState().settings, voice: {
            ...storage.getState().settings.voice, providerId: 'local_conversation',
            welcome: { ...storage.getState().settings.voice.welcome, enabled: false },
            privacy: { ...storage.getState().settings.voice.privacy, currentUiContextMode: 'automatic' },
            providers: { ...storage.getState().settings.voice.providers,
                local_conversation: { schemaVersion: 1, config: { ...local, conversationMode: 'agent',
                    stt: { ...local.stt, provider: 'device' },
                    handsFree: { ...local.handsFree, enabled: true },
                    tts: { ...local.tts, provider: 'device', autoSpeakReplies: true, bargeInEnabled: true },
                    streaming: { ...local.streaming, enabled: true, ttsEnabled: true },
                } },
            },
        } } });
        speechRecStart.mockImplementation(() => { emitSpeechRecEvent('start'); emitSpeechRecEvent('audiostart'); });
        speechRecStop.mockImplementation(() => emitSpeechRecEvent('end'));
        const ui = await mountCurrentUi({ entity: { kind: 'issue', label: 'Retained context' }, commands: [] });
        const control = VOICE_AGENT_GLOBAL_SESSION_ID;
        await localVoiceEngine.toggleLocalVoiceTurn(control, ui.port);
        await voiceAgentSessions.ensureRunning(control);
        const liveStarted = createDeferred<void>();
        const sayStarted = createDeferred<void>();
        const finalReply = createDeferred<VoiceAgentTurnStreamReadResult>();
        const firstText = 'The live Agent is still working.';
        const lateText = 'This later chunk must remain silent.';
        const sayText = 'Read this selected transcript answer.';
        let finishLive = () => {};
        let finishSay = () => {};
        expoSpeechSpeak.mockImplementation((text, options) => {
            options.onStart?.();
            if (text === sayText) {
                finishSay = () => options.onDone?.();
                sayStarted.resolve();
            } else if (text === firstText) {
                finishLive = () => options.onDone?.();
                liveStarted.resolve();
            } else {
                options.onDone?.();
            }
        });
        startTurnRpc.mockResolvedValueOnce({ streamId: 'say-takeover-live' });
        readTurnRpc.mockResolvedValueOnce(ExecutionRunTurnStreamReadResponseSchema.parse({
            streamId: 'say-takeover-live', events: [{ t: 'voice_output', output: {
                v: 1, kind: 'speech_segment', turnId: 'say-takeover-live', seq: 0,
                segmentId: 'say-takeover-live:0', text: firstText,
            } }], nextCursor: 1, done: false,
        })).mockImplementationOnce(() => finalReply.promise);
        const turn = localVoiceEngine.sendLocalVoiceAgentTextTurn(control, 'Keep working.', {
            localId: 'say-takeover-input', deliveryCommand: 'interrupt_and_send',
        });
        const { executeVoiceSpeechAction } = await import('@/sync/ops/actions/voiceSpeechAction');
        const { localVoiceTtsController } = await import('@/voice/backends/tts/localVoiceTtsController');
        const { expoSpeechStop } = await import('./localVoiceEngine.testHarness');
        let saying: ReturnType<typeof executeVoiceSpeechAction> | undefined;
        const finishAgent = () => finalReply.resolve(ExecutionRunTurnStreamReadResponseSchema.parse({
            streamId: 'say-takeover-live', events: [
                { t: 'voice_output', output: { v: 1, kind: 'speech_segment', turnId: 'say-takeover-live',
                    seq: 1, segmentId: 'say-takeover-live:1', text: lateText } },
                { t: 'voice_output', output: { v: 1, kind: 'turn_final', turnId: 'say-takeover-live',
                    seq: 2, text: firstText + ' ' + lateText } },
            ], nextCursor: 3, done: true,
        }));
        try {
            await liveStarted.promise;
            emitSpeechRecEvent('result', { isFinal: false, results: [{ transcript: 'Discard this partial', confidence: 0.9 }] });
            const stopsBefore = expoSpeechStop.mock.calls.length;
            saying = executeVoiceSpeechAction('ui.voice_global.say.start', { text: sayText }, storage.getState().settings);
            await sayStarted.promise;
            expect(expoSpeechStop.mock.calls.length).toBeGreaterThan(stopsBefore);
            expect(speechRecStop).toHaveBeenCalled();
            expect(cancelTurnRpc).not.toHaveBeenCalled();
            expect(voiceAgentSessions.isActive(control)).toBe(true);
            finishAgent();
            await turn;
            expect(expoSpeechSpeak.mock.calls.map(([text]) => text)).toEqual([firstText, sayText]);
            expect(localVoiceTtsController.readSay()).toBe('speaking');
            emitSpeechRecEvent('end');
            expect(localVoiceEngine.getLocalVoiceState()).toMatchObject({ status: 'idle', sessionId: control });
            localVoiceTtsController.stopSay();
            expect(await saying).toEqual({ status: 'cancelled' });
            // Unchanged automatic metadata is delivered once per attempt.
            // A real mounted-owner transition proves Say kept its subscription.
            await ui.unmount();
            await localVoiceEngine.sendLocalVoiceAgentTextTurn(control, 'Do you still see this screen?', {
                localId: 'say-retained-context-input', deliveryCommand: 'interrupt_and_send',
            });
            const message = (startTurnRpc.mock.calls.at(-1)?.[0].payload as { message?: string }).message;
            expect(message).toContain('CURRENT UI CONTEXT');
            expect(message).toContain('"state":"unavailable"');
            expect(cancelTurnRpc).not.toHaveBeenCalled();
            // Stop and a later Agent turn do not restore discarded input. A
            // fresh explicit microphone action admits a clean capture again.
            expect(localVoiceEngine.getLocalVoiceState()).toMatchObject({ status: 'idle', sessionId: control });
            await localVoiceEngine.toggleLocalVoiceTurn(control);
            expect(localVoiceEngine.getLocalVoiceState()).toMatchObject({ status: 'recording', sessionId: control });
        } finally {
            finishAgent(); finishLive(); finishSay(); localVoiceTtsController.stopSay();
            await saying;
            await turn;
        }
    });

    it('Say discards duplex input while a delayed nonstream Agent reply remains silent', async () => {
        const storage = await getStorage();
        const local = readLocalConversationVoiceSettings(storage.getState().settings.voice);
        storage.__setState({ settings: { ...storage.getState().settings, voice: {
            ...storage.getState().settings.voice, providerId: 'local_conversation',
            welcome: { ...storage.getState().settings.voice.welcome, enabled: false },
            providers: { ...storage.getState().settings.voice.providers,
                local_conversation: { schemaVersion: 1, config: { ...local, conversationMode: 'agent',
                    stt: { ...local.stt, provider: 'device' },
                    handsFree: { ...local.handsFree, enabled: true },
                    tts: { ...local.tts, provider: 'device', autoSpeakReplies: true, bargeInEnabled: true },
                    streaming: { ...local.streaming, enabled: true, ttsEnabled: false },
                } },
            },
        } } });
        speechRecStart.mockImplementation(() => { emitSpeechRecEvent('start'); emitSpeechRecEvent('audiostart'); });
        speechRecStop.mockImplementation(() => emitSpeechRecEvent('end'));
        const control = VOICE_AGENT_GLOBAL_SESSION_ID;
        await localVoiceEngine.toggleLocalVoiceTurn(control);
        await voiceAgentSessions.ensureRunning(control);
        const readEntered = createDeferred<void>();
        const sayStarted = createDeferred<void>();
        const final = createDeferred<VoiceAgentTurnStreamReadResult>();
        startTurnRpc.mockResolvedValueOnce({ streamId: 'say-nonstream-final' });
        readTurnRpc.mockImplementationOnce(async () => { readEntered.resolve(); return await final.promise; });
        const finishAgent = () => final.resolve(ExecutionRunTurnStreamReadResponseSchema.parse({
            streamId: 'say-nonstream-final', events: [{ t: 'voice_output', output: {
                v: 1, kind: 'turn_final', turnId: 'say-nonstream-final', seq: 0, text: 'Retain this late Agent answer.',
            } }], nextCursor: 1, done: true,
        }));
        let finishSay = () => {};
        expoSpeechSpeak.mockImplementation((text, options) => {
            options.onStart?.();
            if (text === 'Keep reading the selected answer.') {
                finishSay = () => options.onDone?.(); sayStarted.resolve();
            } else options.onDone?.();
        });
        const turn = localVoiceEngine.sendLocalVoiceAgentTextTurn(control, 'Finish the work.', {
            localId: 'say-nonstream-input', deliveryCommand: 'interrupt_and_send',
        });
        const { executeVoiceSpeechAction } = await import('@/sync/ops/actions/voiceSpeechAction');
        const { localVoiceTtsController } = await import('@/voice/backends/tts/localVoiceTtsController');
        let saying: ReturnType<typeof executeVoiceSpeechAction> | undefined;
        try {
            await readEntered.promise;
            saying = executeVoiceSpeechAction('ui.voice_global.say.start', { text: 'Keep reading the selected answer.' },
                storage.getState().settings);
            await sayStarted.promise;
            finishAgent(); await turn;
            expect(cancelTurnRpc).not.toHaveBeenCalled();
            expect(expoSpeechSpeak.mock.calls.map(([text]) => text)).toEqual(['Keep reading the selected answer.']);
            expect(localVoiceTtsController.readSay()).toBe('speaking');
        } finally {
            finishAgent(); finishSay(); localVoiceTtsController.stopSay(); await saying; await turn;
        }
    });

    it.each(['engine', 'composer'] as const)('keeps newer Say while %s input waits for durable admission', async entry => {
        const storage = await getStorage();
        const local = readLocalConversationVoiceSettings(storage.getState().settings.voice);
        storage.__setState({ settings: { ...storage.getState().settings, voice: {
            ...storage.getState().settings.voice, providerId: 'local_conversation',
            welcome: { ...storage.getState().settings.voice.welcome, enabled: false },
            providers: { ...storage.getState().settings.voice.providers,
                local_conversation: { schemaVersion: 1, config: { ...local, conversationMode: 'agent',
                    stt: { ...local.stt, provider: 'device' },
                    tts: { ...local.tts, provider: 'device', autoSpeakReplies: true },
                    streaming: { ...local.streaming, enabled: true, ttsEnabled: false },
                } },
            },
        } } });
        speechRecStart.mockImplementation(() => { emitSpeechRecEvent('start'); emitSpeechRecEvent('audiostart'); });
        speechRecStop.mockImplementation(() => emitSpeechRecEvent('end'));
        const control = VOICE_AGENT_GLOBAL_SESSION_ID;
        await localVoiceEngine.toggleLocalVoiceTurn(control);
        await voiceAgentSessions.ensureRunning(control);
        const { createLocalConversationVoiceAdapter } = await import('@/voice/adapters/localConversation/localConversationAdapter');
        const { voiceConversationBindingResolver } = await import('@/voice/binding/VoiceConversationBindingResolver');
        const { sendVoiceSessionComposerText } = await import('@/voice/binding/sendVoiceSessionComposerText');
        const binding = voiceConversationBindingResolver.resolveByControlSessionId({ controlSessionId: control });
        if (!binding) throw new Error('Expected native Voice conversation');
        const adapter = createLocalConversationVoiceAdapter();
        const enqueueEntered = createDeferred<void>();
        const releaseEnqueue = createDeferred<void>();
        const enqueue = localVoicePendingEnqueue.getMockImplementation();
        if (!enqueue) throw new Error('Expected canonical pending HTTP boundary');
        localVoicePendingEnqueue.mockImplementationOnce(async request => {
            const response = await enqueue(request);
            enqueueEntered.resolve(); await releaseEnqueue.promise; return response;
        });
        const startsBefore = startTurnRpc.mock.calls.length;
        const sending = entry === 'engine'
            ? localVoiceEngine.sendLocalVoiceAgentTextTurn(control, 'Retain this submitted work.')
            : sendVoiceSessionComposerText({ conversationSessionId: binding.conversationSessionId,
                text: 'Retain this submitted work.', getAdapter: () => adapter });
        const { executeVoiceSpeechAction } = await import('@/sync/ops/actions/voiceSpeechAction');
        const { localVoiceTtsController } = await import('@/voice/backends/tts/localVoiceTtsController');
        const { localVoiceSpeechOutputBoundary } = await import('./localVoiceEngine.testHarness');
        const playback = localVoiceSpeechOutputBoundary.holdNextPlayback('device');
        let saying: ReturnType<typeof executeVoiceSpeechAction> | undefined;
        try {
            await enqueueEntered.promise;
            saying = executeVoiceSpeechAction('ui.voice_global.say.start', { text: 'Keep this newer answer playing.' }, storage.getState().settings);
            await playback.started;
            releaseEnqueue.resolve();
            const result = await sending;
            if (entry === 'composer') expect(result).toMatchObject({ ok: true });
            expect(startTurnRpc.mock.calls.length).toBeGreaterThan(startsBefore);
            expect(cancelTurnRpc).not.toHaveBeenCalled();
            expect(expoSpeechSpeak.mock.calls.map(([text]) => text)).toEqual(['Keep this newer answer playing.']);
            expect(localVoiceTtsController.readSay()).toBe('speaking');
        } finally {
            releaseEnqueue.resolve(); playback(); localVoiceTtsController.stopSay(); await saying; await sending;
        }
    });

    it('streams agent deltas into chunked device TTS playback when enabled', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...readLocalConversationVoiceSettings(storage.getState().settings.voice),
                            conversationMode: 'agent',
                            stt: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).tts,
                                autoSpeakReplies: true,
                                provider: 'device',
                            },
                            agent: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).agent,
                            },
                            streaming: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).streaming,
                                enabled: true,
                                ttsEnabled: true,
                                ttsChunkChars: 32,
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude', agentRuntimeCapabilitiesV1: { localControl: { supported: true } } } },
            },
        });
        storage.__setState({
            ...storage.getState(),
            settings: {
                ...storage.getState().settings,
                voiceSettingsV1: storage.getState().settings.voice,
            },
        });

        ensureAgentRpc.mockResolvedValueOnce({ ok: true, runId: 'local-agent-run', created: true });
        startTurnRpc.mockResolvedValueOnce({ streamId: 'stream-tts-1' });
        // The canonical settings parser may retain the released 200-character
        // chunk size rather than this legacy fixture's smaller override. Keep
        // the stream comfortably above two admitted chunks so this composed
        // test proves queueing instead of depending on a stale threshold.
        const firstStreamedDelta = 'First streamed assistant sentence with enough content to cross the canonical chunk boundary. '.repeat(3).trim();
        const secondStreamedDelta = 'Second streamed assistant sentence continues beyond another canonical chunk boundary. '.repeat(3).trim();
        const finalStreamedText = `${firstStreamedDelta} ${secondStreamedDelta}`;
        readTurnRpc.mockResolvedValueOnce({
            streamId: 'stream-tts-1',
            events: [
                {
                    t: 'voice_output',
                    output: {
                        v: 1,
                        kind: 'speech_segment',
                        turnId: 'stream-tts-1',
                        seq: 0,
                        segmentId: 'stream-tts-1:segment:0',
                        text: firstStreamedDelta,
                    },
                },
                {
                    t: 'voice_output',
                    output: {
                        v: 1,
                        kind: 'speech_segment',
                        turnId: 'stream-tts-1',
                        seq: 1,
                        segmentId: 'stream-tts-1:segment:1',
                        text: secondStreamedDelta,
                    },
                },
                {
                    t: 'voice_output',
                    output: {
                        v: 1,
                        kind: 'turn_final',
                        turnId: 'stream-tts-1',
                        seq: 2,
                        text: finalStreamedText,
                    },
                },
            ],
            nextCursor: 3,
            done: true,
        });
        expoSpeechSpeak.mockImplementation((_text, options) => {
            options?.onStart?.();
            queueMicrotask(() => options?.onDone?.());
        });

        localVoiceSpeechTranscription.mockResolvedValueOnce('hello world');

        const { toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        await toggleLocalVoiceTurn('s1');

        expect(startTurnRpc).toHaveBeenCalledTimes(1);
        await waitForLocalVoiceBoundaryEvent('speech', 2);
        expect(expoSpeechSpeak.mock.calls.length).toBeGreaterThan(1);
    });

    it('keeps single-shot speech playback when streaming speech is disabled', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...readLocalConversationVoiceSettings(storage.getState().settings.voice),
                            conversationMode: 'agent',
                            stt: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).tts,
                                autoSpeakReplies: true,
                                provider: 'device',
                            },
                            agent: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).agent,
                            },
                            streaming: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).streaming,
                                enabled: true,
                                ttsEnabled: false,
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude', agentRuntimeCapabilitiesV1: { localControl: { supported: true } } } },
            },
        });

        ensureAgentRpc.mockResolvedValueOnce({ ok: true, runId: 'local-agent-run', created: true });
        startTurnRpc.mockResolvedValueOnce({ streamId: 'stream-tts-2' });
        // The same multi-segment stream that produces several chunks when
        // streaming speech is enabled; only ttsEnabled differs.
        const firstStreamedDelta = 'First streamed assistant sentence with enough content to cross the canonical chunk boundary. '.repeat(3).trim();
        const secondStreamedDelta = 'Second streamed assistant sentence continues beyond another canonical chunk boundary. '.repeat(3).trim();
        const finalStreamedText = `${firstStreamedDelta} ${secondStreamedDelta}`;
        readTurnRpc.mockResolvedValueOnce({
            streamId: 'stream-tts-2',
            events: [
                { t: 'voice_output', output: { v: 1, kind: 'speech_segment', turnId: 'stream-tts-2', seq: 0,
                    segmentId: 'stream-tts-2:segment:0', text: firstStreamedDelta } },
                { t: 'voice_output', output: { v: 1, kind: 'speech_segment', turnId: 'stream-tts-2', seq: 1,
                    segmentId: 'stream-tts-2:segment:1', text: secondStreamedDelta } },
                { t: 'voice_output', output: { v: 1, kind: 'turn_final', turnId: 'stream-tts-2', seq: 2,
                    text: finalStreamedText } },
            ],
            nextCursor: 3,
            done: true,
        });
        expoSpeechSpeak.mockImplementation((_text, options) => {
            options?.onStart?.();
            queueMicrotask(() => options?.onDone?.());
        });

        localVoiceSpeechTranscription.mockResolvedValueOnce('hello world');

        const { toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        await toggleLocalVoiceTurn('s1');

        expect(startTurnRpc).toHaveBeenCalledTimes(1);
        expect(expoSpeechSpeak).toHaveBeenCalledTimes(1);
        expect(expoSpeechSpeak.mock.calls[0]?.[0]).toBe(finalStreamedText);
    });

    it('retires the real Local Agent context admission synchronously on Account retirement', async () => {
        const storage = await getStorage();
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
        expect(activeServerId).not.toBe('');
        storage.__setState({
            ...storage.getState(),
            settings: {
                ...storage.getState().settings,
                experiments: true,
                featureToggles: {
                    ...storage.getState().settings.featureToggles,
                    voice: true,
                },
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    privacy: {
                        ...storage.getState().settings.voice.privacy,
                        currentUiContextMode: 'automatic',
                    },
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...readLocalConversationVoiceSettings(storage.getState().settings.voice),
                            conversationMode: 'agent',
                            stt: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).tts,
                                autoSpeakReplies: false,
                            },
                            agent: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).agent,
                                prewarmOnConnect: true,
                            },
                            streaming: {
                                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).streaming,
                                enabled: false,
                            },
                        } },
                    },
                },
            },
        });
        storage.__setState({
            ...storage.getState(),
            settings: {
                ...storage.getState().settings,
                voiceSettingsV1: storage.getState().settings.voice,
            },
        });

        const invocations: string[] = [];
        const uiForAccount = (accountId: string): CurrentUiContextMountedEnrichment => ({
            entity: { kind: 'issue', label: `${accountId}_CONTEXT` },
            commands: [{ title: `${accountId} command`, command: { kind: 'hostLocal',
                invoke: () => { invocations.push(accountId); return { ok: true }; },
            } }],
        });
        const currentUi = await mountCurrentUi(uiForAccount('account-a'));
        const agentStart = {
            resolve: null as ((value: VoiceRunStartAck) => void) | null,
        };
        ensureAgentRpc.mockImplementationOnce(
            () => new Promise<VoiceRunStartAck>((resolve) => {
                agentStart.resolve = resolve;
            }),
        );

        const {
            captureActiveServerAccountScopeLifetime,
            retireActiveServerAccountScopeLifetime,
        } = await import('@/sync/domains/scope/activeServerAccountScope');
        const admittedAccountLifetime = captureActiveServerAccountScopeLifetime();
        expect(admittedAccountLifetime?.scope).toEqual({
            serverId: activeServerId,
            accountId: 'account-a',
        });
        const { getVoiceAdapterRegistry } = await import('@/voice/session/voiceAdapterRegistry');
        // Exercise the capture admission directly. VoiceSessionRuntime has its
        // own Account-change lifecycle responsibility; mounting it here would
        // add a second retirement writer and would not decide whether the
        // retained Local Voice port itself is fenced.
        const start = localVoiceEngine.toggleLocalVoiceTurn(
            VOICE_AGENT_GLOBAL_SESSION_ID,
            currentUi.port,
        );
        await waitForLocalVoiceBoundaryEvent('agent-start');
        expect(ensureAgentRpc.mock.calls.length >= 1, 'local Agent start admission').toBe(true);
        const resolveAgentStart = agentStart.resolve;
        if (!resolveAgentStart) throw new Error('missing local agent start resolver');
        resolveAgentStart({ ok: true, runId: 'local-agent-run', created: true });
        await start;
        await voiceAgentSessions.ensureRunning(VOICE_AGENT_GLOBAL_SESSION_ID);
        expect(voiceAgentSessions.isActive(VOICE_AGENT_GLOBAL_SESSION_ID), 'actual local Agent admission').toBe(true);
        const localAdapter = getVoiceAdapterRegistry().get('local_conversation');
        if (!localAdapter?.prepareTextTurn) throw new Error('local conversation adapter unavailable');
        const settingsBeforeRetirement = storage.getState().settings;

        // Retirement is synchronous at the Account owner. It revokes the exact
        // admitted Current UI port independently from later resource teardown.
        retireActiveServerAccountScopeLifetime();
        expect(admittedAccountLifetime?.isCurrent()).toBe(false);
        const wireTurnsBeforeLateEvents = startTurnRpc.mock.calls.length;
        await currentUi.switchAccount('account-b', uiForAccount('account-b'));
        storage.__setState({ settings: settingsBeforeRetirement });
        const accountBSnapshot = currentUi.port.readCurrentUiContext();
        expect(accountBSnapshot?.entity?.label).toBe('account-b_CONTEXT');
        const accountBCommand = accountBSnapshot?.commands.find(command => command.title === 'account-b command');
        if (!accountBCommand) throw new Error('Mounted Account B command unavailable');
        expect(startTurnRpc).toHaveBeenCalledTimes(wireTurnsBeforeLateEvents);
        expect(invocations).toEqual([]);
        readTurnRpc.mockResolvedValueOnce(createTurnReadReply({
            assistantText: 'This must not reach Account B.',
            actions: [
                { t: 'readCurrentUiContext', args: {} },
                attachVoiceAgentActionEffectId({
                    t: 'invokeCurrentUiCommand',
                    args: { commandId: accountBCommand.id },
                }, 'retired-local-agent-tool'),
            ],
        }));
        const onAccepted = vi.fn(async () => {});
        await expect(localAdapter.prepareTextTurn({ controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID, conversationSessionId: 'voice-home-session', text: 'Run the retained tool.' })({ localId: 'retired-local-agent-turn', deliveryCommand: 'interrupt_and_send', onAccepted })).resolves.toBeUndefined();
        // Account retirement already aborted this run. The existing turn
        // boundary settles cancellation; acceptance and disclosure stay fenced.
        expect(onAccepted).not.toHaveBeenCalled();
        expect(startTurnRpc).toHaveBeenCalledTimes(wireTurnsBeforeLateEvents);

        await act(async () => {
            await Promise.resolve();
        });
        await localVoiceEngine.stopLocalVoiceSession();
        retireActiveServerAccountScopeLifetime();

        expect(invocations).toEqual([]);
        expect(startTurnRpc.mock.calls.slice(wireTurnsBeforeLateEvents)
            .map(([request]) => JSON.stringify(request.payload)).join('\n')).not.toContain('account-b_CONTEXT');
        await currentUi.unmount();
        expect(currentUi.port.readCurrentUiContext()).toBeNull();
    });


});
