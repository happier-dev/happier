import type {
    ResolvedAgentContribution,
    ResolvedAgentRuntimeContribution,
} from '@/plugins/projection/registry/types';
import type {
    BackendRuntimeOwnerCandidate,
    BackendRuntimeOwnerResolution,
    BackendRuntimeOwnerTakeoverMarker,
    CliRuntimeCoreGetter,
    EngineResolutionDiagnostic,
} from '../engineRegistryTypes';

export type RuntimeRegistryBackendEngineEntry = Readonly<{
    pluginId?: string;
    registration?: unknown;
}>;

export function createEmptyBackendRuntimeOwnerResolution(backendId: string): BackendRuntimeOwnerResolution {
    return Object.freeze({
        backendId,
        selected: null,
        candidates: Object.freeze([]),
    });
}

function createLegacyHostRuntimeOwnerCandidate(backend: ResolvedAgentRuntimeContribution): BackendRuntimeOwnerCandidate {
    return Object.freeze({
        kind: 'legacy_host',
        ownerId: backend.id,
        provenance: backend.provenance,
    });
}

function resolvePluginRuntimeOwnerPluginId(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    provider?: ResolvedAgentContribution | null;
    engineEntry?: RuntimeRegistryBackendEngineEntry;
}>): string | undefined {
    return params.engineEntry?.pluginId
        ?? params.backend.pluginId
        ?? params.provider?.pluginId;
}

function createPluginRuntimeOwnerCandidate(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    provider?: ResolvedAgentContribution | null;
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

function readBackendRuntimeOwnerTakeoverMarker(
    backend: ResolvedAgentRuntimeContribution,
): BackendRuntimeOwnerTakeoverMarker | undefined {
    const marker = backend.runtimeOwner;
    if (
        marker?.selectedOwner === 'plugin_engine'
        && typeof marker.acceptedBy === 'string'
        && marker.acceptedBy.trim().length > 0
    ) {
        return Object.freeze({
            selectedOwner: 'plugin_engine',
            acceptedBy: marker.acceptedBy,
        });
    }
    return undefined;
}

function createRuntimeOwnerConflictDiagnostic(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    provider?: ResolvedAgentContribution | null;
    pluginOwner: BackendRuntimeOwnerCandidate;
}>): EngineResolutionDiagnostic {
    const pluginLabel = params.pluginOwner.pluginId ?? params.pluginOwner.ownerId;
    return Object.freeze({
        code: 'engine_runtime_owner_conflict',
        message: `Backend '${params.backend.id}' has both legacy host getRuntimeCore and plugin backend engine owner '${pluginLabel}' without an accepted runtime owner takeover marker`,
        backendId: params.backend.id,
        agentId: params.provider?.id ?? params.backend.agentId,
        pluginId: params.pluginOwner.pluginId,
    });
}

function createRuntimeOwnerTakeoverMissingDiagnostic(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    provider?: ResolvedAgentContribution | null;
    engineEntry?: RuntimeRegistryBackendEngineEntry;
}>): EngineResolutionDiagnostic {
    const pluginId = resolvePluginRuntimeOwnerPluginId({
        backend: params.backend,
        provider: params.provider ?? null,
        engineEntry: params.engineEntry,
    });
    return Object.freeze({
        code: 'engine_runtime_owner_takeover_missing',
        message: `Backend '${params.backend.id}' is marked for plugin engine takeover but no registered plugin backend engine owner is available`,
        backendId: params.backend.id,
        agentId: params.provider?.id ?? params.backend.agentId,
        pluginId,
    });
}

export function resolveBackendRuntimeOwner(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    provider?: ResolvedAgentContribution | null;
    runtimeCoreGetter: CliRuntimeCoreGetter | null;
    engineEntry?: RuntimeRegistryBackendEngineEntry;
    manifestOnlyPluginRuntime: boolean;
}>): BackendRuntimeOwnerResolution {
    const candidates: BackendRuntimeOwnerCandidate[] = [];
    const legacyHostOwner = params.backend.provenance === 'first_party' && params.runtimeCoreGetter
        ? createLegacyHostRuntimeOwnerCandidate(params.backend)
        : null;
    const pluginOwnerExists = Boolean(params.engineEntry?.registration)
        || params.manifestOnlyPluginRuntime
        || (params.backend.provenance === 'external' && Boolean(params.runtimeCoreGetter));
    const pluginOwner = pluginOwnerExists
        ? createPluginRuntimeOwnerCandidate({
            backend: params.backend,
            provider: params.provider ?? null,
            engineEntry: params.engineEntry,
        })
        : null;

    if (legacyHostOwner) {
        candidates.push(legacyHostOwner);
    }
    if (pluginOwner) {
        candidates.push(pluginOwner);
    }

    const takeover = readBackendRuntimeOwnerTakeoverMarker(params.backend);
    if (takeover?.selectedOwner === 'plugin_engine' && !pluginOwner) {
        const conflictDiagnostic = createRuntimeOwnerTakeoverMissingDiagnostic({
            backend: params.backend,
            provider: params.provider ?? null,
            engineEntry: params.engineEntry,
        });
        return Object.freeze({
            backendId: params.backend.id,
            selected: null,
            candidates: Object.freeze(candidates),
            takeover,
            conflictDiagnostic,
        });
    }

    if (legacyHostOwner && pluginOwner) {
        if (takeover?.selectedOwner === 'plugin_engine') {
            return Object.freeze({
                backendId: params.backend.id,
                selected: pluginOwner,
                candidates: Object.freeze(candidates),
                takeover,
            });
        }

        const conflictDiagnostic = createRuntimeOwnerConflictDiagnostic({
            backend: params.backend,
            provider: params.provider ?? null,
            pluginOwner,
        });
        return Object.freeze({
            backendId: params.backend.id,
            selected: null,
            candidates: Object.freeze(candidates),
            conflictDiagnostic,
        });
    }

    return Object.freeze({
        backendId: params.backend.id,
        selected: legacyHostOwner ?? pluginOwner,
        candidates: Object.freeze(candidates),
    });
}
