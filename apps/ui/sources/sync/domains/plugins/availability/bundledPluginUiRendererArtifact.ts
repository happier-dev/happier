import type { PluginUiProjectionModel } from '../ui/projection';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { readPluginAccountAvailability } from './projection';

export function readCurrentPluginUiRendererProjection(scope: ServerAccountScope): PluginUiProjectionModel | null {
    // The installed-projection merge already decides explicit development
    // overrides. Before AppShell publishes, Availability owns the app census.
    return readCurrentAppShellPluginUiProjection({ scope, declarationsOnly: true })
        ?? readPluginAccountAvailability(scope).readAccountUiProjection();
}

/**
 * Availability's current projection owns renderer declarations. A retained
 * Machine selection (including one without a source-custody stamp) cannot
 * select a second generation before graph/identity admission.
 * Explicit development and release choices are already reflected in the
 * published projection; an execution origin is not a renderer selection.
 */
export function resolveBundledPluginUiRendererArtifact(
    entry: Readonly<Record<string, unknown>> | null,
    currentProjection: PluginUiProjectionModel | null | undefined,
): Readonly<Record<string, unknown>> | null {
    if (!entry) return entry;
    if (entry.contributionKind === 'reactNativeBundle' && entry.generatedOwnerKind !== undefined
        && entry.generatedOwnerKind !== 'renderer') return entry;
    const runtime = entry.runtime as Readonly<{ decision?: Readonly<{ state?: unknown }> }> | undefined;
    if (runtime?.decision?.state === 'disabled') return entry;
    if (!currentProjection?.installedPackagesById[String(entry.pluginId)]) return entry;
    return currentProjection.reactNativeBundlesById[String(entry.id)]
        ?? currentProjection.hostedWebById[String(entry.id)] ?? null;
}
