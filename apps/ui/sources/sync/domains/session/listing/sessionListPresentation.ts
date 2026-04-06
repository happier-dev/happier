import type { ServerSelectionPresentation } from '@/sync/domains/server/selection/serverSelectionTypes';
import type { SessionListViewItem } from './sessionListViewData';
import { getSessionStorageKind, type SessionListStorageFilter } from '../sessionStorageKind';
import { normalizeTrimmedStringArrayWithSharedEmpty } from './normalizeTrimmedStringArrayWithSharedEmpty';
import { normalizeTrimmedString } from './normalizeTrimmedString';

type ApplySessionListPresentationParams = Readonly<{
    enabled: boolean;
    presentation: ServerSelectionPresentation;
    selectedServerIds?: ReadonlyArray<string>;
}>;

type ResolveSessionListSourceDataParams = Readonly<{
    enabled: boolean;
    activeServerId: string;
    activeData: ReadonlyArray<SessionListViewItem> | null;
    byServerId?: Readonly<Record<string, ReadonlyArray<SessionListViewItem> | null | undefined>>;
    selectedServerIds?: ReadonlyArray<string>;
}>;

type ResolveVisibleSessionListSummaryParams = ResolveSessionListSourceDataParams;

type ResolvedSelectedServerSources = Readonly<{
    selectedServerIds: ReadonlyArray<string>;
    activeServerId: string;
    scoped: Readonly<Record<string, ReadonlyArray<SessionListViewItem> | null | undefined>>;
    selectedSources: ReadonlyArray<ReadonlyArray<SessionListViewItem>>;
    usedOnlyActiveDataSource: boolean;
    hasResolvedSelectedSource: boolean;
    hasUnresolvedSelectedSource: boolean;
}>;

export type VisibleSessionListSummary = Readonly<{
    sessionsReady: boolean;
    sessionCount: number;
}>;

const EMPTY_VISIBLE_SESSION_LIST_SUMMARY: VisibleSessionListSummary = Object.freeze({
    sessionsReady: true,
    sessionCount: 0,
});

const LOADING_VISIBLE_SESSION_LIST_SUMMARY: VisibleSessionListSummary = Object.freeze({
    sessionsReady: false,
    sessionCount: 0,
});

function toServerLabel(item: SessionListViewItem): string {
    const name = String(item.serverName ?? '').trim();
    if (name) return name;
    const id = normalizeTrimmedString(item.serverId);
    if (id) return id;
    return 'Unknown server';
}

function stripSyntheticServerHeaders(data: ReadonlyArray<SessionListViewItem>): SessionListViewItem[] {
    return data.filter((item) => !(item.type === 'header' && item.headerKind === 'server'));
}

function hasSyntheticServerHeaders(data: ReadonlyArray<SessionListViewItem>): boolean {
    return data.some((item) => item.type === 'header' && item.headerKind === 'server');
}

type VisibleServerCoverage = Readonly<{
    distinctServerCount: number;
    coversVisibleServerIds: boolean;
    coversVisibleSessionServerIds: boolean;
    hasSyntheticServerHeaders: boolean;
    isAlreadyCanonicalGroupedServerPresentation: boolean;
}>;

function resolveVisibleServerCoverage(
    data: ReadonlyArray<SessionListViewItem>,
    selectedServerSet: ReadonlySet<string>,
): VisibleServerCoverage {
    const distinctServerIds = new Set<string>();
    let currentServerId: string | null = null;
    let seenSessionInCurrentGroup = false;
    let sawServerGroup = false;
    let coversVisibleServerIds = true;
    let coversVisibleSessionServerIds = true;
    let hasSyntheticServerHeaders = false;
    let isAlreadyCanonicalGroupedServerPresentation = false;

    for (const item of data) {
        if (item.type === 'header') {
            if (item.headerKind === 'server') {
                hasSyntheticServerHeaders = true;
                coversVisibleServerIds = false;
                if (sawServerGroup && !seenSessionInCurrentGroup) {
                    coversVisibleSessionServerIds = false;
                    isAlreadyCanonicalGroupedServerPresentation = false;
                }

                currentServerId = normalizeTrimmedString(item.serverId);
                if (!currentServerId) {
                    coversVisibleServerIds = false;
                    coversVisibleSessionServerIds = false;
                    break;
                }

                sawServerGroup = true;
                seenSessionInCurrentGroup = false;
                isAlreadyCanonicalGroupedServerPresentation = true;
                continue;
            }

            isAlreadyCanonicalGroupedServerPresentation = false;
            continue;
        }

        if (item.type !== 'session') {
            isAlreadyCanonicalGroupedServerPresentation = false;
            break;
        }

        const serverId = normalizeTrimmedString(item.serverId);
        if (!serverId) {
            isAlreadyCanonicalGroupedServerPresentation = false;
            continue;
        }

        distinctServerIds.add(serverId);
        if (!selectedServerSet.has(serverId)) {
            coversVisibleServerIds = false;
            coversVisibleSessionServerIds = false;
        }

        if (currentServerId && serverId !== currentServerId) {
            coversVisibleServerIds = false;
            coversVisibleSessionServerIds = false;
            isAlreadyCanonicalGroupedServerPresentation = false;
        }

        seenSessionInCurrentGroup = true;
    }

    if (sawServerGroup && !seenSessionInCurrentGroup) {
        coversVisibleSessionServerIds = false;
    }

    return {
        distinctServerCount: distinctServerIds.size,
        coversVisibleServerIds,
        coversVisibleSessionServerIds,
        hasSyntheticServerHeaders,
        isAlreadyCanonicalGroupedServerPresentation:
            hasSyntheticServerHeaders && isAlreadyCanonicalGroupedServerPresentation && seenSessionInCurrentGroup,
    };
}

function countSessionItems(data: ReadonlyArray<SessionListViewItem>): number {
    let count = 0;
    for (const item of data) {
        if (item.type === 'session') {
            count += 1;
        }
    }
    return count;
}

function countSessionItemsByStorageFilter(
    data: ReadonlyArray<SessionListViewItem>,
    storageFilter: SessionListStorageFilter,
): number {
    if (storageFilter === 'all') {
        return countSessionItems(data);
    }

    let count = 0;
    for (const item of data) {
        if (item.type !== 'session') continue;
        if (getSessionStorageKind(item.session) !== storageFilter) continue;
        count += 1;
    }
    return count;
}

function resolveSelectedServerSources(
    params: ResolveSessionListSourceDataParams,
): ResolvedSelectedServerSources | null {
    const selectedServerIds = normalizeTrimmedStringArrayWithSharedEmpty(params.selectedServerIds);
    if (selectedServerIds.length === 0) {
        return null;
    }

    const activeServerId = normalizeTrimmedString(params.activeServerId);
    const scoped = params.byServerId ?? {};
    const selectedSources: ReadonlyArray<SessionListViewItem>[] = [];
    let usedOnlyActiveDataSource = true;
    let hasResolvedSelectedSource = false;
    let hasUnresolvedSelectedSource = false;

    for (const serverId of selectedServerIds) {
        const fromCache = scoped[serverId];
        const source = fromCache ?? (serverId === activeServerId ? params.activeData : null);
        if (source == null) {
            hasUnresolvedSelectedSource = true;
            continue;
        }

        hasResolvedSelectedSource = true;
        if (source !== params.activeData) {
            usedOnlyActiveDataSource = false;
        }
        selectedSources.push(source);
    }

    return {
        selectedServerIds,
        activeServerId,
        scoped,
        selectedSources,
        usedOnlyActiveDataSource,
        hasResolvedSelectedSource,
        hasUnresolvedSelectedSource,
    };
}

export function resolveSessionListSourceData(
    params: ResolveSessionListSourceDataParams,
): ReadonlyArray<SessionListViewItem> | null {
    if (!params.enabled) {
        return params.activeData;
    }

    const selectedSourcesState = resolveSelectedServerSources(params);
    if (!selectedSourcesState) {
        return params.activeData;
    }

    const merged: SessionListViewItem[] = [];

    for (const source of selectedSourcesState.selectedSources) {
        merged.push(...source);
    }

    if (selectedSourcesState.hasUnresolvedSelectedSource) {
        return null;
    }

    if (merged.length > 0) {
        if (
            selectedSourcesState.usedOnlyActiveDataSource
            && params.activeData
            && merged.length === params.activeData.length
        ) {
            let matchesActiveData = true;
            for (let index = 0; index < merged.length; index++) {
                if (merged[index] !== params.activeData[index]) {
                    matchesActiveData = false;
                    break;
                }
            }

            if (matchesActiveData) {
                return params.activeData;
            }
        }
        return merged;
    }

    if (selectedSourcesState.hasResolvedSelectedSource) {
        return selectedSourcesState.usedOnlyActiveDataSource && params.activeData ? params.activeData : merged;
    }

    if (selectedSourcesState.hasUnresolvedSelectedSource) {
        return null;
    }

    return null;
}

export function resolveVisibleSessionListSummary(
    params: ResolveVisibleSessionListSummaryParams,
    storageFilter: SessionListStorageFilter = 'all',
): VisibleSessionListSummary {
    const countForSource = (source: ReadonlyArray<SessionListViewItem> | null): VisibleSessionListSummary => {
        if (source === null) {
            return LOADING_VISIBLE_SESSION_LIST_SUMMARY;
        }
        const sessionCount = countSessionItemsByStorageFilter(source, storageFilter);
        if (sessionCount === 0) {
            return EMPTY_VISIBLE_SESSION_LIST_SUMMARY;
        }
        return {
            sessionsReady: true,
            sessionCount,
        };
    };

    if (!params.enabled) {
        return countForSource(params.activeData);
    }

    const selectedSourcesState = resolveSelectedServerSources(params);
    if (!selectedSourcesState) {
        return countForSource(params.activeData);
    }

    let sessionCount = 0;

    for (const source of selectedSourcesState.selectedSources) {
        sessionCount += countSessionItemsByStorageFilter(source, storageFilter);
    }

    if (selectedSourcesState.hasUnresolvedSelectedSource) {
        return LOADING_VISIBLE_SESSION_LIST_SUMMARY;
    }

    if (selectedSourcesState.hasResolvedSelectedSource) {
        if (sessionCount === 0) {
            return EMPTY_VISIBLE_SESSION_LIST_SUMMARY;
        }
        return { sessionsReady: true, sessionCount };
    }

    return LOADING_VISIBLE_SESSION_LIST_SUMMARY;
}

export function applySessionListPresentation(
    data: ReadonlyArray<SessionListViewItem>,
    params: ApplySessionListPresentationParams,
): ReadonlyArray<SessionListViewItem> {
    if (!params.enabled) {
        return data;
    }

    const selectedServerIds = normalizeTrimmedStringArrayWithSharedEmpty(params.selectedServerIds);
    const selectedServerSet = new Set(selectedServerIds);
    const visibleServerCoverage = resolveVisibleServerCoverage(data, selectedServerSet);

    if (selectedServerSet.size === 0 && !visibleServerCoverage.hasSyntheticServerHeaders) {
        if (params.presentation === 'flat-with-badge') {
            return data;
        }
        if (visibleServerCoverage.distinctServerCount <= 1) {
            return data;
        }
    }

    if (
        params.presentation === 'flat-with-badge'
        && selectedServerSet.size > 0
        && !visibleServerCoverage.hasSyntheticServerHeaders
        && visibleServerCoverage.coversVisibleServerIds
    ) {
        return data;
    }

    if (
        params.presentation === 'grouped'
        && selectedServerSet.size > 0
        && !visibleServerCoverage.hasSyntheticServerHeaders
        && visibleServerCoverage.distinctServerCount <= 1
        && visibleServerCoverage.coversVisibleServerIds
    ) {
        return data;
    }

    const withoutServerHeaders = hasSyntheticServerHeaders(data)
        ? stripSyntheticServerHeaders(data)
        : data;
    const filteredBySelection = selectedServerSet.size > 0
        ? (() => {
            const filtered: SessionListViewItem[] = [];
            const pendingUnscoped: SessionListViewItem[] = [];
            for (const item of withoutServerHeaders) {
                const serverId = normalizeTrimmedString(item.serverId);
                if (!serverId) {
                    pendingUnscoped.push(item);
                    continue;
                }
                if (!selectedServerSet.has(serverId)) {
                    pendingUnscoped.length = 0;
                    continue;
                }
                if (pendingUnscoped.length > 0) {
                    filtered.push(...pendingUnscoped);
                    pendingUnscoped.length = 0;
                }
                filtered.push(item);
            }
            return filtered;
        })()
        : withoutServerHeaders;

    if (params.presentation === 'flat-with-badge') {
        return filteredBySelection;
    }

    if (
        params.presentation === 'grouped'
        && selectedServerSet.size > 0
        && visibleServerCoverage.isAlreadyCanonicalGroupedServerPresentation
        && visibleServerCoverage.coversVisibleSessionServerIds
    ) {
        return data;
    }

    if (selectedServerSet.size === 0 && visibleServerCoverage.isAlreadyCanonicalGroupedServerPresentation) {
        return data;
    }

    if (resolveVisibleServerCoverage(filteredBySelection, selectedServerSet).distinctServerCount <= 1) {
        return filteredBySelection;
    }

    const serverOrder: string[] = [];
    const groups = new Map<string, SessionListViewItem[]>();
    const unknownServerKey = '__unknown_server__';
    const pendingUnscopedItems: SessionListViewItem[] = [];

    for (const item of filteredBySelection) {
        const scopedId = normalizeTrimmedString(item.serverId);
        if (!scopedId) {
            pendingUnscopedItems.push(item);
            continue;
        }
        const id = scopedId;
        if (!groups.has(id)) {
            groups.set(id, []);
            serverOrder.push(id);
        }
        if (pendingUnscopedItems.length > 0) {
            groups.get(id)!.push(...pendingUnscopedItems);
            pendingUnscopedItems.length = 0;
        }
        groups.get(id)!.push(item);
    }

    if (pendingUnscopedItems.length > 0) {
        if (!groups.has(unknownServerKey)) {
            groups.set(unknownServerKey, []);
            serverOrder.push(unknownServerKey);
        }
        groups.get(unknownServerKey)!.push(...pendingUnscopedItems);
    }

    const grouped: SessionListViewItem[] = [];
    for (const serverId of serverOrder) {
        const items = groups.get(serverId);
        if (!items || items.length === 0) continue;
        const scopedItem = items.find((item) => normalizeTrimmedString(item.serverId)) ?? items[0];
        grouped.push({
            type: 'header',
            title: toServerLabel(scopedItem),
            headerKind: 'server',
            serverId: serverId === unknownServerKey ? undefined : scopedItem.serverId,
            serverName: scopedItem.serverName,
        });
        grouped.push(...items);
    }

    return grouped;
}
