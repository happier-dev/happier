import * as React from 'react';
import type { FeatureId } from '@happier-dev/protocol/features/catalog';

import { usePathname } from '@/components/appShell/workspace/destinationRoute';
import { useAppShellPluginUiDeclarationProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useTeamsSettingsAdmission } from '@/hooks/teams/useTeamsSettingsAdmission';
import { useTeamsDestinationShown } from '@/hooks/teams/useTeamsDestinationShown';
import { useHomeAdministrationSettingsAdmission } from '@/hooks/home/useHomeAdministrationSettingsAdmission';
import { useLocalSetting, useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';

import { SETTINGS_PAGE_CATALOG, flattenSettingsPageCatalog } from '../pageCatalog';
import { SETTINGS_ROUTES, settingsRoutePathname } from '../routes';
import { resolveSettingsHost, type SettingsHost } from '../settingDeclarations';
import { resolveSettingsPageGateUnavailableReason } from '../settingsPageGateAvailability';
import type { ResolvedSettingsPageNode, SettingsPageId, SettingsPageNode } from '../types';
import { mergeAdmittedPluginSettingsPages } from './pluginSettingsPageCatalog';

export type ResolvedSettingsPageIdentity = Readonly<{
    tree: readonly ResolvedSettingsPageNode[];
    activePageId: SettingsPageId | null;
}>;

type ResolvedSettingsPageTree = ResolvedSettingsPageIdentity & Readonly<{
    featureSnapshot: Readonly<Record<string, boolean>>;
    host: SettingsHost;
    /** Servers a scoped destination may bind to; search matches them against route params at query time. */
    teamAdmittedServerIds: readonly string[];
    homeAdmittedServerIds: readonly string[];
}>;

type CatalogVisibilityContext = Readonly<{
    useProfiles: boolean;
    devModeEnabled: boolean;
    tauriDesktop: boolean;
    features: Readonly<Record<string, boolean>>;
    teamsAdmitted: boolean;
    homeAdministrationAdmitted: boolean;
}>;

function resolveGateVisibility(node: SettingsPageNode, ctx: CatalogVisibilityContext): boolean {
    // Each destination consumes its exact Home-set admission owner.
    if (node.id === 'teams' && !ctx.teamsAdmitted) return false;
    if (node.id === 'homeAdministration' && !ctx.homeAdministrationAdmitted) return false;
    return resolveSettingsPageGateUnavailableReason(node.gate, ctx) === undefined;
}

function resolveTree(nodes: readonly SettingsPageNode[], ctx: CatalogVisibilityContext): ResolvedSettingsPageNode[] {
    const out: ResolvedSettingsPageNode[] = [];
    for (const node of nodes) {
        if (!resolveGateVisibility(node, ctx)) continue;
        const children = node.children ? resolveTree(node.children, ctx) : undefined;
        out.push({
            id: node.id,
            titleKey: node.titleKey,
            title: node.title ?? (node.titleKey ? String(t(node.titleKey)) : node.id),
            subtitleKey: node.subtitleKey,
            ...(node.subtitle ? { subtitle: node.subtitle } : node.subtitleKey ? { subtitle: String(t(node.subtitleKey)) } : {}),
            route: node.route,
            keywords: node.keywordsKey
                ? String(t(node.keywordsKey)).split(',').map(word => word.trim()).filter(word => word.length > 0)
                : (node.keywords ?? []),
            icon: node.icon,
            pluginSettingsPage: node.pluginSettingsPage,
            ...(node.searchOnly ? { searchOnly: true } : {}),
            ...(children && children.length > 0 ? { children } : {}),
        });
    }
    return out;
}

function pathnameIsAtOrBelowRoute(pathname: string, route: string): boolean {
    return pathname === route || pathname.startsWith(`${route}/`);
}

function isQualifiedPluginSettingsPagePathname(pathname: string): boolean {
    const prefix = `${SETTINGS_ROUTES.plugins}/`;
    if (!pathname.startsWith(prefix)) return false;
    return pathname.slice(prefix.length).split('/').filter(Boolean).length >= 2;
}

function resolveActivePageIdFromPathname(pathname: string, flat: readonly SettingsPageNode[]): SettingsPageId | null {
    const exact = flat.find(node => node.route && settingsRoutePathname(node.route) === pathname);
    if (exact) return exact.id;
    // A retired qualified plugin leaf must not fall back to the Marketplace.
    if (isQualifiedPluginSettingsPagePathname(pathname)) return null;
    let best: SettingsPageNode | null = null;
    for (const node of flat) {
        if (!node.route || node.route === SETTINGS_ROUTES.general) continue;
        const route = settingsRoutePathname(node.route);
        if (!pathnameIsAtOrBelowRoute(pathname, route)) continue;
        if (!best || (best.route && route.length > settingsRoutePathname(best.route).length)) best = node;
    }
    return best?.id ?? null;
}

// Page navigation never needs section/field declarations or the Voice search registry.
export const SETTINGS_PAGE_FEATURE_IDS: readonly FeatureId[] = [...new Set(
    flattenSettingsPageCatalog(SETTINGS_PAGE_CATALOG).flatMap(node => node.gate?.featureId ? [node.gate.featureId] : []),
)];

/** Callers supply their constant page or search feature inventory, keeping hook order stable. */
export function useSettingsPageFeatureSnapshot(featureIds: readonly FeatureId[]): Readonly<Record<string, boolean>> {
    const enabled = featureIds.map(featureId => useFeatureEnabled(featureId));
    const signature = enabled.map(value => value ? '1' : '0').join('');
    return React.useMemo(() => Object.fromEntries(featureIds.map((featureId, index) => [featureId, signature[index] === '1'])),
        [featureIds, signature]);
}

const NO_SERVER_IDS: readonly string[] = Object.freeze([]);

/**
 * Shared navigation/admission owner; search adds its own field declarations downstream. It reads the
 * pathname only: route params belong to the search index, so a params-only change reaches no navigation reader.
 */
export function useResolvedSettingsPageTree(enabled: boolean): ResolvedSettingsPageTree {
    const pathname = usePathname();
    const pluginUiProjection = useAppShellPluginUiDeclarationProjection();
    const useProfiles = Boolean(useSetting('useProfiles'));
    const devModeEnabled = Boolean(useLocalSetting('devModeEnabled'));
    const { os: hostOs, desktop: tauriDesktop } = resolveSettingsHost();
    const host = React.useMemo<SettingsHost>(() => ({ os: hostOs, desktop: tauriDesktop }), [hostOs, tauriDesktop]);
    const teamsAdmission = useTeamsSettingsAdmission({ enabled });
    const homeAdministrationAdmission = useHomeAdministrationSettingsAdmission({ enabled });
    const teamsShown = useTeamsDestinationShown(enabled ? teamsAdmission.capableServerIds : NO_SERVER_IDS);
    const teamsAdmitted = teamsAdmission.admitted && teamsShown;
    const homeAdministrationAdmitted = homeAdministrationAdmission.admitted;
    const featureSnapshot = useSettingsPageFeatureSnapshot(SETTINGS_PAGE_FEATURE_IDS);
    const locale = usePreferredLanguage();
    const localize = usePluginLocalizedTextResolver({ projection: pluginUiProjection, locale });
    const catalog = React.useMemo(() => enabled ? mergeAdmittedPluginSettingsPages({
        baseCatalog: SETTINGS_PAGE_CATALOG, projection: pluginUiProjection, locale, localize,
    }) : [], [enabled, pluginUiProjection, locale, localize]);
    const tree = React.useMemo(() => resolveTree(catalog, {
        useProfiles, devModeEnabled, tauriDesktop, features: featureSnapshot, teamsAdmitted, homeAdministrationAdmitted,
    }), [catalog, devModeEnabled, featureSnapshot, teamsAdmitted, homeAdministrationAdmitted, locale, tauriDesktop, useProfiles]);
    // Visibility does not retire a mounted route's identity; plugin lifecycle still owns its leaves.
    const flat = React.useMemo(() => flattenSettingsPageCatalog(catalog), [catalog]);
    const activePageId = React.useMemo(() => resolveActivePageIdFromPathname(pathname ?? '/', flat), [flat, pathname]);
    return {
        tree, activePageId, featureSnapshot, host,
        teamAdmittedServerIds: teamsAdmission.capableServerIds,
        homeAdmittedServerIds: homeAdministrationAdmission.admittedServerIds,
    };
}

/** The full resolved page tree and active page for navigation readers; no search index, no route params. */
export function useResolvedSettingsPageNavigation(): ResolvedSettingsPageIdentity {
    const { tree, activePageId } = useResolvedSettingsPageTree(true);
    return { tree, activePageId };
}

/** Current navigation identity does not demand Settings search or another route's admission. */
export function useResolvedSettingsPageIdentity(): ResolvedSettingsPageIdentity {
    const pathname = usePathname();
    const { tree, activePageId } = useResolvedSettingsPageTree(pathnameIsAtOrBelowRoute(pathname ?? '/', SETTINGS_ROUTES.general));
    return { tree, activePageId };
}
