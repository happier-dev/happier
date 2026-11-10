import { vi } from 'vitest';
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol/plugins/contributions/v2';
import type { AgentRuntime, AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionRuntimeContext, AgentSessionRuntimeEvent, AgentSessionSendRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { composeNativeAgentSessionRuntimeContext, createNativeAgentSessionHostServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import type { AgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import type { ResolvedAgentContribution } from '@/plugins/projection/registry/types';
import { projectEngineRuntimeContributionFromAgent } from '@/agent/runtime/registry/engineRegistry/contributions';
import { resolveBackendRuntimeOwner } from '@/agent/runtime/registry/engineRegistry/runtimeOwnerResolution';
import { resolveBackendRuntimeCore } from '@/agent/runtime/registry/engineRegistry/runtimeCore';
import { createEmptyBackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistryTypes';
import { createLazyExecutionRunHostRuntime } from '../hostRuntime/lazy';
import { withExecutionRunHostRuntimeCleanup } from '../hostRuntime/cleanup';
import { withExecutionRunPermissionResponder } from '../hostRuntime/permissionResponder';
import { withExecutionRunRuntimeIdentityPublication } from '@/agent/runtime/identity/executionRunRuntimeIdentityPublication';
import { createExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';
import type { HostSessionHooksOwner } from '@/plugins/runtime/hooks/session/service';
import type { CreateCliExecutionRunBackendParams } from '@/agent/runtime/registry/engineRegistryTypes';
import type { ExternalSessionHostOperationPortFactory } from '@/agent/runtime/registry/engineRegistry/types';

/** Controllable external Agent SDK boundary; host admission and lifecycle stay real. */
export function createNativeSessionBoundary() {
    const opens: AgentSessionOpenRequest[] = [];
    const inputs: AgentSessionSendRequest[] = [];
    const inputWaiters: Array<Readonly<{ count: number; resolve(): void }>> = [];
    const openWaiters: Array<Readonly<{ count: number; resolve(): void }>> = [];
    let disposal = Promise.resolve();
    let readDisposed = () => false;
    let completeCurrent: ((text: string) => void) | undefined;
    return {
        opens,
        inputs,
        async waitForOpens(count: number) {
            if (opens.length >= count) return;
            await new Promise<void>(resolve => { openWaiters.push({ count, resolve }); });
        },
        isDisposed: () => readDisposed(),
        async waitForInputs(count: number) {
            if (inputs.length >= count) return;
            await new Promise<void>(resolve => { inputWaiters.push({ count, resolve }); });
        },
        whenDisposed: () => disposal,
        async open(request: AgentSessionOpenRequest): Promise<AgentSessionRuntime> {
            opens.push(request);
            for (const waiter of openWaiters) if (opens.length >= waiter.count) waiter.resolve();
            let listener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
            let currentInput: AgentSessionSendRequest | null = null;
            let sequence = 0;
            let disposed = false;
            let resolveDisposal = () => {};
            const base = () => ({ sessionId: request.sessionId, sequence: ++sequence, emittedAtMs: Date.now() });
            readDisposed = () => disposed;
            disposal = new Promise<void>(resolve => { resolveDisposal = resolve; });
            completeCurrent = text => {
                if (!currentInput) throw new Error('The external Agent has no admitted input');
                const turnId = currentInput.delivery.turnId;
                listener?.({ ...base(), kind: 'message-delta', turnId, channel: 'assistant', text });
                listener?.({ ...base(), kind: 'turn-complete', turnId });
                currentInput = null;
            };
            return {
                functionToolsDelivered: Boolean(request.functionTools),
                watch(next) {
                    listener = next;
                    next({ ...base(), kind: 'provider-session-id', providerSessionId: 'registry-native-session' });
                    return { dispose() { if (listener === next) listener = undefined; } };
                },
                async send(input) {
                    inputs.push(input);
                    currentInput = input;
                    listener?.({ ...base(), kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
                    listener?.({ ...base(), kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
                    for (const waiter of inputWaiters) if (inputs.length >= waiter.count) waiter.resolve();
                    return { status: 'admitted' };
                },
                async cancel(input) {
                    if (!currentInput || currentInput.delivery.turnId !== input.turnId) return { status: 'notRunning' };
                    listener?.({ ...base(), kind: 'turn-cancelled', turnId: input.turnId, cause: input.reason });
                    currentInput = null;
                    return { status: 'requested', turnId: input.turnId };
                },
                async dispose() { disposed = true; resolveDisposal(); },
            };
        },
        complete(text = JSON.stringify({ summary: 'Completed.', deliverables: [] })) {
            if (!completeCurrent) throw new Error('The external Agent has not opened');
            completeCurrent(text);
        },
    };
}

/** Real native factory and live wrapper chain; only the Agent SDK and Session transport are fixtures. */
export function createVoiceSessionRuntimeThroughNativeFactory(params: Readonly<{
    runtime: AgentRuntime;
    capabilities: AgentSessionCapabilities;
    modelId: string;
    functionTools?: AgentSessionOpenRequest['functionTools'];
    configuration?: CreateCliExecutionRunBackendParams['configuration'];
    start?: CreateCliExecutionRunBackendParams['start'];
    /** Real Session composition; tests supply its Socket/HTTP boundaries separately. */
    session?: ApiSessionClient;
    externalSessionHostOperations?: ExternalSessionHostOperationPortFactory;
    sessionOwnedRunScope?: CreateCliExecutionRunBackendParams['sessionOwnedRunScope'];
    /** Preserve the real bridge's Run, parent transport and occurrence custody. */
    runtimeOptions?: CreateCliExecutionRunBackendParams;
}>) {
    return createLazyExecutionRunHostRuntime({ resolveRuntime: async () => {
        const agentId = params.runtimeOptions?.backendId ?? 'acme.voice/agents/default';
        const occurrenceId = params.runtimeOptions?.controllerOccurrenceId ?? `voice-${params.modelId}`;
        const agent: ResolvedAgentContribution = {
            id: agentId, pluginId: 'acme.voice', provenance: 'external', source: { kind: 'path' },
            identity: { pluginId: 'acme.voice', localId: 'default' },
            definition: { kindVersion: 1, id: agentId, ownedBackendIds: [] },
            richDefinition: { provenance: 'external', definition: PluginAgentContributionV2Schema.parse({
                id: 'default', title: { key: 'voice.fixture.title', fallback: 'Voice fixture' },
                description: { key: 'voice.fixture.description', fallback: 'Voice fixture' },
                runtime: { kind: 'custom' }, primary: 'sessions', capabilities: { sessions: params.capabilities },
            }) },
        };
        const backend = projectEngineRuntimeContributionFromAgent(agent, agent.id);
        const adapter = await resolveBackendRuntimeCore({
            backend, agent, executionSurfaces: createEmptyBackendExecutionSurfaces(),
            runtimeOwner: resolveBackendRuntimeOwner({ backend, agent, runnerAgentSessionRuntimeSource: true, manifestOnlyPluginRuntime: false }),
            runtimeRegistry: null, nativeAgentRuntime: params.runtime,
            externalSessionHostOperations: params.externalSessionHostOperations,
            nativeAgentRuntimeIdentity: { pluginId: 'acme.voice', pluginVersion: '1.0.0', agentId: agent.id, localAgentId: 'default', occurrenceId,
                isCurrent: () => true },
        });
        if (!adapter) throw new Error('Fixture native Agent factory unavailable');
        const permissionHandler = createExecutionRunPermissionHandler({ permissionMode: params.runtimeOptions?.permissionMode ?? 'read_only', backendId: agent.id });
        const runtime = adapter.runtimeCore.createExecutionRunBackend(params.runtimeOptions ?? {
            cwd: '/repo', runId: 'host-voice-run', controllerOccurrenceId: `voice-${params.modelId}`, scope: 'session_owned',
            ...(params.functionTools ? { functionTools: params.functionTools } : {}),
            backendId: agent.id, modelId: params.modelId, permissionMode: 'read_only',
            ...(params.configuration ? { configuration: params.configuration } : {}),
            start: { intent: 'voice_agent', runClass: 'long_lived', retentionPolicy: 'resumable', ioMode: 'streaming', ...params.start },
            sessionOwnedRunScope: params.sessionOwnedRunScope,
            sessionInteractionHost: {
                machineId: 'voice-fixture-machine', permissionHandler,
                session: params.session ?? {
                    sessionId: 'session-parent', getMetadataSnapshot: () => ({ path: '/repo', machineId: 'voice-fixture-machine' }),
                    updateMetadata: vi.fn(), updateAgentState: vi.fn(), enqueueAgentMessageCommitted: vi.fn(),
                },
            },
            // Unavailable transport fields are deliberately absent at this real
            // Session-client boundary; the fixture never invokes them.
        } as never);
        if (!runtime) throw new Error('Fixture retained native Session unavailable');
        return withExecutionRunRuntimeIdentityPublication({
            runtime: withExecutionRunHostRuntimeCleanup(withExecutionRunPermissionResponder(runtime, permissionHandler), async () => {}),
            identity: { runtimeDescriptor: null, runtimeCapabilities: {}, runtimeFacets: null },
        });
    } });
}

/** Real context composition with unavailable process/transport service boundaries. */
export function createVoiceSessionContextLease(params: Readonly<{
    services: AgentSessionRuntimeContext['services'];
    signal: AbortSignal;
    dispose: () => Promise<void>;
    sessionHooks?: HostSessionHooksOwner;
}>): Readonly<{ context: AgentSessionRuntimeContext; dispose(): Promise<void> }> {
    const sessionServices = createNativeAgentSessionHostServices({
        owners: {
            features: { isEnabled: () => true }, sessionHooks: params.sessionHooks ?? {}, transcripts: { fileFollow: {} },
            accountUsage: {}, mcp: {}, toolExecution: {},
        },
        agentId: 'acme.voice/agents/default', sessionId: 'session-parent', directory: '/repo',
        signal: params.signal, isCurrent: () => true,
        session: {
            sessionId: 'session-parent', updateMetadata: vi.fn(), enqueueAgentMessageCommitted: vi.fn(),
        },
        publications: {
            models: { bind: () => ({ dispose() {} }) },
            activeInput: { bind: () => ({ dispose() {} }), publishStatus: vi.fn() },
        },
        readToolExecutionCapability: () => null,
        // The fixture offers only the transport services reached by this corridor.
    } as never);
    return {
        context: composeNativeAgentSessionRuntimeContext({
            identity: { pluginId: 'acme.voice', pluginVersion: '1.0.0', agentId: 'acme.voice/agents/default' },
            contributionId: 'default', invokedAtMs: 1, sessionId: 'session-parent', signal: params.signal,
            services: params.services, sessionServices,
            ui: {} as AgentSessionRuntimeContext['ui'], protocols: {} as AgentSessionRuntimeContext['protocols'],
            workState: {
                publisher() {
                    return { async publish() {
                        return { status: 'unavailable' as const, diagnostic: { code: 'voice_test_unavailable', severity: 'info' as const } };
                    } };
                },
            },
        }),
        dispose: params.dispose,
    };
}
