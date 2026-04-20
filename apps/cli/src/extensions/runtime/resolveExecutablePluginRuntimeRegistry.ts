import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readPluginReloadStateSnapshot } from '@/extensions/reload/state';
import { BUNDLED_FIRST_PARTY_EXTENSION_PACKAGE_NAMES } from '@/extensions/registry/sources/generatedBundledPlugins';
import type { PluginCompatibilityDiagnostic } from '../diagnostics/types';
import { createResolvedContributionRegistry } from '../registry/createResolvedContributionRegistry';
import { resolveMergedContributionRegistry } from '../registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from '../registry/types';
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
    contributions: Awaited<ReturnType<typeof resolveMergedContributionRegistry>>;
    actionHandlersByActionId: ReadonlyMap<string, PluginActionHandler>;
    hookHandlersByHookId: ReadonlyMap<string, readonly ResolvedPluginHookHandler[]>;
    runtimeAdapterHandlersByBackendId: ReadonlyMap<string, ReadonlyMap<string, PluginHookHandler>>;
    backendEnginesByBackendId: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['backendEnginesByBackendId'];
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

function mergeActivatedContributions(
    base: ResolvedContributionRegistry,
    activated: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>,
): ResolvedContributionRegistry {
    if (
        activated.providers.length === 0
        && activated.backends.length === 0
        && activated.actions.length === 0
        && activated.tools.length === 0
        && activated.commands.length === 0
        && activated.resources.length === 0
        && activated.uiDescriptors.length === 0
        && activated.lifecycleHandlers.length === 0
    ) {
        return base;
    }

    return createResolvedContributionRegistry({
        providers: Object.freeze([
            ...base.providers,
            ...activated.providers,
        ]),
        backends: Object.freeze([
            ...base.backends,
            ...activated.backends,
        ]),
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
        activationTargets: base.activationTargets,
        hookRegistrations: base.hookRegistrations,
        lifecycleHandlers: Object.freeze([
            ...(base.lifecycleHandlers ?? []),
            ...activated.lifecycleHandlers,
        ]),
        pluginDiagnosticsByPluginId: base.pluginDiagnosticsByPluginId,
    });
}

const bundledFirstPartyPackageNames = new Set(BUNDLED_FIRST_PARTY_EXTENSION_PACKAGE_NAMES);

function parseFirstPartyExtensionIdFromPackageName(packageName: string): string | null {
    const prefix = '@happier-dev/extensions-';
    if (!packageName.startsWith(prefix)) {
        return null;
    }
    const extensionId = packageName.slice(prefix.length).trim();
    if (!extensionId) {
        return null;
    }
    return extensionId;
}

async function loadBundledFirstPartyExtensionDaemonModule(packageName: string): Promise<PluginDaemonModuleNamespace> {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRootCandidate = resolve(here, '..', '..', '..', '..', '..');
    const extensionId = parseFirstPartyExtensionIdFromPackageName(packageName);
    if (extensionId) {
        const distCandidate = resolve(repoRootCandidate, 'packages', 'extensions', extensionId, 'dist', 'index.js');
        const srcCandidate = resolve(repoRootCandidate, 'packages', 'extensions', extensionId, 'src', 'index.ts');

        if (existsSync(distCandidate)) {
            return await import(pathToFileURL(distCandidate).href) as PluginDaemonModuleNamespace;
        }
        if (existsSync(srcCandidate)) {
            // Dev-mode fallback so unit tests and local execution can run before extension build outputs exist.
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
            load: async () => await loadBundledFirstPartyExtensionDaemonModule(target.daemonEntryPath),
        };
    }
    return null;
}

export async function resolveExecutablePluginRuntimeRegistry(
    params?: Readonly<{
        happyHomeDir?: string;
        contributions?: ResolvedContributionRegistry;
        generation?: number;
    }>,
): Promise<ResolvedExecutablePluginRuntimeRegistry> {
    const generation = params?.generation ?? await resolveRuntimeGeneration(params?.happyHomeDir);
    const contributions = params?.contributions
        ?? await resolveMergedContributionRegistry({
            happyHomeDir: params?.happyHomeDir,
        });
    const hookHandlerRegistry: ResolvedPluginHookHandlerRegistry = await resolvePluginHookHandlerRegistry({
        registry: contributions,
        generation,
    });
    const activatedRegistry = await activatePluginRuntimeRegistry({
        contributions,
        generation,
        resolveActivationSource: resolveBundledActivationSource,
    });
    const authoritativeContributions = mergeActivatedContributions(contributions, activatedRegistry);
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
        contributions: authoritativeContributions,
        actionHandlersByActionId: activatedRegistry.actionHandlersByActionId,
        hookHandlersByHookId,
        runtimeAdapterHandlersByBackendId: activatedRegistry.runtimeAdapterHandlersByBackendId,
        backendEnginesByBackendId: activatedRegistry.backendEnginesByBackendId ?? new Map(),
        pluginDiagnosticsByPluginId: mergePluginDiagnostics(
            mergePluginDiagnostics(
                authoritativeContributions.pluginDiagnosticsByPluginId,
                hookHandlerRegistry.diagnosticsByPluginId,
            ),
            activatedRegistry.pluginDiagnosticsByPluginId,
        ),
        readHookEventEnvelopeV1,
        dispose: activatedRegistry.dispose,
    };
}
