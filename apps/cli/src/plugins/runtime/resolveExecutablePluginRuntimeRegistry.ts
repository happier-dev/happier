import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readPluginReloadStateSnapshot } from '@/plugins/runtime/reload/state';
import { BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES } from '@/plugins/projection/registry/sources/generatedBundledPlugins';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';

import { activatePluginRuntimeRegistry } from './lifecycle/manager';
import { resolvePluginHookHandlerRegistry } from './resolvePluginHookHandlerRegistry';
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
    requestInterceptors?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['requestInterceptors'];
    networkAllowedPluginIds?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['networkAllowedPluginIds'];
    eventSubscriptionPermissionsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['eventSubscriptionPermissionsByPluginId'];
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
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
    if (
        activated.actions.length === 0
        && activated.tools.length === 0
        && activated.commands.length === 0
        && activated.resources.length === 0
        && activated.uiDescriptors.length === 0
        && activated.lifecycleHandlers.length === 0
    ) {
        return base;
    }

    return createResolvedContributionRegistry({
        providers: base.providers,
        backends: base.backends,
        actions: Object.freeze([
            ...base.actions,
            ...activated.actions,
        ]),
        tools: Object.freeze([
            ...(base.tools ?? []),
            ...activated.tools,
        ]),
        commands: Object.freeze([
            ...(base.commands ?? []),
            ...activated.commands,
        ]),
        resources: Object.freeze([
            ...base.resources,
            ...activated.resources,
        ]),
        uiDescriptors: Object.freeze([
            ...base.uiDescriptors,
            ...activated.uiDescriptors,
        ]),
        settings: base.settings,
        scmHostingProviders: base.scmHostingProviders,
        activationTargets: base.activationTargets,
        hookRegistrations: base.hookRegistrations,
        lifecycleHandlers: Object.freeze([
            ...(base.lifecycleHandlers ?? []),
            ...activated.lifecycleHandlers,
        ]),
        pluginDiagnosticsByPluginId: base.pluginDiagnosticsByPluginId,
    });
}

const bundledFirstPartyPackageNames = new Set(BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES);

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

        if (existsSync(distCandidate)) {
            return await import(pathToFileURL(distCandidate).href) as PluginDaemonModuleNamespace;
        }
        if (existsSync(srcCandidate)) {
            // Dev-mode fallback so unit tests and local execution can run before plugin build outputs exist.
            return await import(pathToFileURL(srcCandidate).href) as PluginDaemonModuleNamespace;
        }
    }

    return await import(packageName) as PluginDaemonModuleNamespace;
}

function resolveBundledActivationSource(target: Readonly<{ pluginId: string; daemonEntryPath: string }>) {
    if (bundledFirstPartyPackageNames.has(target.daemonEntryPath)) {
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
        resolveActivationSource: resolveBundledActivationSource,
    });
    const authoritativeContributes = mergeActivatedContributes(contributes, activatedRegistry);
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
        requestInterceptors: activatedRegistry.requestInterceptors,
        networkAllowedPluginIds: activatedRegistry.networkAllowedPluginIds,
        eventSubscriptionPermissionsByPluginId: activatedRegistry.eventSubscriptionPermissionsByPluginId,
        pluginDiagnosticsByPluginId: mergePluginDiagnostics(
            mergePluginDiagnostics(
                authoritativeContributes.pluginDiagnosticsByPluginId,
                hookHandlerRegistry.diagnosticsByPluginId,
            ),
            activatedRegistry.pluginDiagnosticsByPluginId,
        ),
        readHookEventEnvelopeV1,
        dispose: activatedRegistry.dispose,
    };
}
