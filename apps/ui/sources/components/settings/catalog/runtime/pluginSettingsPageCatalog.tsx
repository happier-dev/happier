import * as React from 'react';

import {
    matchesPluginUiDestinationBindingV1,
    normalizePluginUiSubPathV1,
} from '@happier-dev/protocol/plugins/ui';

import { InstalledPluginMarkById } from '@/components/plugins/shared/InstalledPluginMarkById';
import { resolvePluginUiIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import { resolvePluginUiText } from '@/sync/domains/plugins/ui/i18n';
import type {
    PluginUiProjectionModel,
    PluginUiSettingsGroupProjection,
    PluginUiSettingsPageProjection,
} from '@/sync/domains/plugins/ui/projection';

import type { SettingsPageId, SettingsPageNode } from '../types';

const HOST_SETTINGS_GROUPS: Readonly<Record<string, SettingsPageId>> = Object.freeze({
    general: 'groupGeneral',
    aiAndAgents: 'groupAiAndAgents',
    sessionsBehavior: 'groupSessionsBehavior',
    filesAndSourceControl: 'groupFilesAndSourceControl',
    system: 'groupSystem',
});

type RecordValue = Readonly<Record<string, unknown>>;

type PluginSettingsPageCandidate = Readonly<{
    entry: PluginUiSettingsPageProjection;
    pageId: string;
    title: string;
    subtitle?: string;
    keywords: readonly string[];
    iconToken?: string;
    defaultRank: number;
    group: Readonly<
        | { kind: 'host'; hostGroupId: SettingsPageId }
        | { kind: 'plugin'; pluginId: string; localId: string }
    >;
}>;

type PluginSettingsGroupCandidate = Readonly<{
    entry: PluginUiSettingsGroupProjection;
    pluginId: string;
    localId: string;
    title: string;
    iconToken?: string;
    defaultRank: number;
}>;

export type ResolvedPluginSettingsPageDestination = Readonly<{
    page: PluginUiSettingsPageProjection;
    title: string;
}>;

function asRecord(value: unknown): RecordValue | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as RecordValue
        : null;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readStringArray(value: unknown): readonly string[] {
    return Array.isArray(value)
        ? Object.freeze(value.filter((entry): entry is string => readString(entry) !== null))
        : Object.freeze([]);
}

function readDefaultRank(value: unknown): number {
    return typeof value === 'number' && Number.isInteger(value) ? value : Number.MAX_SAFE_INTEGER;
}

function readLocalizedText(params: Readonly<{
    projection: PluginUiProjectionModel;
    pluginId: string;
    value: unknown;
    locale: string;
}>): string | null {
    const literal = readString(params.value);
    if (literal) return literal;
    const localized = asRecord(params.value);
    const fallback = readString(localized?.fallback);
    const text = resolvePluginUiText({
        projection: params.projection,
        pluginId: params.pluginId,
        key: readString(localized?.key),
        fallback,
        locale: params.locale,
    }).trim();
    return text.length > 0 ? text : null;
}

function readPageIdentity(entry: PluginUiSettingsPageProjection): Readonly<{
    pluginId: string;
    pageId: string;
}> | null {
    const page = asRecord(entry.page);
    const identity = asRecord(page?.id);
    const pluginId = readString(identity?.pluginId);
    const pageId = readString(identity?.localId);
    if (!pluginId || !pageId || pluginId !== entry.pluginId || pageId !== entry.descriptorId) {
        return null;
    }
    return Object.freeze({ pluginId, pageId });
}

function hasExactSettingsBinding(entry: PluginUiSettingsPageProjection, pageId: string): boolean {
    const rendererId = entry.binding.renderer.pluginId === entry.pluginId
        ? entry.binding.renderer.localId
        : null;
    if (!rendererId) return false;
    return entry.binding.destination.pluginId === entry.pluginId
        && entry.binding.destination.localId === pageId
        && matchesPluginUiDestinationBindingV1(entry.binding, {
            container: 'settingsPage',
            targetKind: 'app',
            pluginId: entry.pluginId,
            rendererId,
        });
}

function readPluginSettingsPageCandidate(params: Readonly<{
    entry: PluginUiSettingsPageProjection;
    projection: PluginUiProjectionModel;
    locale: string;
}>): PluginSettingsPageCandidate | null {
    const identity = readPageIdentity(params.entry);
    if (!identity || !hasExactSettingsBinding(params.entry, identity.pageId)) return null;
    const page = asRecord(params.entry.page);
    const group = asRecord(page?.group);
    const title = readLocalizedText({
        projection: params.projection,
        pluginId: identity.pluginId,
        value: page?.title,
        locale: params.locale,
    });
    if (!page || !group || !title) return null;

    const groupKind = readString(group.kind);
    let normalizedGroup: PluginSettingsPageCandidate['group'] | null = null;
    if (groupKind === 'host') {
        const hostGroupId = readString(group.id);
        const mapped = hostGroupId ? HOST_SETTINGS_GROUPS[hostGroupId] : undefined;
        if (!mapped) return null;
        normalizedGroup = Object.freeze({ kind: 'host', hostGroupId: mapped });
    } else if (groupKind === 'plugin') {
        const identityRecord = asRecord(group.id);
        const groupPluginId = readString(identityRecord?.pluginId);
        const localId = readString(identityRecord?.localId);
        if (!groupPluginId || !localId || groupPluginId !== identity.pluginId) return null;
        normalizedGroup = Object.freeze({ kind: 'plugin', pluginId: groupPluginId, localId });
    }
    if (!normalizedGroup) return null;

    const subtitle = readLocalizedText({
        projection: params.projection,
        pluginId: identity.pluginId,
        value: page.subtitle,
        locale: params.locale,
    });
    return Object.freeze({
        entry: params.entry,
        pageId: identity.pageId,
        title,
        ...(subtitle ? { subtitle } : {}),
        keywords: readStringArray(page.keywords),
        ...(readString(page.icon) ? { iconToken: readString(page.icon)! } : {}),
        defaultRank: readDefaultRank(page.defaultRank),
        group: normalizedGroup,
    });
}

function readPluginSettingsGroupCandidate(params: Readonly<{
    entry: PluginUiSettingsGroupProjection;
    projection: PluginUiProjectionModel;
    locale: string;
}>): PluginSettingsGroupCandidate | null {
    const group = asRecord(params.entry.group);
    const identity = asRecord(group?.id);
    const pluginId = readString(identity?.pluginId);
    const localId = readString(identity?.localId);
    const title = readLocalizedText({
        projection: params.projection,
        pluginId: params.entry.pluginId,
        value: group?.title,
        locale: params.locale,
    });
    if (!group || !pluginId || !localId || pluginId !== params.entry.pluginId || !title) return null;
    return Object.freeze({
        entry: params.entry,
        pluginId,
        localId,
        title,
        ...(readString(group.icon) ? { iconToken: readString(group.icon)! } : {}),
        defaultRank: readDefaultRank(group.defaultRank),
    });
}

function compareDefaultRankThenId(
    left: Readonly<{ defaultRank: number; id: string }>,
    right: Readonly<{ defaultRank: number; id: string }>,
): number {
    return left.defaultRank !== right.defaultRank
        ? left.defaultRank - right.defaultRank
        : left.id.localeCompare(right.id);
}

/** The one host-generated route grammar for an admitted Settings page. */
export function pluginSettingsPageRoute(pluginId: string, pageId: string): string {
    return `/settings/plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(pageId)}`;
}

/** The typed Expo route pattern of the one mounted Settings page route. */
export const PLUGIN_SETTINGS_PAGE_ROUTE = '/(app)/settings/plugins/[pluginId]/[pageId]' as const;

/**
 * The typed host route for one Settings page and its plugin-local location.
 *
 * The location rides as a param on the SAME two-segment page route the host
 * built, so a page-internal location replacement (`replacePageLocation`) can
 * never leave the page route or add a history entry — the user's real previous
 * screen stays one Back press away.
 */
export function buildPluginSettingsPageRoutePath(input: Readonly<{
    pluginId: string;
    pageId: string;
    subPath: string;
}>): Readonly<{
    pathname: typeof PLUGIN_SETTINGS_PAGE_ROUTE;
    params: Readonly<{ pluginId: string; pageId: string; subPath: string }>;
}> {
    return Object.freeze({
        pathname: PLUGIN_SETTINGS_PAGE_ROUTE,
        params: Object.freeze({
            pluginId: input.pluginId,
            pageId: input.pageId,
            subPath: normalizePluginUiSubPathV1(input.subPath) ?? '',
        }),
    });
}

function readRouteSegment(value: unknown): string | null {
    if (Array.isArray(value)) {
        return value.length === 1 ? readRouteSegment(value[0]) : null;
    }
    return readString(value);
}

/**
 * Reads the host-generated dynamic route segments plus the page's plugin-local
 * location; ambiguous identity params fail closed. An absent location is the
 * page root (`''`); a present-but-illegal one is `null`, the same fail-closed
 * shape the app-page route owner hands back.
 */
export function readPluginSettingsPageRouteParams(params: Readonly<{
    pluginId?: unknown;
    pageId?: unknown;
    subPath?: unknown;
}>): Readonly<{ pluginId: string; pageId: string; subPath: string | null }> | null {
    const pluginId = readRouteSegment(params.pluginId);
    const pageId = readRouteSegment(params.pageId);
    if (!pluginId || !pageId) return null;
    const rawSubPath = params.subPath === undefined ? '' : readRouteSegment(params.subPath);
    const subPath = rawSubPath === null ? null : normalizePluginUiSubPathV1(rawSubPath);
    return Object.freeze({ pluginId, pageId, subPath });
}

/**
 * The generic route resolves through the SAME admission filter as the catalog.
 * Multiple projected records for one qualified page are not chosen by insertion
 * order: they are unavailable until the Registry projection is coherent again.
 */
export function resolveAdmittedPluginSettingsPage(params: Readonly<{
    projection: PluginUiProjectionModel | null | undefined;
    pluginId: string;
    pageId: string;
    locale: string;
}>): ResolvedPluginSettingsPageDestination | null {
    if (!params.projection) return null;
    const matches = Object.values(params.projection.settingsPagesById)
        .map((entry) => readPluginSettingsPageCandidate({
            entry,
            projection: params.projection!,
            locale: params.locale,
        }))
        .filter((candidate): candidate is PluginSettingsPageCandidate => (
            candidate !== null
            && candidate.entry.pluginId === params.pluginId
            && candidate.pageId === params.pageId
        ));
    if (matches.length !== 1) return null;
    const match = matches[0]!;
    return Object.freeze({ page: match.entry, title: resolveSolePluginGroupTitle(params.projection, match, params.locale) ?? match.title });
}

/**
 * A plugin group with one page is one destination named by its plugin ("Sentry", not its generic page
 * title "PRs & Issues", which names a different page). The Settings row and the opened page (tab, header)
 * both read this one rule.
 */
function resolveSolePluginGroupTitle(
    projection: PluginUiProjectionModel,
    candidate: PluginSettingsPageCandidate,
    locale: string,
): string | null {
    const group = candidate.group;
    if (group.kind !== 'plugin') return null;
    const groups = Object.values(projection.settingsGroupsById)
        .map((entry) => readPluginSettingsGroupCandidate({ entry, projection, locale }))
        .filter((entry): entry is PluginSettingsGroupCandidate => entry !== null
            && entry.pluginId === group.pluginId && entry.localId === group.localId);
    if (groups.length !== 1) return null;
    const pagesInGroup = Object.values(projection.settingsPagesById)
        .map((entry) => readPluginSettingsPageCandidate({ entry, projection, locale }))
        .filter((entry) => entry !== null && entry.group.kind === 'plugin'
            && entry.group.pluginId === group.pluginId && entry.group.localId === group.localId);
    return pagesInGroup.length === 1 ? groups[0]!.title : null;
}

/** A plugin row leads with the plugin's own mark; its declared icon stands in until the mark arrives. */
function makePluginIcon(pluginId: string, iconToken: string | undefined) {
    return (): React.ReactNode => (
        <InstalledPluginMarkById pluginId={pluginId} size={16} fallbackIcon={resolvePluginUiIconName(iconToken)} />
    );
}

function makePluginPageNode(candidate: PluginSettingsPageCandidate): SettingsPageNode {
    const pluginId = candidate.entry.pluginId;
    return Object.freeze({
        id: `pluginSettingsPage:${pluginId}:${candidate.pageId}`,
        title: candidate.title,
        ...(candidate.subtitle ? { subtitle: candidate.subtitle } : {}),
        route: pluginSettingsPageRoute(pluginId, candidate.pageId),
        keywords: candidate.keywords,
        icon: makePluginIcon(pluginId, candidate.iconToken),
        pluginSettingsPage: Object.freeze({ pluginId, pageId: candidate.pageId }),
    });
}

/**
 * Adds Registry-admitted Settings destinations to the incumbent Settings tree.
 * This is intentionally a catalog transformer, not a new route/search owner:
 * the returned tree is fed straight back into `useResolvedSettingsPageCatalog`.
 */
export function mergeAdmittedPluginSettingsPages(params: Readonly<{
    baseCatalog: readonly SettingsPageNode[];
    projection: PluginUiProjectionModel | null | undefined;
    locale: string;
}>): readonly SettingsPageNode[] {
    if (!params.projection) return params.baseCatalog;

    const pageCandidates = Object.values(params.projection.settingsPagesById)
        .map((entry) => readPluginSettingsPageCandidate({ entry, projection: params.projection!, locale: params.locale }))
        .filter((entry): entry is PluginSettingsPageCandidate => entry !== null);
    const duplicatePageIdentities = new Set<string>();
    const pageIdentityCounts = new Map<string, number>();
    for (const candidate of pageCandidates) {
        const key = `${candidate.entry.pluginId}\u0000${candidate.pageId}`;
        const count = (pageIdentityCounts.get(key) ?? 0) + 1;
        pageIdentityCounts.set(key, count);
        if (count > 1) duplicatePageIdentities.add(key);
    }
    const uniquePages = pageCandidates.filter((candidate) => !duplicatePageIdentities.has(
        `${candidate.entry.pluginId}\u0000${candidate.pageId}`,
    ));

    const groupCandidates = Object.values(params.projection.settingsGroupsById)
        .map((entry) => readPluginSettingsGroupCandidate({ entry, projection: params.projection!, locale: params.locale }))
        .filter((entry): entry is PluginSettingsGroupCandidate => entry !== null);
    const duplicateGroupIdentities = new Set<string>();
    const groupByIdentity = new Map<string, PluginSettingsGroupCandidate>();
    for (const candidate of groupCandidates) {
        const key = `${candidate.pluginId}\u0000${candidate.localId}`;
        if (groupByIdentity.has(key)) {
            duplicateGroupIdentities.add(key);
            groupByIdentity.delete(key);
        } else if (!duplicateGroupIdentities.has(key)) {
            groupByIdentity.set(key, candidate);
        }
    }

    const hostPagesByGroupId = new Map<SettingsPageId, PluginSettingsPageCandidate[]>();
    const pluginPagesByGroupIdentity = new Map<string, PluginSettingsPageCandidate[]>();
    for (const candidate of uniquePages) {
        if (candidate.group.kind === 'host') {
            const current = hostPagesByGroupId.get(candidate.group.hostGroupId) ?? [];
            current.push(candidate);
            hostPagesByGroupId.set(candidate.group.hostGroupId, current);
            continue;
        }
        const groupKey = `${candidate.group.pluginId}\u0000${candidate.group.localId}`;
        if (!groupByIdentity.has(groupKey)) continue;
        const current = pluginPagesByGroupIdentity.get(groupKey) ?? [];
        current.push(candidate);
        pluginPagesByGroupIdentity.set(groupKey, current);
    }

    const hostPageNodesByGroupId = new Map<SettingsPageId, readonly SettingsPageNode[]>();
    for (const [groupId, candidates] of hostPagesByGroupId) {
        const nodes = [...candidates]
            .sort((left, right) => compareDefaultRankThenId(
                { defaultRank: left.defaultRank, id: left.entry.id },
                { defaultRank: right.defaultRank, id: right.entry.id },
            ))
            .map(makePluginPageNode);
        hostPageNodesByGroupId.set(groupId, Object.freeze(nodes));
    }

    const pluginGroupNodes = [...groupByIdentity.entries()]
        .map(([identity, group]) => ({ identity, group, pages: pluginPagesByGroupIdentity.get(identity) ?? [] }))
        .filter(({ pages }) => pages.length > 0)
        .sort((left, right) => compareDefaultRankThenId(
            { defaultRank: left.group.defaultRank, id: left.group.entry.id },
            { defaultRank: right.group.defaultRank, id: right.group.entry.id },
        ))
        .map(({ group, pages }): SettingsPageNode => {
            // A plugin group with one page is one destination: name it once, by its plugin, rather
            // than a heading per plugin over a row that repeats a generic page title ("PRs & Issues"
            // under GitHub, GitLab, Sentry…). The page title stays a subtitle and a search keyword.
            if (pages.length === 1) {
                const only = pages[0]!;
                const node = makePluginPageNode(only);
                return Object.freeze({
                    ...node,
                    title: group.title,
                    subtitle: only.subtitle ?? only.title,
                    keywords: Object.freeze([...node.keywords ?? [], only.title]),
                    icon: makePluginIcon(group.pluginId, group.iconToken ?? only.iconToken),
                });
            }
            return Object.freeze({
                id: `pluginSettingsGroup:${group.pluginId}:${group.localId}`,
                title: group.title,
                icon: makePluginIcon(group.pluginId, group.iconToken),
                children: Object.freeze([...pages]
                    .sort((left, right) => compareDefaultRankThenId(
                        { defaultRank: left.defaultRank, id: left.entry.id },
                        { defaultRank: right.defaultRank, id: right.entry.id },
                    ))
                    .map(makePluginPageNode)),
            });
        });

    const mergeHostPages = (nodes: readonly SettingsPageNode[]): readonly SettingsPageNode[] => Object.freeze(nodes.map((node) => {
        const children = node.children ? mergeHostPages(node.children) : undefined;
        const additions = hostPageNodesByGroupId.get(node.id) ?? [];
        if (!children && additions.length === 0) return node;
        return Object.freeze({
            ...node,
            children: Object.freeze([...(children ?? []), ...additions]),
        });
    }));

    // Every plugin-owned destination is disclosed under the Plugins page's own row, collapsed unless one is
    // open: the rail stays a calm list of the host's pages instead of growing a heading and a row per plugin.
    if (pluginGroupNodes.length === 0) return mergeHostPages(params.baseCatalog);
    let placed = false;
    const nestUnderPlugins = (nodes: readonly SettingsPageNode[]): readonly SettingsPageNode[] => Object.freeze(nodes.map((node) => {
        if (node.id === 'plugins') {
            placed = true;
            return Object.freeze({ ...node, children: Object.freeze([...(node.children ?? []), ...pluginGroupNodes]) });
        }
        return node.children ? Object.freeze({ ...node, children: nestUnderPlugins(node.children) }) : node;
    }));
    const nested = nestUnderPlugins(mergeHostPages(params.baseCatalog));
    if (placed) return nested;
    // The Plugins page is switched off on this Home: its destinations keep one heading after the host groups.
    return Object.freeze(nested.map((node) => node.id !== 'settings' ? node : Object.freeze({
        ...node,
        children: Object.freeze([...(node.children ?? []), Object.freeze({
            id: 'groupPlugins',
            titleKey: 'settings.pluginPages',
            children: Object.freeze(pluginGroupNodes),
        }) as SettingsPageNode]),
    })));
}
