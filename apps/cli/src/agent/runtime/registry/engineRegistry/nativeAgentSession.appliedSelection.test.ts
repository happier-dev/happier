import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionRuntimeEvent, AgentSessionRealtimeConversation } from '@happier-dev/plugin-sdk/agents/runtime';
import { UsageEventIngestRequestSchema, type SessionTeamCredentialBindingIntentV1 } from '@happier-dev/protocol';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { HostSessionRuntimeHookRuntime } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { resolveHostSessionRuntimeFactoryResult } from '@/agent/runtime/session/loop/factoryResult';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { createNativeAgentRuntimeSessionPlanFixture as createNativeAgentRuntimeSessionPlan } from './nativeAgentSession.testkit';
import { createNativeSessionClientTestPort, createExternalContributionFixtures, createLease, createSessionHostServiceOwners } from './nativeAgentSession.testkit';
import { buildUsageEventIngestRequest } from '@/usage/buildUsageEventIngestRequest';
import { createAgentSessionRealtimeVoiceAuthority } from '@/agent/runtime/session/realtime/resolveAgentSessionRealtimeVoiceAuthority';
import { registerAgentSessionRealtimeVoiceRpc } from '@/agent/runtime/session/realtime/registerAgentSessionRealtimeVoiceRpc';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { runScmCommand, runWithScmCommandRunner } from '@/scm/runtime';

async function openSession(binding?: SessionTeamCredentialBindingIntentV1, connectedAccounts: NonNullable<AgentSessionOpenRequest['connectedAccounts']> = [], runtimeAuth?: AgentSessionRuntime['runtimeAuth'], attached = false, realtimeConversation?: AgentSessionRealtimeConversation, exec?: ExecService) {
    const agentId = 'acme-applied-reader';
    const contributions = createExternalContributionFixtures(agentId);
    const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
    const nativeSession: AgentSessionRuntime & { realtimeConversation?: AgentSessionRealtimeConversation } = {
        send: async () => ({ status: 'admitted' }),
        watch: listener => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; }, dispose: async () => undefined,
        ...(runtimeAuth ? { runtimeAuth } : {}),
        ...(realtimeConversation ? { realtimeConversation } : {}),
    };
    const plan = await createNativeAgentRuntimeSessionPlan({
        runtime: { sessions: { open: async () => nativeSession } },
        lease: createLease(agentId), backend: contributions.backend, agent: contributions.agent,
        createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
        ...(exec ? { createInvocationServices: async () => ({ ...createUnavailablePluginServices(), exec }) } : {}),
        // Runner materialization is out-of-process custody, not a replacement of host logic.
        prepareTeamCredentialProviderBinding: async () => ({
            providerBinding: {
                source: { kind: 'team_resource', resourceId: 'opened-resource', resourceRevision: 3 },
                model: { id: 'team-model', name: 'Team model' },
                upstream: { protocol: 'openai-responses', normalizedUrl: 'https://provider.example/v1', credential: 'apiKey' },
                materialization: { v: 1, kind: 'spawnEnv' },
            },
            environmentOverlay: [], additionalRedactionValues: [], cleanup: () => undefined,
        }),
        sessionInput: buildPluginSessionBindingInput({
            credentials: { token: 'test-token', encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) } },
            directory: '/tmp/applied-reader', backendTarget: { kind: 'backend', backendId: agentId },
            resolveLateEnvironment: async () => ({
                environmentVariables: {}, unsetEnvironmentVariables: [], sensitiveEnvironmentVariableNames: [],
                sessionConnectedAccounts: connectedAccounts,
            }),
            ...(binding ? {
                modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey: `backend:${agentId}`, providerConnectionId: null, modelId: 'team-model' } },
                ...(attached ? { existingSessionId: 'applied-reader', sessionAttachSecret: { encryptionMode: 'plain', snapshot: {
                    metadata: {}, metadataVersion: 1, agentState: null, agentStateVersion: 0, acceptedTeamCredentialBinding: binding,
                } } } : { teamCredentialBindings: [binding] }),
            } : {}),
        }),
    });
    if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');
    const published: Array<Parameters<ApiSessionClient['publishUsageObservation']>[0]> = [];
    const session = createNativeSessionClientTestPort('applied-reader', {
        publishUsageObservation: (input: Parameters<ApiSessionClient['publishUsageObservation']>[0]) => { published.push(input); },
    });
    // The host factory's process/transport fixture is intentionally narrower than a full runner.
    const created = await plan.config.createSessionRuntime({
        directory: '/tmp/applied-reader', metadata: {}, machineId: 'machine-1', session,
        transcriptSession: {}, messageBuffer: {}, mcpServers: {}, permissionHandler: { cancelByPluginTurn: async () => undefined },
        getPermissionMode: () => 'default', setThinking: () => undefined, memoryRecallGuidanceEnabled: false,
    } as never);
    const resolved = resolveHostSessionRuntimeFactoryResult(created);
    // Match the host loop's native-runtime-or-operations projection of existing hook controls.
    const hookRuntime = (resolved.nativeRuntime ?? resolved.runtime) as HostSessionRuntimeHookRuntime;
    return { created, hookRuntime, session, agentId, published, emit: (event: AgentSessionRuntimeEvent) => { for (const listener of listeners) listener(event); } };
}

describe('native accepted-open applied selection', () => {
    it('never borrows plugin Exec when host SCM authority is absent, including after recreation', async () => {
        // The separate composed suite proves production runner/daemon SCM wiring.
        // A bare native Session must fail closed rather than borrow plugin authority.
        const resolve = vi.fn<ExecService['systemTools']['resolve']>(async () => {
            throw new PluginError({ code: 'workspace_exec_isolation_unavailable', message: 'Workspace execution is unavailable' });
        });
        const { created, hookRuntime } = await openSession(undefined, [], undefined, false, undefined, {
            ...createUnavailablePluginServices().exec, systemTools: { resolve },
        });
        const command = { bin: 'git', cwd: '/tmp/applied-reader', args: ['rev-parse', '--show-toplevel'] };
        const runCheckpointCommand = () => runWithScmCommandRunner(hookRuntime.runScmCommand, () => runScmCommand(command));
        try {
            await expect(runCheckpointCommand()).resolves.toMatchObject({
                success: false, stdout: '', stderr: 'scm_exec_unavailable', exitCode: -1,
            });
            expect(resolve).not.toHaveBeenCalled();
            await created.operations.resetOrDisposeRuntime('runtime_recovery');
            await expect(runCheckpointCommand()).resolves.toMatchObject({
                success: false, stdout: '', stderr: 'scm_exec_unavailable', exitCode: -1,
            });
            expect(resolve).not.toHaveBeenCalled();
            await created.operations.resetOrDisposeRuntime('runtime_recovery', { kind: 'create' });
            await expect(runCheckpointCommand()).resolves.toMatchObject({
                success: false, stdout: '', stderr: 'scm_exec_unavailable', exitCode: -1,
            });
            expect(resolve).not.toHaveBeenCalled();
        } finally { await created.operations.resetOrDisposeRuntime(); }
    });
    it.each(['end', 'disconnect', 'retirement', 'failed_start'] as const)('withdraws person Start authority at %s before native cleanup can settle', async ending => {
        let releaseStop!: () => void;
        let publishTerminal: ((event: import('@happier-dev/plugin-sdk/agents/runtime').AgentSessionRealtimeLifecycleEvent) => void) | undefined;
        const stopPending = new Promise<void>(resolve => { releaseStop = resolve; });
        const realtimeConversation: AgentSessionRealtimeConversation = {
            inspect: async () => ({ status: 'available', transport: 'webrtc' }),
            start: async () => ending === 'failed_start'
                ? { status: 'failed', diagnostic: { code: 'native_start_failed', severity: 'error' } }
                : ({ status: 'started', transport: { kind: 'webrtc', answerSdp: 'answer' },
                handle: { stop: async () => { await stopPending; return { status: 'stopped' }; },
                    watch: listener => { publishTerminal = listener; return { dispose() {} }; }, dispose() {} } }),
        };
        const { created, hookRuntime, emit, session } = await openSession(undefined, [], undefined, false, realtimeConversation);
        const unsubscribe = created.operations.subscribeRuntimeEvents(() => undefined);
        const provider = { pluginId: 'acme.agent-plugin', localId: 'realtime' };
        const retirement = new AbortController();
        const handlers = new Map<string, import('@/api/rpc/types').RpcHandler>();
        const registration = registerAgentSessionRealtimeVoiceRpc({
            rpc: { registerHandler: (method, handler) => { handlers.set(method, handler); } }, runtime: hookRuntime,
            getHappierSessionId: () => session.sessionId, ownerId: 'session-occurrence', agentGeneration: 'generation',
            isOccurrenceCurrent: () => true, resolveProviderOccurrenceId: () => 'provider-occurrence',
            resolveRetirementSignal: () => retirement.signal,
            resolveConversation: () => ({ conversation: realtimeConversation, retirementSignal: retirement.signal }),
            admitNativeInput: async ({ admission, conversation, signal }) => {
                const admitted = hookRuntime.admitAgentSessionRealtimeInput?.({ admission, conversation, signal,
                    agentStartCaller: { kind: 'session', sessionId: session.sessionId, starterDepth: 0, turnDepth: 0 } });
                if (!admitted) throw new Error('Native admission unavailable');
                return { dispose: async () => { admitted.dispose(); } };
            },
        });
        const request = { v: 1, provider, applicationAttemptId: 'live-attempt', transport: { kind: 'webrtc', offerSdp: 'offer' } };
        const context = { signal: new AbortController().signal, callerAuthority: 'present_user' as const,
            authorization: { kind: 'session.write' as const, sessionId: session.sessionId, authority: 'sessionOwner' as const } };
        try {
            // A locally supplied turn/attempt name is not authenticated person input.
            await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)!(request,
                { signal: context.signal, callerAuthority: 'account_automation' })).resolves.toMatchObject({ ok: false });
            // A shared writer/legacy relay has Session write proof, not owner-classified Start proof.
            await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)!(request, {
                ...context, authorization: { kind: 'session.write', sessionId: session.sessionId },
            })).resolves.toMatchObject({ ok: false, code: 'agent_realtime_owner_required' });
            expect(created.operations.readActiveTurnAdmissionWitness?.()).toBeNull();
            await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)!(request, context)).resolves.toMatchObject({
                status: ending === 'failed_start' ? 'failed' : 'started' });
            emit({ kind: 'turn-start', sequence: 1, sessionId: session.sessionId, emittedAtMs: 1, turnId: 'provider-turn', startedBy: 'provider' });
            if (ending === 'failed_start') {
                expect(created.operations.readActiveTurnAdmissionWitness?.()).toBeNull();
                return;
            }
            expect(created.operations.readActiveTurnAdmissionWitness?.()).toMatchObject({ turnId: 'provider-turn',
                nativeRealtimeAdmission: { attemptId: request.applicationAttemptId } });
            if (ending === 'disconnect' || ending === 'retirement') {
                if (ending === 'disconnect') publishTerminal?.({ kind: 'terminal', reason: 'upstream_closed' });
                else retirement.abort();
                expect(created.operations.readActiveTurnAdmissionWitness?.()).toBeNull();
                return;
            }
            await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP)!({ v: 1, provider, applicationAttemptId: 'other-attempt' }, context))
                .resolves.toMatchObject({ status: 'already_stopped' });
            expect(created.operations.readActiveTurnAdmissionWitness?.()).not.toBeNull();
            const stopping = handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP)!({ v: 1, provider, applicationAttemptId: request.applicationAttemptId }, context);
            await vi.waitFor(() => expect(created.operations.readActiveTurnAdmissionWitness?.()).toBeNull());
            releaseStop();
            await expect(stopping).resolves.toMatchObject({ status: 'stopped' });
            publishTerminal?.({ kind: 'terminal', reason: 'upstream_closed' });
        } finally { releaseStop(); registration.dispose(); unsubscribe(); await created.operations.resetOrDisposeRuntime(); }
    });
    it('admits provider-started native input only under the exact live host Realtime fact, without Queue custody', async () => {
        const conversation: AgentSessionRealtimeConversation = { inspect: async () => ({ status: 'available', transport: 'webrtc' }),
            start: async () => ({ status: 'busy' }) };
        const { created, hookRuntime, emit } = await openSession(undefined, [], undefined, false, conversation);
        const unsubscribe = created.operations.subscribeRuntimeEvents(() => undefined);
        const lifetime = new AbortController();
        const admission = { admissionId: 'native-input-1', occurrenceId: 'native-occurrence-1', attemptId: 'voice-attempt-1' };
        const caller = { kind: 'session' as const, sessionId: 'applied-reader', starterDepth: 0, turnDepth: 0 };
        let sequence = 0;
        const start = (turnId: string) => emit({ kind: 'turn-start', sequence: ++sequence, sessionId: 'applied-reader',
            emittedAtMs: sequence, turnId, startedBy: 'provider' });
        const complete = (turnId: string) => emit({ kind: 'turn-complete', sequence: ++sequence, sessionId: 'applied-reader',
            emittedAtMs: sequence, turnId });
        try {
            start('unadmitted');
            expect(created.operations.readActiveTurnAdmissionWitness?.()).toBeNull();
            complete('unadmitted');
            expect(hookRuntime.admitAgentSessionRealtimeInput?.({ admission, conversation, agentStartCaller: { ...caller, sessionId: 'another-session' },
                signal: lifetime.signal })).toBeNull();
            const admitted = hookRuntime.admitAgentSessionRealtimeInput?.({ admission, conversation, agentStartCaller: caller, signal: lifetime.signal });
            start('native-voice-turn');
            expect(created.operations.readActiveTurnAdmissionWitness?.()).toMatchObject({
                inputId: admission.admissionId, turnId: 'native-voice-turn', userMessageSeq: null, userMessageSeqs: [],
                nativeRealtimeAdmission: admission, agentStartCaller: caller,
            });
            expect(created.operations.readTurnStartingInputId?.('native-voice-turn')).toBeNull();
            complete('native-voice-turn');
            // One admitted attempt covers successive speech turns, not an invented Queue item per utterance.
            start('next-native-voice-turn');
            expect(created.operations.readActiveTurnAdmissionWitness?.()?.inputId).toBe(admission.admissionId);
            lifetime.abort();
            expect(created.operations.readActiveTurnAdmissionWitness?.()).toBeNull();
            admitted?.dispose();
            complete('next-native-voice-turn');
            start('after-end');
            expect(created.operations.readActiveTurnAdmissionWitness?.()).toBeNull();
        } finally { unsubscribe(); await created.operations.resetOrDisposeRuntime(); }
    });
    it('keeps native realtime reachable through the real host adapter and retires it with the Session', async () => {
        // The native Agent is the external executable boundary; all host adapters,
        // authority resolution and Session RPC dispatch below remain real.
        const realtimeConversation: AgentSessionRealtimeConversation = {
            inspect: async () => ({ status: 'available', transport: 'webrtc' }),
            start: async () => ({ status: 'busy' }),
        };
        const { created, hookRuntime, session, agentId } = await openSession(undefined, [], undefined, false, realtimeConversation);
        const provider = { pluginId: 'acme.agent-plugin', localId: 'realtime' };
        const policyAgentRef = { pluginId: provider.pluginId, localId: agentId };
        const retirement = new AbortController();
        const authority = createAgentSessionRealtimeVoiceAuthority({
            occurrenceId: 'native-realtime-owner', policyAgentRef, isAgentRuntimeCurrent: () => true,
            providers: [{ provider, occurrenceId: 'native-realtime-provider', isCurrent: () => true, retirementSignal: retirement.signal,
                declaration: { id: provider.localId, title: 'Native realtime', kind: 'conversation', roles: ['realtime_conversation'], platforms: ['web'],
                    capabilities: { turn: { cancelResponse: false, bargeIn: false }, tools: { effectCalls: 'none' } },
                    execution: { kind: 'experimental_agent_session_realtime', agent: policyAgentRef },
                    client: { artifactId: 'voice-runtime', exportName: 'activate' } },
            }],
        });
        const registration = registerAgentSessionRealtimeVoiceRpc({
            rpc: session.rpcHandlerManager, runtime: hookRuntime, getHappierSessionId: () => session.sessionId,
            ownerId: 'native-realtime-owner', agentGeneration: authority.occurrenceId,
            isOccurrenceCurrent: authority.isCurrent, resolveProviderOccurrenceId: authority.resolveProviderOccurrenceId,
            resolveRetirementSignal: authority.resolveRetirementSignal, resolveConversation: authority.resolveConversation,
        });
        const inspect = () => session.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_INSPECT, { v: 1, provider });
        try {
            await expect(inspect()).resolves.toMatchObject({ ok: true, status: 'available', transport: 'webrtc' });
            await created.operations.resetOrDisposeRuntime('runtime_recovery');
            await expect(inspect()).resolves.toMatchObject({ ok: false, reason: 'unsupported_runtime' });
            await created.operations.resetOrDisposeRuntime('runtime_recovery', { kind: 'create' });
            await expect(inspect()).resolves.toMatchObject({ ok: true, status: 'available', transport: 'webrtc' });
            retirement.abort();
            await expect(inspect()).resolves.toMatchObject({ ok: false, reason: 'unsupported_runtime' });
        } finally {
            registration.dispose();
            await created.operations.resetOrDisposeRuntime();
        }
    });

    it.each([
        { scopes: ['workspace'], nativeScope: false, expectedScope: 'workspace' },
        { scopes: ['personal', 'workspace'], nativeScope: false, expectedScope: 'workspace' },
        { scopes: ['unknown', 'workspace'], nativeScope: false, expectedScope: 'workspace' },
        { scopes: ['personal'], nativeScope: false, expectedScope: 'personal' },
        { scopes: ['unknown'], nativeScope: false, expectedScope: undefined },
        { scopes: ['workspace'], nativeScope: true, expectedScope: 'workspace' },
        { scopes: ['workspace'], nativeScope: 'personal', expectedScope: 'personal' },
    ] as const)('captures service scope at dispatch, retaining ambiguous workspace candidates ($scopes, native=$nativeScope)', async ({ scopes, nativeScope, expectedScope }) => {
        const service = { pluginId: 'acme.connected-account', localId: 'credential' };
        const { created, published, emit } = await openSession(undefined, scopes.map((usageAccountScope, index) => ({
            purpose: 'primary', usageAccountScope, account: { service, accountId: `account-${index}` },
        })));
        const unsubscribe = created.operations.subscribeRuntimeEvents(() => undefined);
        try {
            await created.operations.sendTurnPrompt('request', { turnId: 'scope-turn', localId: 'scope-input' });
            // The native boundary proves input custody before its turn starts,
            // as the production Agent adapters do; `send` alone grants no witness.
            emit({ kind: 'input-accepted', sequence: 0, sessionId: 'applied-reader', emittedAtMs: 98,
                inputIds: ['scope-input'], delivery: { kind: 'newTurn', turnId: 'scope-turn' } });
            emit({ kind: 'turn-start', sequence: 1, sessionId: 'applied-reader', emittedAtMs: 99,
                turnId: 'scope-turn', startedBy: 'host' });
            emit({ kind: 'usage-observed', sequence: 2, sessionId: 'applied-reader', emittedAtMs: 100,
                turnId: 'scope-turn', observationId: 'scope-observation', source: 'native', scope: 'turn_delta', modelId: 'model',
                ...(nativeScope ? { attribution: { v: 1, turnId: 'scope-turn', source: { kind: 'native',
                    connectedAccount: { service, accountId: 'account-0' },
                    ...(nativeScope === 'personal' ? { accountScope: 'personal' } : {}) } } } : {}),
                tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 } });
            await vi.waitFor(() => expect(published).toHaveLength(1));
            const ingested = UsageEventIngestRequestSchema.parse(buildUsageEventIngestRequest({
                ...published[0]!, observedAt: published[0]!.observedAt ?? 100, sessionId: 'applied-reader',
            }));
            expect(ingested).toMatchObject({ attribution: { turnId: 'scope-turn', source: {
                kind: 'native', connectedAccount: scopes.length === 1 ? { service, accountId: 'account-0' } : null,
                ...(expectedScope ? { accountScope: expectedScope } : {}),
            } } });
            if (!expectedScope) expect(published[0]).not.toHaveProperty('attribution.source.accountScope');
        } finally { unsubscribe(); await created.operations.resetOrDisposeRuntime(); }
    });

    it('opens the accepted Team binding from a committed attach for an external Agent', async () => {
        const { created, hookRuntime } = await openSession({ v: 1, slot: { kind: 'provider_model' },
            resourceId: 'opened-resource', expectedResourceRevision: 3, deliveryMode: 'brokered', teamId: 'opened-team' }, [], undefined, true);
        try {
            expect(hookRuntime.readAppliedTeamCredentialModel?.()).toMatchObject({ resourceId: 'opened-resource', teamId: 'opened-team' });
        } finally { await created.operations.resetOrDisposeRuntime(); }
    });
    it('consumes response-bound native account proof across same-model switches and refuses start-only proof', async () => {
        const service = { pluginId: 'acme.connected-account', localId: 'credential' };
        let activeAccount: string | null = 'account-a';
        const { created, published, emit } = await openSession(undefined, [{ purpose: 'primary', account: { service, accountId: 'account-a' } }], {
            apply: async () => ({ ok: false, error: 'unused' }),
            // The native authentication reader is a vendor/process boundary. Host request and accounting logic stay real.
            readIdentity: async request => activeAccount ? { ok: true, serviceId: request.serviceId,
                identity: { strategy: 'provider_account_id', proofStrength: 'exact' }, runtime: { profileId: activeAccount } }
                : { ok: false, error: 'proof-unavailable' },
        });
        let sequence = 0;
        created.operations.subscribeRuntimeEvents(() => undefined);
        try {
            for (const [turnId, accountId] of [['turn-a', 'account-a'], ['turn-b', 'account-b'], ['turn-unknown', null]] as const) {
                activeAccount = accountId;
                await created.operations.sendTurnPrompt('request', { turnId, localId: turnId });
                emit({ kind: 'turn-start', sequence: ++sequence, sessionId: 'applied-reader', emittedAtMs: sequence, turnId, startedBy: 'provider' });
                // A response received after runtime selection changes must retain its dispatched account.
                activeAccount = 'later-account';
                emit({ kind: 'usage-observed', sequence: ++sequence, sessionId: 'applied-reader', emittedAtMs: sequence,
                    ...(accountId ? { attribution: { v: 1 as const, turnId, source: { kind: 'native' as const, connectedAccount: { service, accountId } } } } : {}),
                    turnId, observationId: turnId, source: 'native', scope: 'turn_delta', modelId: 'same-model',
                    tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 } });
                emit({ kind: 'turn-complete', sequence: ++sequence, sessionId: 'applied-reader', emittedAtMs: sequence, turnId });
            }
            await vi.waitFor(() => expect(published).toHaveLength(3));
            expect(published[0]).toMatchObject({ attribution: { v: 1, turnId: 'turn-a', source: { kind: 'native', connectedAccount: { service, accountId: 'account-a' } } } });
            expect(published[1]).toMatchObject({ attribution: { v: 1, turnId: 'turn-b', source: { kind: 'native', connectedAccount: { service, accountId: 'account-b' } } } });
            expect(published[2]).not.toHaveProperty('attribution');
        } finally { await created.operations.resetOrDisposeRuntime(); }
    });
    it.each(['direct', 'brokered'] as const)('reads the opened %s Team identity without pending intent or private material', async (deliveryMode) => {
        const { created, hookRuntime, session, agentId } = await openSession({
            v: 1, slot: { kind: 'provider_model' }, resourceId: 'opened-resource',
            expectedResourceRevision: 3, deliveryMode, teamId: 'opened-team',
        });
        try {
            expect.soft(hookRuntime.openedWithoutConnectedServices?.()).toBe(true);
            await session.updateMetadata((metadata) => ({ ...metadata, modelSelectionIntentV2: {
                kind: 'team_credential_provider_model', resourceId: 'pending-resource', teamId: 'pending-team',
                expectedResourceRevision: 4, deliveryMode, agentTargetKey: `backend:${agentId}`, modelId: 'pending-model',
            } }));
            expect(hookRuntime.readAppliedTeamCredentialModel?.()).toEqual({
                kind: 'team_credential_provider_model', resourceId: 'opened-resource', teamId: 'opened-team',
                expectedResourceRevision: 3, deliveryMode, agentTargetKey: `backend:${agentId}`, modelId: 'team-model',
            });
        } finally { await created.operations.resetOrDisposeRuntime(); }
        expect(hookRuntime.readAppliedTeamCredentialModel?.()).toBeUndefined();
        expect(hookRuntime.openedWithoutConnectedServices?.()).toBe(false);
    });

    it('distinguishes an opened native Session from an unavailable legacy Team identity', async () => {
        const native = await openSession();
        try {
            expect.soft(native.hookRuntime.openedWithoutConnectedServices?.()).toBe(true);
            expect(native.hookRuntime.readAppliedTeamCredentialModel?.()).toBeNull();
        } finally { await native.created.operations.resetOrDisposeRuntime(); }
        const legacyTeam = await openSession({ v: 1, slot: { kind: 'provider_model' },
            resourceId: 'opened-resource', expectedResourceRevision: 3, deliveryMode: 'brokered' });
        try {
            expect(legacyTeam.hookRuntime.readAppliedTeamCredentialModel?.()).toBeUndefined();
        } finally { await legacyTeam.created.operations.resetOrDisposeRuntime(); }
    });

    it('does not turn an accepted Connected Account into empty-route proof', async () => {
        const { created, hookRuntime } = await openSession(undefined, [{
            purpose: 'primary', account: { service: { pluginId: 'acme.connected-account', localId: 'credential' }, accountId: 'account-a' },
        }]);
        try {
            expect(hookRuntime.openedWithoutConnectedServices?.()).toBe(false);
            expect(hookRuntime.readAppliedTeamCredentialModel?.()).toBeNull();
        } finally { await created.operations.resetOrDisposeRuntime(); }
    });
});
