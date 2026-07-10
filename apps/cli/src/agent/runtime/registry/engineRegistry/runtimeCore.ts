import {
    readAcpBackendSpec,
    type AgentRuntimeV1,
    type CreateExecutionRunBackendParamsV1,
    type PluginContextV1,
    type RegisterAgentRuntimeV1,
} from '@happier-dev/plugin-sdk';
import type {
    ResolvedAgentContribution,
    ResolvedAgentRuntimeContribution,
} from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
    createAcpRuntimeCoreFromDefinition,
    normalizePluginAcpDefinition,
    normalizePluginBackendContributionAcpDefinition,
} from '@/agent/acp/runtime/definition';
import { createPublicPluginSessionRuntimePlan } from '@/plugins/runtime/runtimeCore/plugin/session';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import {
    type BackendExecutionSurfaces,
    type CliEngineAdapter,
    type CliRuntimeCore,
    type CliRuntimeCoreGetter,
} from '../engineRegistryTypes';
import { requireExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import { bindPluginContextToRuntimeCore } from './runtimeCoreBinding';
import { readPluginContextV1Binder } from './pluginContext/binder';
import { isRecord } from './pluginContext/values';
import type {
    BackendRuntimeOwnerResolution,
} from '../engineRegistryTypes';
import type { RuntimeRegistryBackendEngineEntry } from './runtimeOwnerResolution';

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

function resolveManifestOnlyAcpBackendAdapter(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    pluginContext: PluginContextV1;
}>): CliEngineAdapter | null {
    const richDefinition = params.backend.richDefinition;
    if (richDefinition?.provenance !== 'external') {
        return null;
    }
    if (!shouldNormalizeManifestOnlyAcpBackend(params.backend)) {
        return null;
    }

    try {
        const acpDefinition = normalizePluginBackendContributionAcpDefinition({
            pluginId: params.backend.pluginId,
            backend: richDefinition.definition,
        });
        const adapter = createAcpRuntimeCoreFromDefinition(acpDefinition, {
            pluginContext: params.pluginContext,
        });
        const binder = readPluginContextV1Binder(params.pluginContext);
        return {
            ...adapter,
            runtimeCore: bindPluginContextToRuntimeCore(adapter.runtimeCore, binder),
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid manifest-only ACP backend '${params.backend.id}' from plugin '${params.backend.pluginId ?? 'unknown'}': ${reason}`);
    }
}

export async function resolveBackendRuntimeCore(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    provider: ResolvedAgentContribution;
    executionSurfaces: BackendExecutionSurfaces;
    runtimeCoreGetter: CliRuntimeCoreGetter | null;
    runtimeOwner: BackendRuntimeOwnerResolution;
    engineEntry?: RuntimeRegistryBackendEngineEntry;
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
    pluginContext: PluginContextV1;
    pluginEngine?: AgentRuntimeV1 | null;
}>): Promise<CliEngineAdapter | null> {
    const selectedOwnerKind = params.runtimeOwner.selected?.kind ?? null;
    if (!selectedOwnerKind) {
        return null;
    }

    if (selectedOwnerKind === 'plugin_engine') {
        const runtimeRegistry = params.runtimeRegistry;
        const engineEntry = params.engineEntry;
        const registration = engineEntry?.registration as RegisterAgentRuntimeV1 | undefined;
        if (runtimeRegistry && registration) {
            const engine = params.pluginEngine ?? await registration.create(params.pluginContext);
            const acpSpec = readAcpBackendSpec(engine);
            if (acpSpec) {
                const acpDefinition = normalizePluginAcpDefinition({
                    pluginId: engineEntry?.pluginId,
                    spec: acpSpec,
                });
                const adapter = createAcpRuntimeCoreFromDefinition(acpDefinition, {
                    pluginContext: params.pluginContext,
                });
                const binder = readPluginContextV1Binder(params.pluginContext);
                return {
                    ...adapter,
                    runtimeCore: bindPluginContextToRuntimeCore(adapter.runtimeCore, binder),
                };
            }
            if (!engine.runtimeCore) {
                return null;
            }
            const binder = readPluginContextV1Binder(params.pluginContext);
            const rawRuntimeCore = engine.runtimeCore;
            const publicRuntimeCore: CliRuntimeCore = Object.freeze({
                async createSessionRuntime(sessionParams: unknown) {
                    return await createPublicPluginSessionRuntimePlan({
                        backend: params.backend,
                        provider: params.provider,
                        createSessionRuntime: async (runtimeParams) =>
                            await rawRuntimeCore.createSessionRuntime(runtimeParams),
                        sessionInput: buildPluginSessionBindingInput(sessionParams),
                    });
                },
                createExecutionRunBackend(opts) {
                    const runtime = rawRuntimeCore.createExecutionRunBackend(
                        opts as CreateExecutionRunBackendParamsV1,
                    );
                    return requireExecutionRunHostRuntime(
                        runtime,
                        `Execution-run plugin backend '${params.backend.id}' from plugin '${params.backend.pluginId ?? 'unknown'}' must implement ExecutionRunHostRuntime`,
                    );
                },
            });
            const wrappedRuntimeCore = bindPluginContextToRuntimeCore(publicRuntimeCore, binder);
            return {
                runtimeCore: wrappedRuntimeCore,
                facets: engine.facets ?? undefined,
                messageMeta: engine.messageMeta ?? undefined,
            };
        }

        const manifestOnlyAdapter = resolveManifestOnlyAcpBackendAdapter({
            backend: params.backend,
            pluginContext: params.pluginContext,
        });
        if (manifestOnlyAdapter) {
            return manifestOnlyAdapter;
        }

        if (params.backend.provenance === 'external' && params.runtimeCoreGetter) {
            const runtimeCoreFactory = await params.runtimeCoreGetter();
            return await runtimeCoreFactory({
                backend: params.backend,
                provider: params.provider,
                executionSurfaces: params.executionSurfaces,
            });
        }
        return null;
    }

    const getRuntimeCore = params.runtimeCoreGetter;
    if (!getRuntimeCore) {
        return null;
    }
    const runtimeCoreFactory = await getRuntimeCore();
    return await runtimeCoreFactory({
        backend: params.backend,
        provider: params.provider,
        executionSurfaces: params.executionSurfaces,
    });
}
