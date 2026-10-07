import * as React from 'react';
import { useGlobalSearchParams, usePathname } from '@/components/appShell/workspace/destinationRoute';
import Fuse, { type IFuseOptions } from 'fuse.js';
import type { FeatureId } from '@happier-dev/protocol';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useTeamsSettingsAdmission } from '@/hooks/teams/useTeamsSettingsAdmission';
import { useTeamsDestinationShown } from '@/hooks/teams/useTeamsDestinationShown';
import { useHomeAdministrationSettingsAdmission } from '@/hooks/home/useHomeAdministrationSettingsAdmission';
import { storage, useLocalSetting, useSetting } from '@/sync/domains/state/storage';
import { getPreferredLanguage, t } from '@/text';
import { useAppShellPluginUiProjection, useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { voiceSettingsDeclarationRegistry } from '@/voice/settings/voiceContributedSettingsDeclarations';
import { projectConversationLanguagePreference } from '@/voice/settings/language/conversationLanguage';

import { SETTINGS_PAGE_CATALOG, flattenSettingsPageCatalog } from '../pageCatalog';
import { SETTINGS_ROUTES, settingsRoutePathname } from '../routes';
import { SETTINGS_PAGE_DECLARATIONS, getSettingsPageDeclarations } from '../settingsPageDeclarations';
import {
    buildSettingHref,
    collectDeclaredFeatureIds,
    resolveSettingsHost,
    settingRendersOnHost,
    type SettingRef,
    type SettingsHost,
    type SettingsRouteContext,
    type SettingsPageDeclaration,
} from '../settingDeclarations';
import type { ResolvedSettingsPageNode, SettingsPageId, SettingsPageNode, SettingsPageSearchResult } from '../types';
import { mergeAdmittedPluginSettingsPages } from './pluginSettingsPageCatalog';
import { resolveSettingsPageGateUnavailableReason } from '../settingsPageGateAvailability';

export type ResolvedSettingsPageCatalog = Readonly<{
    tree: readonly ResolvedSettingsPageNode[];
    activePageId: SettingsPageId | null;
    search: (query: string) => readonly SettingsPageSearchResult[];
}>;

type SettingsPageSearchDoc = Readonly<{
    id: SettingsPageId;
    route: string;
    title: string;
    subtitle: string;
    keywords: readonly string[];
    pathTokens: readonly string[];
    setting?: SettingsPageSearchResult['setting'];
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
    // These two destinations consume their exact Home-set admission owners.
    // Neither the focused Home nor a catalog-local role check can decide them.
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
            ...(node.subtitle
                ? { subtitle: node.subtitle }
                : node.subtitleKey
                    ? { subtitle: String(t(node.subtitleKey)) }
                    : {}),
            route: node.route,
            keywords: node.keywordsKey ? splitSearchWords(String(t(node.keywordsKey))) : (node.keywords ?? []),
            icon: node.icon,
            pluginSettingsPage: node.pluginSettingsPage,
            ...(children && children.length > 0 ? { children } : {}),
        });
    }
    return out;
}

/** A page's translated search words are one comma-separated list. */
function splitSearchWords(list: string): string[] {
    return list.split(',').map((word) => word.trim()).filter((word) => word.length > 0);
}

function buildSettingDocs(params: Readonly<{
    pageId: SettingsPageId;
    pageRoute: string;
    pageTitle: string;
    features: Readonly<Record<string, boolean>>;
    host: SettingsHost;
    routeContext?: SettingsRouteContext;
    declarations: readonly SettingsPageDeclaration[];
}>): SettingsPageSearchDoc[] {
    const docs: SettingsPageSearchDoc[] = [];
    for (const declaration of params.declarations) {
        if (declaration.pageId !== params.pageId) continue;
        // A sub-page's settings open its own route, under the catalog page in the result path.
        const route = declaration.subpage?.route ?? params.pageRoute;
        const subpageTitle = declaration.subpage ? String(t(declaration.subpage.titleKey)) : null;
        const pagePath = subpageTitle ? [params.pageTitle, subpageTitle] : [params.pageTitle];
        for (const ref of Object.values(declaration.settings) as readonly SettingRef[]) {
            if (ref.featureId && params.features[ref.featureId] !== true) continue;
            if (!settingRendersOnHost(ref, params.host)) continue;
            const href = buildSettingHref(route, ref, params.routeContext);
            if (href === null) continue;
            docs.push(buildSettingDoc({ pageId: params.pageId, route: href, pagePath, ref }));
        }
    }
    return docs;
}

function buildSettingDoc(params: Readonly<{
    pageId: SettingsPageId;
    route: string;
    pagePath: readonly string[];
    ref: SettingRef;
}>): SettingsPageSearchDoc {
    const { ref } = params;
    const title = ref.title ?? String(t(ref.titleKey));
    const sectionTitle = ref.sectionTitleKey ? String(t(ref.sectionTitleKey)) : null;
    const path = sectionTitle && sectionTitle !== title && !params.pagePath.includes(sectionTitle)
        ? [...params.pagePath, sectionTitle]
        : [...params.pagePath];
    return {
        id: params.pageId,
        route: params.route,
        title,
        subtitle: ref.description ?? (ref.descriptionKey ? String(t(ref.descriptionKey)) : ''),
        keywords: (ref.keywordKeys ?? []).map((key) => String(t(key))),
        pathTokens: path,
        setting: { anchor: ref.anchor, title, path },
    };
}

function buildSearchDocs(
    nodes: readonly ResolvedSettingsPageNode[],
    features: Readonly<Record<string, boolean>>,
    host: SettingsHost,
    routeContext: SettingsRouteContext,
    scopedRouteAdmission: Readonly<{ teams: boolean; homeAdministration: boolean }>,
    declarations: readonly SettingsPageDeclaration[],
): SettingsPageSearchDoc[] {
    const out: SettingsPageSearchDoc[] = [];
    const visit = (items: readonly ResolvedSettingsPageNode[], ancestors: readonly string[]) => {
        for (const item of items) {
            const title = item.title ?? (item.titleKey ? String(t(item.titleKey)) : item.id);
            const subtitle = item.subtitle ?? (item.subtitleKey ? String(t(item.subtitleKey)) : '');
            const nextAncestors = title ? [...ancestors, title] : ancestors;

            if (typeof item.route === 'string' && item.route.length > 0) {
                out.push({
                    id: item.id,
                    route: item.route,
                    title,
                    subtitle,
                    keywords: item.keywords ?? [],
                    pathTokens: ancestors,
                });
                const scopedContext = (item.id === 'teams' && !scopedRouteAdmission.teams)
                    || (item.id === 'homeAdministration' && !scopedRouteAdmission.homeAdministration)
                    ? undefined
                    : routeContext;
                // A setting opens its own page, never the page's entry link.
                out.push(...buildSettingDocs({ pageId: item.id, pageRoute: settingsRoutePathname(item.route), pageTitle: title, features, host, routeContext: scopedContext, declarations }));
            }

            if (item.children) {
                visit(item.children, nextAncestors);
            }
        }
    };

    visit(nodes, []);
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

function resolveActivePageIdFromPathname(
    pathname: string,
    flat: readonly SettingsPageNode[]
): SettingsPageId | null {
    const exact = flat.find((node) => node.route && settingsRoutePathname(node.route) === pathname);
    if (exact) return exact.id;

    // The generic plugin Settings route is a qualified leaf identity. If its
    // admission has retired, retain no active catalog page instead of making
    // the unavailable route look like an admitted page or the Marketplace.
    if (isQualifiedPluginSettingsPagePathname(pathname)) return null;

    // Fallback: choose the longest Settings route on a segment boundary. The
    // Settings overview is an exact-only index page, not an owner for every
    // unmatched /settings child route.
    let best: SettingsPageNode | null = null;
    for (const node of flat) {
        if (!node.route || node.route === SETTINGS_ROUTES.general) continue;
        const route = settingsRoutePathname(node.route);
        if (!pathnameIsAtOrBelowRoute(pathname, route)) continue;
        if (!best || (best.route && route.length > settingsRoutePathname(best.route).length)) {
            best = node;
        }
    }
    return best?.id ?? null;
}

const PAGE_SEARCH_OPTIONS: IFuseOptions<SettingsPageSearchDoc> = {
    includeScore: false,
    ignoreLocation: true,
    threshold: 0.35,
    keys: [
        { name: 'title', weight: 0.6 },
        { name: 'keywords', weight: 0.3 },
        { name: 'pathTokens', weight: 0.2 },
        { name: 'subtitle', weight: 0.1 },
    ],
};

/** A row's path (page › section) only breaks ties: its own label and words decide the match. */
const SETTING_SEARCH_OPTIONS: IFuseOptions<SettingsPageSearchDoc> = {
    ...PAGE_SEARCH_OPTIONS,
    keys: [
        { name: 'title', weight: 0.6 },
        { name: 'keywords', weight: 0.3 },
        { name: 'subtitle', weight: 0.1 },
        { name: 'pathTokens', weight: 0.05 },
    ],
};

/**
 * Every feature a catalog page or a declared section is gated on. Derived from the catalog and the
 * declarations, so a new gate is evaluated the moment it is declared.
 */
const SETTINGS_GATE_FEATURE_IDS: readonly FeatureId[] = [...new Set<FeatureId>([
    ...flattenSettingsPageCatalog(SETTINGS_PAGE_CATALOG).flatMap((node) => (node.gate?.featureId ? [node.gate.featureId] : [])),
    ...collectDeclaredFeatureIds(SETTINGS_PAGE_DECLARATIONS),
])];

function useSettingsFeatureSnapshot(): Readonly<Record<string, boolean>> {
    // The id list is a module constant, so these hooks run in the same order on every render.
    const enabled = SETTINGS_GATE_FEATURE_IDS.map((featureId) => useFeatureEnabled(featureId));
    const signature = enabled.map((value) => (value ? '1' : '0')).join('');
    return React.useMemo(
        () => Object.fromEntries(SETTINGS_GATE_FEATURE_IDS.map((featureId, index) => [featureId, signature[index] === '1'])),
        [signature],
    );
}

export function useResolvedSettingsPageCatalog(): ResolvedSettingsPageCatalog {
    const pathname = usePathname();
    // The catalog lives in the Settings layout; global params describe the selected leaf,
    // unlike layout-local params. Scoped declarations validate them against its pathname.
    const routeParams = useGlobalSearchParams();
    const routeContext = React.useMemo<SettingsRouteContext>(
        () => ({ pathname: pathname ?? '/', params: routeParams }),
        [pathname, routeParams],
    );
    const appShellPluginUiProjection = useAppShellPluginUiProjection();
    const localizePluginText = useProjectedPluginLocalizedTextResolver();
    const voiceDeclarationRevision = React.useSyncExternalStore(
        voiceSettingsDeclarationRegistry.subscribe ?? (() => () => {}),
        voiceSettingsDeclarationRegistry.getRevision ?? (() => 0),
        voiceSettingsDeclarationRegistry.getRevision ?? (() => 0),
    );
    const voiceProviderId = storage((state) => state.settings.voice.providerId);
    const voiceLanguageKind = storage((state) => projectConversationLanguagePreference(state.settings.voice, voiceSettingsDeclarationRegistry).kind);
    const declarations = React.useMemo(() => getSettingsPageDeclarations(localizePluginText, storage.getState().settings), [localizePluginText, voiceDeclarationRevision, voiceProviderId, voiceLanguageKind]);
    const useProfiles = Boolean(useSetting('useProfiles'));
    const devModeEnabled = Boolean(useLocalSetting('devModeEnabled'));
    const { os: hostOs, desktop: tauriDesktop } = resolveSettingsHost();
    const host = React.useMemo<SettingsHost>(() => ({ os: hostOs, desktop: tauriDesktop }), [hostOs, tauriDesktop]);
    const teamsAdmission = useTeamsSettingsAdmission();
    const homeAdministrationAdmission = useHomeAdministrationSettingsAdmission();
    // The feature admits Teams; each Home then says whether this viewer is shown it.
    const teamsShown = useTeamsDestinationShown(teamsAdmission.capableServerIds);
    const teamsAdmitted = teamsAdmission.admitted && teamsShown;
    const homeAdministrationAdmitted = homeAdministrationAdmission.admitted;
    const routeServerId = routeParams.serverId;
    const teamRouteAdmitted = typeof routeServerId === 'string' && teamsAdmission.capableServerIds.includes(routeServerId);
    const homeRouteAdmitted = typeof routeServerId === 'string' && homeAdministrationAdmission.admittedServerIds.includes(routeServerId);

    const featureSnapshot = useSettingsFeatureSnapshot();
    const locale = getPreferredLanguage();

    const catalog = React.useMemo(() => mergeAdmittedPluginSettingsPages({
        baseCatalog: SETTINGS_PAGE_CATALOG,
        projection: appShellPluginUiProjection.pluginUiProjection,
        locale,
    }), [appShellPluginUiProjection.pluginUiProjection, locale]);

    const tree = React.useMemo(() => {
        return resolveTree(catalog, {
            useProfiles,
            devModeEnabled,
            tauriDesktop,
            features: featureSnapshot,
            teamsAdmitted,
            homeAdministrationAdmitted,
        });
    }, [
        catalog,
        devModeEnabled,
        featureSnapshot,
        teamsAdmitted,
        homeAdministrationAdmitted,
        locale,
        tauriDesktop,
        useProfiles,
    ]);

    // Navigation/search visibility does not retire a still-mounted route's identity.
    // Plugin leaves remain lifecycle-owned by the merged projection above.
    const flat = React.useMemo(() => flattenSettingsPageCatalog(catalog), [catalog]);

    const activePageId = React.useMemo(() => {
        return resolveActivePageIdFromPathname(pathname ?? '/', flat);
    }, [flat, pathname]);

    const searchDocs = React.useMemo(() => buildSearchDocs(tree, featureSnapshot, host, routeContext, {
        teams: teamRouteAdmitted,
        homeAdministration: homeRouteAdmitted,
    }, declarations), [declarations, featureSnapshot, homeRouteAdmitted, host, routeContext, teamRouteAdmitted, tree]);

    // Pages and rows rank in separate pools. One pool let a page with many declared rows lose to its
    // own rows (every row's path names the page), so typing a page's name never offered the page.
    const fuses = React.useMemo(() => ({
        pages: new Fuse(searchDocs.filter((doc) => !doc.setting), PAGE_SEARCH_OPTIONS),
        settings: new Fuse(searchDocs.filter((doc) => doc.setting), SETTING_SEARCH_OPTIONS),
    }), [searchDocs]);

    const search = React.useCallback((query: string): readonly SettingsPageSearchResult[] => {
        const q = String(query ?? '').trim().toLowerCase();
        if (!q) return [];

        // Pages stay first without hiding matching rows behind a shared result cap.
        const pages = fuses.pages.search(q);
        const settings = fuses.settings.search(q);
        return [
            ...pages.map((result) => ({ id: result.item.id, route: result.item.route })),
            ...settings.map((result) => ({ id: result.item.id, route: result.item.route, setting: result.item.setting! })),
        ];
    }, [fuses]);

    return {
        tree,
        activePageId,
        search,
    };
}

export const __testables = {
    flattenSettingsPageCatalog,
};
