import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { createSessionFixture, createSessionMessagesFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import type { Message } from '@happier-dev/session-core/messages';
import {
    createRetainedVoiceAgentRpcBoundary, createStandaloneVoicePolicyHarness, prepareStandaloneVoicePolicyHarness,
} from '@/dev/testkit/harness/standaloneVoicePolicyHarness';
import {
    ExecutionRunTurnStreamStartRequestSchema, ExecutionRunTurnStreamStartV2RequestSchema, ExecutionRunTurnStreamReadRequestSchema,
    ExecutionRunTurnStreamStartResponseSchema, ExecutionRunTurnStreamReadResponseSchema,
    type ExecutionRunTurnStreamEvent,
} from '@happier-dev/protocol/execution/runs/streaming';
import { ExecutionRunEnsureOrStartRequestSchema, ExecutionRunPublicStateSchema } from '@happier-dev/protocol/execution/runs/index';
import { AgentRuntimeFacetsV1Schema } from '@happier-dev/protocol/sessions/metadata/agentRuntimeFacetsV1';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readVoiceAgentActionEffectId } from '@/voice/agent/types';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
const route = vi.hoisted(() => ({ segments: ['(app)', 'settings', 'voice'], pathname: '/settings/voice' }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    segments: () => route.segments, pathname: () => route.pathname, params: {},
}).module);
await prepareStandaloneVoicePolicyHarness();
let disposeStreamingFixture: (() => Promise<void>) | undefined;
afterEach(async () => {
    // Retire the real Run while Account HTTP/currentness is still installed;
    // the global afterEach resets those boundaries before onTestFinished.
    standardCleanup();
    try { await disposeStreamingFixture?.(); }
    finally { disposeStreamingFixture = undefined; }
});

async function createStreamingFixture(options: Readonly<{ streaming?: boolean; target?: boolean; targetWithoutTerminal?: boolean; persistent?: boolean; staleRpc?: boolean; bootstrapReceipt?: boolean }> = {}) {
    const starts: Array<ReturnType<typeof ExecutionRunTurnStreamStartRequestSchema.parse>> = [];
    const reads: Array<ReturnType<typeof ExecutionRunTurnStreamReadRequestSchema.parse>> = [];
    let events: ExecutionRunTurnStreamEvent[] = [{ t: 'done', assistantText: 'assistant reply', actions: [] }];
    let preparedInstructionsFor: ReturnType<typeof ExecutionRunTurnStreamReadResponseSchema.parse>['preparedInstructionsFor'];
    let beforeRead: (() => void) | undefined;
    let nextStartError: Readonly<{ error: string; errorCode: string }> | null = null;
    let transcript: NonNullable<ReturnType<typeof ExecutionRunEnsureOrStartRequestSchema.parse>['start']>['transcript'];
    const rpc = await createRetainedVoiceAgentRpcBoundary({ runId: 'streaming-run',
        onRpc(method, input) {
            if (method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START
                || method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1) {
                const start = ExecutionRunEnsureOrStartRequestSchema.parse(input).start;
                if (start) transcript = start.transcript;
            }
        },
        async handleOtherRpc(method, input) {
            if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START
                || method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2) {
                const request = method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2
                    ? ExecutionRunTurnStreamStartV2RequestSchema.parse(input)
                    : ExecutionRunTurnStreamStartRequestSchema.parse(input);
                starts.push(request);
                if (rpc.readRetainedRun()?.runId !== request.runId) {
                    return { ok: false, error: 'execution_run_not_found', errorCode: 'execution_run_not_found' };
                }
                if (nextStartError) {
                    const error = nextStartError;
                    nextStartError = null;
                    return { ok: false, ...error };
                }
                return ExecutionRunTurnStreamStartResponseSchema.parse({ streamId: 'streaming-turn' });
            }
            if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) {
                reads.push(ExecutionRunTurnStreamReadRequestSchema.parse(input));
                beforeRead?.();
                return ExecutionRunTurnStreamReadResponseSchema.parse({
                    streamId: 'streaming-turn', events, nextCursor: events.length, done: true,
                    ...(preparedInstructionsFor ? { preparedInstructionsFor } : {}),
                });
            }
            if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL) return { ok: true };
            throw new Error(`Unexpected streaming daemon method: ${method}`);
        },
    });
    const target = createSessionFixture({ id: 'streaming-target', active: true, activeAt: Date.now(), metadata: {
        ...createSessionFixture().metadata!, flavor: options.targetWithoutTerminal ? 'codex' : 'claude', summary: { text: 'STREAMING_TARGET_SENTINEL', updatedAt: 1 },
        path: '/private/STREAMING_PATH_SENTINEL', agentRuntimeCapabilitiesV1: { localControl: options.targetWithoutTerminal ? null : { supported: true } },
    } });
    const fixture = await createStandaloneVoicePolicyHarness({
        mode: 'off', sessions: [
            ...(options.target ? [target] : []),
            ...(options.staleRpc ? [createSessionFixture({ id: 'current-resume-publication', metadata: {
                ...createSessionFixture().metadata!,
                agentRuntimeFacetsV1: AgentRuntimeFacetsV1Schema.parse({ v: 1, transcriptSource: { supported: true, followLeaseSupported: true } }),
            } })] : []),
        ],
        existingSession: { metadata: { ...createSessionFixture().metadata!, flavor: 'claude',
            agentRuntimeCapabilitiesV1: { localControl: { supported: true } },
            ...(!options.staleRpc ? { agentRuntimeFacetsV1: AgentRuntimeFacetsV1Schema.parse({ v: 1, transcriptSource: { supported: true, followLeaseSupported: true } }) } : {}),
        } },
        async dispatch(method, input) {
            const result = await rpc.dispatch(method, input);
            if (options.bootstrapReceipt && (method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START
                || method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1)
                && ExecutionRunEnsureOrStartRequestSchema.parse(input).start) {
                const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
                if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Missing bootstrap response');
                return { ...result, preparedInstructionsFor: {
                    serverId: captureActiveServerAccountScopeLifetime()!.scope.serverId, sessionId: target.id } };
            }
            // The external daemon projects the transcript admitted in the actual
            // Ensure request; the initializer's handle is never reconstructed.
            if (method === SESSION_RPC_METHODS.EXECUTION_RUN_GET && result && typeof result === 'object' && 'run' in result) {
                return { ...result, run: ExecutionRunPublicStateSchema.parse({ ...ExecutionRunPublicStateSchema.parse(result.run), transcript }) };
            }
            return result;
        },
    });
    let active: Awaited<ReturnType<typeof fixture.activateLocalAgent>> | null = null;
    disposeStreamingFixture = async () => {
        try {
            await active?.dispose();
            if (active) expect(rpc.readRetainedRun()).toBeNull();
        }
        finally { await fixture.dispose(); }
    };
    const { storage } = await import('@/sync/domains/state/storage');
    const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
    const { readLocalConversationVoiceSettings, writeVoiceProviderSettingsConfig } = await import('@/sync/domains/settings/voiceSettings');
    const local = readLocalConversationVoiceSettings(storage.getState().settings.voice);
    storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: writeVoiceProviderSettingsConfig(storage.getState().settings.voice, 'local_conversation', {
        ...local, streaming: { ...local.streaming, enabled: options.streaming !== false },
        agent: { ...local.agent, resumabilityMode: 'provider_resume',
            transcript: { ...local.agent.transcript, persistenceMode: options.persistent ? 'persistent' : 'ephemeral' } },
    }) }, storage.getState().settings));
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Streaming Account lifetime unavailable');
    // The harness eagerly initializes a Run without a runtime callback. Retire
    // it so this attempt observes a real bootstrap, rather than an Ensure-only
    // adoption that cannot report newly delivered instructions.
    if (options.bootstrapReceipt) await rpc.dispatch(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId: 'streaming-run' });
    active = await fixture.activateLocalAgent(options.target ? { serverId: lifetime.scope.serverId, sessionId: target.id } : null);
    const { voiceAgentSessions: transport } = await import('@/voice/agent/voiceAgentSessions');
    const { VOICE_AGENT_GLOBAL_SESSION_ID: controlSessionId } = await import('@/voice/agent/voiceAgentGlobalSessionId');
    return {
        starts, reads, rpc, transport, controlSessionId, fixture, storage,
        setEvents(value: ExecutionRunTurnStreamEvent[]) { events = value; },
        setPreparedInstructionsFor(value: NonNullable<typeof preparedInstructionsFor>) { preparedInstructionsFor = value; },
        beforeRead(callback: () => void) { beforeRead = callback; },
        rejectNextStart(error: string, errorCode: string) { nextStartError = { error, errorCode }; },
        setPrivacy(currentUiContextMode: 'automatic' | 'on_demand' | 'off') {
            const voice = storage.getState().settings.voice;
            act(() => storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: { ...voice, privacy: { ...voice.privacy, currentUiContextMode } } }, storage.getState().settings)));
        },
    };
}

async function mountAutomaticUiContext() {
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const credentials = await TokenStorage.getCredentialsForServerUrl(getActiveServerSnapshot().serverUrl);
    if (!credentials) throw new Error('Current UI requires the actual restored Account');
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
    const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
    const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
    const { CurrentUiContextProvider, useOptionalCurrentUiContextReader, usePublishCurrentUiContext } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
    const { createCurrentUiContextAutomaticUpdateProjector } = await import('@/voice/context/voiceHooks');
    const current: { reader: ReturnType<typeof useOptionalCurrentUiContextReader> } = { reader: null };
    const enrichment = { entity: { kind: 'streaming_ui', label: 'PRIVATE_UI_ENTITY_SENTINEL' }, commands: [] };
    function Publication() {
        usePublishCurrentUiContext(enrichment);
        current.reader = useOptionalCurrentUiContextReader();
        return null;
    }
    const tree = () => React.createElement(InjectedAuthProvider, { credentials, children:
        React.createElement(MainAppTabStateProvider, { children: React.createElement(AppPaneProvider, { children:
            React.createElement(CurrentUiContextProvider, { children: React.createElement(PluginSurfaceFocusEligibilityProvider,
                { active: true, currentUiContextActive: true, children: React.createElement(Publication) }) }) }) }) });
    route.segments = ['(app)', 'settings', 'voice'];
    route.pathname = '/settings/voice';
    const screen = await renderScreen(tree());
    onTestFinished(screen.unmount);
    const projector = createCurrentUiContextAutomaticUpdateProjector();
    const read = () => {
        const snapshot = current.reader?.readCurrentUiContext();
        if (!snapshot) throw new Error('Mounted Current UI producer unavailable');
        expect(snapshot.entity?.label).toBe('PRIVATE_UI_ENTITY_SENTINEL');
        const update = projector.project(snapshot);
        if (!update) throw new Error('Current UI projection did not change');
        projector.markDelivered(update);
        return update;
    };
    return {
        read,
        async navigate() {
            route.segments = ['(app)', 'settings', 'voice', 'advanced'];
            route.pathname = '/settings/voice/advanced';
            await screen.update(tree());
            return read();
        },
    };
}

describe('Voice streaming through retained initialization, execution transport and daemon RPC', () => {
    it.each([true, false])('does not visit loaded transcript rows before an ordinary turn (streaming=%s)', async streaming => {
        const f = await createStreamingFixture({ streaming });
        let idReads = 0;
        const messages = Array.from({ length: 2_000 }, (_, index): Message => ({
            get id() { idReads += 1; return `historical-${index}`; },
            kind: 'agent-text', text: 'Earlier answer.', seq: index + 1, localId: null, createdAt: index,
        }));
        f.storage.setState({ sessionMessages: { ...f.storage.getState().sessionMessages,
            [f.fixture.sessionId]: createSessionMessagesFixture({
                messageIdsOldestFirst: messages.map(message => message.id),
                messagesById: Object.fromEntries(messages.map(message => [message.id, message])),
            }),
        } });
        idReads = 0;
        await expect(f.transport.sendTurn(f.controlSessionId, 'hello')).resolves.toEqual({
            assistantText: 'assistant reply', actions: [],
        });
        expect(idReads).toBe(0);
        expect(f.starts).toHaveLength(1);
    });
    it.each(['person', 'synthetic'] as const)('exposes only the active host turn origin to shared MCP Actions (%s)', async turnOrigin => {
        const f = await createStreamingFixture();
        const playHostText = async () => ({ status: 'completed' as const });
        let readDuringTurn = false;
        f.beforeRead(() => {
            expect(f.transport.readVoiceAgentHandle(f.controlSessionId)?.toolTurnContext?.current).toEqual({ turnOrigin, playHostText });
            readDuringTurn = true;
        });
        await f.transport.sendTurn(f.controlSessionId, 'hello', { turnOrigin, playHostText });
        expect(readDuringTurn).toBe(true);
        expect(f.transport.readVoiceAgentHandle(f.controlSessionId)?.toolTurnContext?.current).toBeUndefined();
    });
    it('publishes actual bootstrap instruction delivery while the current local attempt connects', async () => {
        const { voiceConversationRuntimeMachine: machine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
        const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
        machine.reset();
        machine.transitionToConnecting({ controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
        onTestFinished(() => machine.reset());
        const f = await createStreamingFixture({ target: true, bootstrapReceipt: true });
        expect(machine.getSnapshot().preparedInstructionsFor).toEqual({
            serverId: f.fixture.handle.accountLifetime.scope.serverId, sessionId: 'streaming-target' });
    });
    it.each([true, false])('projects actual delivered instructions through local tool delivery (streaming=%s)', async streaming => {
        const f = await createStreamingFixture({ streaming, target: true });
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const receipt = { serverId: captureActiveServerAccountScopeLifetime()!.scope.serverId, sessionId: 'streaming-target' };
        f.setPreparedInstructionsFor(receipt);
        const { sendVoiceTextTurn } = await import('@/voice/local/sendVoiceTextTurn');
        const { createVoicePlaybackController } = await import('@/voice/runtime/playback/VoicePlaybackController');
        const { voiceConversationRuntimeMachine: machine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
        machine.reset();
        onTestFinished(() => machine.reset());
        const { deriveLocalVoiceSessionSnapshot } = await import('@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot');
        const { readLocalConversationVoiceSettings, writeVoiceProviderSettingsConfig } = await import('@/sync/domains/settings/voiceSettings');
        const settings = f.storage.getState().settings;
        const local = readLocalConversationVoiceSettings(settings.voice);
        await sendVoiceTextTurn({ sessionId: f.controlSessionId, settings: { ...settings, voice:
            writeVoiceProviderSettingsConfig(settings.voice, 'local_conversation', { ...local, tts: { ...local.tts, autoSpeakReplies: false } }) },
            userText: 'hello', playbackController: createVoicePlaybackController(), voiceAgentSessions: f.transport,
            durableDispatch: { localId: 'receipt-local', deliveryCommand: 'interrupt_and_send' } });
        expect(deriveLocalVoiceSessionSnapshot('local_conversation', 'local', machine.getSnapshot()).preparedInstructionsFor).toEqual(receipt);
        machine.transitionToEnding({ controlSessionId: f.controlSessionId });
        expect(machine.getSnapshot().preparedInstructionsFor).toBeUndefined();
    });
    it.each([
        { streaming: true, anchor: 'none' },
        { streaming: false, anchor: 'none' },
        { streaming: true, anchor: 'missing' },
        { streaming: false, anchor: 'missing' },
        { streaming: true, anchor: 'admitted' },
        { streaming: false, anchor: 'admitted' },
        { streaming: true, anchor: 'answered' },
        { streaming: false, anchor: 'answered' },
    ] as const)('recovers only current anchored text after delayed history hydration (streaming=$streaming, anchor=$anchor)', async ({ streaming, anchor }) => {
        const f = await createStreamingFixture({ streaming });
        f.setEvents([{ t: 'done', assistantText: '', actions: [] }]);
        const oldReply = { id: 'old-reply', kind: 'agent-text', text: 'An earlier answer.', seq: 16, localId: null, createdAt: 1 } satisfies Message;
        const user = { id: 'current-user', kind: 'user-text', text: 'My new question.', seq: 17, localId: 'voice-input', createdAt: 2 } satisfies Message;
        const reply = { id: 'current-reply', kind: 'agent-text', text: 'The current answer.', seq: 18, localId: null, createdAt: 3 } satisfies Message;
        // The external daemon/read boundary releases persisted history only after
        // the wrapper has captured its baseline and admitted the current input.
        f.beforeRead(() => {
            const messages = [oldReply, ...(anchor === 'admitted' || anchor === 'answered' ? [user] : []), ...(anchor === 'answered' ? [reply] : [])];
            f.storage.setState({ sessionMessages: { ...f.storage.getState().sessionMessages,
                [f.fixture.sessionId]: createSessionMessagesFixture({
                    messageIdsOldestFirst: messages.map(message => message.id),
                    messagesById: Object.fromEntries(messages.map(message => [message.id, message])),
                }),
            } });
        });
        await expect(f.transport.sendTurn(f.controlSessionId, user.text, anchor === 'none'
            ? undefined : { userTranscript: { mode: 'persist', localId: user.localId } })).resolves.toEqual({
            assistantText: anchor === 'answered' ? reply.text : '', actions: [],
        });
    });

    it('delivers a carrier Voice Agent turn when its coding target has no terminal-control surface', async () => {
        const f = await createStreamingFixture({ target: true, targetWithoutTerminal: true });
        await expect(f.transport.sendTurn(f.controlSessionId, 'hello')).resolves.toEqual({
            assistantText: 'assistant reply', actions: [],
        });
        expect(f.starts).toEqual([expect.objectContaining({ runId: 'streaming-run' })]);
        expect(f.rpc.readRetainedRun()?.status).toBe('running');
    });

    it('sends ordinary input without recovery intent while the retained RPC Session is stale', async () => {
        const f = await createStreamingFixture({ persistent: true, staleRpc: true });
        const { voiceSessionBindingStore, bindVoiceRuntimeAttemptBinding, createVoiceRuntimeAttemptBindingOwner } = await import('@/voice/binding/voiceConversationBindingStore');
        const original = voiceSessionBindingStore.getState().getByControlSessionId(f.controlSessionId);
        if (!original) throw new Error('Actual retained control binding unavailable');
        bindVoiceRuntimeAttemptBinding({ owner: createVoiceRuntimeAttemptBindingOwner(), binding: {
            ...original, conversationSessionId: 'current-resume-publication',
            conversationSessionAddress: { ...original.conversationSessionAddress, sessionId: 'current-resume-publication' },
            updatedAt: original.updatedAt + 1,
        } });
        onTestFinished(() => voiceSessionBindingStore.getState().unbind('current-resume-publication'));
        // The canonical Home boundary may wrap SDK acknowledgements to retain
        // the socket's principal. Observe that actual outer boundary directly.
        const emissions = [...new Set(f.fixture.rpcSockets)].map(socket => {
            const emission = vi.spyOn(socket, 'emitWithAck');
            onTestFinished(() => emission.mockRestore());
            return emission;
        });
        expect((await f.transport.sendTurn(f.controlSessionId, 'hello')).assistantText).toBe('assistant reply');
        expect(f.starts).toEqual([expect.objectContaining({ runId: 'streaming-run' })]);
        expect(f.starts[0]).not.toHaveProperty('resume');
        const startMethods = emissions.flatMap(emission =>
            emission.mock.calls.flatMap(([event, payload]) => {
                if (event !== 'rpc-call' || !payload || typeof payload !== 'object' || !('method' in payload)
                    || typeof payload.method !== 'string' || !payload.method.endsWith(`:${SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START}`)) return [];
                return [payload.method];
            }));
        expect(startMethods).toEqual([`${f.fixture.sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START}`]);
    });

    it('preserves process-local effect identity while normalizing the streamed turn response', async () => {
        const f = await createStreamingFixture();
        f.setEvents([
            { t: 'voice_output', output: { v: 1, kind: 'side_effect', turnId: 'streaming-turn', seq: 0,
                effectId: 'effect-normalized', action: { t: 'sendSessionMessage', args: { message: 'Do it' } } } },
            { t: 'voice_output', output: { v: 1, kind: 'turn_final', turnId: 'streaming-turn', seq: 1, text: 'Working on it.' } },
        ]);
        const result = await f.transport.sendTurn(f.controlSessionId, 'hello');
        expect(result).toEqual({ assistantText: 'Working on it.', actions: [{ t: 'sendSessionMessage', args: { message: 'Do it' } }] });
        expect(readVoiceAgentActionEffectId(result.actions[0])).toBe('effect-normalized');
    });

    it('uses the canonical client read-loop and distinct client-turn effect identity when eager speech is disabled', async () => {
        const f = await createStreamingFixture({ streaming: false });
        f.setEvents([{ t: 'done', assistantText: 'legacy reply', actions: [{ t: 'sendSessionMessage', args: { message: 'Legacy action' } }] }]);
        const first = await f.transport.sendTurn(f.controlSessionId, 'hello');
        const second = await f.transport.sendTurn(f.controlSessionId, 'again');
        expect(first).toEqual({ assistantText: 'legacy reply', actions: [{ t: 'sendSessionMessage', args: { message: 'Legacy action' } }] });
        expect(readVoiceAgentActionEffectId(first.actions[0])).toBe(`${f.fixture.sessionId}:client:1:0`);
        expect(readVoiceAgentActionEffectId(second.actions[0])).toBe(`${f.fixture.sessionId}:client:2:0`);
        expect(f.reads.map(read => read.cursor)).toEqual([0, 0]);
        expect(f.starts.every(start => start.resume !== true)).toBe(true);
    });

    it('injects only the latest automatic UI projection beside one deferred redacted Session context', async () => {
        const f = await createStreamingFixture({ streaming: false, target: true });
        f.setPrivacy('automatic');
        const ui = await mountAutomaticUiContext();
        const oldUpdate = ui.read();
        f.transport.appendAutomaticUiContextUpdate(f.controlSessionId, oldUpdate);
        const latestUpdate = await ui.navigate();
        expect(latestUpdate).not.toBe(oldUpdate);
        f.transport.appendAutomaticUiContextUpdate(f.controlSessionId, latestUpdate);
        await f.transport.sendTurn(f.controlSessionId, 'hello');
        await f.transport.sendTurn(f.controlSessionId, 'again');
        const payload = f.starts[0]?.message ?? '';
        expect(payload).toContain('STREAMING_TARGET_SENTINEL');
        expect(payload.match(/THIS IS THE CURRENT TARGET SESSION/g)).toHaveLength(1);
        expect(payload).not.toContain('STREAMING_PATH_SENTINEL');
        expect(payload).toContain(latestUpdate);
        expect(payload).not.toContain(oldUpdate);
        expect(payload).not.toContain('PRIVATE_UI_ENTITY_SENTINEL');
        expect(payload.match(/CURRENT UI CONTEXT/g)).toHaveLength(1);
        expect(f.starts[1]?.message).toBe('again');
    });

    it('retains explicit attempt context after rejected start and retires it after acceptance', async () => {
        const f = await createStreamingFixture({ streaming: false });
        f.transport.appendAttemptContextUpdate(f.controlSessionId, 'EXPLICIT_ATTEMPT_CONTEXT_SENTINEL');
        f.rejectNextStart('provider unavailable', 'execution_run_busy');
        await expect(f.transport.sendTurn(f.controlSessionId, 'first')).rejects.toThrow('provider unavailable');
        await f.transport.sendTurn(f.controlSessionId, 'retry');
        await f.transport.sendTurn(f.controlSessionId, 'next');
        expect(f.starts[0]?.message).toContain('EXPLICIT_ATTEMPT_CONTEXT_SENTINEL');
        expect(f.starts[1]?.message).toContain('EXPLICIT_ATTEMPT_CONTEXT_SENTINEL');
        expect(f.starts[2]?.message).toBe('next');
    });

    it.each(['on_demand', 'off'] as const)('redacts queued automatic context when disclosure changes to %s before admission', async currentUiContextMode => {
        const f = await createStreamingFixture({ streaming: false });
        f.setPrivacy('automatic');
        f.transport.appendAttemptContextUpdate(f.controlSessionId, 'ORDINARY_CONTEXT_SENTINEL');
        const ui = await mountAutomaticUiContext();
        const revokedUpdate = ui.read();
        f.transport.appendAutomaticUiContextUpdate(f.controlSessionId, revokedUpdate);
        f.setPrivacy(currentUiContextMode);
        await f.transport.sendTurn(f.controlSessionId, 'hello');
        f.setPrivacy('automatic');
        await f.transport.sendTurn(f.controlSessionId, 'again');
        expect(f.starts[0]?.message).toContain('ORDINARY_CONTEXT_SENTINEL');
        expect(f.starts[0]?.message).not.toContain(revokedUpdate);
        expect(f.starts[1]?.message).toBe('again');
    });

    it('recovers an absent daemon Run without duplicating prepared context or requeueing deferred context', async () => {
        const f = await createStreamingFixture({ streaming: false, target: true });
        f.transport.appendAttemptContextUpdate(f.controlSessionId, 'RECOVERED_ATTEMPT_SENTINEL');
        await f.rpc.dispatch(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId: 'streaming-run' });
        expect(f.rpc.readRetainedRun()).toBeNull();
        const afterRetirement = f.rpc.requests.length;
        await expect(f.transport.sendTurn(f.controlSessionId, 'recover')).resolves.toEqual({ assistantText: 'assistant reply', actions: [] });
        const recoveryRequests = f.rpc.requests.slice(afterRetirement);
        const restartIndex = recoveryRequests.findIndex(request =>
            (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START
                || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1)
            && ExecutionRunEnsureOrStartRequestSchema.parse(request.input).start);
        expect(restartIndex).toBeGreaterThan(recoveryRequests.findIndex(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START));
        expect(restartIndex).toBeLessThan(recoveryRequests.map(request => request.method).lastIndexOf(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START));
        expect(ExecutionRunEnsureOrStartRequestSchema.parse(recoveryRequests[restartIndex]?.input).start?.intent).toBe('voice_agent');
        expect(f.rpc.readRetainedRun()?.runId).toBe('streaming-run');
        await f.transport.sendTurn(f.controlSessionId, 'next');
        expect(f.starts[1]?.message).toBe(f.starts[0]?.message);
        expect(f.starts[1]?.message.match(/RECOVERED_ATTEMPT_SENTINEL/g)).toHaveLength(1);
        expect(f.starts[1]?.message.match(/THIS IS THE CURRENT TARGET SESSION/g)).toHaveLength(1);
        expect(f.starts[2]?.message).toBe('next');
        expect(f.transport.isActive(f.controlSessionId)).toBe(true);
    });
});
