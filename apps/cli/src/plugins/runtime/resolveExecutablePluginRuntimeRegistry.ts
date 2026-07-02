import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readPluginReloadStateSnapshot } from './reload/state';
import { BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES } from '../projection/registry/sources/generatedBundledPlugins';
import type { PluginCompatibilityDiagnostic } from '../validation/diagnostics/types';
import { createResolvedContributionRegistry } from '../projection/registry/createResolvedContributionRegistry';
import { resolveMergedContributionRegistry } from '../projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from '../projection/registry/types';
import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';

import { activatePluginRuntimeRegistry } from './lifecycle/manager';
import {
    resolveTrustedOptionalPermissionGrantsFromServer,
    type ResolveTrustedOptionalPluginPermissionGrants,
} from './permissions/grants';
import { resolvePluginHookHandlerRegistry } from './resolvePluginHookHandlerRegistry';
import { createPluginScmBackendRegistryFromRuntimeRegistry } from '../../scm/scmBackendCatalog';
import type {
    PluginActionHandler,
    PluginHookHandler,
    ResolvedPluginHookHandler,
    ResolvedPluginHookHandlerRegistry,
    PluginDaemonModuleNamespace,
} from './types';

export type ResolvedExecutablePluginRuntimeRegistry = Readonly<{
    // Includes internal merged contribution surfaces (`catalogEntry`,
    // runtime-adapter operation names declared by plugin manifests. The loaded
    // handler map is host-local even though the operation names are stable ABI.
    contributes: Awaited<ReturnType<typeof resolveMergedContributionRegistry>>;
    actionHandlersByActionId: ReadonlyMap<string, PluginActionHandler>;
    hookHandlersByHookId: ReadonlyMap<string, readonly ResolvedPluginHookHandler[]>;
    runtimeCoreHandlersByBackendId: ReadonlyMap<string, ReadonlyMap<string, PluginHookHandler>>;
    backendEnginesByBackendId: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['backendEnginesByBackendId'];
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
    addRuntimeDisposable?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['addRuntimeDisposable'];
    readHookEventEnvelopeV1: typeof readHookEventEnvelopeV1;
    dispose: () => Promise<void>;
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

    return Object.freeze(merged);
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
    const baseLifecycleHandlerIds = new Set((base.lifecycleHandlers ?? []).map((handler) => handler.definition.id));
    const activatedLifecycleHandlers = activated.lifecycleHandlers.filter((handler) => !baseLifecycleHandlerIds.has(handler.definition.id));

    if (
        activatedActions.length === 0
        && activated.tools.length === 0
        && activated.commands.length === 0
        && activatedLifecycleHandlers.length === 0
    ) {
        return base;
    }

    return createResolvedContributionRegistry({
        providers: base.providers,
        backends: base.backends,
        actions: Object.freeze([
            ...base.actions,
            ...activatedActions,
        ]),
        tools: Object.freeze([
            ...(base.tools ?? []),
            ...activated.tools,
        ]),
        commands: Object.freeze([
            ...(base.commands ?? []),
            ...activated.commands,
        ]),
        resources: base.resources,
        uiDescriptors: base.uiDescriptors,
        executionRunProfiles: base.executionRunProfiles,
        installables: base.installables,
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

function parseFirstPartyPluginIdFromPackageName(packageName: string): string | null {
    const prefix = '@happier-dev/plugins-';
    if (!packageName.startsWith(prefix)) {
        return null;
    }
    const pluginId = packageName.slice(prefix.length).trim();
    if (!pluginId) {
        return null;
    }
    return pluginId;
}

async function loadBundledFirstPartyPluginDaemonModule(packageName: string): Promise<PluginDaemonModuleNamespace> {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRootCandidate = resolve(here, '..', '..', '..', '..', '..');
    const pluginId = parseFirstPartyPluginIdFromPackageName(packageName);
    if (pluginId) {
        const distCandidate = resolve(repoRootCandidate, 'packages', 'plugins', pluginId, 'dist', 'index.js');
        const srcCandidate = resolve(repoRootCandidate, 'packages', 'plugins', pluginId, 'src', 'index.ts');

        if (existsSync(srcCandidate)) {
            // Dev/test local plugins must share the host's TS module graph; dist can carry a second SDK runtime context.
            return await import(pathToFileURL(srcCandidate).href) as PluginDaemonModuleNamespace;
        }
        if (existsSync(distCandidate)) {
            return await import(pathToFileURL(distCandidate).href) as PluginDaemonModuleNamespace;
        }
    }

    return await import(packageName) as PluginDaemonModuleNamespace;
}

function resolveBundledActivationSource(target: Readonly<{ pluginId: string; daemonEntryPath: string }>) {
    if (BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES.includes(target.daemonEntryPath)) {
        return {
            kind: 'bundled' as const,
            moduleId: target.daemonEntryPath,
            load: async () => await loadBundledFirstPartyPluginDaemonModule(target.daemonEntryPath),
        };
    }
    return null;
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
    });
    const activatedRegistry = await activatePluginRuntimeRegistry({
        contributes,
        generation,
        pluginIds: params?.pluginIds,
        resolveActivationSource: resolveBundledActivationSource,
        resolveTrustedOptionalPermissionGrants: params?.resolveTrustedOptionalPermissionGrants
            ?? resolveTrustedOptionalPermissionGrantsFromServer,
    });
    const authoritativeContributes = mergeActivatedContributes(contributes, activatedRegistry);
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
                right.priority - left.priority
                || left.pluginId.localeCompare(right.pluginId)
                || left.registrationIndex - right.registrationIndex
                || left.manifestPath.localeCompare(right.manifestPath)
                || left.exportName.localeCompare(right.exportName)
                || left.daemonEntryPath.localeCompare(right.daemonEntryPath)
            ))),
        );
    }

    return {
        contributes: authoritativeContributes,
        actionHandlersByActionId: activatedRegistry.actionHandlersByActionId,
        hookHandlersByHookId,
        runtimeCoreHandlersByBackendId: activatedRegistry.runtimeCoreHandlersByBackendId,
        backendEnginesByBackendId: activatedRegistry.backendEnginesByBackendId ?? new Map(),
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
        pluginDiagnosticsByPluginId: mergePluginDiagnostics(
            mergePluginDiagnostics(
                mergePluginDiagnostics(
                    authoritativeContributes.pluginDiagnosticsByPluginId,
                    hookHandlerRegistry.diagnosticsByPluginId,
                ),
                scmBackendRegistry.diagnosticsByPluginId,
            ),
            activatedRegistry.pluginDiagnosticsByPluginId,
        ),
        addRuntimeDisposable: activatedRegistry.addRuntimeDisposable,
        readHookEventEnvelopeV1,
        dispose: activatedRegistry.dispose,
    };
}
