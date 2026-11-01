import * as React from 'react';
import Fuse, { type FuseResult, type IFuseOptions } from 'fuse.js';
import type { FeatureId } from '@happier-dev/protocol';

import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { voiceSettingsDeclarationRegistry } from '@/voice/settings/voiceContributedSettingsDeclarations';
import { projectConversationLanguagePreference } from '@/voice/settings/language/conversationLanguage';

import { flattenSettingsPageCatalog } from '../pageCatalog';
import { settingsRoutePathname } from '../routes';
import { SETTINGS_PAGE_DECLARATIONS, getSettingsPageDeclarations } from '../settingsPageDeclarations';
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
import { SETTINGS_PAGE_FEATURE_IDS, useResolvedSettingsPageTree, useSettingsPageFeatureSnapshot } from './useResolvedSettingsPageIdentity';

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
    const sectionTitle = ref.sectionTitle ?? (ref.sectionTitleKey ? String(t(ref.sectionTitleKey)) : null);
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

const PAGE_SEARCH_OPTIONS: IFuseOptions<SettingsPageSearchDoc> = {
    includeScore: false,
    includeMatches: true,
    ignoreLocation: true,
    // Title typo recovery allows a one-in-five edit error, not harbor -> behavior/abort.
    threshold: 0.2,
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

const SETTINGS_SEARCH_FEATURE_IDS: readonly FeatureId[] = collectDeclaredFeatureIds(SETTINGS_PAGE_DECLARATIONS)
    .filter(featureId => !SETTINGS_PAGE_FEATURE_IDS.includes(featureId));

export function useResolvedSettingsPageCatalog(): ResolvedSettingsPageCatalog {
    const { tree, activePageId, featureSnapshot: pageFeatures, host, routeContext, teamRouteAdmitted, homeRouteAdmitted } = useResolvedSettingsPageTree(true);
    const searchFeatures = useSettingsPageFeatureSnapshot(SETTINGS_SEARCH_FEATURE_IDS);
    const featureSnapshot = React.useMemo(() => ({ ...pageFeatures, ...searchFeatures }), [pageFeatures, searchFeatures]);
    const localizePluginText = useProjectedPluginLocalizedTextResolver();
    const voiceDeclarationRevision = React.useSyncExternalStore(
        voiceSettingsDeclarationRegistry.subscribe ?? (() => () => {}),
        voiceSettingsDeclarationRegistry.getRevision ?? (() => 0),
        voiceSettingsDeclarationRegistry.getRevision ?? (() => 0),
    );
    const voiceProviderId = storage((state) => state.settings.voice.providerId);
    const voiceLanguageKind = storage((state) => projectConversationLanguagePreference(state.settings.voice, voiceSettingsDeclarationRegistry).kind);
    const declarations = React.useMemo(() => getSettingsPageDeclarations(localizePluginText, storage.getState().settings), [localizePluginText, voiceDeclarationRevision, voiceProviderId, voiceLanguageKind]);

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

        // Literal evidence takes priority. Typo recovery may use only the displayed title,
        // never fuzzy descriptions, keywords or locations ("harbor" -> "behavior").
        const project = ({ item: doc, matches }: FuseResult<SettingsPageSearchDoc>, allowTitleTypo = false): SettingsPageSearchResult[] => {
            const contains = (value: string) => value.toLowerCase().includes(q);
            const visibleMatch = [doc.title, ...(doc.setting?.path ?? [])].some(contains);
            const keyword = doc.keywords.find(contains);
            const descriptionMatch = doc.subtitle.toLowerCase().indexOf(q);
            // Prefer the explicit search word. Description-only matches begin at the hit,
            // so a row clamp cannot hide the evidence behind a long lead or location.
            const matchText = visibleMatch ? undefined : keyword ?? (descriptionMatch < 0 ? undefined
                : `${descriptionMatch > 0 ? '…' : ''}${doc.subtitle.slice(descriptionMatch)}`);
            if (!visibleMatch && !matchText && !(allowTitleTypo && matches?.some(match => match.key === 'title'))) return [];
            return [{ id: doc.id, route: doc.route,
                ...(doc.setting ? { setting: doc.setting } : {}),
                ...(matchText ? { matchText } : {}) }];
        };
        // Pages stay first without hiding matching rows behind a shared result cap.
        const matches = [
            ...fuses.pages.search(q),
            ...fuses.settings.search(q),
        ];
        const literalResults = matches.flatMap(result => project(result));
        return literalResults.length > 0 ? literalResults : matches.flatMap(result => project(result, true));
    }, [fuses]);

    return {
        tree,
        activePageId,
        search,
    };
}
