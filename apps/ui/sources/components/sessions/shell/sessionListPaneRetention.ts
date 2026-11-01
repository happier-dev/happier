import * as React from 'react';

import type { VisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import type { SessionListQueryHomeState } from '@/sync/domains/session/listing/sessionListQueryController';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';

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

function publishRetentionChange(): void {
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
        || previous.paneState.query !== state.paneState.query
    ) publishRetentionChange();
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
    const dataActive = [...retainedPaneStateByKey.values()].filter((retained) => retained.queryMembershipActive);
    const focused = dataActive.filter((retained) => retained.referenceCorpusActive === true);
    const candidates = focused.length > 0 ? focused : dataActive;
    if (candidates.length !== 1) return null;
    const retained = candidates[0]!;
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
