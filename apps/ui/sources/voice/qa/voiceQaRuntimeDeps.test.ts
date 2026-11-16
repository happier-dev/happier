import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    ExecutionRunTurnStreamStartRequestSchema,
    ExecutionRunTurnStreamStartV2RequestSchema,
    ExecutionRunTurnStreamReadResponseSchema,
} from '@happier-dev/protocol/execution/runs/streaming';
import { createDeferred, createSessionFixture, createSessionMessagesFixture } from '@/dev/testkit';
import { readMountedSessionRealtimeTranscriptConsumerSessionIds } from '@/sync/runtime/sessionRealtimeTranscriptConsumers';
import {
    createStandaloneVoicePolicyHarness,
    prepareStandaloneVoicePolicyHarness,
} from '@/dev/testkit/harness/standaloneVoicePolicyHarness';
import { createRetainedVoiceAgentRpcBoundary } from '@/dev/testkit/harness/voiceAgentRpcBoundary';
import { withGeneratedElevenLabsVoiceRuntime } from '@/dev/testkit/harness/elevenLabsVoiceRuntime';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

const sdk = vi.hoisted(() => ({
    startSession: vi.fn(),
    endSession: vi.fn(async () => {}),
    sendUserMessage: vi.fn(),
    sendContextualUpdate: vi.fn(),
}));
vi.mock('@elevenlabs/client', () => ({ Conversation: { startSession: sdk.startSession } }));
vi.mock('expo-audio', () => ({ AudioModule: { setAudioModeAsync: vi.fn(async () => {}) } }));
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

await prepareStandaloneVoicePolicyHarness();
const { storage } = await import('@/sync/domains/state/storage');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { createDefaultVoiceQaControllerDeps } = await import('./voiceQaRuntimeDeps');
const { createVoiceQaController } = await import('./voiceQaController');
const { useVoiceQaStore } = await import('./voiceQaStore');
const { getVoiceAdapterRegistry, registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
const previousStorage = storage.getState();
const previousBindings = voiceSessionBindingStore.getState();
const previousAdapters = getVoiceAdapterRegistry().list();

describe('createDefaultVoiceQaControllerDeps', () => {
    beforeEach(() => {
        sdk.startSession.mockReset();
        sdk.endSession.mockClear();
        sdk.sendUserMessage.mockClear();
        sdk.sendContextualUpdate.mockClear();
    });
    afterEach(() => {
        vi.useRealTimers();
        registerVoiceAdapters(previousAdapters);
        voiceSessionBindingStore.setState(previousBindings, true);
        storage.setState(previousStorage, true);
        vi.restoreAllMocks();
    });

    it('retires an interrupted-reply observation when its QA deadline ends', async () => {
        vi.useFakeTimers();
        storage.setState({ sessions: { 'qa-waiter': createSessionFixture({ id: 'qa-waiter', serverId: 'qa-waiter-home' }) }, sessionMessages: {} });
        let observed: string | null | undefined;
        const waiting = createDefaultVoiceQaControllerDeps().waitForInterruptedLocalAssistantTurn({
            conversationSessionId: 'qa-waiter', timeoutMs: 1_000,
        }).then(value => { observed = value; });
        try {
            expect(readMountedSessionRealtimeTranscriptConsumerSessionIds('qa-waiter-home')).toContain('qa-waiter');
            await vi.advanceTimersByTimeAsync(1_001);
            expect(observed).toBe(null);
            expect(readMountedSessionRealtimeTranscriptConsumerSessionIds('qa-waiter-home')).not.toContain('qa-waiter');
        } finally {
            // Unstick the old adapter on RED without leaving transcript demand.
            storage.setState({ sessionMessages: { 'qa-waiter': createSessionMessagesFixture({
                messageIdsOldestFirst: ['cleanup'], messagesById: { cleanup: {
                    id: 'cleanup', kind: 'agent-text', text: 'cleanup', createdAt: 1, localId: null,
                } },
            }) } });
            await waiting;
        }
    });

    it('refuses an unmounted Home before starting the generated realtime provider', async () => {
        await expect(createDefaultVoiceQaControllerDeps().startRealtime({
            serverId: 'other-home', sessionId: 'target-session',
        })).rejects.toThrow('voice_qa_target_home_not_mounted');
        expect(sdk.startSession).not.toHaveBeenCalled();
    });

    it('preserves explicit transcript custody through real Voice activation and the scoped daemon client', async () => {
        const daemon = await createRetainedVoiceAgentRpcBoundary({
            handleOtherRpc: async (method, input) => {
                if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START || method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2) {
                    (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2
                        ? ExecutionRunTurnStreamStartV2RequestSchema : ExecutionRunTurnStreamStartRequestSchema).parse(input);
                    return { streamId: 'qa-stream' };
                }
                if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) {
                    return ExecutionRunTurnStreamReadResponseSchema.parse({
                        streamId: 'qa-stream', events: [{ t: 'done', assistantText: 'ok', actions: [] }],
                        nextCursor: 1, done: true,
                    });
                }
                throw new Error('Unexpected QA daemon operation: ' + method);
            },
        });
        const fixture = await createStandaloneVoicePolicyHarness({
            mode: 'off',
            existingSession: createSessionFixture({ id: 'voice-hidden-s1', active: true, metadata: {
                path: '/voice', host: 'voice.test', flavor: 'claude',
                ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }),
                agentRuntimeCapabilitiesV1: { localControl: { supported: true } },
            } }),
            dispatch: daemon.dispatch,
        });
        let activation: Awaited<ReturnType<typeof fixture.activateLocalAgent>> | undefined;
        try {
            activation = await fixture.activateLocalAgent();
            const deps = createDefaultVoiceQaControllerDeps();
            await expect(deps.sendLocalTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'Outer prompt', {
                userTranscript: { mode: 'persist', localId: ' durable-outer-id ' },
            })).resolves.toMatchObject({ assistantText: 'ok' });
            await expect(deps.sendLocalTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'tool follow-up', {
                userTranscript: { mode: 'suppress' },
            })).resolves.toMatchObject({ assistantText: 'ok' });
            const streams = daemon.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2)
                .map(request => ExecutionRunTurnStreamStartV2RequestSchema.parse(request.input));
            expect(streams).toHaveLength(2);
            expect(streams[0]).toMatchObject({ userTranscript: { mode: 'persist', localId: ' durable-outer-id ' } });
            expect(streams[1]).toMatchObject({ userTranscript: { mode: 'suppress' } });
        } finally {
            await activation?.dispose();
            await fixture.dispose();
        }
    });

    const withGeneratedRealtimeQa = async (exercise: (scope: Readonly<{
        controller: ReturnType<typeof createVoiceQaController>;
        deps: ReturnType<typeof createDefaultVoiceQaControllerDeps>;
        home: Awaited<ReturnType<typeof import('@/dev/testkit/harness/actionHomesHttpHarness').serveAccountHomes>>;
        providerId: string;
    }>) => Promise<void>) => {
        // Preserve the original vendor web slice at its genuine SDK boundary.
        const webSdkModuleId = '@elevenlabs/client/web';
        vi.doMock(webSdkModuleId, () => ({ Conversation: { startSession: sdk.startSession } }));
        sdk.startSession.mockResolvedValue({
            endSession: sdk.endSession, setMicMuted() {}, setVolume() {},
            sendUserMessage: sdk.sendUserMessage, sendContextualUpdate: sdk.sendContextualUpdate,
            getId: () => 'qa-elevenlabs',
        });
        await withGeneratedElevenLabsVoiceRuntime(async ({ home, providerId }) => {
            const credentials = await TokenStorage.getCredentialsForServerUrl(home.homes.qa!.serverUrl);
            expect(await TokenStorage.getCredentials()).toEqual(credentials);
            await exercise({
                controller: createVoiceQaController(), deps: createDefaultVoiceQaControllerDeps(), home, providerId,
            });
        });
    };

    it('sends a generated provider text turn only after real pending custody and settles its exact row', async () => {
        await withGeneratedRealtimeQa(async ({ controller, deps, home, providerId }) => {
        await controller.start({ initialContext: 'context' });
        expect(sdk.startSession).toHaveBeenLastCalledWith(expect.objectContaining({ textOnly: true }));
        expect(deps.isRealtimeStarted()).toBe(true);
        expect(useVoiceQaStore.getState()).toMatchObject({ status: 'running', runtimeSessionId: 'qa-history' });
        await controller.sendPrompt({ prompt: 'hello' });
        expect(sdk.sendUserMessage).toHaveBeenCalledWith('hello');
        expect(useVoiceQaStore.getState().entries.some(entry => entry.kind === 'user' && entry.text === 'hello')).toBe(true);
        const pending = home.requests.filter(request => request.method === 'POST' && /\/pending$/.test(request.path));
        expect(pending).toHaveLength(1);
        expect(pending[0]?.path).toBe('/v2/sessions/qa-history/pending');
        expect(pending[0]?.body).toMatchObject({
            deliveryMode: 'external_handoff', requestedAction: { v: 1, kind: 'send_now' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
        });
        const handled = home.requests.filter(request => request.method === 'POST' && /\/delivery\/handled$/.test(request.path));
        expect(handled).toHaveLength(1);
        const body = pending[0]!.body;
        if (!body || typeof body !== 'object' || !('localId' in body) || typeof body.localId !== 'string') throw new Error('Missing durable local id');
        expect(handled[0]?.path).toContain(encodeURIComponent(body.localId));
        await deps.stopMedia!(VOICE_AGENT_GLOBAL_SESSION_ID, providerId);
        expect(deps.isRealtimeStarted()).toBe(false);
        expect(deps.getMediaSnapshot!().status).toBe('disconnected');
        await controller.stop();
        expect(useVoiceQaStore.getState().status).toBe('idle');
        });
    });

    it('rejects a missing generated provider SDK identity and releases its SDK conversation', async () => {
        await withGeneratedRealtimeQa(async ({ controller }) => {
        sdk.startSession.mockResolvedValueOnce({
            endSession: sdk.endSession, setMicMuted() {}, setVolume() {},
            sendUserMessage: sdk.sendUserMessage, sendContextualUpdate: sdk.sendContextualUpdate,
            getId: () => '',
        });
        await expect(controller.start({ initialContext: 'context' }))
            .rejects.toThrow('voice_connection_failed');
        expect(useVoiceQaStore.getState().status).toBe('error');
        expect(sdk.endSession).toHaveBeenCalled();
        expect(sdk.startSession).toHaveBeenCalled();
        });
    });

    it('marks QA failed when actual adapter Stop aborts its pending generated provider connection', async () => {
        await withGeneratedRealtimeQa(async ({ controller, deps }) => {
            const lateConversation = {
                endSession: sdk.endSession, setMicMuted() {}, setVolume() {},
                sendUserMessage: sdk.sendUserMessage, sendContextualUpdate: sdk.sendContextualUpdate,
                getId: () => 'qa-aborted-elevenlabs',
            };
            const negotiation = createDeferred<typeof lateConversation>();
            const sdkStarted = createDeferred<void>();
            sdk.startSession.mockImplementationOnce(() => {
                sdkStarted.resolve();
                return negotiation.promise;
            });
            const starting = controller.start({ initialContext: 'context' })
                .then(() => ({ error: null }), error => ({ error }));
            await Promise.race([sdkStarted.promise, starting]);
            expect(sdk.startSession).toHaveBeenCalled();
            const stopping = deps.stopRealtime();
            negotiation.resolve(lateConversation);
            await stopping;
            expect((await starting).error).toMatchObject({ message: 'realtime_voice_session_not_started' });
            expect(useVoiceQaStore.getState().status).toBe('error');
        });
    });

    it('rejects QA Start when actual public Stop cancels a pending generated provider connection', async () => {
        await withGeneratedRealtimeQa(async ({ controller }) => {
        const lateConversation = {
            endSession: sdk.endSession, setMicMuted() {}, setVolume() {},
            sendUserMessage: sdk.sendUserMessage, sendContextualUpdate: sdk.sendContextualUpdate,
            getId: () => 'qa-late-elevenlabs',
        };
        const negotiation = createDeferred<typeof lateConversation>();
        const sdkStarted = createDeferred<void>();
        const startsBeforeCancellation = sdk.startSession.mock.calls.length;
        sdk.startSession.mockImplementationOnce(() => {
            sdkStarted.resolve();
            return negotiation.promise;
        });
        const cancelledStart = controller.start({ initialContext: 'context' })
            .then(() => ({ error: null }), error => ({ error }));
        await Promise.race([sdkStarted.promise, cancelledStart]);
        expect(sdk.startSession.mock.calls.length).toBeGreaterThan(startsBeforeCancellation);
        const stopping = controller.stop();
        negotiation.resolve(lateConversation);
        await stopping;
        expect((await cancelledStart).error).toMatchObject({ message: 'realtime_voice_session_not_started' });
        expect(useVoiceQaStore.getState().status).toBe('idle');

        });
    });

});
