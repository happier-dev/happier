import type { AgentRuntime } from '@happier-dev/plugin-sdk/agent-runtime';
import type {
    ResolvedAgentContribution,
    ResolvedAgentRuntimeContribution,
} from '@/plugins/projection/registry/types';
import { readAgentExecutionRunCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import {
    type BackendExecutionSurfaces,
    type CliEngineAdapter,
    type CliRuntimeCore,
} from '../engineRegistryTypes';
import type {
    BackendRuntimeOwnerResolution,
} from '../engineRegistryTypes';
import type { RuntimeRegistryBackendEngineEntry } from './runtimeOwnerResolution';
import { resolveLeasedAgentRuntime } from './agentRuntimeLease';
import { createNativeAgentRuntimeSessionPlan } from './nativeAgentSession';
import { createNativeAgentSessionHostServiceOwners } from './nativeAgentSessionHostServiceOwners';
import { createNativeAgentExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/nativeAgentExecutionRun';
import { resolveAgentSessionRealtimeVoiceAuthority } from '@/agent/runtime/session/realtime/resolveAgentSessionRealtimeVoiceAuthority';
import type {
    PluginRuntimeAuthoritySnapshotV1,
} from '@/plugins/runtime/lifecycle/activation/runtimeAuthority';
import type { ExternalSessionHostOperationPortFactory } from './types';
import type {
    AgentSessionRealtimeVoiceAuthority,
} from '@/agent/runtime/session/realtime/registerAgentSessionRealtimeVoiceRpc';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function shouldNormalizeManifestOnlyAcpBackend(backend: ResolvedAgentRuntimeContribution): boolean {
    if (backend.runtimeKind === 'acp') {
        return true;
    }
    const richDefinition = backend.richDefinition;
    if (richDefinition?.provenance !== 'external' || !isRecord(richDefinition.definition)) {
        return false;
    }
    if (richDefinition.definition.runtimeKind === 'acp' || Object.prototype.hasOwnProperty.call(richDefinition.definition, 'acp')) {
        return true;
    }
    const engine = richDefinition.definition.engine;
    return isRecord(engine) && engine.kind === 'acp';
}

export async function resolveBackendRuntimeCore(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    agent: ResolvedAgentContribution;
    executionSurfaces: BackendExecutionSurfaces;
    runtimeOwner: BackendRuntimeOwnerResolution;
    engineEntry?: RuntimeRegistryBackendEngineEntry;
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
    nativeAgentRuntimeVoiceAuthority?:
        AgentSessionRealtimeVoiceAuthority | null;
    happyHomeDir?: string;
    nativeAgentRuntime?: AgentRuntime | null;
    externalSessionHostOperations?: ExternalSessionHostOperationPortFactory | null;
    nativeAgentRuntimeIdentity?: Readonly<{
        pluginId: string;
        pluginVersion: string;
        agentId: string;
        generation: string;
        immutableGenerationId?: string | null;
        runtimeAuthority?: PluginRuntimeAuthoritySnapshotV1;
        retirementSignal?: AbortSignal;
        isCurrent(): boolean;
    }>;
}>): Promise<CliEngineAdapter | null> {
    const selectedOwnerKind = params.runtimeOwner.selected?.kind ?? null;
    if (!selectedOwnerKind) {
        return null;
    }

    if (selectedOwnerKind === 'plugin_engine') {
        const runtimeRegistry = params.runtimeRegistry;
        const engineEntry = params.engineEntry;
        if ((runtimeRegistry && engineEntry)
            || (params.nativeAgentRuntime && params.nativeAgentRuntimeIdentity)) {
            const nativeAgentRuntime = params.nativeAgentRuntime
                ?? (engineEntry
                    ? await resolveLeasedAgentRuntime({ lease: engineEntry })
                    : null);
            if (nativeAgentRuntime) {
                const nativeIdentity = params.nativeAgentRuntimeIdentity ?? engineEntry;
                if (!nativeIdentity) {
                    throw new Error('Native Agent runtime identity is unavailable');
                }
                const agentRetirementSignal =
                    nativeIdentity.retirementSignal
                    ?? engineEntry?.retirementSignal;
                const daemonAgentRuntimeCarrierRetirementSignal =
                    params.nativeAgentRuntimeIdentity?.retirementSignal;
                const agentSessionRealtimeVoiceAuthority =
                    params.nativeAgentRuntimeVoiceAuthority
                    ?? resolveAgentSessionRealtimeVoiceAuthority({
                        runtimeRegistry: params.runtimeRegistry,
                        policyAgentRef: params.agent.identity ?? null,
                        agentRuntimeIdentity: nativeIdentity,
                        ...(agentRetirementSignal
                            ? { agentRetirementSignal }
                            : {}),
                    });
                const runtimeCore: CliRuntimeCore = Object.freeze({
                    async createSessionRuntime(sessionParams: unknown) {
                        return await createNativeAgentRuntimeSessionPlan({
                            runtime: nativeAgentRuntime,
                            identity: nativeIdentity,
                            backend: params.backend,
                            agent: params.agent,
                            executionSurfaces: params.executionSurfaces,
                            externalSessionHostOperations:
                                params.externalSessionHostOperations,
                            createSessionHostServiceOwners: ({
                                hostRuntimeParams,
                                sessionId,
                                directory,
                                signal,
                            }) => createNativeAgentSessionHostServiceOwners({
                                runtimeRegistry,
                                identity: nativeIdentity,
                                backend: params.backend,
                                agent: params.agent,
                                hostRuntimeParams,
                                sessionId,
                                directory,
                                signal,
                                ...(params.nativeAgentRuntimeIdentity
                                    ?.runtimeAuthority
                                    ? {
                                        runtimeAuthority:
                                            params.nativeAgentRuntimeIdentity
                                                .runtimeAuthority,
                                    }
                                    : {}),
                                ...(params.happyHomeDir
                                    ? { happyHomeDir: params.happyHomeDir }
                                    : {}),
                            }),
                            ...(runtimeRegistry?.createAgentInvocationServices && engineEntry ? {
                                createInvocationServices: ({ correlationId, cwd, environment, providerBindingActive, signal, session }) => (
                                    runtimeRegistry.createAgentInvocationServices!({
                                        pluginId: engineEntry.pluginId,
                                        pluginVersion: engineEntry.pluginVersion,
                                        agentId: engineEntry.agentId,
                                        generation: engineEntry.generation,
                                        correlationId,
                                        cwd,
                                        environment,
                                        providerBindingActive,
                                        signal,
                                        session,
                                        isGenerationCurrent: engineEntry.isCurrent,
                                    })
                                ),
                            } : {}),
                            ...(agentRetirementSignal
                                ? { generationSignal: agentRetirementSignal }
                                : {}),
                            ...(daemonAgentRuntimeCarrierRetirementSignal
                                ? {
                                    daemonAgentRuntimeCarrierRetirementSignal,
                                }
                                : {}),
                            ...(agentSessionRealtimeVoiceAuthority
                                ? { agentSessionRealtimeVoiceAuthority }
                                : {}),
                            sessionInput: buildPluginSessionBindingInput(sessionParams),
                        });
                    },
                    createExecutionRunBackend(options) {
                        if (!engineEntry || !runtimeRegistry) {
                            throw new Error('Daemon session runtime carrier does not own execution runs');
                        }
                        const openCapabilities = readAgentExecutionRunCapabilities(
                            params.agent.richDefinition?.definition,
                        )?.open;
                        const runId = options.runId?.trim();
                        const services = runId && runtimeRegistry.createAgentInvocationServices
                            ? runtimeRegistry.createAgentInvocationServices({
                                pluginId: engineEntry.pluginId,
                                pluginVersion: engineEntry.pluginVersion,
                                agentId: engineEntry.agentId,
                                generation: engineEntry.generation,
                                correlationId: runId,
                                cwd: options.cwd,
                                ...(options.isolation?.env ? { environment: options.isolation.env } : {}),
                                signal: engineEntry.retirementSignal,
                                isGenerationCurrent: engineEntry.isCurrent,
                            })
                            : undefined;
                        return createNativeAgentExecutionRunHostRuntime({
                            runtime: nativeAgentRuntime,
                            lease: engineEntry,
                            options,
                            supportsResume: openCapabilities?.includes('resume') === true,
                            generationSignal: engineEntry.retirementSignal,
                            ...(services ? { services } : {}),
                        });
                    },
                });
                return { runtimeCore };
            }
        }

        return null;
    }
    return null;
}
