import type { PluginCompatibilityDiagnostic } from '@/extensions/plugins/shared/pluginDiagnostics';
import { resolveMergedContributionRegistry } from '@/extensions/registry/createResolvedContributionRegistry';
import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';

import { resolvePluginHookHandlerRegistry } from './resolvePluginHookHandlerRegistry';
import type { ResolvedPluginHookHandler, ResolvedPluginHookHandlerRegistry } from './types';

export type ResolvedExecutablePluginRuntimeRegistry = Readonly<{
    contributions: Awaited<ReturnType<typeof resolveMergedContributionRegistry>>;
    hookHandlersByHookId: ReadonlyMap<string, readonly ResolvedPluginHookHandler[]>;
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
    readHookEventEnvelopeV1: typeof readHookEventEnvelopeV1;
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

export async function resolveExecutablePluginRuntimeRegistry(
    params?: Readonly<{ happyHomeDir?: string }>,
): Promise<ResolvedExecutablePluginRuntimeRegistry> {
    const contributions = await resolveMergedContributionRegistry({
        happyHomeDir: params?.happyHomeDir,
    });
    const hookHandlerRegistry: ResolvedPluginHookHandlerRegistry = await resolvePluginHookHandlerRegistry({
        registry: contributions,
    });

    return {
        contributions,
        hookHandlersByHookId: hookHandlerRegistry.handlersByHookId,
        pluginDiagnosticsByPluginId: mergePluginDiagnostics(
            contributions.pluginDiagnosticsByPluginId,
            hookHandlerRegistry.diagnosticsByPluginId,
        ),
        readHookEventEnvelopeV1,
    };
}
