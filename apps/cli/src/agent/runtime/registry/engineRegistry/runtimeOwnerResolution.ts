import type {
    ResolvedAgentContribution,
    ResolvedAgentRuntimeContribution,
} from '@/plugins/projection/registry/types';
import type {
    BackendRuntimeOwnerCandidate,
    BackendRuntimeOwnerResolution,
} from '../engineRegistryTypes';
import type { AgentRuntimeRegistrationLease } from '@/plugins/runtime/lifecycle/contributions/targetAgents';

export type RuntimeRegistryBackendEngineEntry = AgentRuntimeRegistrationLease;

export function createEmptyBackendRuntimeOwnerResolution(backendId: string): BackendRuntimeOwnerResolution {
    return Object.freeze({
        backendId,
        selected: null,
        candidates: Object.freeze([]),
    });
}

function resolvePluginRuntimeOwnerPluginId(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    agent?: ResolvedAgentContribution | null;
    engineEntry?: RuntimeRegistryBackendEngineEntry;
}>): string | undefined {
    return params.engineEntry?.pluginId
        ?? params.backend.pluginId
        ?? params.agent?.pluginId;
}

function createPluginRuntimeOwnerCandidate(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    agent?: ResolvedAgentContribution | null;
    engineEntry?: RuntimeRegistryBackendEngineEntry;
}>): BackendRuntimeOwnerCandidate {
    const pluginId = resolvePluginRuntimeOwnerPluginId(params);
    return Object.freeze({
        kind: 'plugin_engine',
        ownerId: pluginId ?? params.backend.id,
        provenance: params.backend.provenance,
        ...(pluginId ? { pluginId } : {}),
    });
}

export function resolveBackendRuntimeOwner(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    agent?: ResolvedAgentContribution | null;
    engineEntry?: RuntimeRegistryBackendEngineEntry;
    manifestOnlyPluginRuntime: boolean;
    nativeAgentRuntimeCarrier?: boolean;
}>): BackendRuntimeOwnerResolution {
    const pluginOwnerExists = params.engineEntry?.hasPrimaryRuntime === true
        || params.nativeAgentRuntimeCarrier === true
        || params.manifestOnlyPluginRuntime;
    const pluginOwner = pluginOwnerExists
        ? createPluginRuntimeOwnerCandidate({
            backend: params.backend,
            agent: params.agent ?? null,
            engineEntry: params.engineEntry,
        })
        : null;

    return Object.freeze({
        backendId: params.backend.id,
        selected: pluginOwner,
        candidates: Object.freeze(pluginOwner ? [pluginOwner] : []),
    });
}
