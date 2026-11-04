import type { ServerSelectionPresentation } from '@/sync/domains/server/selection/serverSelectionTypes';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import { areServerProfileIdentifiersEquivalent, getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import type { SessionListQueryHomeState } from './sessionListQueryController';

import { normalizeTrimmedStringArrayWithSharedEmpty } from './normalizeTrimmedStringArrayWithSharedEmpty';
import { normalizeTrimmedString } from './normalizeTrimmedString';
import { buildSessionListIndexNodeId } from '@/sync/domains/sessionList/sessionListIndexIdentity';

type ApplySessionListPresentationParams = Readonly<{
    enabled: boolean;
    presentation: ServerSelectionPresentation;
    selectedServerIds?: ReadonlyArray<string>;
}>;

const EMPTY_SESSION_LIST_INDEX_ITEMS: SessionListIndexItem[] = [];
const EMPTY_VISIBLE_SESSION_LIST_SUMMARY = Object.freeze({ sessionsReady: true, sessionCount: 0 });
const LOADING_VISIBLE_SESSION_LIST_SUMMARY = Object.freeze({ sessionsReady: false, sessionCount: 0 });

export type VisibleSessionListSummary = Readonly<{
    sessionsReady: boolean;
    sessionCount: number;
}>;

export type SessionListQueryPresentation =
    | Readonly<{ kind: 'initial_loading' }>
    | Readonly<{
        kind: 'ready';
        complete: boolean;
        /**
         * A selected Home withheld historical shared
         * Sessions pending their owner's metadata upgrade: the list is not whole.
         */
        historicalSharesWithheld?: boolean;
        /** Whether real pagination can still advance while historical shares are withheld. */
        hasMore?: boolean;
    }>
    | Readonly<{ kind: 'refreshing'; retainedRows: true }>
    | Readonly<{
        kind: 'partial';
        unavailableHomes: readonly Readonly<{
            serverId: string;
            reason: 'not_selected' | 'offline' | 'error' | 'unsupported';
        }>[];
    }>
    | Readonly<{ kind: 'error'; retainedRows: boolean }>;

/**
 * Projects the query repository's per-Home lifecycle into the one presentation
 * contract consumed by the Sessions surface. This is the only place where a
 * zero-row query can become authoritative.
 */
export function resolveSessionListQueryPresentation(input: Readonly<{
    selectedServerIds: readonly string[];
    statesByServerId: Readonly<Record<string, SessionListQueryHomeState | undefined>>;
    coverageComplete: boolean;
    retainedRowCount: number;
    sessionsEnabled?: boolean;
    workflowRunUnavailableHomes?: readonly Readonly<{
        serverId: string;
        reason: 'not_selected' | 'unsupported';
    }>[];
    workflowRunWindow?: Readonly<{
        serverId?: string | null;
        status: 'loading' | 'loaded' | 'failed';
        hasMore: boolean;
        loadingMore: boolean;
        loadMoreFailed: boolean;
    }>;
    /**
     * The Home is still being reached (right after sign-in or a restart): a query that failed in that gap
     * has not settled into an error, so it reads as loading and the reconnect reads it again.
     */
    settlingHomeServerId?: string | null;
}>): SessionListQueryPresentation {
    const presentation = resolveSettledSessionListQueryPresentation(input);
    if (presentation.kind !== 'error') return presentation;
    const { failedServerIds, ...error } = presentation;
    return input.settlingHomeServerId && failedServerIds.length > 0
        && failedServerIds.every(serverId => areServerProfileIdentifiersEquivalent(serverId, input.settlingHomeServerId))
        ? error.retainedRows ? { kind: 'refreshing', retainedRows: true } : { kind: 'initial_loading' }
        : error;
}

type ScopedQueryPresentation = Exclude<SessionListQueryPresentation, { kind: 'error' }>
    | Readonly<{ kind: 'error'; retainedRows: boolean; failedServerIds: readonly string[] }>;

function resolveSettledSessionListQueryPresentation(input: Readonly<{
    selectedServerIds: readonly string[];
    statesByServerId: Readonly<Record<string, SessionListQueryHomeState | undefined>>;
    coverageComplete: boolean;
    retainedRowCount: number;
    sessionsEnabled?: boolean;
    workflowRunUnavailableHomes?: readonly Readonly<{
        serverId: string;
        reason: 'not_selected' | 'unsupported';
    }>[];
    workflowRunWindow?: Readonly<{
        serverId?: string | null;
        status: 'loading' | 'loaded' | 'failed';
        hasMore: boolean;
        loadingMore: boolean;
        loadMoreFailed: boolean;
    }>;
}>): ScopedQueryPresentation {
    const window = input.workflowRunWindow;
    if (window?.status === 'failed' || window?.loadMoreFailed) {
        // A Run failure must not hide an independently failed Session query.
        // Without the Run's producing Home we cannot attribute the combined failure.
        const queryFailures = input.sessionsEnabled === false ? [] : input.selectedServerIds.filter(serverId =>
            input.statesByServerId[serverId]?.phase === 'error');
        return { kind: 'error', retainedRows: input.retainedRowCount > 0,
            failedServerIds: window.serverId ? [window.serverId, ...queryFailures] : [] };
    }
    if (window?.status === 'loading') {
        return input.retainedRowCount > 0
            ? { kind: 'refreshing', retainedRows: true }
            : { kind: 'initial_loading' };
    }
    const sessions = input.sessionsEnabled === false
        ? { kind: 'ready' as const, complete: true }
        : resolveSessionQueryPresentation(input);
    if (input.workflowRunUnavailableHomes && input.workflowRunUnavailableHomes.length > 0) {
        const unavailableHomes = sessions.kind === 'partial' ? [...sessions.unavailableHomes] : [];
        for (const home of input.workflowRunUnavailableHomes) {
            if (!unavailableHomes.some((entry) => areServerProfileIdentifiersEquivalent(entry.serverId, home.serverId))) unavailableHomes.push(home);
        }
        return { kind: 'partial', unavailableHomes };
    }
    if (sessions.kind === 'initial_loading' && input.retainedRowCount > 0) {
        return { kind: 'refreshing', retainedRows: true };
    }
    if (window && sessions.kind === 'ready' && (window.hasMore || window.loadingMore)) {
        return { ...sessions, complete: false, hasMore: window.hasMore };
    }
    return sessions;
}

function resolveSessionQueryPresentation(input: Readonly<{
    selectedServerIds: readonly string[];
    statesByServerId: Readonly<Record<string, SessionListQueryHomeState | undefined>>;
    coverageComplete: boolean;
    retainedRowCount: number;
}>): ScopedQueryPresentation {
    const selectedServerIds = normalizeTrimmedStringArrayWithSharedEmpty(input.selectedServerIds);
    if (selectedServerIds.length === 0) {
        return input.coverageComplete
            ? { kind: 'ready', complete: true }
            : { kind: 'initial_loading' };
    }

    const unavailableHomes: Array<Extract<SessionListQueryPresentation, { kind: 'partial' }>['unavailableHomes'][number]> = [];
    let hasReadyHome = false;
    let hasPendingHome = false;
    let hasTerminalError = false;

    for (const serverId of selectedServerIds) {
        const state = input.statesByServerId[serverId];
        if (!state || state.phase === 'idle' || state.phase === 'loading' || state.phase === 'refreshing') {
            hasPendingHome = true;
            continue;
        }
        if (state.phase === 'ready') {
            hasReadyHome = true;
            if (state.membershipUnavailableReason) unavailableHomes.push({ serverId, reason: 'unsupported' });
            continue;
        }
        if (state.phase === 'not_selected') {
            unavailableHomes.push({ serverId, reason: 'not_selected' });
            continue;
        }
        if (state.phase === 'offline') {
            unavailableHomes.push({ serverId, reason: 'offline' });
            continue;
        }
        const reason = state.failureReason === 'unsupported' ? 'unsupported' : 'error';
        unavailableHomes.push({ serverId, reason });
        if (reason === 'error') hasTerminalError = true;
    }

    if (hasPendingHome) {
        return input.retainedRowCount > 0
            ? { kind: 'refreshing', retainedRows: true }
            : { kind: 'initial_loading' };
    }
    if (unavailableHomes.length > 0) {
        if (!hasReadyHome && hasTerminalError) {
            return { kind: 'error', retainedRows: input.retainedRowCount > 0,
                failedServerIds: unavailableHomes.filter(home => home.reason === 'error').map(home => home.serverId) };
        }
        return { kind: 'partial', unavailableHomes };
    }
    const historicalSharesWithheld = selectedServerIds.some((serverId) => (
        (input.statesByServerId[serverId]?.metadataUpgradeRequiredCount ?? 0) > 0
    ));
    return historicalSharesWithheld
        ? {
            kind: 'ready',
            complete: input.coverageComplete,
            historicalSharesWithheld,
            hasMore: selectedServerIds.some((serverId) => {
                const state = input.statesByServerId[serverId];
                return state?.hasNext === true || state?.attentionHasNext === true;
            }),
        }
        : { kind: 'ready', complete: input.coverageComplete };
}

type ResolveSessionListSourceIndexParams = Readonly<{
    enabled: boolean;
    activeServerId: string;
    activeIndex: ReadonlyArray<SessionListIndexItem> | null;
    byServerId?: Readonly<Record<string, ReadonlyArray<SessionListIndexItem> | null | undefined>>;
    selectedServerIds?: ReadonlyArray<string>;
}>;

type ResolvedSelectedServerSources = Readonly<{
    selectedServerIds: ReadonlyArray<string>;
    activeServerId: string;
    scoped: Readonly<Record<string, ReadonlyArray<SessionListIndexItem> | null | undefined>>;
    selectedSources: ReadonlyArray<ReadonlyArray<SessionListIndexItem>>;
    usedOnlyActiveIndexSource: boolean;
    hasResolvedSelectedSource: boolean;
    hasUnresolvedSelectedSource: boolean;
}>;

export function readSessionListIndexForServerId(
    scoped: Readonly<Record<string, ReadonlyArray<SessionListIndexItem> | null | undefined>> | null | undefined,
    serverIdRaw: string | null | undefined,
): ReadonlyArray<SessionListIndexItem> | null | undefined {
    const serverId = normalizeTrimmedString(serverIdRaw);
    if (!scoped || !serverId) return undefined;
    if (Object.prototype.hasOwnProperty.call(scoped, serverId)) {
        return scoped[serverId] ?? null;
    }
    for (const candidateServerId of Object.keys(scoped)) {
        if (!areServerProfileIdentifiersEquivalent(candidateServerId, serverId)) continue;
        return scoped[candidateServerId] ?? null;
    }
    return undefined;
}

function resolveSelectedServerSources(
    params: ResolveSessionListSourceIndexParams,
): ResolvedSelectedServerSources | null {
    const selectedServerIds = normalizeTrimmedStringArrayWithSharedEmpty(params.selectedServerIds);
    if (selectedServerIds.length === 0) {
        return null;
    }

    const activeServerId = normalizeTrimmedString(params.activeServerId);
    const scoped = params.byServerId ?? {};
    const selectedSources: ReadonlyArray<SessionListIndexItem>[] = [];
    let usedOnlyActiveIndexSource = true;
    let hasResolvedSelectedSource = false;
    let hasUnresolvedSelectedSource = false;

    for (const serverId of selectedServerIds) {
        const fromCache = readSessionListIndexForServerId(scoped, serverId);
        const source = areServerProfileIdentifiersEquivalent(serverId, activeServerId)
            ? (params.activeIndex ?? fromCache ?? null)
            : (fromCache ?? null);
        if (source == null) {
            hasUnresolvedSelectedSource = true;
            continue;
        }

        hasResolvedSelectedSource = true;
        if (source !== params.activeIndex) {
            usedOnlyActiveIndexSource = false;
        }
        selectedSources.push(source);
    }

    return {
        selectedServerIds,
        activeServerId,
        scoped,
        selectedSources,
        usedOnlyActiveIndexSource,
        hasResolvedSelectedSource,
        hasUnresolvedSelectedSource,
    };
}

export function resolveSessionListSourceIndex(
    params: ResolveSessionListSourceIndexParams,
): ReadonlyArray<SessionListIndexItem> | null {
    if (!params.enabled) {
        return params.activeIndex;
    }

    const selectedSourcesState = resolveSelectedServerSources(params);
    if (!selectedSourcesState) {
        return params.activeIndex;
    }

    const merged: SessionListIndexItem[] = [];
    for (const source of selectedSourcesState.selectedSources) {
        merged.push(...source);
    }

    if (merged.length > 0) {
        if (
            selectedSourcesState.usedOnlyActiveIndexSource
            && params.activeIndex
            && merged.length === params.activeIndex.length
        ) {
            let matchesActiveIndex = true;
            for (let index = 0; index < merged.length; index++) {
                if (merged[index] !== params.activeIndex[index]) {
                    matchesActiveIndex = false;
                    break;
                }
            }

            if (matchesActiveIndex) {
                return params.activeIndex;
            }
        }
        return merged;
    }

    if (selectedSourcesState.hasResolvedSelectedSource) {
        // Stale-while-revalidate: keep resolved sources visible even if some selected servers are still loading.
        return selectedSourcesState.usedOnlyActiveIndexSource && params.activeIndex ? params.activeIndex : merged;
    }

    if (selectedSourcesState.hasUnresolvedSelectedSource) {
        return null;
    }

    return null;
}

function resolveSessionStorageKindFromIndexItem(
    item: Extract<SessionListIndexItem, { type: 'session' }>,
): 'persisted' | 'direct' {
    return item.storageKind === 'direct' ? 'direct' : 'persisted';
}

export function resolveVisibleSessionListIndexSummary(
    params: ResolveSessionListSourceIndexParams,
    storageFilter: SessionListStorageFilter = 'all',
): VisibleSessionListSummary {
    const countSessions = (source: ReadonlyArray<SessionListIndexItem>) => {
        let sessionCount = 0;
        if (storageFilter === 'all') {
            for (const item of source) {
                if (item.type === 'session') {
                    sessionCount += 1;
                }
            }
            return sessionCount;
        }

        for (const item of source) {
            if (item.type !== 'session') continue;
            if (resolveSessionStorageKindFromIndexItem(item) !== storageFilter) continue;
            sessionCount += 1;
        }
        return sessionCount;
    };

    if (!params.enabled) {
        const source = params.activeIndex;
        if (source === null) {
            return LOADING_VISIBLE_SESSION_LIST_SUMMARY;
        }
        const sessionCount = countSessions(source);
        if (sessionCount === 0) {
            return EMPTY_VISIBLE_SESSION_LIST_SUMMARY;
        }
        return { sessionsReady: true, sessionCount };
    }

    const selectedSourcesState = resolveSelectedServerSources(params);
    if (!selectedSourcesState) {
        const source = params.activeIndex;
        if (source === null) {
            return LOADING_VISIBLE_SESSION_LIST_SUMMARY;
        }
        const sessionCount = countSessions(source);
        if (sessionCount === 0) {
            return EMPTY_VISIBLE_SESSION_LIST_SUMMARY;
        }
        return { sessionsReady: true, sessionCount };
    }

    let sessionCount = 0;
    for (const source of selectedSourcesState.selectedSources) {
        sessionCount += countSessions(source);
    }

    if (selectedSourcesState.hasResolvedSelectedSource) {
        if (sessionCount === 0) {
            return EMPTY_VISIBLE_SESSION_LIST_SUMMARY;
        }
        return { sessionsReady: true, sessionCount };
    }

    if (selectedSourcesState.hasUnresolvedSelectedSource) {
        return LOADING_VISIBLE_SESSION_LIST_SUMMARY;
    }

    return LOADING_VISIBLE_SESSION_LIST_SUMMARY;
}

function stripSyntheticServerHeaders(data: ReadonlyArray<SessionListIndexItem>): SessionListIndexItem[] {
    return data.filter((item) => !(item.type === 'header' && item.headerKind === 'server'));
}

/** Restore admitted Home/primary bands after group moves without changing logical collapse keys. */
export function restoreSessionListContextHeaders(
    ordered: SessionListIndexItem[],
    presented: readonly SessionListIndexItem[],
): SessionListIndexItem[] {
    const headers = new Map<string, Extract<SessionListIndexItem, { type: 'header' }>>();
    const sessions = new Map<string, Extract<SessionListIndexItem, { type: 'header' }>>();
    for (const item of presented) {
        if (item.type !== 'header' || !item.serverId) continue;
        if (item.headerKind === 'server' && !headers.has(item.serverId)) headers.set(item.serverId, item);
        if (item.headerKind === 'sessions' && !sessions.has(item.serverId)) sessions.set(item.serverId, item);
    }
    if (headers.size === 0 && sessions.size === 0) return ordered;
    const seenHomes = new Set<string>();
    const output: SessionListIndexItem[] = [];
    let previousHome: string | undefined;
    for (const item of ordered) {
        if (item.type === 'header' && (item.headerKind === 'server' || item.headerKind === 'sessions')) continue;
        const home = item.serverId;
        if (home && home !== previousHome) {
            const presentationAnchorGroupKey = item.groupKey ?? buildSessionListIndexNodeId(item);
            for (const header of [headers.get(home), sessions.get(home)]) {
                if (header) output.push(seenHomes.has(home) ? { ...header, presentationAnchorGroupKey } : header);
            }
            seenHomes.add(home);
            previousHome = home;
        }
        output.push(item);
    }
    return output;
}

type VisibleServerCoverage = Readonly<{
    distinctServerCount: number;
    coversVisibleServerIds: boolean;
    coversVisibleSessionServerIds: boolean;
    hasSyntheticServerHeaders: boolean;
    isAlreadyCanonicalGroupedServerPresentation: boolean;
}>;

function resolveVisibleServerCoverage(
    data: ReadonlyArray<SessionListIndexItem>,
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

export function applySessionListIndexPresentation(
    data: ReadonlyArray<SessionListIndexItem>,
    params: ApplySessionListPresentationParams,
): ReadonlyArray<SessionListIndexItem> {
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

    const withoutServerHeaders = data.some((item) => item.type === 'header' && item.headerKind === 'server')
        ? stripSyntheticServerHeaders(data)
        : data;
    const filteredBySelection = selectedServerSet.size > 0
        ? (() => {
            const filtered: SessionListIndexItem[] = [];
            const pendingUnscoped: SessionListIndexItem[] = [];
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

    if (filteredBySelection.length === 0) {
        return EMPTY_SESSION_LIST_INDEX_ITEMS;
    }

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
    const groups = new Map<string, SessionListIndexItem[]>();
    const unknownServerKey = '__unknown_server__';
    const pendingUnscopedItems: SessionListIndexItem[] = [];

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

    const out: SessionListIndexItem[] = [];

    for (const serverId of serverOrder) {
        const items = groups.get(serverId);
        if (!items || items.length === 0) continue;

        const serverName = items.find((item) => item.type === 'session' && normalizeTrimmedString(item.serverName))?.serverName
            ?? items.find((item) => item.type === 'header' && normalizeTrimmedString(item.serverName))?.serverName
            ?? null;
        const title = resolveHomeDisplayLabel(getServerProfileById(serverId) ?? {
            id: serverId, name: serverName ?? '', serverUrl: '',
        }, serverId);

        out.push({
            type: 'header',
            title,
            headerKind: 'server',
            groupKey: `server:${serverId}`,
            serverId,
            serverName: title,
        });
        out.push(...items);
    }

    return out;
}
