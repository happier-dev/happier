import type { ResolvedExecutablePluginRuntimeRegistry } from '../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginCompatibilityDiagnostic } from '../../../plugins/validation/diagnostics/types';
import type {
    ResolvedAgentContribution,
    ResolvedAgentRuntimeContribution,
} from '../../../plugins/projection/registry/types';

import {
    type EngineResolutionDiagnostic,
} from './engineRegistryTypes';

function appendPluginDiagnostics(
    diagnostics: EngineResolutionDiagnostic[],
    backend: ResolvedAgentRuntimeContribution,
    agent: ResolvedAgentContribution,
    pluginDiagnostics: readonly PluginCompatibilityDiagnostic[],
): void {
    for (const diagnostic of pluginDiagnostics) {
        diagnostics.push({
            code: 'engine_plugin_registry_diagnostic',
            message: diagnostic.message,
            detailCode: diagnostic.code,
            backendId: backend.id,
            agentId: agent.id,
            pluginId: backend.pluginId,
        });
    }
}

/**
 * Projects registry diagnostics for an external Agent runtime.
 *
 * Executable surfaces are owned by the activated Agent runtime and materialized
 * through backendEngineSurfaceBindings. The retired manifest/static-handler
 * registry no longer contributes execution surfaces here.
 */
export async function resolvePluginBackendSurfaceHandlers(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    agent: ResolvedAgentContribution;
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry;
    hasRegisteredAgentRuntime?: boolean;
}>): Promise<Readonly<{
    diagnostics: readonly EngineResolutionDiagnostic[];
}>> {
    const { agent, backend, runtimeRegistry } = params;
    const diagnostics: EngineResolutionDiagnostic[] = [];
    if (backend.pluginId) {
        appendPluginDiagnostics(
            diagnostics,
            backend,
            agent,
            runtimeRegistry.pluginDiagnosticsByPluginId[backend.pluginId] ?? [],
        );
    }
    if (params.hasRegisteredAgentRuntime !== true) {
        diagnostics.push({
            code: 'engine_plugin_backend_surface_missing',
            message: `Backend '${backend.id}' has no registered Agent runtime`,
            backendId: backend.id,
            agentId: agent.id,
            pluginId: backend.pluginId,
        });
    }
    return {
        diagnostics: Object.freeze(diagnostics),
    };
}
