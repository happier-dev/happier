import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { isSeededDemoHome } from '@/demoMode/runtime/enterExitDemoMode';
import { EMPTY_ORDINARY_SESSION_LIST_FRONTIER } from '@/sync/engine/sessions/ordinarySessionListFrontier';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import { createScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';
import { readHomeAccountReadRevision } from '@/sync/runtime/orchestration/homeAccountChange';
import { sync } from '@/sync/sync';
import { SESSION_LIST_PAGE_DEFAULT_LIMIT } from '@happier-dev/protocol/sessions/listing/query';
import type { SessionListFetchResult } from '@/sync/engine/sessions/sessionSnapshot';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import {
    fetchConcurrentSessionListQueryPage,
    getConcurrentSessionListQueryHomeAvailability,
    isConcurrentOrdinarySessionListHome,
    loadNextConcurrentOrdinarySessionListPage,
    readConcurrentOrdinarySessionListLifecycle,
    refreshConcurrentOrdinarySessionList,
    retryConcurrentSessionListQueryHome,
} from '@/sync/runtime/orchestration/concurrentSessionCache';
import {
    getAppliedActiveServerSnapshot,
    isAppliedActiveServerRuntimeAvailable,
    retryActiveServerConnection,
} from '@/sync/runtime/orchestration/connectionManager';

import { buildOrdinarySessionListHomeState, type OrdinarySessionListLifecycle } from './ordinarySessionListHomeState';
import { readSessionListQueryReadEpoch } from './sessionListQueryInvalidation';
import {
    isSessionListCursorRepeated,
    type SessionListQueryHomeState,
    type SessionListQueryPageRequest,
} from './sessionListQueryController';

export type SessionListQueryHomeAvailability = 'online' | 'pending' | 'offline';

export function getSessionListQueryHomeAvailability(
    serverIdRaw: string,
): SessionListQueryHomeAvailability {
    const serverId = String(serverIdRaw ?? '').trim();
    if (!serverId) return 'offline';
    if (isSeededDemoHome(serverId)) return 'online';
    const staged = getActiveServerSnapshot();
    const applied = getAppliedActiveServerSnapshot();
    const runtimeAvailable = isAppliedActiveServerRuntimeAvailable();
    const isApplied = areServerProfileIdentifiersEquivalent(serverId, applied.serverId);
    const hasUnappliedStagedHome = !areServerProfileIdentifiersEquivalent(staged.serverId, applied.serverId);

    // The staged target is withdrawn from the secondary cache before it can own the singleton.
    // That ownership gap is loading, not evidence that the Home is unreachable.
    if (
        hasUnappliedStagedHome
        && areServerProfileIdentifiersEquivalent(serverId, staged.serverId)
    ) {
        return 'pending';
    }
    if (runtimeAvailable && isApplied) {
        return storage.getState().socketStatus === 'connected' ? 'online' : 'offline';
    }
    const concurrentAvailability = getConcurrentSessionListQueryHomeAvailability(serverId);
    if (concurrentAvailability !== 'offline') return concurrentAvailability;
    return 'offline';
}

export function isSessionListQueryHomeOnline(serverIdRaw: string): boolean {
    return getSessionListQueryHomeAvailability(serverIdRaw) === 'online';
}

/**
 * Reads the incumbent ordinary lifecycle without creating a second pagination owner.
 */
export function readOrdinarySessionListLifecycle(serverId: string): OrdinarySessionListLifecycle {
    if (isSeededDemoHome(serverId)) return {
        serverId,
        hasFetchedSnapshot: true,
        fetchInFlight: false,
        fetchMoreInFlight: false,
        frontier: EMPTY_ORDINARY_SESSION_LIST_FRONTIER,
    };
    return resolveOrdinarySessionListHomeOwner(serverId) === 'sync'
        ? sync.readOrdinarySessionListLifecycle()
        : readConcurrentOrdinarySessionListLifecycle(serverId);
}

/**
 * Whether Sync's singleton lifecycle owns this Home's ordinary `/v2/sessions`
 * corpus. It is the same fact that routes a page request to Sync rather than to
 * the concurrent cache, so the filter's ordinary corpus cannot disagree with the
 * transport about which Home Sync is serving.
 */
export function isSyncOwnedOrdinarySessionListHome(serverIdRaw: string): boolean {
    const serverId = String(serverIdRaw ?? '').trim();
    if (!serverId) return false;
    return isAppliedActiveServerRuntimeAvailable()
        && areServerProfileIdentifiersEquivalent(serverId, getAppliedActiveServerSnapshot().serverId);
}

export type OrdinarySessionListHomeOwner = 'sync' | 'concurrent' | 'demo';

/**
 * Which runtime owns this Home's ordinary `/v2/sessions` corpus, if any.
 *
 * One answer for every Home: Sync owns the applied active Home, the concurrent
 * cache owns every other managed Home. A filter whose corpus is ordinary reads
 * the incumbent frontier through this seam rather than mounting a controller
 * that would paginate and `replace` the same membership behind a second cursor.
 */
export function resolveOrdinarySessionListHomeOwner(
    serverIdRaw: string,
): OrdinarySessionListHomeOwner | null {
    const serverId = String(serverIdRaw ?? '').trim();
    if (!serverId) return null;
    if (isSeededDemoHome(serverId)) return 'demo';
    if (isSyncOwnedOrdinarySessionListHome(serverId)) return 'sync';
    return isConcurrentOrdinarySessionListHome(serverId) ? 'concurrent' : null;
}

/**
 * The incumbent ordinary frontier for this Home, projected onto the per-Home query
 * state, so one cursor advances and one membership is canonical.
 */
export function readOrdinarySessionListHomeState(input: Readonly<{
    serverId: string;
    requestedQueryKey: string;
    online: boolean | null;
}>): SessionListQueryHomeState {
    const state = storage.getState();
    return buildOrdinarySessionListHomeState({
        serverId: input.serverId,
        requestedQueryKey: input.requestedQueryKey,
        sessionIds: state.ordinarySessionListMembershipByServerId?.[input.serverId] ?? [],
        observation: state.concurrentSessionListCacheByServerId?.[input.serverId]?.listObservation ?? null,
        lifecycle: readOrdinarySessionListLifecycle(input.serverId),
        online: input.online,
    });
}

/** Advance this Home's incumbent ordinary frontier. There is no second cursor to advance. */
export async function loadNextOrdinarySessionListPage(serverIdRaw: string): Promise<void> {
    if (isSeededDemoHome(serverIdRaw)) return;
    if (resolveOrdinarySessionListHomeOwner(serverIdRaw) === 'sync') {
        await sync.fetchMoreSessions();
        return;
    }
    await loadNextConcurrentOrdinarySessionListPage(serverIdRaw);
}

/** Replace this Home's ordinary corpus from page one. */
export async function refreshOrdinarySessionList(serverIdRaw: string): Promise<void> {
    if (isSeededDemoHome(serverIdRaw)) return;
    if (resolveOrdinarySessionListHomeOwner(serverIdRaw) === 'sync') {
        await sync.refreshSessions();
        return;
    }
    await refreshConcurrentOrdinarySessionList(serverIdRaw);
}

/**
 * Page reads on the wire. Every surface that shows a corpus owns its own controller, so one commit
 * that mounts several of them, or one Account change that refreshes them, asks for the same page
 * together. Those callers share one request. A read that began before the Home's latest invalidation
 * is never shared with a caller that asks after it.
 */
const pageReads = createScopedResolutionSingleFlight<Awaited<ReturnType<typeof readSessionListQueryPageForHome>>>();

/**
 * A strict-query page and a row-only page of one corpus are the same read: the store tells them apart
 * only by whether the page may bootstrap an ordinary list index, which the ordinary owner establishes itself.
 */
function readSharedMembership(membership: SessionListQueryPageRequest['membership']): string {
    return membership === 'query' || membership === 'rowOnly' ? 'corpus' : membership;
}

/** One request per concurrent corpus read; it is aborted only when every caller that wanted it has left. */
export async function fetchSessionListQueryPageForHome(
    serverIdRaw: string,
    page: SessionListQueryPageRequest,
): Promise<SessionListFetchResult> {
    const serverId = String(serverIdRaw ?? '').trim();
    const { selectSession, ...rawPage } = page;
    if (!selectSession) return fetchSharedPage(serverId, rawPage);

    // The private selector never crosses the transport or changes the raw page's
    // shared-read identity. Advance existing cursors until one selected page fills.
    const limit = page.limit ?? (page.source.kind === 'query' ? page.source.body.limit : undefined)
        ?? SESSION_LIST_PAGE_DEFAULT_LIMIT;
    const selected = new Map<string, SessionListFetchResult>();
    let request: SessionListQueryPageRequest = { ...rawPage, hydration: 'required' };
    let selectionUnavailable = false;
    let metadataUpgradeRequiredCount = 0;
    let membershipUnavailableReason: SessionListFetchResult['membershipUnavailableReason'];
    let attentionNextCursor: string | null = null;
    let attentionHasNext = false;
    while (true) {
        throwIfAborted(page.signal);
        const result = await fetchSharedPage(serverId, { ...request, limit: limit - selected.size });
        if (!result.current) return result;
        selectionUnavailable ||= result.selectionUnavailable === true;
        metadataUpgradeRequiredCount += result.metadataUpgradeRequiredCount ?? 0;
        membershipUnavailableReason ??= result.membershipUnavailableReason;
        if (!request.cursor) {
            attentionNextCursor = result.attentionNextCursor;
            attentionHasNext = result.attentionHasNext;
        }
        for (const sessionId of result.sessionIds) {
            if (result.isSessionCurrent?.(sessionId) === false) continue;
            const membership = selectSession(sessionId, serverId);
            if (membership === null) selectionUnavailable = true;
            if (membership === true) selected.set(sessionId, result);
        }
        const attention = Boolean(request.attentionCursor);
        const hasNext = attention ? result.attentionHasNext : result.hasNext;
        const cursor = attention ? result.attentionNextCursor : result.nextCursor;
        if (selected.size >= limit || !hasNext || !cursor) return {
            ...result,
            sessionIds: [...selected.keys()],
            isSessionCurrent: sessionId => selected.get(sessionId)?.isSessionCurrent?.(sessionId) !== false,
            ...(!attention ? { attentionNextCursor, attentionHasNext } : {}),
            selectionUnavailable, metadataUpgradeRequiredCount, membershipUnavailableReason,
        };
        if (isSessionListCursorRepeated(attention ? request.attentionCursor : request.cursor, cursor, hasNext)) {
            throw Object.assign(new Error('Session list cursor did not advance'), { code: 'cursor_not_advancing' });
        }
        request = { ...rawPage, hydration: 'required',
            ...(attention ? { attentionCursor: cursor } : { cursor }) };
    }
}

function fetchSharedPage(serverId: string, page: SessionListQueryPageRequest) {
    const key = JSON.stringify([
        serverId, readHomeAccountReadRevision(serverId), readSessionListQueryReadEpoch(serverId),
        page.source, readSharedMembership(page.membership), page.hydration ?? null, page.candidateStartedBy ?? null,
        page.limit ?? null, page.cursor ?? null, page.attentionCursor ?? null,
    ]);
    return pageReads.run(key, signal => readSessionListQueryPageForHome(serverId, { ...page, signal }), { signal: page.signal });
}

async function readSessionListQueryPageForHome(
    serverId: string,
    page: SessionListQueryPageRequest,
) {
    if (isSyncOwnedOrdinarySessionListHome(serverId)) {
        return sync.fetchSessionListQueryPage(serverId, page);
    }
    return fetchConcurrentSessionListQueryPage(serverId, page);
}

/**
 * The query source owns controller refresh; this boundary only restores the
 * exact Home transport that made its query unavailable.
 */
export async function retrySessionListQueryHome(serverIdRaw: string): Promise<void> {
    const serverId = String(serverIdRaw ?? '').trim();
    if (!serverId) return;
    if (isSeededDemoHome(serverId)) return;
    if (isSyncOwnedOrdinarySessionListHome(serverId)) {
        await retryActiveServerConnection();
        return;
    }
    await retryConcurrentSessionListQueryHome(serverId);
}
