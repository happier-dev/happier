import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntime, AgentSessionRuntimeContext, AgentSessionRuntimeEvent, AgentSessionRealtimeConversation } from '@happier-dev/plugin-sdk/agents/runtime';
import { configuration } from '@/configuration';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority,
    removeAgentRuntimeDaemonServiceAuthorityIfOwned } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { AgentRuntimeDaemonServiceRequestV1Schema } from '../process/agentRuntimeDaemonServiceProtocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandler } from '@/api/rpc/types';
import { admitNativeRealtimeInput } from './admitNativeRealtimeInput';
import { registerAgentSessionRealtimeVoiceRpc } from './registerAgentSessionRealtimeVoiceRpc';

const processIdentity = vi.hoisted(() => vi.fn());
// OS process observation is the boundary; retain real authority-file custody and IPC codecs.
vi.mock('@/daemon/processIdentity', async importOriginal => ({
    ...await importOriginal<typeof import('@/daemon/processIdentity')>(),
    readProcessIdentityByPid: processIdentity,
}));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('native Realtime Start input admission', () => {
    it.each(['end', 'runtime_retirement', 'replacement_during_admission'] as const)('withdraws the same real host fact at %s without a Pending input', async ending => {
        const sessionId = 'native-session';
        const command = 'node /runtime/.runner-snapshots/native-input/dist/index.mjs';
        const runner = { pid: process.pid, processStartTimeMs: 23_346,
            processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:native-input' };
        processIdentity.mockResolvedValue({ pid: runner.pid, processStartTimeMs: runner.processStartTimeMs, command });
        const path = await createAgentRuntimeDaemonServiceAuthorityPath(configuration);
        const authority = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
            path, sessionId, runner, retainedAgent: createAgentSessionRunnerFactoryBinding({
                v: 1, pluginId: 'acme.native', pluginVersion: '1.2.3', agentId: 'native', localAgentId: 'native',
                sourceCustody: { kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
                locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
                normalizedModulePath: '/immutable/native/runtime.mjs', loadMode: 'immutable-js',
            }) };
        vi.stubEnv('HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE', path);
        let admission = { admissionId: 'start-input', occurrenceId: 'native-occurrence', attemptId: 'attempt-1' };
        const requests: string[] = [];
        let releaseRetirement!: () => void;
        const retirementReply = new Promise<void>(resolve => { releaseRetirement = resolve; });
        // Daemon HTTP is the system boundary. Its real admission/currentness is tested in controlServer's composed suite.
        const daemon = createServer(async (incoming, response) => {
            let body = '';
            for await (const chunk of incoming) body += chunk;
            const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(body));
            expect(request.context.sessionId).toBe(sessionId);
            if (request.operation.kind !== 'native_realtime.input.admit' && request.operation.kind !== 'native_realtime.input.retire') {
                throw new Error('Unexpected native admission operation');
            }
            expect(request.operation.admission).toEqual(admission);
            requests.push(request.operation.kind);
            if (request.operation.kind === 'native_realtime.input.admit' && ending === 'replacement_during_admission') {
                await native.resetOrDisposeRuntime();
                currentNative = replacement;
            }
            if (request.operation.kind === 'native_realtime.input.retire' && ending === 'end') await retirementReply;
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ ok: true, result: request.operation.kind === 'native_realtime.input.admit'
                ? { kind: 'native_realtime.input.admission', admission }
                : { kind: 'native_realtime.input.retired' } }));
        });
        await new Promise<void>(resolve => daemon.listen(0, '127.0.0.1', resolve));
        const address = daemon.address();
        if (!address || typeof address === 'string') throw new Error('Expected daemon fixture address');
        const published = await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: address.port, capability: 'A'.repeat(43) });
        let listener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
        const stop = vi.fn(async () => ({ status: 'stopped' as const }));
        const conversation: AgentSessionRealtimeConversation = { inspect: async () => ({ status: 'available', transport: 'webrtc' }),
            start: async () => ending === 'end'
                ? { status: 'started', transport: { kind: 'webrtc', answerSdp: 'answer' },
                    handle: { stop, watch: () => ({ dispose() {} }), dispose() {} } }
                : { status: 'busy' } };
        const provider: AgentSessionRuntime & { realtimeConversation: AgentSessionRealtimeConversation } = {
            realtimeConversation: conversation, send: async () => { throw new Error('Realtime does not enqueue a prompt'); },
            watch: callback => { listener = callback; return { dispose() {} }; }, dispose() {} };
        const facets = { context: { signal: new AbortController().signal } as AgentSessionRuntimeContext, cwd: '/workspace', connectedAccounts: [],
            capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false }, cancellation: { declared: false },
            configuration: { declared: false }, compaction: { capability: null } } satisfies NonNullable<Parameters<typeof createNativeAgentSessionOperations>[7]>;
        const native = createNativeAgentSessionOperations(provider, sessionId, undefined, undefined, undefined, undefined, undefined,
            facets);
        const replacementProvider = { ...provider, realtimeConversation: { ...conversation } };
        const replacement = createNativeAgentSessionOperations(replacementProvider, sessionId,
            undefined, undefined, undefined, undefined, undefined, facets);
        let currentNative = native;
        const unsubscribe = native.subscribeRuntimeEvents(() => undefined);
        const lifetime = new AbortController();
        const handlers = new Map<string, RpcHandler>();
        const providerRef = { pluginId: 'acme.native', localId: 'realtime' };
        const registration = registerAgentSessionRealtimeVoiceRpc({
            rpc: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
            runtime: native, getHappierSessionId: () => sessionId,
            ownerId: 'native-occurrence', agentGeneration: 'native-generation',
            isOccurrenceCurrent: () => true, resolveProviderOccurrenceId: () => 'native-provider-occurrence',
            resolveRetirementSignal: () => null,
            resolveConversation: () => ({ conversation, retirementSignal: null }),
            admitNativeInput: async input => {
                admission = input.admission;
                return await admitNativeRealtimeInput({ ...input, runtime: native, starterDepth: 2 });
            },
        });
        const context = { signal: lifetime.signal, callerAuthority: 'present_user' as const,
            authorization: { kind: 'session.write' as const, sessionId, authority: 'sessionOwner' as const } };
        let stopping: Promise<unknown> | undefined;
        try {
            let admitted: Awaited<ReturnType<typeof admitNativeRealtimeInput>> | undefined;
            if (ending === 'end') {
                await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)!({ v: 1, provider: providerRef,
                    applicationAttemptId: admission.attemptId, transport: { kind: 'webrtc', offerSdp: 'offer' } }, context))
                    .resolves.toMatchObject({ status: 'started' });
            } else {
                const admitting = admitNativeRealtimeInput({ runtime: {
                    admitAgentSessionRealtimeInput: input => currentNative.admitAgentSessionRealtimeInput?.(input) ?? null,
                }, conversation, sessionId, starterDepth: 2, admission, signal: lifetime.signal });
                if (ending === 'replacement_during_admission') {
                    await expect(admitting).rejects.toThrow();
                    expect(replacement.readActiveTurnAdmissionWitness?.()).toBeNull();
                    expect(requests).toEqual(['native_realtime.input.admit', 'native_realtime.input.retire']);
                    return;
                }
                admitted = await admitting;
            }
            listener?.({ kind: 'turn-start', sequence: 1, sessionId, emittedAtMs: 1, turnId: 'provider-native-turn', startedBy: 'provider' });
            const witness = native.readActiveTurnAdmissionWitness?.();
            expect(witness).toMatchObject({ inputId: admission.admissionId, turnId: 'provider-native-turn',
                agentStartCaller: { kind: 'session', sessionId, starterDepth: 2, turnDepth: 0 },
                nativeRealtimeAdmission: admission, userMessageSeq: null, userMessageSeqs: [] });
            expect(native.readTurnStartingInputId?.('provider-native-turn')).toBeNull();
            if (ending === 'end') {
                stopping = Promise.resolve(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP)!({ v: 1,
                    provider: providerRef, applicationAttemptId: admission.attemptId }, context));
                await vi.waitFor(() => expect(requests).toContain('native_realtime.input.retire'));
                expect(witness?.signal?.aborted).toBe(true);
                expect(native.readActiveTurnAdmissionWitness?.()).toBeNull();
                // A held daemon HTTP reply must not postpone native microphone/transport Stop.
                await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
                releaseRetirement();
                await expect(stopping).resolves.toMatchObject({ status: 'stopped' });
            } else await native.resetOrDisposeRuntime();
            expect(witness?.signal?.aborted).toBe(true);
            expect(native.readActiveTurnAdmissionWitness?.()).toBeNull();
            await admitted?.dispose();
            expect(requests).toEqual(['native_realtime.input.admit', 'native_realtime.input.retire']);
        } finally {
            releaseRetirement();
            await stopping?.catch(() => undefined);
            registration.dispose();
            unsubscribe(); await native.resetOrDisposeRuntime();
            await replacement.resetOrDisposeRuntime();
            await removeAgentRuntimeDaemonServiceAuthorityIfOwned({ happyHomeDir: authority.happyHomeDir,
                publicReleaseRing: authority.publicReleaseRing, path, capabilityDigest: published.capabilityDigest });
            await new Promise<void>((resolve, reject) => daemon.close(error => error ? reject(error) : resolve()));
        }
    });
});
