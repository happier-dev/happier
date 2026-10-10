import type { SessionListQueryV1 } from '@happier-dev/protocol';

import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { normalizeSessionAddress, sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import type { SessionListFetchResult } from '@/sync/engine/sessions/sessionSnapshot';
import type { SessionListPageSource } from '@/sync/engine/sessions/sessionHttpCompat';
import { HappyError } from '@/utils/errors/errors';

import { buildSessionListQueryKey } from './sessionListQueryKey';

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

export type SessionListQueryFailureReason =
    | 'unsupported'
    | 'invalid_query'
    | 'access_denied'
    | 'cursor_not_advancing'
    | 'network';

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
    failureReason: SessionListQueryFailureReason | null;
    failureCode: string | null;
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
    limit?: number;
    cursor?: string | null;
    attentionCursor?: string | null;
    signal: AbortSignal;
}>;

/**
 * Whether one released owner/direct GET corpus can answer the structural part
 * of this query. Source and text search remain local row projections, so their
 * pagination may reuse this adapter; Team/Group/tag/attention selections may
 * not silently broaden to the ordinary corpus.
 */
export function canSessionListOrdinaryPageAnswerQuery(query: SessionListQueryV1): boolean {
    return query.audiences.length === 0
        && query.tagIds.length === 0
        && query.attention === 'any'
        && query.scope === 'my_work';
}

export type SessionListQueryHomeController = Readonly<{
    getSnapshot(): SessionListQueryHomeState;
    subscribe(listener: () => void): () => void;
    update(input: ControllerInput): Promise<void>;
    refresh(): Promise<void>;
    /**
     * Re-read page one after an Account change. `'structural'` (a row-level Session
     * write) skips a corpus the ordinary list can answer: its membership is decided by
     * ownership and archive state, which the exact row refresh already reconciles.
     */
    invalidate(scope?: 'structural'): Promise<void>;
    /**
     * Removes one committed-retired (deleted/revoked) Session from this Home's
     * applied membership. A response already in flight is fenced at the list reader,
     * so the address cannot return until a later read admits it again.
     */
    retire(sessionId: string): void;
    loadNext(): Promise<void>;
    dispose(): void;
}>;

type ControllerInput = Readonly<{
    query: SessionListQueryV1;
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
 * of the corpus is being requested. The caller's validated `limit` is page policy
 * and stays on every initial, ordinary-continuation and attention-continuation
 * request, so a filter builder asking for a non-default page size gets it.
 */
function stripCursorState(query: SessionListQueryV1): SessionListQueryV1 {
    const { cursor: _cursor, attentionCursor: _attentionCursor, ...base } = query;
    return base;
}

function appendAddresses(
    current: readonly SessionAddress[],
    serverId: string,
    sessionIds: readonly string[],
): readonly SessionAddress[] {
    const next = [...current];
    const seen = new Set(current.map(sessionAddressKey));
    for (const sessionId of sessionIds) {
        const address = normalizeSessionAddress(serverId, sessionId);
        if (!address) continue;
        const key = sessionAddressKey(address);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(address);
    }
    return next.length === current.length ? current : next;
}

function readFailureCode(error: unknown): string | null {
    if (error instanceof HappyError) return error.code?.trim() || null;
    if (!error || typeof error !== 'object' || !('code' in error)) return null;
    return typeof error.code === 'string' && error.code.trim() ? error.code.trim() : null;
}

function readFailureStatus(error: unknown): number | null {
    if (error instanceof HappyError) return error.status ?? null;
    if (!error || typeof error !== 'object' || !('status' in error)) return null;
    return typeof error.status === 'number' && Number.isFinite(error.status) ? error.status : null;
}

function classifyFailure(error: unknown): Readonly<{
    reason: Exclude<SessionListQueryFailureReason, 'cursor_not_advancing'>;
    code: string | null;
}> {
    const code = readFailureCode(error);
    const status = readFailureStatus(error);
    if (
        code === 'operation_not_supported'
        || code === 'feature_not_supported'
        || code === 'filtered_session_listing_unavailable'
    ) {
        return { reason: 'unsupported', code };
    }
    if (code === 'invalid_query' || code === 'invalid_request' || status === 400 || status === 422) {
        return { reason: 'invalid_query', code };
    }
    if (code === 'access_denied' || code === 'not_authenticated' || status === 401 || status === 403) {
        return { reason: 'access_denied', code };
    }
    return { reason: 'network', code };
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
        if (disposed || next === state) return;
        const previous = state;
        state = next;
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
        ) return;
        publish({ ...state, requestedQueryKey, phase, failureReason, failureCode });
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
        const requestedCursor = family === 'ordinary' ? state.nextCursor : null;
        const requestedAttentionCursor = family === 'attention' ? state.attentionNextCursor : null;

        publish({
            ...state,
            requestedQueryKey: requestQueryKey,
            phase: family === 'replace'
                ? (state.addresses.length > 0 ? 'refreshing' : 'loading')
                : 'loading',
            failureReason: null,
            failureCode: null,
        });

        let promise: Promise<void> | undefined;
        promise = (async () => {
            try {
                const result = await params.fetchPage({
                    source: plan.source,
                    membership: plan.membership,
                    ...(typeof requestInput.query.limit === 'number'
                        ? { limit: requestInput.query.limit }
                        : {}),
                    ...(family === 'ordinary' ? { cursor: requestedCursor } : {}),
                    ...(family === 'attention' ? { attentionCursor: requestedAttentionCursor } : {}),
                    signal: abortController.signal,
                });
                if (!isRequestCurrent(requestRevision, abortController.signal)) return;
                if (!result.current) {
                    publish({ ...state, phase: 'offline', failureReason: null, failureCode: null });
                    return;
                }

                const repeatedOrdinaryCursor = family === 'ordinary'
                    && result.hasNext
                    && Boolean(requestedCursor)
                    && result.nextCursor === requestedCursor;
                const repeatedAttentionCursor = family === 'attention'
                    && result.attentionHasNext
                    && Boolean(requestedAttentionCursor)
                    && result.attentionNextCursor === requestedAttentionCursor;
                const addresses = appendAddresses(
                    family === 'replace' ? [] : state.addresses,
                    serverId,
                    result.sessionIds.filter((sessionId) => result.isSessionCurrent?.(sessionId) !== false),
                );

                if (repeatedOrdinaryCursor || repeatedAttentionCursor) {
                    publish({
                        ...state,
                        appliedQueryKey: requestQueryKey,
                        appliedSourceKind: plan.source.kind,
                        addresses,
                        ...(repeatedOrdinaryCursor ? { nextCursor: null, hasNext: false } : {}),
                        ...(repeatedAttentionCursor ? { attentionNextCursor: null, attentionHasNext: false } : {}),
                        phase: 'error',
                        failureReason: 'cursor_not_advancing',
                        failureCode: 'cursor_not_advancing',
                    });
                    return;
                }

                publish({
                    ...state,
                    appliedQueryKey: requestQueryKey,
                    appliedSourceKind: plan.source.kind,
                    addresses,
                    metadataUpgradeRequiredCount: (family === 'replace' ? 0 : state.metadataUpgradeRequiredCount ?? 0)
                        + (result.metadataUpgradeRequiredCount ?? 0),
                    ...(family !== 'attention' ? {
                        nextCursor: result.nextCursor,
                        hasNext: result.hasNext,
                    } : {}),
                    ...(family !== 'ordinary' ? {
                        attentionNextCursor: result.attentionNextCursor,
                        attentionHasNext: result.attentionHasNext,
                    } : {}),
                    phase: 'ready',
                    freshnessAt: now(),
                    failureReason: null,
                    failureCode: null,
                });
            } catch (error) {
                if (!isRequestCurrent(requestRevision, abortController.signal)) return;
                const failure = classifyFailure(error);
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
                    } : {}),
                    phase: 'error',
                    failureReason: failure.reason,
                    failureCode: failure.code,
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
            input = nextInput;
            if (!nextInput.selected) {
                revision += 1;
                activeAbortController?.abort('session-list-query-home-not-selected');
                activeAbortController = null;
                inFlight = null;
                refreshQueued = false;
                publishPhase(nextQueryKey, 'not_selected');
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
            if (!nextInput.online) {
                revision += 1;
                activeAbortController?.abort('session-list-query-home-offline');
                activeAbortController = null;
                inFlight = null;
                // A refresh queued against the request that just lost currentness
                // cannot survive into reconnect. `update` below already performs
                // the one canonical replacement for the newly-online input; a
                // later invalidation can still queue against that new request.
                refreshQueued = false;
                publishPhase(nextQueryKey, 'offline');
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
                && !membershipChanged;
            if (requestAlreadyInFlight) {
                await inFlight;
                return;
            }
            if (queryChanged || membershipChanged) {
                await startPage('replace');
            }
        },
        refresh: () => {
            if (inFlight) {
                refreshQueued = true;
                const currentRequest = inFlight;
                // `startPage` installs the coalesced replacement synchronously
                // from the current request's `finally`. Chain to that promise so
                // pull-to-refresh does not report completion after only the stale
                // request it asked to replace.
                return currentRequest.then(() => inFlight ?? Promise.resolve());
            }
            return startPage('replace');
        },
        invalidate: (scope) => {
            if (disposed || !input?.selected || !input.online) return Promise.resolve();
            if (scope === 'structural' && canSessionListOrdinaryPageAnswerQuery(input.query)) return Promise.resolve();
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
        retire: (sessionIdRaw) => {
            const sessionId = String(sessionIdRaw ?? '').trim();
            if (disposed || !sessionId) return;
            const addresses = state.addresses.filter((address) => address.sessionId !== sessionId);
            if (addresses.length === state.addresses.length) return;
            publish({ ...state, addresses });
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
