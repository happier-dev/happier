import * as React from 'react';
import { useAppShellPluginUiProjectionSubscription } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { resolvePluginThemeList } from './pluginThemeCatalog';
import type { PluginThemeListItem } from './pluginThemeCatalog';
import type { ThemeReference } from '@happier-dev/protocol/account/settings/themeProfiles';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

/** Subscribes only to the admitted theme family, through the existing projection owner. */
export function usePluginThemeList(): readonly PluginThemeListItem[];
export function usePluginThemeList(enabled: boolean): readonly PluginThemeListItem[];
export function usePluginThemeList(reference: Extract<ThemeReference, { kind: 'plugin' }> | null, enabled?: boolean): PluginThemeListItem | null;
export function usePluginThemeList(reference?: Extract<ThemeReference, { kind: 'plugin' }> | null | boolean, observe = true): readonly PluginThemeListItem[] | PluginThemeListItem | null {
    const projection = useAppShellPluginUiProjectionSubscription();
    const all = reference === undefined || typeof reference === 'boolean';
    const enabled = observe && reference !== false;
    const key = reference && typeof reference !== 'boolean' ? buildQualifiedPluginContributionKey({ pluginId: reference.pluginId, localId: reference.contributionId }) : null;
    const subscribeFamily = React.useCallback((listener: () => void) => all && enabled ? projection.subscribe(listener) : () => {}, [all, enabled, projection]);
    const readFamily = React.useCallback(() => all && enabled ? projection.getSnapshot().pluginUiProjection?.themesById : undefined, [all, enabled, projection]);
    const family = React.useSyncExternalStore(subscribeFamily, readFamily, readFamily);
    const subscribeEntry = React.useCallback((listener: () => void) => key && enabled ? projection.subscribe(listener) : () => {}, [key, enabled, projection]);
    // Addressed headers remain readable on an initial hidden mount without subscribing or acquiring bodies.
    const readEntry = React.useCallback(() => key ? projection.getSnapshot().pluginUiProjection?.themesById[key] ?? null : null, [key, projection]);
    const entry = React.useSyncExternalStore(subscribeEntry, readEntry, readEntry);
    return React.useMemo(() => {
        if (all) return resolvePluginThemeList(family ? { themesById: family } : null);
        return entry ? resolvePluginThemeList({ themesById: { [entry.id]: entry } })[0] ?? null : null;
    }, [all, family, entry]);
}
