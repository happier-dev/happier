import { SESSION_LIST_PAGE_DEFAULT_LIMIT, type SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';

import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { normalizeSessionAddress, sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import type { SessionListFetchResult, fetchAndApplySessions } from '@/sync/engine/sessions/sessionSnapshot';
import type { SessionListPageSource } from '@/sync/engine/sessions/sessionHttpCompat';
import { classifySessionListFailure, type SessionListQueryFailureReason } from './sessionListFailure';
export type { SessionListQueryFailureReason } from './sessionListFailure';

import { buildSessionListQueryKey } from './sessionListQueryKey';
import {
    canRowWriteChangeSessionListMembership,
    canSessionListOrdinaryPageAnswerQuery,
    isSessionListQueryRowPlaceable,
    resolveSessionListQueryRowMembership,
    type SessionListRowMembershipFacets,
    type SessionListRowPlacementFacts,
} from './sessionListQuerySelection';
export { canSessionListOrdinaryPageAnswerQuery };
import type { SessionListHomeObservation } from './sessionListHomeObservation';

/** One strict-query corpus's applied membership as the store holds it. */
export type SessionListQueryMembership = Readonly<{
    serverId: string;
    accountId: string;
    sessionIds: readonly string[];
    /**
     * Restored from this device's warm cache; no page has confirmed it in this process. It renders
     * only as retained (never complete coverage), an applied page always replaces it, and it is not
     * written back, so persisted corpora stay the ones this process actually read.
     */
    lastKnown?: true;
}>;

export type SessionListRowPlacement = Readonly<{ sessionId: string; facts: SessionListRowPlacementFacts }>;

export type SessionListQueryHomeState = Readonly<{
    requestedQueryKey: string;
    appliedQueryKey: string | null;
    addresses: readonly SessionAddress[];
    nextCursor: string | null;
    hasNext: boolean;
    attentionNextCursor: string | null;
    attentionHasNext: boolean;
    phase: 'idle' | 'loading' | 'refreshing' | 'ready' | 'offline' | 'error' | 'not_selected';
    freshnessAt: number | null;
    /** Admitted Home currentness; membership/cursor changes retain this projection. */
    homeObservation: SessionListHomeObservation;
    failureReason: SessionListQueryFailureReason | null;
    failureCode: string | null;
    /** The admitted request that failed; retained cursors do not identify that request. */
    failedOperation?: RequestFamily;
    /**
     * Which request adapter produced the applied membership. A released GET
     * adapter cannot answer the strict query's structural selection, so coverage
     * owners must not read `ready` alone as authoritative for a filtered corpus.
     */
    appliedSourceKind: 'query' | 'ordinary' | null;
    /**
     * Historical rows the Home withheld from this applied membership pending their
     * owner's metadata upgrade (released layout 0). Exhausted cursors with a
     * non-zero count are a read-to-the-end corpus that is still not whole.
     */
    metadataUpgradeRequiredCount?: number;
    membershipUnavailableReason?: SessionListFetchResult['membershipUnavailableReason'];
}>;

/**
 * Canonical list membership this page belongs to. Ordinary and archived GET pages
 * and the strict query are request adapters over one per-Home pagination owner, not
 * competing cursor states, so the store keeps labelling each corpus correctly.
 */
export type SessionListPageMembership = 'ordinary' | 'archived' | 'query' | 'rowOnly';

/**
 * Released GET listing for one corpus, used when filtered listing is unavailable on
 * that Home. It is selected up front from the Home's feature decision — it is never
 * a fallback after a strict query request fails.
 */
export type SessionListOrdinaryPageAdapter = Readonly<{
    path: string;
    allowV1Fallback: boolean;
    membership: Exclude<SessionListPageMembership, 'query' | 'rowOnly'>;
}>;

export type SessionListQueryPageRequest = Readonly<{
    source: SessionListPageSource;
    membership: SessionListPageMembership;
    /** Predicate consumers need settled summaries, not just structural membership. */
    hydration?: 'required';
    candidateStartedBy?: Parameters<typeof fetchAndApplySessions>[0]['candidateStartedBy'];
    limit?: number;
    cursor?: string | null;
    attentionCursor?: string | null;
    signal: AbortSignal;
}>;

export type SessionListQueryHomeController = Readonly<{
    getSnapshot(): SessionListQueryHomeState;
    subscribe(listener: () => void): () => void;
    update(input: ControllerInput): Promise<void>;
    refresh(): Promise<void>;
    /** Retry the failed request, preserving a continuation's exact cursor. */
    retry(): Promise<void>;
    /**
     * Re-read page one after an Account change. `'structural'` (a row-level Session
     * write) replaces only a corpus whose selection can change with that row.
     * Exact row refresh already reconciles content and escalates archive/access changes.
     * `rowFacets` narrows that to the membership inputs the writes can move.
     */
    /**
     * `'structural'` re-reads only a corpus a row write can move; `'recover'` (a transport reconnect)
     * re-reads only a corpus left without a current answer, since the changes catch-up owns the rest.
     */
    invalidate(scope?: 'structural' | 'recover', rowFacets?: SessionListRowMembershipFacets): Promise<void>;
    /**
     * Removes one committed-retired (deleted/revoked) Session from this Home's
     * applied membership. A response already in flight is fenced at the list reader,
     * so the address cannot return until a later read admits it again.
     */
    retire(sessionId: string): void;
    /**
     * Applies freshly read rows in place: inserts a member at its sort position,
     * removes a non-member, and leaves an older row below an unread frontier to
     * paging. Returns false when this query's selection is not decided by row facts.
     */
    place(rows: readonly SessionListRowPlacement[], readSortKey: (sessionId: string) => number | null): boolean;
    /** Incumbent ordinary success remains the fallback until this query has succeeded. */
    observeOrdinaryLastSuccessAt(lastSuccessAt: number | null): void;
    loadNext(): Promise<void>;
    dispose(): void;
}>;

type ControllerInput = Readonly<{
    query: SessionListQueryV1;
    /** Exhaustive consumers apply one exhausted relation; omission preserves progressive pages. */
    readMode?: 'complete';
    selected: boolean;
    /** `null` means the selected Home's transport ownership is being transferred. */
    online: boolean | null;
    supported?: boolean | null;
    /**
     * Secondary consumers may retain the strict query's exact membership in
     * this controller while sharing only hydrated rows with the store. That
     * keeps them from replacing the mounted Sessions filter's membership.
     */
    queryMembership?: Extract<SessionListPageMembership, 'query' | 'rowOnly'>;
    /** Released GET adapter for this corpus when the Home cannot serve the strict query. */
    ordinaryAdapter?: SessionListOrdinaryPageAdapter | null;
}>;

type RequestFamily = 'replace' | 'ordinary' | 'attention';

type PageRequestPlan = Readonly<{
    source: SessionListPageSource;
    membership: SessionListPageMembership;
    supportsAttentionContinuation: boolean;
}>;

/**
 * Single admission owner for one Home's page request.
 *
 * The strict query stays admitted only by `supported === true`; a Home that cannot
 * serve it runs its configured released GET adapter instead. Nothing here turns a
 * failed or unsupported query into a semantically different GET result: the adapter
 * is chosen from the Home's feature decision before any request is issued.
 */
function resolvePageRequestPlan(input: ControllerInput | null): PageRequestPlan | null {
    if (!input || !input.selected || !input.online) return null;
    if (input.supported === true) {
        return {
            source: { kind: 'query', body: stripCursorState(input.query), allowV1Fallback: false },
            membership: input.queryMembership ?? 'query',
            supportsAttentionContinuation: true,
        };
    }
    if (input.supported === false && input.ordinaryAdapter) {
        return {
            source: {
                kind: 'ordinary',
                path: input.ordinaryAdapter.path,
                allowV1Fallback: input.ordinaryAdapter.allowV1Fallback,
            },
            membership: input.ordinaryAdapter.membership,
            supportsAttentionContinuation: false,
        };
    }
    return null;
}

/**
 * Normalization removes only the cursor fields: this controller owns which page
 * of the corpus is being requested. The caller's validated `limit` owns the
 * visible page size; a short-page continuation asks for its remaining rows
 * without changing the corpus identity or the caller's page policy.
 */
function stripCursorState(query: SessionListQueryV1): SessionListQueryV1 {
    const { cursor: _cursor, attentionCursor: _attentionCursor, ...base } = query;
    return base;
}

function appendAddresses(
    current: readonly SessionAddress[],
    serverId: string,
    sessionIds: readonly string[],
    previous?: readonly SessionAddress[],
): readonly SessionAddress[] {
    const next = [...current];
    const seen = new Set(current.map(sessionAddressKey));
    const previousByKey = previous ? new Map(previous.map(address => [sessionAddressKey(address), address])) : null;
    for (const sessionId of sessionIds) {
        const address = normalizeSessionAddress(serverId, sessionId);
        if (!address) continue;
        const key = sessionAddressKey(address);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(previousByKey?.get(key) ?? address);
    }
    if (previous && previous.length === next.length && next.every((address, index) => address === previous[index])) return previous;
    return next.length === current.length ? current : next;
}

export function createSessionListQueryHomeController(params: Readonly<{
    serverId: string;
    fetchPage(request: SessionListQueryPageRequest): Promise<SessionListFetchResult>;
    /**
     * Receives every change of the applied membership (`null` when access denial
     * withdraws it). The store is the rendered owner; this controller keeps only the
     * request and cursor lifecycle.
     */
    commitMembership?(queryKey: string, sessionIds: readonly string[] | null): void;
    now?: () => number;
}>): SessionListQueryHomeController {
    const serverId = params.serverId.trim();
    if (!serverId) {
        throw new Error('Session list query controller requires a Home id');
    }
    const now = params.now ?? Date.now;
    const listeners = new Set<() => void>();
    let input: ControllerInput | null = null;
    let disposed = false;
    let revision = 0;
    let activeAbortController: AbortController | null = null;
    let inFlight: Promise<void> | null = null;
    let refreshQueued = false;
    let ordinaryLastSuccessAt: number | null = null;
    let state: SessionListQueryHomeState = {
        requestedQueryKey: '',
        appliedQueryKey: null,
        addresses: [],
        nextCursor: null,
        hasNext: false,
        attentionNextCursor: null,
        attentionHasNext: false,
        phase: 'idle',
        freshnessAt: null,
        homeObservation: { phase: 'idle', lastSuccessAt: null },
        failureReason: null,
        failureCode: null,
        appliedSourceKind: null,
    };

    /**
     * Query identity is derived here, never accepted from a caller: two callers
     * cannot disagree about which corpus a page belongs to.
     */
    const deriveQueryKey = (candidate: ControllerInput): string => (
        buildSessionListQueryKey(serverId, candidate.query)
    );

    const publish = (next: SessionListQueryHomeState): void => {
        if (disposed) return;
        const lastSuccessAt = typeof next.freshnessAt === 'number' && Number.isFinite(next.freshnessAt)
            ? next.freshnessAt : ordinaryLastSuccessAt;
        // Membership and lifecycle have distinct consumers. Admit a new currentness
        // fact only when its producing phase or success time actually changes.
        const homeObservation = state.homeObservation.phase === next.phase
            && state.homeObservation.lastSuccessAt === lastSuccessAt
            ? state.homeObservation
            : { phase: next.phase, lastSuccessAt };
        if (next === state && homeObservation === state.homeObservation) return;
        const previous = state;
        state = next.homeObservation === homeObservation ? next : { ...next, homeObservation };
        if (input?.queryMembership !== 'rowOnly') {
            if (next.appliedQueryKey && (next.appliedQueryKey !== previous.appliedQueryKey || next.addresses !== previous.addresses)) {
                params.commitMembership?.(next.appliedQueryKey, next.addresses.map((address) => address.sessionId));
            } else if (!next.appliedQueryKey && previous.appliedQueryKey) {
                params.commitMembership?.(previous.appliedQueryKey, null);
            }
        }
        for (const listener of listeners) listener();
    };

    /**
     * Publish an unavailable phase (not selected, support loading, unsupported,
     * transferring, offline) only when it changes what subscribers can observe.
     * Surfaces re-apply their input on every socket or machine-status change; a
     * fresh but equal state object would re-render every list consumer each time.
     */
    const publishPhase = (
        requestedQueryKey: string,
        phase: SessionListQueryHomeState['phase'],
        failureReason: SessionListQueryHomeState['failureReason'] = null,
        failureCode: SessionListQueryHomeState['failureCode'] = null,
    ): void => {
        if (
            state.requestedQueryKey === requestedQueryKey
            && state.phase === phase
            && state.failureReason === failureReason
            && state.failureCode === failureCode
            && state.failedOperation === undefined
        ) return;
        publish({ ...state, requestedQueryKey, phase, failureReason, failureCode, failedOperation: undefined });
    };

    const isRequestCurrent = (requestRevision: number, signal: AbortSignal): boolean => (
        !disposed
        && revision === requestRevision
        && !signal.aborted
        && resolvePageRequestPlan(input) !== null
    );

    const startPage = (family: RequestFamily): Promise<void> => {
        if (disposed) return Promise.resolve();
        const plan = resolvePageRequestPlan(input);
        if (!plan || !input) return Promise.resolve();
        if (family === 'attention' && !plan.supportsAttentionContinuation) return Promise.resolve();
        if (family !== 'replace' && inFlight) return inFlight;

        const requestInput = input;
        const requestQueryKey = deriveQueryKey(requestInput);
        const requestRevision = family === 'replace' ? ++revision : revision;
        if (family === 'replace') {
            activeAbortController?.abort('session-list-query-replaced');
        }
        const abortController = new AbortController();
        activeAbortController = abortController;
        let operation = family;
        let requestedCursor = family === 'ordinary' ? state.nextCursor : null;
        let requestedAttentionCursor = family === 'attention' ? state.attentionNextCursor : null;
        const complete = requestInput.readMode === 'complete' && family === 'replace';

        publish({
            ...state,
            requestedQueryKey: requestQueryKey,
            phase: family === 'replace'
                ? (state.addresses.length > 0 ? 'refreshing' : 'loading')
                : 'loading',
            failureReason: null,
            failureCode: null,
            failedOperation: undefined,
        });

        let promise: Promise<void> | undefined;
        promise = (async () => {
            try {
                const completePages: Pick<SessionListFetchResult, 'sessionIds' | 'isSessionCurrent'>[] = [];
                const pageIds = new Set<string>();
                let metadataUpgradeRequiredCount = 0;
                let membershipUnavailableReason: SessionListFetchResult['membershipUnavailableReason'];
                let nextCursor: string | null = null;
                let hasNext = false;
                let attentionNextCursor: string | null = null;
                let attentionHasNext = false;
                let readOrdinary = false;
                let readAttention = false;
                const pageLimit = requestInput.query.limit ?? SESSION_LIST_PAGE_DEFAULT_LIMIT;
                while (true) {
                    if (!isRequestCurrent(requestRevision, abortController.signal)) return;
                    const result = await params.fetchPage({
                        source: plan.source,
                        membership: plan.membership,
                        ...(!complete && plan.source.kind === 'query'
                            ? { limit: pageLimit - pageIds.size }
                            : typeof requestInput.query.limit === 'number'
                            ? { limit: requestInput.query.limit }
                            : {}),
                        ...(operation === 'ordinary' ? { cursor: requestedCursor } : {}),
                        ...(operation === 'attention' ? { attentionCursor: requestedAttentionCursor } : {}),
                        signal: abortController.signal,
                    });
                    if (!isRequestCurrent(requestRevision, abortController.signal)) return;
                    if (!result.current) {
                        publish({ ...state, phase: 'offline', failureReason: null, failureCode: null });
                        return;
                    }

                    const repeatedOrdinaryCursor = operation === 'ordinary'
                        && result.hasNext
                        && Boolean(requestedCursor)
                        && result.nextCursor === requestedCursor;
                    const repeatedAttentionCursor = operation === 'attention'
                        && result.attentionHasNext
                        && Boolean(requestedAttentionCursor)
                        && result.attentionNextCursor === requestedAttentionCursor;
                    const missingCompleteCursor = complete && ((operation !== 'attention' && result.hasNext && !result.nextCursor)
                        || (operation !== 'ordinary' && plan.supportsAttentionContinuation && result.attentionHasNext && !result.attentionNextCursor));

                    if (repeatedOrdinaryCursor || repeatedAttentionCursor || missingCompleteCursor) {
                        publish({
                            ...state,
                            ...(!complete ? {
                                appliedQueryKey: requestQueryKey,
                                appliedSourceKind: plan.source.kind,
                                addresses: appendAddresses(family === 'replace' ? [] : state.addresses, serverId,
                                    result.sessionIds.filter(sessionId => result.isSessionCurrent?.(sessionId) !== false)),
                                ...(repeatedOrdinaryCursor ? { nextCursor: null, hasNext: false } : {}),
                                ...(repeatedAttentionCursor ? { attentionNextCursor: null, attentionHasNext: false } : {}),
                            } : {}),
                            phase: 'error',
                            failureReason: 'cursor_not_advancing',
                            failureCode: 'cursor_not_advancing',
                            // The non-advancing cursor was withdrawn; only a replacement can recover.
                            failedOperation: undefined,
                        });
                        return;
                    }

                    if (operation !== 'attention') {
                        readOrdinary = true;
                        nextCursor = result.nextCursor;
                        hasNext = result.hasNext;
                    }
                    if (operation !== 'ordinary') {
                        readAttention = true;
                        attentionNextCursor = result.attentionNextCursor;
                        attentionHasNext = complete ? plan.supportsAttentionContinuation && result.attentionHasNext : result.attentionHasNext;
                    }
                    completePages.push({ sessionIds: result.sessionIds, isSessionCurrent: result.isSessionCurrent });
                    for (const id of result.sessionIds) {
                        if (result.isSessionCurrent?.(id) !== false) pageIds.add(id);
                    }
                    metadataUpgradeRequiredCount += result.metadataUpgradeRequiredCount ?? 0;
                    membershipUnavailableReason ??= result.membershipUnavailableReason;
                    if (complete) {
                        if (hasNext && nextCursor) {
                            operation = 'ordinary';
                            requestedCursor = nextCursor;
                            continue;
                        }
                        if (attentionHasNext && attentionNextCursor) {
                            operation = 'attention';
                            requestedAttentionCursor = attentionNextCursor;
                            continue;
                        }
                    }
                    // Exact server admission may reject an entire candidate window.
                    // Fill only this requested visible page, retaining both independent
                    // cursors; exhaustion is a cursor fact, never a short-row heuristic.
                    if (!complete && plan.source.kind === 'query'
                        && pageIds.size < pageLimit) {
                        if (operation !== 'attention' && hasNext && nextCursor) {
                            operation = 'ordinary';
                            requestedCursor = nextCursor;
                            continue;
                        }
                        if (attentionHasNext && attentionNextCursor) {
                            operation = 'attention';
                            requestedAttentionCursor = attentionNextCursor;
                            continue;
                        }
                    }
                    // Each page's retirement fence stays live until the whole relation commits.
                    // An equal replacement keeps the published membership identity, so a background
                    // refetch never re-publishes unchanged membership to its consumers.
                    const addresses = appendAddresses(family === 'replace' ? [] : state.addresses, serverId,
                        completePages.flatMap(page => page.sessionIds.filter(
                            sessionId => page.isSessionCurrent?.(sessionId) !== false)), family === 'replace' ? state.addresses : undefined);
                    publish({
                        ...state,
                        appliedQueryKey: requestQueryKey,
                        appliedSourceKind: plan.source.kind,
                        addresses,
                        metadataUpgradeRequiredCount: complete ? metadataUpgradeRequiredCount
                            : (family === 'replace' ? 0 : state.metadataUpgradeRequiredCount ?? 0) + metadataUpgradeRequiredCount,
                        membershipUnavailableReason: complete ? membershipUnavailableReason
                            : membershipUnavailableReason ?? (family === 'replace' ? undefined : state.membershipUnavailableReason),
                        ...(readOrdinary ? {
                            nextCursor,
                            hasNext,
                        } : {}),
                        ...(readAttention ? {
                            attentionNextCursor,
                            attentionHasNext,
                        } : {}),
                        phase: 'ready',
                        freshnessAt: now(),
                        failureReason: null,
                        failureCode: null,
                        failedOperation: undefined,
                    });
                    return;
                }
            } catch (error) {
                if (!isRequestCurrent(requestRevision, abortController.signal)) return;
                const failure = classifySessionListFailure(error);
                publish({
                    ...state,
                    ...(failure.reason === 'access_denied' ? {
                        addresses: [],
                        appliedQueryKey: null,
                        appliedSourceKind: null,
                        nextCursor: null,
                        hasNext: false,
                        attentionNextCursor: null,
                        attentionHasNext: false,
                        freshnessAt: null,
                        metadataUpgradeRequiredCount: 0,
                        membershipUnavailableReason: undefined,
                    } : {}),
                    phase: 'error',
                    failureReason: failure.reason,
                    failureCode: failure.code,
                    failedOperation: family,
                });
            } finally {
                if (activeAbortController === abortController) {
                    activeAbortController = null;
                }
                if (inFlight === promise) {
                    inFlight = null;
                }
                if (
                    refreshQueued
                    && isRequestCurrent(requestRevision, abortController.signal)
                    && input?.selected === true
                    && input.online === true
                ) {
                    refreshQueued = false;
                    void startPage('replace');
                }
            }
        })();
        inFlight = promise;
        return promise;
    };

    const refresh = (): Promise<void> => {
        if (inFlight) {
            refreshQueued = true;
            const currentRequest = inFlight;
            // The coalesced replacement is installed synchronously in the current request's finally.
            return currentRequest.then(() => inFlight ?? Promise.resolve());
        }
        return startPage('replace');
    };

    return {
        getSnapshot: () => state,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        update: async (nextInput) => {
            if (disposed) return;
            const previousInput = input;
            const previousQueryKey = previousInput ? deriveQueryKey(previousInput) : null;
            const nextQueryKey = deriveQueryKey(nextInput);
            const readModeChanged = previousInput !== null && previousInput.readMode !== nextInput.readMode;
            input = nextInput;
            if (readModeChanged && nextInput.readMode === 'complete') {
                // A progressive prefix cannot become a complete answer merely by changing policy.
                publish({ ...state, addresses: [], appliedQueryKey: null, appliedSourceKind: null,
                    nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
                    freshnessAt: null, metadataUpgradeRequiredCount: 0, membershipUnavailableReason: undefined });
            }
            if (!nextInput.selected) {
                revision += 1;
                activeAbortController?.abort('session-list-query-home-not-selected');
                activeAbortController = null;
                inFlight = null;
                refreshQueued = false;
                publishPhase(nextQueryKey, 'not_selected');
                return;
            }
            if (nextInput.online === false) {
                revision += 1;
                activeAbortController?.abort('session-list-query-home-offline');
                activeAbortController = null;
                inFlight = null;
                // Reconnect owns the next replacement; a queued refresh cannot
                // outlive the transport that was to answer it. Feature discovery
                // may also be unavailable, but that cannot hide a known outage.
                refreshQueued = false;
                publishPhase(nextQueryKey, 'offline');
                return;
            }
            if (nextInput.supported === null || nextInput.supported === undefined) {
                revision += 1;
                activeAbortController?.abort('session-list-query-support-loading');
                activeAbortController = null;
                inFlight = null;
                refreshQueued = false;
                publishPhase(nextQueryKey, 'idle');
                return;
            }
            // Strict query admission stays exactly `supported === true`. A Home that
            // cannot serve it is unsupported unless this corpus has a released GET
            // adapter configured up front, in which case that adapter is the request
            // source — never a post-failure substitution.
            if (nextInput.supported !== true && !nextInput.ordinaryAdapter) {
                revision += 1;
                activeAbortController?.abort('session-list-query-unsupported');
                activeAbortController = null;
                inFlight = null;
                refreshQueued = false;
                publishPhase(nextQueryKey, 'error', 'unsupported', 'filtered_session_listing_unavailable');
                return;
            }
            if (nextInput.online === null) {
                revision += 1;
                activeAbortController?.abort('session-list-query-home-transferring');
                activeAbortController = null;
                inFlight = null;
                refreshQueued = false;
                publishPhase(nextQueryKey, state.appliedQueryKey === nextQueryKey ? 'refreshing' : 'loading');
                return;
            }
            const queryChanged = previousQueryKey !== nextQueryKey
                || state.appliedQueryKey !== nextQueryKey;
            const previousPlan = resolvePageRequestPlan(previousInput);
            const nextPlan = resolvePageRequestPlan(input);
            const membershipChanged = previousPlan === null
                || previousPlan.membership !== nextPlan?.membership;
            // The same query re-applied while its page is still in flight is not a new request:
            // restarting it would abort the page that is about to answer, and a surface that
            // re-applies its input on every render would never leave loading.
            const requestAlreadyInFlight = inFlight !== null
                && previousQueryKey === nextQueryKey
                && state.requestedQueryKey === nextQueryKey
                && !membershipChanged
                && !readModeChanged;
            if (requestAlreadyInFlight) {
                await inFlight;
                return;
            }
            if (queryChanged || membershipChanged || readModeChanged) {
                await startPage('replace');
            }
        },
        refresh,
        retry: () => {
            if (inFlight) return inFlight;
            if (state.phase === 'error') {
                if (state.failedOperation === 'ordinary' && state.hasNext && state.nextCursor) return startPage('ordinary');
                if (state.failedOperation === 'attention' && state.attentionHasNext && state.attentionNextCursor) return startPage('attention');
            }
            return refresh();
        },
        invalidate: (scope, rowFacets) => {
            if (disposed || !input?.selected || !input.online) return Promise.resolve();
            // An unread page may hold a member a row write reorders into view, so only a
            // fully read corpus narrows the re-read to the inputs the writes can move.
            const fullyRead = !state.hasNext && !state.attentionHasNext;
            if (scope === 'structural'
                && !canRowWriteChangeSessionListMembership(input.query, fullyRead ? rowFacets : undefined)) return Promise.resolve();
            // Row-decided selections are placed from the batch-read row instead (`place`).
            if (scope === 'structural' && isSessionListQueryRowPlaceable(input.query)) return Promise.resolve();
            if (scope === 'recover') {
                // A read already replacing the corpus (the online transition starts one) is the recovery.
                if (inFlight) return inFlight;
                if (state.phase === 'ready' && state.appliedQueryKey === state.requestedQueryKey) return Promise.resolve();
            }
            if (inFlight) {
                refreshQueued = true;
                const currentRequest = inFlight;
                // Coalesce onto the same completion contract as refresh: the
                // queued replacement is installed synchronously from the
                // current request's `finally`, so chain to it rather than
                // reporting completion after only the stale request.
                return currentRequest.then(() => inFlight ?? Promise.resolve());
            }
            return startPage('replace');
        },
        place: (rows, readSortKey) => {
            if (disposed || !input?.selected || !input.online) return true;
            if (!isSessionListQueryRowPlaceable(input.query)) return false;
            if (!state.appliedQueryKey) return true;
            const placementBySessionId = new Map(rows.map(row => [row.sessionId, row.facts]));
            const sortKeyOf = (sessionId: string) => placementBySessionId.get(sessionId)?.sortKey ?? readSortKey(sessionId);
            let addresses = state.addresses;
            for (const { sessionId, facts } of rows) {
                const member = resolveSessionListQueryRowMembership(input.query, facts);
                const index = addresses.findIndex(address => address.sessionId === sessionId);
                const loaded = index >= 0;
                if (loaded) addresses = addresses.filter(address => address.sessionId !== sessionId);
                if (!member) continue;
                const address = loaded ? state.addresses.find(other => other.sessionId === sessionId)! : normalizeSessionAddress(serverId, sessionId);
                if (!address) continue;
                // Server order: sort key descending, then id descending.
                const position = addresses.findIndex(other => {
                    const otherKey = sortKeyOf(other.sessionId);
                    return otherKey === null || otherKey < facts.sortKey
                        || (otherKey === facts.sortKey && other.sessionId < sessionId);
                });
                if (position >= 0) addresses = [...addresses.slice(0, position), address, ...addresses.slice(position)];
                // Older than every loaded row: a loaded member stays last; an unloaded
                // one belongs to an unread page. An active-storage first page carries
                // every pinned member, and an includeAttention one every attention row
                // (while its attention partition is fully read), ahead of the window.
                else if (loaded || (!state.hasNext && !state.attentionHasNext)
                    || (input.query.storage === 'active' && facts.pinned)
                    || (input.query.includeAttention === true && facts.needsAttention && !state.attentionHasNext)) {
                    addresses = [...addresses, address];
                }
            }
            const unchanged = addresses.length === state.addresses.length
                && addresses.every((address, index) => address === state.addresses[index]);
            if (!unchanged) publish({ ...state, addresses });
            return true;
        },
        retire: (sessionIdRaw) => {
            const sessionId = String(sessionIdRaw ?? '').trim();
            if (disposed || !sessionId) return;
            const addresses = state.addresses.filter((address) => address.sessionId !== sessionId);
            if (addresses.length === state.addresses.length) return;
            publish({ ...state, addresses });
        },
        observeOrdinaryLastSuccessAt: (lastSuccessAt) => {
            ordinaryLastSuccessAt = typeof lastSuccessAt === 'number' && Number.isFinite(lastSuccessAt)
                ? lastSuccessAt : null;
            publish(state);
        },
        loadNext: () => {
            if (inFlight) return inFlight;
            if (state.hasNext && state.nextCursor) return startPage('ordinary');
            if (state.attentionHasNext && state.attentionNextCursor) return startPage('attention');
            return Promise.resolve();
        },
        dispose: () => {
            if (disposed) return;
            disposed = true;
            revision += 1;
            activeAbortController?.abort('session-list-query-controller-disposed');
            activeAbortController = null;
            inFlight = null;
            refreshQueued = false;
            listeners.clear();
        },
    };
}
