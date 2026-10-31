import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { createSessionFixture } from '@/dev/testkit';
import { createStandaloneVoicePolicyHarness, prepareStandaloneVoicePolicyHarness } from '@/dev/testkit/harness/standaloneVoicePolicyHarness';
import { createRetainedVoiceAgentRpcBoundary } from '@/dev/testkit/harness/voiceAgentRpcBoundary';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { RPC_ERROR_CODES, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

// Warm the real owner graph during collection, before behavior deadlines.
await prepareStandaloneVoicePolicyHarness();
await import('@/voice/adapters/localConversation/localConversationAdapter');

describe('real Local Voice Agent activation', () => {
    it.each(['stopped', 'terminal'] as const)('keeps the primary Run %s when optional cleanup inventory is unavailable', async primary => {
        const daemon = await createRetainedVoiceAgentRpcBoundary();
        let inventoryUnavailable = false;
        const fixture = await createStandaloneVoicePolicyHarness({ mode: 'off', dispatch: async (method, input) => {
            if (inventoryUnavailable && method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST) {
                return { ok: false, errorCode: 'target_unavailable', error: 'Target unavailable' };
            }
            if (inventoryUnavailable && primary === 'terminal' && method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP) {
                return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Run already ended' };
            }
            return daemon.dispatch(method, input);
        } });
        const { createVoiceExecutionTransport } = await import('./VoiceExecutionTransport');
        const { readVoiceAgentRunMetadataFromSession } = await import('@/voice/persistence/voiceAgentRunMetadata');
        const transport = createVoiceExecutionTransport();
        const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await transport.ensureRunning(fixture.sessionId);
            const run = daemon.readRetainedRun();
            if (!run) throw new Error('Expected admitted Run');
            if (primary === 'terminal') run.status = 'failed';
            inventoryUnavailable = true;
            await expect(transport.stop(fixture.sessionId, undefined, new AbortController().signal)).resolves.toBeUndefined();
            expect(readVoiceAgentRunMetadataFromSession({ sessionId: fixture.sessionId,
                serverId: fixture.handle.accountLifetime.scope.serverId })).toBeNull();
            expect(warnings).toHaveBeenCalledWith(expect.stringContaining('[voiceRunRecovery]'),
                expect.objectContaining({ errorCode: 'target_unavailable' }));
            expect(transport.isActive(fixture.sessionId)).toBe(false);
        } finally { inventoryUnavailable = false; warnings.mockRestore(); await fixture.dispose(); }
    });

    it('does not load hidden carrier history before starting targetless Voice', async () => {
        const daemon = await createRetainedVoiceAgentRpcBoundary();
        const fixture = await createStandaloneVoicePolicyHarness({
            mode: 'off',
            existingSession: createSessionFixture({ id: 'hidden-voice', active: true, metadata: {
                path: '/voice', host: 'voice.test', flavor: 'claude',
                ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }),
                agentRuntimeCapabilitiesV1: { localControl: { supported: true } },
            } }),
            dispatch: daemon.dispatch,
        });
        let activation: Awaited<ReturnType<typeof fixture.activateLocalAgent>> | undefined;
        try {
            fixture.messageRequests.length = 0;
            activation = await fixture.activateLocalAgent();
            expect(activation.controller.isAgentActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(true);
            expect(activation.binding.targetSessionAddress).toBeNull();
            expect(daemon.readRetainedRun()?.status).toBe('running');
            // Targetless context has no transcript consumer; retained history
            // is replayed by the daemon rather than hydrated on this client.
            expect(fixture.messageRequests.filter(path => path.includes('/hidden-voice/'))).toHaveLength(0);
        } finally {
            await activation?.dispose();
            await fixture.dispose();
        }
    });

    it.each([
        { source: 'handle', errorCode: 'execution_run_not_allowed' },
        { source: 'metadata', errorCode: 'execution_run_not_allowed' },
        { source: 'running', errorCode: 'execution_run_not_allowed' },
        { source: 'unobservable', errorCode: 'execution_run_not_allowed' },
        { source: 'metadata', errorCode: 'target_unavailable' },
        { source: 'unobservable', errorCode: 'target_unavailable' },
    ] as const)('reconciles a refused Stop only against authoritative terminal state ($source, $errorCode)', async ({ source, errorCode }) => {
        const daemon = await createRetainedVoiceAgentRpcBoundary();
        let refuseStop = false;
        const fixture = await createStandaloneVoicePolicyHarness({ mode: 'off', dispatch: async (method, input) => {
            // Genuine daemon boundary: Stop rejects a non-running Run. The
            // same code alone cannot prove terminal state to the client.
            if (refuseStop && method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP) {
                return { ok: false, errorCode, error: 'Stop unavailable' };
            }
            if (refuseStop && source === 'unobservable' && method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) {
                return { ok: false, errorCode: 'execution_run_read_unavailable', error: 'Unavailable' };
            }
            return daemon.dispatch(method, input);
        } });
        const { createVoiceExecutionTransport } = await import('./VoiceExecutionTransport');
        const { readVoiceAgentRunMetadataFromSession } = await import('@/voice/persistence/voiceAgentRunMetadata');
        const transport = createVoiceExecutionTransport();
        const caller = new AbortController();
        try {
            if (source !== 'metadata') await transport.ensureRunning(fixture.sessionId);
            const run = daemon.readRetainedRun();
            if (!run) throw new Error('Expected admitted daemon Run');
            // This mutable wire fixture is the external daemon's record, not
            // UI state or a mocked internal lifecycle decision.
            if (source !== 'running') run.status = 'failed';
            refuseStop = true;
            const stopping = transport.stop(fixture.sessionId, undefined, caller.signal);
            if (source === 'running' || source === 'unobservable') {
                await expect(stopping).rejects.toMatchObject({ rpcErrorCode: errorCode,
                    ...(errorCode === 'target_unavailable' ? { name: 'VoiceRunStopUnconfirmedError' } : {}) });
                expect(readVoiceAgentRunMetadataFromSession({ sessionId: fixture.sessionId,
                    serverId: fixture.handle.accountLifetime.scope.serverId })?.runId).toBe(run.runId);
            } else {
                await expect(stopping).resolves.toBeUndefined();
                expect(transport.isActive(fixture.sessionId)).toBe(false);
                expect(daemon.readRetainedRun()?.status).toBe('failed');
                expect(readVoiceAgentRunMetadataFromSession({ sessionId: fixture.sessionId,
                    serverId: fixture.handle.accountLifetime.scope.serverId })).toBeNull();
            }
        } finally {
            refuseStop = false;
            await fixture.dispose();
        }
    });

    it.each(['cancel', 'disconnect', 'cleanup_disconnect'] as const)('keeps failed Stop ordered before retry after %s', async (outcome) => {
        const daemon = await createRetainedVoiceAgentRpcBoundary();
        let stall = false;
        let entered!: () => void;
        let loseTransport!: (reason: Error) => void;
        const entering = new Promise<void>(resolve => { entered = resolve; });
        const fixture = await createStandaloneVoicePolicyHarness({ mode: 'off', dispatch: async (method, input) => {
            if (stall && method === (outcome === 'cleanup_disconnect'
                ? SESSION_RPC_METHODS.EXECUTION_RUN_LIST : SESSION_RPC_METHODS.EXECUTION_RUN_STOP)) {
                entered();
                // Socket.IO's ACK owner rejects with this error on disconnect.
                return await new Promise((_resolve, reject) => { loseTransport = reject; });
            }
            return daemon.dispatch(method, input);
        } });
        const { createVoiceExecutionTransport } = await import('./VoiceExecutionTransport');
        const { readRpcErrorCode } = await import('@/sync/runtime/rpcErrors');
        const transport = createVoiceExecutionTransport();
        const caller = new AbortController();
        try {
            await transport.ensureRunning(fixture.sessionId);
            stall = true;
            const stopping = transport.stop(fixture.sessionId, undefined, caller.signal).catch(error => error);
            await entering;
            if (outcome === 'cancel') caller.abort();
            else loseTransport(new Error('socket has been disconnected'));
            const failure: unknown = await stopping;
            if (outcome === 'cleanup_disconnect') expect(failure).toBeUndefined();
            else expect(failure).not.toBeNull();
            // An interrupted cleanup read is transport-unavailable; mutation
            // acknowledgments retain their outcome-unknown public code.
            if (outcome !== 'cleanup_disconnect') expect(readRpcErrorCode(failure)).toBe(outcome === 'cancel' ? 'SOCKET_RPC_ABORTED'
                : RPC_ERROR_CODES.OUTCOME_UNKNOWN);
            if (outcome === 'cancel') {
                expect(fixture.rpcSockets.some(socket => vi.mocked(socket.emit).mock.calls.some(([event]) => event === SOCKET_RPC_EVENTS.CANCEL))).toBe(true);
            }
            if (outcome === 'cleanup_disconnect') expect(daemon.readRetainedRun()).toBeNull();
            else expect(daemon.readRetainedRun()?.status).toBe('running');
            stall = false;
            for (const socket of fixture.rpcSockets) socket.connect();
            const previousEnsure = daemon.requests.filter(request => request.method.includes('ensure')).length;
            await transport.ensureRunning(fixture.sessionId);
            const retry = daemon.requests.slice().reverse();
            const ensureIndex = retry.findIndex(request => request.method.includes('ensure'));
            const stopIndex = retry.findIndex(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP);
            expect(ensureIndex).toBeLessThan(stopIndex);
            expect(daemon.requests.filter(request => request.method.includes('ensure')).length).toBe(previousEnsure + 1);
            expect(transport.isActive(fixture.sessionId)).toBe(true);
        } finally {
            stall = false;
            await fixture.dispose();
        }
    });

    it('stops an unanswered activation and permits a new activation on the same session', async () => {
        const daemon = await createRetainedVoiceAgentRpcBoundary();
        let stall = false;
        let entered!: () => void;
        const entering = new Promise<void>(resolve => { entered = resolve; });
        const fixture = await createStandaloneVoicePolicyHarness({ mode: 'off', dispatch: async (method, input) => {
            if (stall && (method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START
                || method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1)) {
                entered();
                return await new Promise(() => {});
            }
            return daemon.dispatch(method, input);
        } });
        const { createVoiceExecutionTransport } = await import('./VoiceExecutionTransport');
        const transport = createVoiceExecutionTransport();
        try {
            stall = true;
            const pending = transport.ensureRunning(fixture.sessionId).then(() => 'resolved', () => 'cancelled');
            await entering;
            const stopping = transport.stop(fixture.sessionId);
            expect(await pending).toBe('cancelled');
            await stopping;
            expect(transport.isActive(fixture.sessionId)).toBe(false);
            stall = false;
            await transport.ensureRunning(fixture.sessionId);
            expect(transport.isActive(fixture.sessionId)).toBe(true);
        } finally {
            stall = false;
            await fixture.dispose();
        }
    });
    it('releases the old device handle on continuation without stopping the run reused by the new device', async () => {
        const daemon = await createRetainedVoiceAgentRpcBoundary();
        const fixture = await createStandaloneVoicePolicyHarness({
            mode: 'off', dispatch: daemon.dispatch,
        });
        const { createVoiceExecutionTransport } = await import('./VoiceExecutionTransport');
        const oldDevice = createVoiceExecutionTransport();
        const newDevice = createVoiceExecutionTransport();
        try {
            await oldDevice.ensureRunning(fixture.sessionId);
            const run = daemon.readRetainedRun();
            expect(run?.status).toBe('running');
            await newDevice.ensureRunning(fixture.sessionId);
            expect(daemon.readRetainedRun()?.runId).toBe(run?.runId);
            await oldDevice.stop(fixture.sessionId, 'continued_elsewhere');
            expect(oldDevice.isActive(fixture.sessionId)).toBe(false);
            expect(newDevice.isActive(fixture.sessionId)).toBe(true);
            expect(daemon.readRetainedRun()).toEqual(run);
            const { readVoiceAgentRunMetadataFromSession } = await import('@/voice/persistence/voiceAgentRunMetadata');
            expect(readVoiceAgentRunMetadataFromSession({ sessionId: fixture.sessionId,
                serverId: fixture.handle.accountLifetime.scope.serverId })?.runId).toBe(run?.runId);
        } finally {
            await newDevice.stop(fixture.sessionId);
            await fixture.dispose();
        }
    });

    it('makes the hidden bound conversation active through the initializer and daemon transport, then retires its context sink', async () => {
        const daemon = await createRetainedVoiceAgentRpcBoundary();
        const fixture = await createStandaloneVoicePolicyHarness({
            mode: 'off', initializeSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            existingSession: createSessionFixture({ id: 'hidden-voice', active: true, metadata: {
                path: '/voice', host: 'voice.test', flavor: 'claude',
                ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }),
                agentRuntimeCapabilitiesV1: { localControl: { supported: true } },
            } }),
            dispatch: daemon.dispatch,
        });
        let activation: Awaited<ReturnType<typeof fixture.activateLocalAgent>> | undefined;
        try {
            activation = await fixture.activateLocalAgent();
            expect(activation.controller.isAgentActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(true);
            const { resolveActiveLocalVoiceAgentBinding } = await import('@/voice/context/resolveActiveLocalVoiceAgentBinding');
            expect(resolveActiveLocalVoiceAgentBinding()).toMatchObject({
                operationalSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                announcementSessionId: 'hidden-voice',
                binding: { conversationSessionId: 'hidden-voice', transcriptMode: 'native_session' },
            });
            expect(activation.adapter.resolveContextChannel?.((await import('@/sync/domains/state/storage')).storage.getState().settings.voice))
                .toMatchObject({ hostAuthoredContext: 'session_context' });
            expect(daemon.requests.some(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START
                || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1)).toBe(true);
            await activation.dispose();
            activation = undefined;
            expect(resolveActiveLocalVoiceAgentBinding()).toBeNull();
            expect(daemon.readRetainedRun()).toBeNull();
        } finally {
            await activation?.dispose();
            await fixture.dispose();
        }
    });
});
