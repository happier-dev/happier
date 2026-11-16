import type { PluginContributionLocalId } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ThemeProfileV1 } from './themeProfileTypes';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';

export type PluginThemeListItem = Readonly<{
    id: string;
    pluginId: string;
    pluginVersion: string;
    pluginName: string;
    contributionId: PluginContributionLocalId;
    theme: ThemeProfileV1;
}>;

const EMPTY: readonly PluginThemeListItem[] = Object.freeze([]);

/** Admitted declaration data only. MODEL owns library identity, mutability and selection. */
export function resolvePluginThemeList(projection: Pick<PluginUiProjectionModel, 'themesById'> | null): readonly PluginThemeListItem[] {
    if (!projection) return EMPTY;
    const entries = Object.values(projection.themesById ?? {});
    if (entries.length === 0) return EMPTY;
    return Object.freeze(entries.map(entry => Object.freeze({
        id: entry.id,
        pluginId: entry.pluginId,
        pluginVersion: entry.pluginVersion,
        pluginName: entry.pluginName ?? entry.pluginId,
        contributionId: entry.definition.id,
        theme: entry.definition.theme,
    })));
}

/** Borrows the committed app-shell projection; listing performs no transport or Artifact writes. */
export function readPluginThemeList(): readonly PluginThemeListItem[] {
    return resolvePluginThemeList(readCurrentAppShellPluginUiProjection());
}
