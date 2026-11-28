import * as React from 'react';
import type { FeatureId } from '@happier-dev/protocol/features/catalog';

import { useGlobalSearchParams, usePathname } from '@/components/appShell/workspace/destinationRoute';
import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useFeatureDecisions } from '@/hooks/server/useFeatureDecision';
import { useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { voiceSettingsDeclarationRegistry } from '@/voice/settings/voiceContributedSettingsDeclarations';
import { projectConversationLanguagePreference } from '@/voice/settings/language/conversationLanguage';
import { usePluginKeyboardCommands } from '@/keyboard/usePluginKeyboardCommands';

import { flattenSettingsPageCatalog } from '../pageCatalog';
import { settingsRoutePathname } from '../routes';
import { loadSettingsPagePresentation, readSettingsPagePresentation } from '../loadSettingsPagePresentation';
import {
    buildSettingHref,
    collectDeclaredFeatureIds,
    settingRendersOnHost,
    type SettingRef,
    type SettingsHost,
    type SettingsRouteContext,
    type SettingsPageDeclaration,
} from '../settingDeclarations';
import type { ResolvedSettingsPageNode, SettingsPageId, SettingsPageSearchResult } from '../types';
import { createSettingsCatalogSearch, readSettingRowSearchText } from './settingsCatalogSearch';
import { SETTINGS_PAGE_FEATURE_IDS, useResolvedSettingsPageTree } from './useResolvedSettingsPageIdentity';

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
        const rowAnchors = new Set(Object.values(declaration.sectionRefs).flatMap(section => section.settingAnchors));
        for (const ref of Object.values(declaration.settings) as readonly SettingRef[]) {
            if (!rowAnchors.has(ref.anchor)) continue;
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
    const searchText = readSettingRowSearchText(ref);
    const { title } = searchText;
    const sectionTitle = ref.sectionTitle ?? (ref.sectionTitleKey ? String(t(ref.sectionTitleKey)) : null);
    const path = sectionTitle && sectionTitle !== title && !params.pagePath.includes(sectionTitle)
        ? [...params.pagePath, sectionTitle]
        : [...params.pagePath];
    return {
        id: params.pageId,
        route: params.route,
        ...searchText,
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

const EMPTY_SEARCH_FEATURE_IDS: readonly FeatureId[] = [];
const EMPTY_DECLARATIONS: readonly SettingsPageDeclaration[] = [];

export function useResolvedSettingsPageCatalog(): ResolvedSettingsPageCatalog & Readonly<{ searchRevision: number; presentationStatus: 'loading' | 'ready' | 'error' }> {
    const [presentation, setPresentation] = React.useState(readSettingsPagePresentation);
    const [presentationFailed, setPresentationFailed] = React.useState(false);
    React.useEffect(() => {
        if (presentation) return;
        let active = true;
        void loadSettingsPagePresentation().then(value => {
            if (active) setPresentation(value);
        }, error => {
            console.warn('[settings] Search presentation could not be loaded.', error);
            if (active) setPresentationFailed(true);
        });
        return () => { active = false; };
    }, [presentation]);
    const { tree, activePageId, featureSnapshot: pageFeatures, host, teamAdmittedServerIds, homeAdmittedServerIds } = useResolvedSettingsPageTree(true);
    // Only the search index reads route params (route-function hrefs), so only its consumers follow them.
    const pathname = usePathname();
    const routeParams = useGlobalSearchParams();
    const routeContext = React.useMemo<SettingsRouteContext>(() => ({ pathname: pathname ?? '/', params: routeParams }), [pathname, routeParams]);
    const routeServerId = routeParams.serverId;
    const teamRouteAdmitted = typeof routeServerId === 'string' && teamAdmittedServerIds.includes(routeServerId);
    const homeRouteAdmitted = typeof routeServerId === 'string' && homeAdmittedServerIds.includes(routeServerId);
    const searchFeatureIds = React.useMemo(() => presentation
        ? collectDeclaredFeatureIds(presentation.SETTINGS_PAGE_DECLARATIONS).filter(featureId => !SETTINGS_PAGE_FEATURE_IDS.includes(featureId))
        : EMPTY_SEARCH_FEATURE_IDS, [presentation]);
    const searchDecisions = useFeatureDecisions(searchFeatureIds);
    const featureSnapshot = React.useMemo(() => ({
        ...pageFeatures,
        ...Object.fromEntries(searchFeatureIds.map(id => [id, searchDecisions[id]?.state === 'enabled'])),
    }), [pageFeatures, searchFeatureIds, searchDecisions]);
    const localizePluginText = useProjectedPluginLocalizedTextResolver();
    const pluginKeyboardCommands = usePluginKeyboardCommands();
    const voiceDeclarationRevision = React.useSyncExternalStore(
        voiceSettingsDeclarationRegistry.subscribe ?? (() => () => {}),
        voiceSettingsDeclarationRegistry.getRevision ?? (() => 0),
        voiceSettingsDeclarationRegistry.getRevision ?? (() => 0),
    );
    const voiceProviderId = storage((state) => state.settings.voice.providerId, { settings: ['voice'] });
    // A selector runs on every render and Store publish; the language kind parses the selected
    // service's stored config, so it is derived only when voice settings or their registry change.
    const voiceSettings = storage((state) => state.settings.voice, { settings: ['voice'] });
    const voiceLanguageKind = React.useMemo(() => projectConversationLanguagePreference(voiceSettings, voiceSettingsDeclarationRegistry).kind,
        [voiceDeclarationRevision, voiceSettings]);
    const declarations = React.useMemo(() => presentation?.getSettingsPageDeclarations(
        localizePluginText, storage.getState().settings, pluginKeyboardCommands,
    ) ?? EMPTY_DECLARATIONS, [presentation, localizePluginText, voiceDeclarationRevision, voiceProviderId, voiceLanguageKind, pluginKeyboardCommands]);

    const searchDocs = React.useMemo(() => buildSearchDocs(tree, featureSnapshot, host, routeContext, {
        teams: teamRouteAdmitted,
        homeAdministration: homeRouteAdmitted,
    }, declarations), [declarations, featureSnapshot, homeRouteAdmitted, host, routeContext, teamRouteAdmitted, tree]);

    const search = React.useMemo(() => {
        const find = createSettingsCatalogSearch(searchDocs, doc => Boolean(doc.setting));
        return (query: string): readonly SettingsPageSearchResult[] => find(query).map(({ item, matchText }) => ({
            id: item.id,
            route: item.route,
            ...(item.setting ? { setting: item.setting } : {}),
            ...(matchText ? { matchText } : {}),
        }));
    }, [searchDocs]);

    // Query dispatchers invalidate only when the catalog's actual search inputs change,
    // not when this hook's result object is recreated by an unrelated render.
    const searchIdentity = React.useRef({ search, revision: 0 });
    if (searchIdentity.current.search !== search) {
        searchIdentity.current = { search, revision: searchIdentity.current.revision + 1 };
    }

    return {
        tree,
        activePageId,
        search,
        searchRevision: searchIdentity.current.revision,
        presentationStatus: presentation ? 'ready' : presentationFailed ? 'error' : 'loading',
    };
}
