import * as React from 'react';

import { matchesPluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import { Icon } from '@/components/ui/icons/Icon';
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

function readRouteSegment(value: unknown): string | null {
    if (Array.isArray(value)) {
        return value.length === 1 ? readRouteSegment(value[0]) : null;
    }
    return readString(value);
}

/** Reads exactly the two host-generated dynamic route segments; ambiguous params fail closed. */
export function readPluginSettingsPageRouteParams(params: Readonly<{
    pluginId?: unknown;
    pageId?: unknown;
}>): Readonly<{ pluginId: string; pageId: string }> | null {
    const pluginId = readRouteSegment(params.pluginId);
    const pageId = readRouteSegment(params.pageId);
    return pluginId && pageId ? Object.freeze({ pluginId, pageId }) : null;
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
    return matches.length === 1
        ? Object.freeze({ page: matches[0]!.entry, title: matches[0]!.title })
        : null;
}

function makePluginIcon(iconToken: string | undefined) {
    return ({ theme }: Parameters<NonNullable<SettingsPageNode['icon']>>[0]): React.ReactNode => (
        <Icon
            name={resolvePluginUiIconName(iconToken)}
            size={16}
            color={theme.colors.text.secondary}
        />
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
        icon: makePluginIcon(candidate.iconToken),
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
        .map(({ group, pages }): SettingsPageNode => Object.freeze({
            id: `pluginSettingsGroup:${group.pluginId}:${group.localId}`,
            title: group.title,
            icon: makePluginIcon(group.iconToken),
            children: Object.freeze([...pages]
                .sort((left, right) => compareDefaultRankThenId(
                    { defaultRank: left.defaultRank, id: left.entry.id },
                    { defaultRank: right.defaultRank, id: right.entry.id },
                ))
                .map(makePluginPageNode)),
        }));

    const mergeHostPages = (nodes: readonly SettingsPageNode[]): readonly SettingsPageNode[] => Object.freeze(nodes.map((node) => {
        const children = node.children ? mergeHostPages(node.children) : undefined;
        const additions = hostPageNodesByGroupId.get(node.id) ?? [];
        if (!children && additions.length === 0) return node;
        return Object.freeze({
            ...node,
            children: Object.freeze([...(children ?? []), ...additions]),
        });
    }));

    return Object.freeze(mergeHostPages(params.baseCatalog).map((node) => {
        if (node.id !== 'settings' || pluginGroupNodes.length === 0) return node;
        return Object.freeze({
            ...node,
            children: Object.freeze([...(node.children ?? []), ...pluginGroupNodes]),
        });
    }));
}

export const __testables = {
    pluginSettingsPageRoute,
};
