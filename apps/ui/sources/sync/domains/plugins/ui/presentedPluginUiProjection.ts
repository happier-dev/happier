import type { PluginUiProjectionModel } from './projection';
import type { PluginUiProjectionCurrentness } from './usePluginUiProjectionCurrentness';

/** Answered plugin slices present before the Machine's full UI catalog is read. */
export function selectPresentedPluginUiProjection(
    currentness: Pick<PluginUiProjectionCurrentness, 'phase' | 'pluginUiProjection' | 'installedPackagesProjection' | 'presentedPluginIds'> | null | undefined,
): Readonly<{ projection: PluginUiProjectionModel | null; presentedPluginIds: ReadonlySet<string> | null }> {
    const presentedPluginIds = currentness?.phase === 'establishing' && currentness.installedPackagesProjection
        ? currentness.presentedPluginIds ?? null : null;
    return {
        projection: presentedPluginIds ? currentness?.installedPackagesProjection ?? null : currentness?.pluginUiProjection ?? null,
        presentedPluginIds,
    };
}
