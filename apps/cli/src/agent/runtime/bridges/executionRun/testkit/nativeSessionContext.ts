import { vi } from 'vitest';
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol';
import type { AgentRuntime, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
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

/** Real native factory and live wrapper chain; only the Agent SDK and Session transport are fixtures. */
export function createVoiceSessionRuntimeThroughNativeFactory(params: Readonly<{
    runtime: AgentRuntime;
    capabilities: AgentSessionCapabilities;
    modelId: string;
}>) {
    return createLazyExecutionRunHostRuntime({ resolveRuntime: async () => {
        const agent: ResolvedAgentContribution = {
            id: 'acme.voice/agents/default', pluginId: 'acme.voice', provenance: 'external', source: { kind: 'path' },
            identity: { pluginId: 'acme.voice', localId: 'default' },
            definition: { kindVersion: 1, id: 'acme.voice/agents/default', ownedBackendIds: [] },
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
            nativeAgentRuntimeIdentity: { pluginId: 'acme.voice', pluginVersion: '1.0.0', agentId: agent.id, localAgentId: 'default', occurrenceId: `voice-${params.modelId}`, isCurrent: () => true },
        });
        if (!adapter) throw new Error('Fixture native Agent factory unavailable');
        const permissionHandler = createExecutionRunPermissionHandler({ permissionMode: 'read_only', backendId: agent.id });
        const runtime = adapter.runtimeCore.createExecutionRunBackend({
            cwd: '/repo', runId: 'host-voice-run', controllerOccurrenceId: `voice-${params.modelId}`, scope: 'session_owned',
            backendId: agent.id, modelId: params.modelId, permissionMode: 'read_only',
            start: { intent: 'voice_agent', runClass: 'long_lived', retentionPolicy: 'resumable', ioMode: 'streaming' },
            sessionInteractionHost: {
                machineId: 'voice-fixture-machine', permissionHandler,
                session: {
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
}>): Readonly<{ context: AgentSessionRuntimeContext; dispose(): Promise<void> }> {
    const sessionServices = createNativeAgentSessionHostServices({
        owners: {
            features: { isEnabled: () => true }, sessionHooks: {}, transcripts: { fileFollow: {} },
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
