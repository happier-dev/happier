import * as React from 'react';
import { useAppShellPluginUiProjection, useAppShellPluginUiProjectionSubscription } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { readCurrentAppShellPluginUiProjection, subscribeCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolvePluginThemeList } from './pluginThemeCatalog';
import type { PluginThemeListItem } from './pluginThemeCatalog';
import type { ThemeReference } from '@happier-dev/protocol/account/settings/themeProfiles';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

const noSources: ReadonlyMap<string, string> = new Map();

/** Store catalog controls read contributor labels without observing the theme entries themselves. */
export function usePluginThemeSources(enabled: boolean): ReadonlyMap<string, string> {
    return useAppShellPluginUiProjection(({ pluginUiProjection }) => {
        if (!enabled || !pluginUiProjection) return noSources;
        const sources = new Map<string, string>();
        for (const { pluginId, pluginName } of resolvePluginThemeList(pluginUiProjection)) {
            if (!sources.has(pluginId)) sources.set(pluginId, pluginName);
        }
        return sources;
    }, enabled);
}

/** Subscribes only to the admitted theme family, through the existing projection owner. */
export function usePluginThemeList(): readonly PluginThemeListItem[];
export function usePluginThemeList(enabled: boolean): readonly PluginThemeListItem[];
export function usePluginThemeList(reference: Extract<ThemeReference, { kind: 'plugin' }> | null, enabled?: boolean,
    committedScope?: ServerAccountScope | null): PluginThemeListItem | null;
export function usePluginThemeList(reference?: Extract<ThemeReference, { kind: 'plugin' }> | null | boolean, observe = true,
    committedScope?: ServerAccountScope | null): readonly PluginThemeListItem[] | PluginThemeListItem | null {
    const projection = useAppShellPluginUiProjectionSubscription();
    const all = reference === undefined || typeof reference === 'boolean';
    const enabled = observe && reference !== false;
    const key = reference && typeof reference !== 'boolean' ? buildQualifiedPluginContributionKey({ pluginId: reference.pluginId, localId: reference.contributionId }) : null;
    const subscribeFamily = React.useCallback((listener: () => void) => all && enabled ? projection.subscribe(listener) : () => {}, [all, enabled, projection]);
    const readFamily = React.useCallback(() => all && enabled ? projection.getSnapshot().pluginUiProjection?.themesById : undefined, [all, enabled, projection]);
    const family = React.useSyncExternalStore(subscribeFamily, readFamily, readFamily);
    const subscribeEntry = React.useCallback((listener: () => void) => {
        if (!key || !enabled || committedScope === null) return () => {};
        return committedScope === undefined ? projection.subscribe(listener) : subscribeCommittedAppShellPluginUiProjection(listener);
    }, [key, enabled, projection, committedScope]);
    // Addressed headers remain readable on an initial hidden mount without subscribing or acquiring bodies.
    const readEntry = React.useCallback(() => {
        if (!key) return null;
        const model = committedScope === undefined ? projection.getSnapshot().pluginUiProjection
            : committedScope && readCurrentAppShellPluginUiProjection({ scope: committedScope, declarationsOnly: true });
        return model?.themesById[key] ?? null;
    }, [key, projection, committedScope]);
    const entry = React.useSyncExternalStore(subscribeEntry, readEntry, readEntry);
    return React.useMemo(() => {
        if (all) return resolvePluginThemeList(family ? { themesById: family } : null);
        return entry ? resolvePluginThemeList({ themesById: { [entry.id]: entry } })[0] ?? null : null;
    }, [all, family, entry]);
}
