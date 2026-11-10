import * as React from 'react';

import type { VisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import type { SessionListQueryHomeState } from '@/sync/domains/session/listing/sessionListQueryController';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { readSessionAddressLookupQueryMembership } from '@/sync/domains/session/resolveSessionAddressFromLocalState';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

export type SessionListNeedsYouProjection = Readonly<{
    count: number;
    items: readonly Extract<SessionListIndexItem, { type: 'session' | 'workflow_run' }>[];
    incomplete: boolean;
}>;

/** The displayed shelf owns both its total and membership; Inbox totals have a different scope. */
export function projectSessionListNeedsYou(pane: Pick<VisibleSessionListPaneState, 'visibleSessionListIndex' | 'showLoading' | 'filterResult'>): SessionListNeedsYouProjection | null {
    const index = pane.visibleSessionListIndex;
    if (!index || pane.showLoading) return null;
    const header = index.find(item => item.type === 'header' && item.headerKind === 'attention');
    if (!header) return { count: 0, items: [], incomplete: pane.filterResult?.coverage !== 'complete' };
    if (header.type !== 'header' || header.eligibleCount === undefined) return null;
    // Interaction may retain a slot after placement withdraws its earned reason;
    // that visible slot no longer belongs to the header's current count.
    const items = index.filter((item): item is SessionListNeedsYouProjection['items'][number] =>
        item.type === 'session' && item.occurrenceRole === 'needsYou' && item.attentionPlacementReason !== undefined
        || item.type === 'workflow_run' && item.groupKind === 'attention');
    return { count: header.eligibleCount, items,
        incomplete: pane.filterResult?.coverage !== 'complete' || header.eligibleCount > items.length };
}

export type RetainedSessionListPaneState = Readonly<{
    storageKind: SessionListStorageFilter;
    pathname?: string;
    sourceScopeKey: string;
    surfaceRoutePathname?: string;
    paneState: VisibleSessionListPaneState;
    queryMembershipActive: boolean;
    /** This mounted pane currently owns interaction for its data-active surface. */
    referenceCorpusActive?: boolean;
    /** Exact Home selection represented by this pane, including ordinary mode. */
    selectedServerIds?: readonly string[];
}>;

type SessionListPaneRetentionIdentity = Pick<RetainedSessionListPaneState, 'storageKind' | 'pathname' | 'sourceScopeKey'>;

const retainedPaneStateByKey = new Map<string, RetainedSessionListPaneState>();
const retentionListeners = new Set<() => void>();
let retentionRevision = 0;
const needsYouListeners = new Set<() => void>();
let needsYouProjection: SessionListNeedsYouProjection | null = null;

function activeRetainedPane(): RetainedSessionListPaneState | null {
    const active = [...retainedPaneStateByKey.values()].filter(state => state.queryMembershipActive);
    const focused = active.filter(state => state.referenceCorpusActive === true);
    const candidates = focused.length > 0 ? focused : active;
    return candidates.length === 1 ? candidates[0]! : null;
}

function publishNeedsYouChange(): void {
    const retained = activeRetainedPane();
    const next = retained ? projectSessionListNeedsYou(retained.paneState) : null;
    const previous = needsYouProjection;
    if (next === previous || (next && previous && next.count === previous.count && next.incomplete === previous.incomplete
        && next.items.length === previous.items.length && next.items.every((item, index) => {
            const before = previous.items[index]!;
            return item.type === before.type && item.serverId === before.serverId
                && (item.type === 'session' && before.type === 'session' ? item.sessionId === before.sessionId
                    : item.type === 'workflow_run' && before.type === 'workflow_run' && item.runId === before.runId);
        }))) return;
    needsYouProjection = next;
    for (const listener of needsYouListeners) listener();
}

function publishRetentionChange(): void {
    publishNeedsYouChange();
    retentionRevision += 1;
    for (const listener of retentionListeners) listener();
}

function normalizeRetentionStorageKind(storageKind: SessionListStorageFilter | null | undefined): string {
    const normalized = typeof storageKind === 'string' ? storageKind.trim() : '';
    return normalized || 'all';
}

function normalizeRetentionPathname(pathname: string | null | undefined): string {
    const normalized = typeof pathname === 'string' ? pathname.trim() : '';
    return normalized || '/';
}

function normalizeRetentionSourceScopeKey(sourceScopeKey: string | null | undefined): string {
    const normalized = typeof sourceScopeKey === 'string' ? sourceScopeKey.trim() : '';
    return normalized || 'source:default';
}

function getRetentionKey(identity: SessionListPaneRetentionIdentity): string {
    return JSON.stringify([
        normalizeRetentionStorageKind(identity.storageKind),
        normalizeRetentionPathname(identity.pathname),
        normalizeRetentionSourceScopeKey(identity.sourceScopeKey),
    ]);
}

function isRetainablePaneState(paneState: VisibleSessionListPaneState): boolean {
    return !paneState.showLoading;
}

export function readRetainedSessionListPaneState(
    identity: SessionListPaneRetentionIdentity,
): RetainedSessionListPaneState | null {
    return retainedPaneStateByKey.get(getRetentionKey(identity)) ?? null;
}

/**
 * Retention readers consume only query membership: `active`, coverage and each Home's admitted lookup
 * membership. The pane's query object also carries its row index, which every row write rebuilds, and
 * its states carry revalidation stamps; neither is a retention change.
 */
function sameRetainedQueryMembership(
    previous: VisibleSessionListPaneState['query'],
    next: VisibleSessionListPaneState['query'],
): boolean {
    if (previous === next) return true;
    if (!previous || !next) return false;
    if (previous.active !== next.active || previous.coverageComplete !== next.coverageComplete) return false;
    if (previous.statesByServerId === next.statesByServerId) return true;
    // Freshness stamps and Home observations change on every revalidation; lookup reads only admitted membership.
    const serverIds = new Set([...Object.keys(previous.statesByServerId), ...Object.keys(next.statesByServerId)]);
    for (const serverId of serverIds) {
        const before = previous.statesByServerId[serverId];
        const after = next.statesByServerId[serverId];
        if (before === after) continue;
        if (!before || !after) return false;
        const beforeMembership = readSessionAddressLookupQueryMembership(before);
        const afterMembership = readSessionAddressLookupQueryMembership(after);
        if (beforeMembership !== afterMembership && !(beforeMembership && afterMembership
            && beforeMembership.length === afterMembership.length
            && beforeMembership.every((address, index) => sessionAddressKey(address) === sessionAddressKey(afterMembership[index]!)))) return false;
    }
    return true;
}

export function retainSessionListPaneState(
    state: RetainedSessionListPaneState,
): RetainedSessionListPaneState | null {
    if (!isRetainablePaneState(state.paneState)) {
        return null;
    }
    const key = getRetentionKey(state);
    const previous = retainedPaneStateByKey.get(key);
    retainedPaneStateByKey.set(key, state);
    if (
        !previous
        || previous.queryMembershipActive !== state.queryMembershipActive
        || previous.referenceCorpusActive !== state.referenceCorpusActive
        || !sameRetainedQueryMembership(previous.paneState.query, state.paneState.query)
    ) publishRetentionChange();
    else if (previous.paneState.visibleSessionListIndex !== state.paneState.visibleSessionListIndex
        || previous.paneState.showLoading !== state.paneState.showLoading
        || previous.paneState.filterResult?.coverage !== state.paneState.filterResult?.coverage) publishNeedsYouChange();
    return state;
}

export function setRetainedSessionListPaneQueryMembershipActive(
    identity: SessionListPaneRetentionIdentity,
    active: boolean,
): void {
    const retained = readRetainedSessionListPaneState(identity);
    if (!retained || retained.queryMembershipActive === active) return;
    retainedPaneStateByKey.set(getRetentionKey(identity), { ...retained, queryMembershipActive: active });
    publishRetentionChange();
}

export function setRetainedSessionListPaneReferenceCorpusActive(
    identity: SessionListPaneRetentionIdentity,
    active: boolean,
): void {
    const retained = readRetainedSessionListPaneState(identity);
    if (!retained || retained.referenceCorpusActive === active) return;
    retainedPaneStateByKey.set(getRetentionKey(identity), { ...retained, referenceCorpusActive: active });
    publishRetentionChange();
}

export function readActiveRetainedSessionListQueryStates(): readonly SessionListQueryHomeState[] {
    const states: SessionListQueryHomeState[] = [];
    for (const retained of retainedPaneStateByKey.values()) {
        if (!retained.queryMembershipActive || retained.paneState.query?.active !== true) continue;
        for (const state of Object.values(retained.paneState.query.statesByServerId)) {
            if (state) states.push(state);
        }
    }
    return states;
}

export type ActiveRetainedSessionListReferenceCorpus = Readonly<{
    addresses: readonly SessionAddress[];
    selectedServerIds: readonly string[];
    coverage: 'complete' | 'incomplete';
}>;

/**
 * Projects the focused data-active Sessions pane's exact qualified membership
 * for natural-reference consumers. Its query controller or ordinary Sync list
 * remains the completeness owner; this adapter neither fetches nor upgrades
 * retained/cache presence to authority. Multiple data-active panes are usable
 * only when exactly one of them owns interaction, so selection is never guessed.
 */
export function readActiveRetainedSessionListReferenceCorpus(input?: Readonly<{
    ordinaryMembershipByServerId?: Readonly<Record<string, readonly string[] | undefined>>;
}>): ActiveRetainedSessionListReferenceCorpus | null {
    const retained = activeRetainedPane();
    if (!retained) return null;
    const activeQuery = retained.paneState.query;

    if (activeQuery?.active !== true) {
        const selectedServerIds = [...new Set(
            (retained.selectedServerIds ?? []).map((serverId) => serverId.trim()).filter(Boolean),
        )];
        const addresses: SessionAddress[] = [];
        for (const serverId of selectedServerIds) {
            for (const sessionId of input?.ordinaryMembershipByServerId?.[serverId] ?? []) {
                const normalizedSessionId = sessionId.trim();
                if (normalizedSessionId) addresses.push({ serverId, sessionId: normalizedSessionId });
            }
        }
        return {
            addresses,
            selectedServerIds,
            // Released owner/direct GET membership remains visible and its own exhaustion stays
            // truthful, but it cannot prove the strict My Work/all-accessible corpus is complete.
            coverage: 'incomplete',
        };
    }

    const selectedServerIds = Object.keys(activeQuery.statesByServerId);
    const addressesByKey = new Map<string, SessionAddress>();
    for (const state of Object.values(activeQuery.statesByServerId)) {
        for (const address of state?.addresses ?? []) {
            addressesByKey.set(sessionAddressKey(address), address);
        }
    }
    return {
        addresses: [...addressesByKey.values()],
        selectedServerIds,
        coverage: activeQuery.coverageComplete ? 'complete' : 'incomplete',
    };
}

export function useActiveRetainedSessionListQueryStates(): readonly SessionListQueryHomeState[] {
    const revision = React.useSyncExternalStore(
        React.useCallback((listener) => {
            retentionListeners.add(listener);
            return () => retentionListeners.delete(listener);
        }, []),
        () => retentionRevision,
        () => retentionRevision,
    );
    return React.useMemo(() => readActiveRetainedSessionListQueryStates(), [revision]);
}

export function readActiveRetainedSessionListNeedsYou(): SessionListNeedsYouProjection | null {
    return needsYouProjection;
}

export function useActiveRetainedSessionListNeedsYou(): SessionListNeedsYouProjection | null {
    return React.useSyncExternalStore(
        React.useCallback((listener) => {
            needsYouListeners.add(listener);
            return () => needsYouListeners.delete(listener);
        }, []),
        readActiveRetainedSessionListNeedsYou,
        readActiveRetainedSessionListNeedsYou,
    );
}

export function updateRetainedSessionListPaneSurfaceRoutePathname(
    identity: SessionListPaneRetentionIdentity,
    surfaceRoutePathname: string | undefined,
): RetainedSessionListPaneState | null {
    const retained = readRetainedSessionListPaneState(identity);
    if (!retained) return null;
    if ((retained.surfaceRoutePathname ?? '') === (surfaceRoutePathname ?? '')) {
        return retained;
    }
    const next = {
        ...retained,
        surfaceRoutePathname,
    };
    retainedPaneStateByKey.set(getRetentionKey(identity), next);
    return next;
}

export function releaseRetainedSessionListPaneState(identity: SessionListPaneRetentionIdentity): boolean {
    const released = retainedPaneStateByKey.delete(getRetentionKey(identity));
    if (released) publishRetentionChange();
    return released;
}

export function resetSessionListPaneRetentionForTests(): void {
    retainedPaneStateByKey.clear();
    publishRetentionChange();
}
