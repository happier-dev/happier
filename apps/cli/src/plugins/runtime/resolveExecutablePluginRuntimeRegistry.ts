import { readPluginReloadStateSnapshot } from './reload/state';
import { BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES } from '../projection/registry/sources/generatedBundledPlugins';
import type { PluginCompatibilityDiagnostic } from '../validation/diagnostics/types';
import { createResolvedContributionRegistry } from '../projection/registry/createResolvedContributionRegistry';
import { resolveMergedContributionRegistry } from '../projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from '../projection/registry/types';
import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';

import { activatePluginRuntimeRegistry } from './lifecycle/manager';
import { createBundledActivationSourceResolver } from './bundledActivationSource';
import {
    resolveTrustedOptionalPermissionGrantsFromServer,
    type ResolveTrustedOptionalPluginPermissionGrants,
} from './permissions/grants';
import { resolvePluginHookHandlerRegistry } from './resolvePluginHookHandlerRegistry';
import {
    activateScmProviderRuntimeEvents,
    createPluginScmBackendRegistryFromRuntimeRegistry,
} from '../../scm/pluginBackends/runtimeRegistry';
import type {
    PluginActionHandler,
    PluginHookHandler,
    ResolvedPluginHookHandler,
    ResolvedPluginHookHandlerRegistry,
} from './types';

export type ResolvedExecutablePluginRuntimeRegistry = Readonly<{
    // Includes internal merged contribution surfaces (`catalogEntry`,
    // runtime-adapter operation names declared by plugin manifests. The loaded
    // handler map is host-local even though the operation names are stable ABI.
    contributes: Awaited<ReturnType<typeof resolveMergedContributionRegistry>>;
    actionHandlersByActionId: ReadonlyMap<string, PluginActionHandler>;
    hookHandlersByHookId: ReadonlyMap<string, readonly ResolvedPluginHookHandler[]>;
    runtimeCoreHandlersByBackendId: ReadonlyMap<string, ReadonlyMap<string, PluginHookHandler>>;
    agentRuntimesByAgentId: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['agentRuntimesByAgentId'];
    daemonAuthBridgesByServiceId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['daemonAuthBridgesByServiceId'];
    notificationCategoriesById?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['notificationCategoriesById'];
    notificationChannelsById?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['notificationChannelsById'];
    scmHostingProvidersById: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['scmHostingProvidersById'];
    scmBackendsById?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['scmBackendsById'];
    scmBackendRegistrations?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['scmBackendRegistrations'];
    requestInterceptors?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['requestInterceptors'];
    mcpServers?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['mcpServers'];
    mcpDiscoveryProviders?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['mcpDiscoveryProviders'];
    networkAllowedPluginIds?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['networkAllowedPluginIds'];
    networkAllowedUrlOriginsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['networkAllowedUrlOriginsByPluginId'];
    processSpawnAllowedPathsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['processSpawnAllowedPathsByPluginId'];
    systemToolDefinitionsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['systemToolDefinitionsByPluginId'];
    envAllowedNamesByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['envAllowedNamesByPluginId'];
    filesystemReadAllowedPathsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['filesystemReadAllowedPathsByPluginId'];
    filesystemWriteAllowedPathsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['filesystemWriteAllowedPathsByPluginId'];
    permissionsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['permissionsByPluginId'];
    permissionDeclarationsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['permissionDeclarationsByPluginId'];
    requiredPermissionsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['requiredPermissionsByPluginId'];
    requiredPermissionDeclarationsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['requiredPermissionDeclarationsByPluginId'];
    optionalPermissionDeclarationsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['optionalPermissionDeclarationsByPluginId'];
    trustedOptionalPermissionsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['trustedOptionalPermissionsByPluginId'];
    trustedOptionalPermissionDeclarationsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['trustedOptionalPermissionDeclarationsByPluginId'];
    runtimeCapabilitiesByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['runtimeCapabilitiesByPluginId'];
    eventDeclarationsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['eventDeclarationsByPluginId'];
    eventSubscriptionPermissionsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['eventSubscriptionPermissionsByPluginId'];
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
    activatedPluginIds: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['activatedPluginIds'];
    activatePluginsByEvent: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['activatePluginsByEvent'];
    addRuntimeDisposable?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['addRuntimeDisposable'];
    readHookEventEnvelopeV1: typeof readHookEventEnvelopeV1;
    dispose: (params?: Readonly<{
        timeoutMs?: number;
        onError?: (event: Readonly<{
            pluginId: string;
            phase: 'deactivating' | 'runtime_disposables' | 'registered_disposables' | 'deactivated';
            error: unknown;
        }>) => void;
    }>) => Promise<void>;
}>;

function mergePluginDiagnostics(
    left: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>,
    right: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>,
): Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>> {
    const merged: Record<string, readonly PluginCompatibilityDiagnostic[]> = {};
    const pluginIds = new Set([
        ...Object.keys(left),
        ...Object.keys(right),
    ]);

    for (const pluginId of pluginIds) {
        merged[pluginId] = Object.freeze([
            ...(left[pluginId] ?? []),
            ...(right[pluginId] ?? []),
        ]);
    }

    return merged;
}

async function resolveRuntimeGeneration(happyHomeDir: string | undefined): Promise<number> {
    if (!happyHomeDir) {
        return 0;
    }
    const snapshot = await readPluginReloadStateSnapshot(happyHomeDir);
    return snapshot?.generation ?? 0;
}

function mergeActivatedContributes(
    base: ResolvedContributionRegistry,
    activated: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>,
): ResolvedContributionRegistry {
    const baseActionIds = new Set(base.actions.map((action) => action.definition.id));
    const activatedActions = activated.actions.filter((action) => !baseActionIds.has(action.definition.id));
    const baseToolIds = new Set((base.tools ?? []).map((tool) => tool.definition.id));
    const activatedTools = activated.tools.filter((tool) => !baseToolIds.has(tool.definition.id));
    const baseCommandIds = new Set((base.commands ?? []).map((command) => command.definition.id));
    const activatedCommands = activated.commands.filter((command) => !baseCommandIds.has(command.definition.id));
    const baseLifecycleHandlerIds = new Set((base.lifecycleHandlers ?? []).map((handler) => handler.definition.id));
    const activatedLifecycleHandlers = activated.lifecycleHandlers.filter((handler) => !baseLifecycleHandlerIds.has(handler.definition.id));

    if (
        activatedActions.length === 0
        && activatedTools.length === 0
        && activatedCommands.length === 0
        && activatedLifecycleHandlers.length === 0
    ) {
        return base;
    }

    return createResolvedContributionRegistry({
        agents: base.agents,
        agentRuntimes: base.agentRuntimes,
        actions: Object.freeze([
            ...base.actions,
            ...activatedActions,
        ]),
        tools: Object.freeze([
            ...(base.tools ?? []),
            ...activatedTools,
        ]),
        commands: Object.freeze([
            ...(base.commands ?? []),
            ...activatedCommands,
        ]),
        resources: base.resources,
        uiDescriptors: base.uiDescriptors,
        executionRunProfiles: base.executionRunProfiles,
        managedDependencies: base.managedDependencies,
        settings: base.settings,
        scmHostingProviders: base.scmHostingProviders,
        scmBackends: base.scmBackends,
        connectedAccountDescriptors: base.connectedAccountDescriptors,
        activationTargets: base.activationTargets,
        hookRegistrations: base.hookRegistrations,
        lifecycleHandlers: Object.freeze([
            ...(base.lifecycleHandlers ?? []),
            ...activatedLifecycleHandlers,
        ]),
        pluginDiagnosticsByPluginId: base.pluginDiagnosticsByPluginId,
    });
}

export async function resolveExecutablePluginRuntimeRegistry(
    params?: Readonly<{
        happyHomeDir?: string;
        contributes?: ResolvedContributionRegistry;
        generation?: number;
        pluginIds?: readonly string[];
        resolveTrustedOptionalPermissionGrants?: ResolveTrustedOptionalPluginPermissionGrants;
    }>,
): Promise<ResolvedExecutablePluginRuntimeRegistry> {
    const generation = params?.generation ?? await resolveRuntimeGeneration(params?.happyHomeDir);
    const contributes = params?.contributes
        ?? await resolveMergedContributionRegistry({
            happyHomeDir: params?.happyHomeDir,
        });
    const hookHandlerRegistry: ResolvedPluginHookHandlerRegistry = await resolvePluginHookHandlerRegistry({
        registry: contributes,
        generation,
        pluginIds: params?.pluginIds,
    });
    const resolveBundledActivationSource = createBundledActivationSourceResolver({
        bundledPackageNames: BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES,
    });
    const activatedRegistry = await activatePluginRuntimeRegistry({
        contributes,
        generation,
        happyHomeDir: params?.happyHomeDir,
        pluginIds: params?.pluginIds,
        resolveActivationSource: resolveBundledActivationSource,
        resolveTrustedOptionalPermissionGrants: params?.resolveTrustedOptionalPermissionGrants
            ?? resolveTrustedOptionalPermissionGrantsFromServer,
    });
    const authoritativeContributes = mergeActivatedContributes(contributes, activatedRegistry);
    // Event-gated SCM plugins (scm-git, scm-sapling, ...) declare
    // `activationEvents: ['onScmProvider:<id>']` instead of `startup`, so
    // `activatedRegistry` has no registration for them yet at this point.
    // Fire their activation event first — via the SAME canonical helper the
    // SCM catalog path uses — so `scmBackendsById`/`scmBackendRegistrations`
    // (mutated in place by activation) are populated before diagnostics are
    // computed below. Without this, every caller of this function (including
    // the Settings→Plugins projection) would see a false
    // `plugin_scm_backend_missing_activation` for correctly-wired,
    // not-yet-activated SCM plugins.
    await activateScmProviderRuntimeEvents({
        contributes: authoritativeContributes,
        activatePluginsByEvent: activatedRegistry.activatePluginsByEvent,
    });
    const scmBackendRegistry = createPluginScmBackendRegistryFromRuntimeRegistry({
        contributes: authoritativeContributes,
        scmBackendsById: activatedRegistry.scmBackendsById,
        scmBackendRegistrations: activatedRegistry.scmBackendRegistrations,
    });
    const hookHandlersByHookId = new Map<string, readonly ResolvedPluginHookHandler[]>();
    for (const [hookId, handlers] of hookHandlerRegistry.handlersByHookId.entries()) {
        hookHandlersByHookId.set(hookId, handlers);
    }
    for (const [hookId, handlers] of activatedRegistry.hookHandlersByHookId.entries()) {
        const existing = hookHandlersByHookId.get(hookId) ?? [];
        hookHandlersByHookId.set(
            hookId,
            Object.freeze([...existing, ...handlers].sort((left, right) => (
                left.priority - right.priority
                || left.pluginId.localeCompare(right.pluginId)
                || left.registrationIndex - right.registrationIndex
                || left.manifestPath.localeCompare(right.manifestPath)
                || left.exportName.localeCompare(right.exportName)
                || left.daemonEntryPath.localeCompare(right.daemonEntryPath)
            ))),
        );
    }
    const pluginDiagnosticsByPluginId: Record<string, readonly PluginCompatibilityDiagnostic[]> = {
        ...mergePluginDiagnostics(
            mergePluginDiagnostics(
                mergePluginDiagnostics(
                    authoritativeContributes.pluginDiagnosticsByPluginId,
                    hookHandlerRegistry.diagnosticsByPluginId,
                ),
                scmBackendRegistry.diagnosticsByPluginId,
            ),
            activatedRegistry.pluginDiagnosticsByPluginId,
        ),
    };

    function mergeActivatedHookHandlers(): void {
        for (const [hookId, handlers] of activatedRegistry.hookHandlersByHookId.entries()) {
            const staticHandlers = hookHandlerRegistry.handlersByHookId.get(hookId) ?? [];
            hookHandlersByHookId.set(
                hookId,
                Object.freeze([...staticHandlers, ...handlers].sort((left, right) => (
                    left.priority - right.priority
                    || left.pluginId.localeCompare(right.pluginId)
                    || left.registrationIndex - right.registrationIndex
                    || left.manifestPath.localeCompare(right.manifestPath)
                    || left.exportName.localeCompare(right.exportName)
                    || left.daemonEntryPath.localeCompare(right.daemonEntryPath)
                ))),
            );
        }
    }

    async function activatePluginsByEvent(activationEvent: string): Promise<Awaited<ReturnType<typeof activatedRegistry.activatePluginsByEvent>>> {
        const results = await activatedRegistry.activatePluginsByEvent(activationEvent);
        mergeActivatedHookHandlers();
        for (const result of results) {
            pluginDiagnosticsByPluginId[result.pluginId] = Object.freeze([
                ...(authoritativeContributes.pluginDiagnosticsByPluginId[result.pluginId] ?? []),
                ...(hookHandlerRegistry.diagnosticsByPluginId[result.pluginId] ?? []),
                ...(scmBackendRegistry.diagnosticsByPluginId[result.pluginId] ?? []),
                ...result.diagnostics,
            ]);
        }
        return results;
    }

    return {
        contributes: authoritativeContributes,
        actionHandlersByActionId: activatedRegistry.actionHandlersByActionId,
        hookHandlersByHookId,
        runtimeCoreHandlersByBackendId: activatedRegistry.runtimeCoreHandlersByBackendId,
        agentRuntimesByAgentId: activatedRegistry.agentRuntimesByAgentId ?? new Map(),
        daemonAuthBridgesByServiceId: activatedRegistry.daemonAuthBridgesByServiceId ?? new Map(),
        notificationCategoriesById: activatedRegistry.notificationCategoriesById,
        notificationChannelsById: activatedRegistry.notificationChannelsById,
        scmHostingProvidersById: activatedRegistry.scmHostingProvidersById,
        scmBackendsById: activatedRegistry.scmBackendsById,
        scmBackendRegistrations: activatedRegistry.scmBackendRegistrations,
        requestInterceptors: activatedRegistry.requestInterceptors,
        mcpServers: activatedRegistry.mcpServers,
        mcpDiscoveryProviders: activatedRegistry.mcpDiscoveryProviders,
        networkAllowedPluginIds: activatedRegistry.networkAllowedPluginIds,
        networkAllowedUrlOriginsByPluginId: activatedRegistry.networkAllowedUrlOriginsByPluginId,
        processSpawnAllowedPathsByPluginId: activatedRegistry.processSpawnAllowedPathsByPluginId,
        systemToolDefinitionsByPluginId: activatedRegistry.systemToolDefinitionsByPluginId,
        envAllowedNamesByPluginId: activatedRegistry.envAllowedNamesByPluginId,
        filesystemReadAllowedPathsByPluginId: activatedRegistry.filesystemReadAllowedPathsByPluginId,
        filesystemWriteAllowedPathsByPluginId: activatedRegistry.filesystemWriteAllowedPathsByPluginId,
        permissionsByPluginId: activatedRegistry.permissionsByPluginId,
        permissionDeclarationsByPluginId: activatedRegistry.permissionDeclarationsByPluginId,
        requiredPermissionsByPluginId: activatedRegistry.requiredPermissionsByPluginId,
        requiredPermissionDeclarationsByPluginId: activatedRegistry.requiredPermissionDeclarationsByPluginId,
        optionalPermissionDeclarationsByPluginId: activatedRegistry.optionalPermissionDeclarationsByPluginId,
        trustedOptionalPermissionsByPluginId: activatedRegistry.trustedOptionalPermissionsByPluginId,
        trustedOptionalPermissionDeclarationsByPluginId: activatedRegistry.trustedOptionalPermissionDeclarationsByPluginId,
        runtimeCapabilitiesByPluginId: activatedRegistry.runtimeCapabilitiesByPluginId,
        eventDeclarationsByPluginId: activatedRegistry.eventDeclarationsByPluginId,
        eventSubscriptionPermissionsByPluginId: activatedRegistry.eventSubscriptionPermissionsByPluginId,
        pluginDiagnosticsByPluginId,
        activatedPluginIds: activatedRegistry.activatedPluginIds,
        activatePluginsByEvent,
        addRuntimeDisposable: activatedRegistry.addRuntimeDisposable,
        readHookEventEnvelopeV1,
        dispose: activatedRegistry.dispose,
    };
}
