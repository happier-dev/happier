import * as React from 'react';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { resolvePluginThemeList } from './pluginThemeCatalog';
import type { PluginThemeListItem } from './pluginThemeCatalog';
import type { ThemeReference } from '@happier-dev/protocol/account/settings/themeProfiles';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

/** Subscribes only to the admitted theme family, through the existing projection owner. */
export function usePluginThemeList(): readonly PluginThemeListItem[];
export function usePluginThemeList(reference: Extract<ThemeReference, { kind: 'plugin' }> | null): PluginThemeListItem | null;
export function usePluginThemeList(reference?: Extract<ThemeReference, { kind: 'plugin' }> | null): readonly PluginThemeListItem[] | PluginThemeListItem | null {
    const all = reference === undefined;
    const key = reference ? buildQualifiedPluginContributionKey({ pluginId: reference.pluginId, localId: reference.contributionId }) : null;
    const family = useAppShellPluginUiProjection(value => all ? value.pluginUiProjection?.themesById : undefined);
    const entry = useAppShellPluginUiProjection(value => key ? value.pluginUiProjection?.themesById[key] ?? null : null);
    return React.useMemo(() => {
        if (all) return resolvePluginThemeList(family ? { themesById: family } : null);
        return entry ? resolvePluginThemeList({ themesById: { [entry.id]: entry } })[0] ?? null : null;
    }, [all, family, entry]);
}
