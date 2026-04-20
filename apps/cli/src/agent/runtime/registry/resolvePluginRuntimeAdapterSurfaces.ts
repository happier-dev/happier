import { loadPluginDaemonModule } from '../../../extensions/runtime/loadPluginDaemonModule';
import type { ResolvedExecutablePluginRuntimeRegistry } from '../../../extensions/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginDaemonModuleNamespace, PluginHookHandler } from '../../../extensions/runtime/types';
import type { PluginCompatibilityDiagnostic } from '../../../extensions/diagnostics/types';
import { buildBackendRuntimeAdapterDispatchKey } from '../../../extensions/manifest/adapters';
import type {
    AnyTerminalRuntimeOps,
    DirectSessionProviderOps,
    ProviderAttachOps,
    SessionHandoffProviderOps,
} from '../../../backends/types';
import type {
    ResolvedBackendContribution,
    ResolvedBackendRuntimeAdapterContribution,
    ResolvedProviderContribution,
} from '../../../extensions/registry/types';
import type { BackendRuntimeAdapterV1 } from '@happier-dev/protocol';
import { BackendRuntimeAdapterOperationCatalogV1 as BACKEND_RUNTIME_ADAPTER_OPERATION_CATALOG_V1 } from '@happier-dev/protocol';

import {
    createEmptyBackendExecutionSurfaces,
    type BackendExecutionSurfaces,
    type EngineResolutionDiagnostic,
} from './engineRegistryTypes';

function appendPluginDiagnostics(
    diagnostics: EngineResolutionDiagnostic[],
    backend: ResolvedBackendContribution,
    provider: ResolvedProviderContribution,
    pluginDiagnostics: readonly PluginCompatibilityDiagnostic[],
): void {
    for (const diagnostic of pluginDiagnostics) {
        diagnostics.push({
            code: 'engine_plugin_registry_diagnostic',
            message: diagnostic.message,
            detailCode: diagnostic.code,
            backendId: backend.id,
            providerId: provider.id,
            pluginId: backend.pluginId,
        });
    }
}

function resolvePluginRuntimeAdapterHandlerExport(
    moduleNamespace: PluginDaemonModuleNamespace,
    exportName?: string,
): Readonly<
    | { status: 'found'; handler: PluginHookHandler }
    | { status: 'missing' }
    | { status: 'invalid' }
> {
    if (exportName) {
        const directExport = moduleNamespace[exportName];
        if (typeof directExport === 'function') {
            return { status: 'found', handler: directExport as PluginHookHandler };
        }
        if (directExport !== undefined) {
            return { status: 'invalid' };
        }

        const defaultExport = moduleNamespace.default;
        if (defaultExport && typeof defaultExport === 'object') {
            const nestedExport = (defaultExport as Record<string, unknown>)[exportName];
            if (typeof nestedExport === 'function') {
                return { status: 'found', handler: nestedExport as PluginHookHandler };
            }
            if (nestedExport !== undefined) {
                return { status: 'invalid' };
            }
        }
        return { status: 'missing' };
    }

    if (typeof moduleNamespace.default === 'function') {
        return { status: 'found', handler: moduleNamespace.default as PluginHookHandler };
    }

    return moduleNamespace.default === undefined ? { status: 'missing' } : { status: 'invalid' };
}

function resolveBackendExecutionSurfacesFromHandlers(
    handlerByAdapterId: ReadonlyMap<string, PluginHookHandler>,
): BackendExecutionSurfaces {
    const terminalRuntime = resolveTerminalRuntimeOps(handlerByAdapterId);
    const directSessions = resolveDirectSessionProviderOps(handlerByAdapterId);
    const attach = resolveProviderAttachOps(handlerByAdapterId);
    const sessionHandoff = resolveSessionHandoffProviderOps(handlerByAdapterId);

    return {
        terminalRuntime,
        directSessions,
        attach,
        sessionHandoff,
    };
}

function readRuntimeAdapterHandler(
    handlerByAdapterId: ReadonlyMap<string, PluginHookHandler>,
    kind: BackendRuntimeAdapterV1['kind'],
    operation: BackendRuntimeAdapterV1['operation'],
): PluginHookHandler | undefined {
    return handlerByAdapterId.get(buildBackendRuntimeAdapterDispatchKey({
        kind,
        operation,
    }));
}

function resolveRuntimeAdapterDefinition(
    runtimeAdapter: ResolvedBackendRuntimeAdapterContribution,
): BackendRuntimeAdapterV1 {
    return runtimeAdapter.definition;
}

function resolveTerminalRuntimeOps(
    handlerByAdapterId: ReadonlyMap<string, PluginHookHandler>,
): AnyTerminalRuntimeOps | null {
    const launch = readRuntimeAdapterHandler(
        handlerByAdapterId,
        'terminalRuntime',
        BACKEND_RUNTIME_ADAPTER_OPERATION_CATALOG_V1.terminalRuntime.launch,
    );
    const discoverIdentity = readRuntimeAdapterHandler(
        handlerByAdapterId,
        'terminalRuntime',
        BACKEND_RUNTIME_ADAPTER_OPERATION_CATALOG_V1.terminalRuntime.discoverIdentity,
    );
    const bindTranscript = readRuntimeAdapterHandler(
        handlerByAdapterId,
        'terminalRuntime',
        BACKEND_RUNTIME_ADAPTER_OPERATION_CATALOG_V1.terminalRuntime.bindTranscript,
    );

    if (!launch && !discoverIdentity && !bindTranscript) {
        return null;
    }

    return {
        ...(launch
            ? {
                launch: launch as AnyTerminalRuntimeOps['launch'],
            }
            : {}),
        ...(discoverIdentity
            ? {
                discoverIdentity: discoverIdentity as AnyTerminalRuntimeOps['discoverIdentity'],
            }
            : {}),
        ...(bindTranscript
            ? {
                bindTranscript: bindTranscript as AnyTerminalRuntimeOps['bindTranscript'],
            }
            : {}),
    };
}

function resolveDirectSessionProviderOps(
    handlerByAdapterId: ReadonlyMap<string, PluginHookHandler>,
): DirectSessionProviderOps | null {
    const validateSource = readRuntimeAdapterHandler(
        handlerByAdapterId,
        'directSessions',
        BACKEND_RUNTIME_ADAPTER_OPERATION_CATALOG_V1.directSessions.validateSource,
    );
    const listCandidates = readRuntimeAdapterHandler(
        handlerByAdapterId,
        'directSessions',
        BACKEND_RUNTIME_ADAPTER_OPERATION_CATALOG_V1.directSessions.listCandidates,
    );
    const getActivity = readRuntimeAdapterHandler(
        handlerByAdapterId,
        'directSessions',
        BACKEND_RUNTIME_ADAPTER_OPERATION_CATALOG_V1.directSessions.getActivity,
    );
    const pageTranscript = readRuntimeAdapterHandler(
        handlerByAdapterId,
        'directSessions',
        BACKEND_RUNTIME_ADAPTER_OPERATION_CATALOG_V1.directSessions.pageTranscript,
    );
    const readAfterTranscript = readRuntimeAdapterHandler(
        handlerByAdapterId,
        'directSessions',
        BACKEND_RUNTIME_ADAPTER_OPERATION_CATALOG_V1.directSessions.readAfterTranscript,
    );
    const resolveTakeoverSpawnOptions = readRuntimeAdapterHandler(
        handlerByAdapterId,
        'directSessions',
        BACKEND_RUNTIME_ADAPTER_OPERATION_CATALOG_V1.directSessions.resolveTakeoverSpawnOptions,
    );

    if (
        !validateSource
        || !listCandidates
        || !getActivity
        || !pageTranscript
        || !readAfterTranscript
        || !resolveTakeoverSpawnOptions
    ) {
        return null;
    }

    const acquireFollowLease = readRuntimeAdapterHandler(
        handlerByAdapterId,
        'directSessions',
        BACKEND_RUNTIME_ADAPTER_OPERATION_CATALOG_V1.directSessions.acquireFollowLease,
    );
    const canonicalizeLinkedSession = readRuntimeAdapterHandler(
        handlerByAdapterId,
        'directSessions',
        BACKEND_RUNTIME_ADAPTER_OPERATION_CATALOG_V1.directSessions.canonicalizeLinkedSession,
    );
    const resolveLinkIdentity = readRuntimeAdapterHandler(
        handlerByAdapterId,
        'directSessions',
        BACKEND_RUNTIME_ADAPTER_OPERATION_CATALOG_V1.directSessions.resolveLinkIdentity,
    );

    return {
        validateSource: validateSource as DirectSessionProviderOps['validateSource'],
        listCandidates: listCandidates as DirectSessionProviderOps['listCandidates'],
        getActivity: getActivity as DirectSessionProviderOps['getActivity'],
        pageTranscript: pageTranscript as DirectSessionProviderOps['pageTranscript'],
        readAfterTranscript: readAfterTranscript as DirectSessionProviderOps['readAfterTranscript'],
        resolveTakeoverSpawnOptions: resolveTakeoverSpawnOptions as DirectSessionProviderOps['resolveTakeoverSpawnOptions'],
        ...(acquireFollowLease
            ? {
                acquireFollowLease: acquireFollowLease as DirectSessionProviderOps['acquireFollowLease'],
            }
            : {}),
        ...(canonicalizeLinkedSession
            ? {
                canonicalizeLinkedSession: canonicalizeLinkedSession as DirectSessionProviderOps['canonicalizeLinkedSession'],
            }
            : {}),
        ...(resolveLinkIdentity
            ? {
                resolveLinkIdentity: resolveLinkIdentity as DirectSessionProviderOps['resolveLinkIdentity'],
            }
            : {}),
    };
}

function resolveProviderAttachOps(
    handlerByAdapterId: ReadonlyMap<string, PluginHookHandler>,
): ProviderAttachOps | null {
    const evaluateEligibility = readRuntimeAdapterHandler(
        handlerByAdapterId,
        'attach',
        BACKEND_RUNTIME_ADAPTER_OPERATION_CATALOG_V1.attach.evaluateEligibility,
    );
    const probeReachability = readRuntimeAdapterHandler(
        handlerByAdapterId,
        'attach',
        BACKEND_RUNTIME_ADAPTER_OPERATION_CATALOG_V1.attach.probeReachability,
    );
    const runAttach = readRuntimeAdapterHandler(
        handlerByAdapterId,
        'attach',
        BACKEND_RUNTIME_ADAPTER_OPERATION_CATALOG_V1.attach.run,
    );

    if (!evaluateEligibility || !runAttach) {
        return null;
    }

    return {
        evaluateEligibility: evaluateEligibility as ProviderAttachOps['evaluateEligibility'],
        ...(probeReachability
            ? {
                probeReachability: probeReachability as ProviderAttachOps['probeReachability'],
            }
            : {}),
        runAttach: runAttach as ProviderAttachOps['runAttach'],
    };
}

function resolveSessionHandoffProviderOps(
    handlerByAdapterId: ReadonlyMap<string, PluginHookHandler>,
): SessionHandoffProviderOps | null {
    const exportBundle = readRuntimeAdapterHandler(
        handlerByAdapterId,
        'sessionHandoff',
        BACKEND_RUNTIME_ADAPTER_OPERATION_CATALOG_V1.sessionHandoff.exportBundle,
    );
    const importBundle = readRuntimeAdapterHandler(
        handlerByAdapterId,
        'sessionHandoff',
        BACKEND_RUNTIME_ADAPTER_OPERATION_CATALOG_V1.sessionHandoff.importBundle,
    );

    if (!exportBundle || !importBundle) {
        return null;
    }

    return {
        exportBundle: exportBundle as SessionHandoffProviderOps['exportBundle'],
        importBundle: importBundle as SessionHandoffProviderOps['importBundle'],
    };
}

export async function resolvePluginRuntimeAdapterSurfaces(params: Readonly<{
    backend: ResolvedBackendContribution;
    provider: ResolvedProviderContribution;
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry;
}>): Promise<Readonly<{
    surfaces: BackendExecutionSurfaces;
    diagnostics: readonly EngineResolutionDiagnostic[];
}>> {
    const { backend, provider, runtimeRegistry } = params;
    const diagnostics: EngineResolutionDiagnostic[] = [];
    if (backend.pluginId) {
        appendPluginDiagnostics(
            diagnostics,
            backend,
            provider,
            runtimeRegistry.pluginDiagnosticsByPluginId[backend.pluginId] ?? [],
        );
    }

    const runtimeAdapters = runtimeRegistry.contributions.runtimeAdaptersByBackendId.get(backend.id) ?? [];
    const activatedHandlers = runtimeRegistry.runtimeAdapterHandlersByBackendId.get(backend.id);

    const handlerByAdapterId = new Map<string, PluginHookHandler>();
    if (activatedHandlers && activatedHandlers.size > 0) {
        for (const [adapterId, handler] of activatedHandlers.entries()) {
            handlerByAdapterId.set(adapterId, handler);
        }
    }

    if (runtimeAdapters.length > 0) {
        if (!backend.daemonEntryPath) {
            diagnostics.push({
                code: 'engine_plugin_daemon_entry_missing',
                message: `Backend '${backend.id}' has no daemon entry path`,
                backendId: backend.id,
                providerId: provider.id,
                pluginId: backend.pluginId,
            });
        } else if (runtimeAdapters.some((runtimeAdapter) => resolveRuntimeAdapterDefinition(runtimeAdapter).handler.target !== 'daemon')) {
            diagnostics.push({
                code: 'engine_plugin_runtime_adapter_non_daemon_target',
                message: `Backend '${backend.id}' runtime adapters must target daemon handlers only`,
                backendId: backend.id,
                providerId: provider.id,
                pluginId: backend.pluginId,
            });
        } else {
            const missingRuntimeAdapters = runtimeAdapters.filter((runtimeAdapter) => {
                const runtimeAdapterDefinition = resolveRuntimeAdapterDefinition(runtimeAdapter);
                return !handlerByAdapterId.has(buildBackendRuntimeAdapterDispatchKey({
                    kind: runtimeAdapterDefinition.kind,
                    operation: runtimeAdapterDefinition.operation,
                }));
            });
            if (missingRuntimeAdapters.length === 0) {
                const surfaces = resolveBackendExecutionSurfacesFromHandlers(handlerByAdapterId);
                return {
                    surfaces,
                    diagnostics: Object.freeze(diagnostics),
                };
            }

            let moduleNamespace: PluginDaemonModuleNamespace | null = null;
            try {
                moduleNamespace = await loadPluginDaemonModule({
                    daemonEntryPath: backend.daemonEntryPath,
                    cacheKey: backend.manifestDigest,
                    trustPolicy: backend.sourceSpec?.trustPolicy,
                });
            } catch (error) {
                const errorCode = error instanceof Error ? String((error as Error & { code?: string }).code ?? '') : '';
                diagnostics.push({
                    code: 'engine_plugin_daemon_module_load_failed',
                    message: error instanceof Error ? error.message : `Failed to load daemon module for backend '${backend.id}'`,
                    backendId: backend.id,
                    providerId: provider.id,
                    pluginId: backend.pluginId,
                    detailCode:
                        errorCode === 'PLUGIN_DAEMON_TRUST_APPROVAL_REQUIRED'
                            ? 'plugin_trust_approval_required'
                            : errorCode === 'PLUGIN_DAEMON_TRUST_UNTRUSTED'
                                ? 'plugin_untrusted'
                                : undefined,
                });
            }

            if (moduleNamespace) {
                for (const runtimeAdapter of missingRuntimeAdapters) {
                    const runtimeAdapterDefinition = resolveRuntimeAdapterDefinition(runtimeAdapter);
                    const resolvedExport = resolvePluginRuntimeAdapterHandlerExport(
                        moduleNamespace,
                        runtimeAdapterDefinition.handler.exportName,
                    );
                    if (resolvedExport.status === 'found') {
                        handlerByAdapterId.set(buildBackendRuntimeAdapterDispatchKey({
                            kind: runtimeAdapterDefinition.kind,
                            operation: runtimeAdapterDefinition.operation,
                        }), resolvedExport.handler);
                        continue;
                    }
                    diagnostics.push({
                        code: resolvedExport.status === 'missing'
                            ? 'engine_plugin_runtime_adapter_handler_missing'
                            : 'engine_plugin_runtime_adapter_handler_invalid',
                        message: `Backend '${backend.id}' runtime adapter '${runtimeAdapterDefinition.id}' (${runtimeAdapterDefinition.kind}:${runtimeAdapterDefinition.operation}) export '${runtimeAdapterDefinition.handler.exportName ?? 'default'}' ${resolvedExport.status}`,
                        backendId: backend.id,
                        providerId: provider.id,
                        pluginId: backend.pluginId,
                    });
                }
            }
        }
    }

    if (handlerByAdapterId.size === 0) {
        if (runtimeAdapters.length === 0 && (!activatedHandlers || activatedHandlers.size === 0)) {
            diagnostics.push({
                code: 'engine_plugin_runtime_adapter_missing',
                message: `Backend '${backend.id}' has no runtime adapters`,
                backendId: backend.id,
                providerId: provider.id,
                pluginId: backend.pluginId,
            });
        }
        return {
            surfaces: createEmptyBackendExecutionSurfaces(),
            diagnostics: Object.freeze(diagnostics),
        };
    }

    const surfaces = resolveBackendExecutionSurfacesFromHandlers(handlerByAdapterId);
    return {
        surfaces,
        diagnostics: Object.freeze(diagnostics),
    };
}
