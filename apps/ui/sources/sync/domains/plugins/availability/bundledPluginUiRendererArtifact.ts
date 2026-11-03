import type { PluginUiProjectionModel } from '../ui/projection';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { readPluginAccountAvailability } from './projection';

type PluginUiRendererProjectionInputs = Readonly<{
    accountProjection: PluginUiProjectionModel | null;
    selectedProjection: PluginUiProjectionModel | null;
}>;

export function readCurrentPluginUiRendererProjection(scope: ServerAccountScope): PluginUiRendererProjectionInputs {
    const accountProjection = readPluginAccountAvailability(scope).readAccountUiProjection();
    // AppShell owns explicit development overrides, but its merged Machine
    // inventory is not the app/Account-release census owned by Availability.
    return { accountProjection, selectedProjection:
        readCurrentAppShellPluginUiProjection({ scope, declarationsOnly: true }) ?? accountProjection };
}

/**
 * Availability's app/Account-release census owns eligibility for current renderer
 * selection. External Machine-only plugins retain their exact Machine entry.
 * Explicit development and release choices are already reflected in the
 * published projection; an execution origin is not a renderer selection.
 */
export function resolveBundledPluginUiRendererArtifact(
    entry: Readonly<Record<string, unknown>> | null,
    currentProjection: PluginUiRendererProjectionInputs | null | undefined,
): Readonly<Record<string, unknown>> | null {
    if (!entry) return entry;
    if (entry.contributionKind === 'reactNativeBundle' && entry.generatedOwnerKind !== undefined
        && entry.generatedOwnerKind !== 'renderer') return entry;
    const runtime = entry.runtime as Readonly<{ decision?: Readonly<{ state?: unknown }> }> | undefined;
    if (runtime?.decision?.state === 'disabled') return entry;
    if (!currentProjection?.accountProjection?.installedPackagesById[String(entry.pluginId)]) return entry;
    return currentProjection.selectedProjection?.reactNativeBundlesById[String(entry.id)]
        ?? currentProjection.selectedProjection?.hostedWebById[String(entry.id)] ?? null;
}
