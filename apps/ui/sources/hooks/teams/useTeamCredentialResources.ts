import * as React from 'react';
import type {
    TeamCredentialResourceListFilterV1,
    TeamCredentialResourceActivityEventV1,
    TeamCredentialResourceCatalogEntryV1,
    TeamCredentialResourceSummaryV1,
    TeamCredentialViewerCapabilitiesV1,
    TeamCredentialUsageLimitV1,
    TeamCredentialUsageQueryInputV1,
    TeamCredentialUsageQueryResultV1,
    TeamCredentialSourceCandidateV1,
    TeamCredentialSourceCandidateListOutputV1,
    TeamCredentialRequestPolicySupportInputV1,
    TeamCredentialRequestPolicySupportOutputV1,
} from '@happier-dev/protocol/teams';
import { teamCredentialResourcesQueryKeyV1, mergeTeamCredentialUsagePages } from '@happier-dev/protocol/teams';
import type { HomeDomainFailure } from '@/sync/ops/teams/teamActionClient';
import { homeDomainFailureFromSnapshotError } from '@/sync/domains/teams/teamSnapshotFailure';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import {
    loadMoreTeamCredentialResources,
    observeTeamCredentialResource,
    observeTeamCredentialResourceCatalog,
    observeTeamCredentialResources,
    refreshTeamCredentialResources,
    refreshTeamCredentialResource,
    refreshTeamCredentialResourceCatalog,
} from '@/sync/engine/teams/teamsDirectoryEngine';
import { subscribeTeamCredentialUsageChanged } from '@/sync/engine/teams/teamCredentialUsageChanges';
import {
    listTeamCredentialActivity,
    listTeamCredentialSourceCandidates,
    listTeamCredentialUsageLimits,
    queryTeamCredentialUsage,
    getTeamCredentialRequestPolicySupport,
} from '@/sync/ops/teams/teamCredentialOperations';
import {
    getTeamCredentialResourceCatalogSnapshot,
    getTeamCredentialResourceSnapshot,
    getTeamCredentialResourcesSnapshot,
    readTeamCredentialResource,
    subscribeTeamsSnapshots,
} from '@/sync/store/teams/teamsSnapshots';

import { useTeamPagedList, type TeamPagedList } from './useTeamPagedList';
import {
    composeTeamCredentialProviderSourceOffer,
    type TeamCredentialSourceCandidatePresentationV1,
} from './composeTeamCredentialProviderSourceOffer';
import type { TeamCredentialProviderSourceOfferV1 } from './useTeamCredentialProviderSourceOffers';

/**
 * One Team's shared credential resources, and what this viewer may do with them.
 *
 * Administration rows and viewer capabilities remain one Home answer. Recipient
 * choices load independently through useTeamCredentialResourceCatalog. Neither
 * authority is reconstructed from a role, a custodian id or a Team capability.
 * `viewer` is `null` until the administration read answers,
 * so management entry points stay hidden while that question is open.
 */
export type TeamCredentialResourcesProjection = Readonly<{
    rows: readonly TeamCredentialResourceSummaryV1[];
    viewer: TeamCredentialViewerCapabilitiesV1 | null;
    status: 'loading' | 'refreshing' | 'ready' | 'error';
    /** Retained rows cannot prove absence while their snapshot is stale. */
    isCurrent: boolean;
    error: HomeDomainFailure | null;
    hasMore: boolean;
    loadMore: () => Promise<void>;
    retry: () => Promise<void>;
    reload: () => Promise<void>;
}>;

const NO_RESOURCES: readonly TeamCredentialResourceSummaryV1[] = Object.freeze([]);
const NO_CATALOG: readonly TeamCredentialResourceCatalogEntryV1[] = Object.freeze([]);

export type TeamCredentialResourceProjection = Readonly<{
    resource: TeamCredentialResourceSummaryV1 | null;
    status: 'loading' | 'refreshing' | 'ready' | 'error';
    isCurrent: boolean;
    resolved: boolean;
    error: HomeDomainFailure | null;
    reload: () => Promise<void>;
}>;

/** One exact administration resource, independent of list pagination. */
export function useTeamCredentialResource(params: Readonly<{
    scope: ServerAccountScope | null;
    address: TeamAddress | null;
    resourceId: string;
    enabled: boolean;
}>): TeamCredentialResourceProjection {
    const { scope, address, resourceId } = params;
    const serverId = scope?.serverId ?? '';
    const accountId = scope?.accountId ?? '';
    const addressServerId = address?.serverId ?? '';
    const teamId = address?.teamId ?? '';
    const active = params.enabled && scope !== null && address !== null && resourceId !== '';

    React.useEffect(() => {
        if (!active) return;
        return observeTeamCredentialResource({ serverId, accountId }, { serverId: addressServerId, teamId }, resourceId);
    }, [active, serverId, accountId, addressServerId, teamId, resourceId]);

    const snapshot = React.useSyncExternalStore(
        subscribeTeamsSnapshots,
        () => (active ? getTeamCredentialResourceSnapshot(scope, address, resourceId) : null),
        () => null,
    );
    const resource = snapshot?.status === 'error' && snapshot.error?.retryable === false
        ? null
        : snapshot?.data ?? (active ? readTeamCredentialResource(scope, address, resourceId) : null);
    const reload = React.useCallback(async () => {
        if (!active) return;
        await refreshTeamCredentialResource({ serverId, accountId }, { serverId: addressServerId, teamId }, resourceId);
    }, [active, serverId, accountId, addressServerId, teamId, resourceId]);

    return React.useMemo(() => Object.freeze({
        resource,
        status: snapshot?.status ?? 'loading',
        isCurrent: snapshot?.status === 'ready' && snapshot.stale === false,
        resolved: snapshot?.status === 'ready'
            || (snapshot?.status === 'error' && snapshot.error?.retryable === false),
        error: snapshot?.error ? homeDomainFailureFromSnapshotError(snapshot.error) : null,
        reload,
    }), [resource, snapshot, reload]);
}

export type TeamCredentialResourceCatalogProjection = Readonly<{
    resources: readonly TeamCredentialResourceCatalogEntryV1[];
    isCurrent: boolean;
    resolved: boolean;
    error: HomeDomainFailure | null;
    reload: () => Promise<void>;
}>;

/** The independent least-privilege recipient catalog used by read-only detail. */
export function useTeamCredentialResourceCatalog(params: Readonly<{
    scope: ServerAccountScope | null;
    address: TeamAddress | null;
    enabled: boolean;
}>): TeamCredentialResourceCatalogProjection {
    const { scope, address } = params;
    const serverId = scope?.serverId ?? '';
    const accountId = scope?.accountId ?? '';
    const addressServerId = address?.serverId ?? '';
    const teamId = address?.teamId ?? '';
    const active = params.enabled && scope !== null && address !== null;
    React.useEffect(() => {
        if (!active) return;
        return observeTeamCredentialResourceCatalog({ serverId, accountId }, { serverId: addressServerId, teamId });
    }, [active, serverId, accountId, addressServerId, teamId]);
    const subscribeCatalog = React.useCallback((listener: () => void) => subscribeTeamsSnapshots(listener, {
        scope: active ? { serverId, accountId } : null,
        credentialCatalogs: [{ address: { serverId: addressServerId, teamId } }],
    }), [active, serverId, accountId, addressServerId, teamId]);
    const snapshot = React.useSyncExternalStore(
        subscribeCatalog,
        () => (active ? getTeamCredentialResourceCatalogSnapshot(scope, address) : null),
        () => null,
    );
    const reload = React.useCallback(async () => {
        if (!active) return;
        await refreshTeamCredentialResourceCatalog({ serverId, accountId }, { serverId: addressServerId, teamId });
    }, [active, serverId, accountId, addressServerId, teamId]);
    return React.useMemo(() => Object.freeze({
        resources: snapshot?.data ?? NO_CATALOG,
        isCurrent: snapshot?.status === 'ready' && snapshot.stale === false,
        resolved: snapshot?.status === 'ready'
            || (snapshot?.status === 'error' && snapshot.error?.retryable === false),
        error: snapshot?.error ? homeDomainFailureFromSnapshotError(snapshot.error) : null,
        reload,
    }), [snapshot, reload]);
}

export function useTeamCredentialResources(params: Readonly<{
    scope: ServerAccountScope | null;
    address: TeamAddress | null;
    enabled: boolean;
    search?: string;
    filter?: TeamCredentialResourceListFilterV1;
}>): TeamCredentialResourcesProjection {
    const { scope, address, enabled, search, filter = 'all' } = params;
    const serverId = scope?.serverId ?? '';
    const accountId = scope?.accountId ?? '';
    const addressServerId = address?.serverId ?? '';
    const teamId = address?.teamId ?? '';
    const active = enabled && scope !== null && address !== null;
    const queryKey = address && (search || filter !== 'all')
        ? teamCredentialResourcesQueryKeyV1({
            teamId: address.teamId,
            filter,
            ...(search ? { search } : {}),
        })
        : '';

    React.useEffect(() => {
        if (!active) return;
        return observeTeamCredentialResources({ serverId, accountId }, { serverId: addressServerId, teamId }, search, filter);
    }, [active, serverId, accountId, addressServerId, teamId, search, filter]);

    const snapshot = React.useSyncExternalStore(
        subscribeTeamsSnapshots,
        () => (active ? getTeamCredentialResourcesSnapshot(scope, address, queryKey) : null),
        () => null,
    );

    const reload = React.useCallback(async () => {
        if (!active) return;
        await refreshTeamCredentialResources({ serverId, accountId }, { serverId: addressServerId, teamId }, search, filter);
    }, [active, serverId, accountId, addressServerId, teamId, search, filter]);

    const [loadingMore, setLoadingMore] = React.useState(false);
    const loadMore = React.useCallback(async () => {
        if (!active) return;
        setLoadingMore(true);
        try {
            await loadMoreTeamCredentialResources({ serverId, accountId }, { serverId: addressServerId, teamId }, search, filter);
        } finally {
            setLoadingMore(false);
        }
    }, [active, serverId, accountId, addressServerId, teamId, search, filter]);
    const hasMore = (snapshot?.nextCursor ?? null) !== null;
    const retry = hasMore && snapshot?.data
        ? loadMore
        : reload;

    return React.useMemo(() => Object.freeze({
        rows: snapshot?.data ?? NO_RESOURCES,
        viewer: snapshot?.viewer ?? null,
        // A refresh over rows already on screen is not a loading state: the
        // previous resources stay rendered and are marked stale.
        status: loadingMore
            ? 'refreshing' as const
            : snapshot === null || snapshot.status === 'loading'
            ? 'loading' as const
            : snapshot.status,
        isCurrent: snapshot?.status === 'ready' && snapshot.stale === false,
        error: snapshot?.error ? homeDomainFailureFromSnapshotError(snapshot.error) : null,
        hasMore,
        loadMore,
        retry,
        reload,
    }), [snapshot, loadingMore, hasMore, loadMore, retry, reload]);
}

/**
 * One resource's administrative history.
 *
 * This stays a paged read rather than a shared projection: activity is only
 * ever read by the open Activity route, so promoting it would add retained
 * state with no second consumer. It is requested only once that route opens.
 */
export function useTeamCredentialActivity(params: Readonly<{
    scope: ServerAccountScope | null;
    resourceId: string;
    enabled: boolean;
}>): TeamPagedList<TeamCredentialResourceActivityEventV1> {
    const serverId = params.scope?.serverId ?? '';
    const accountId = params.scope?.accountId ?? '';
    const { resourceId } = params;

    const loadPage = React.useCallback(
        async (cursor: string | null, signal: AbortSignal) => {
            const outcome = await listTeamCredentialActivity({
                scope: { serverId, accountId },
                resourceId,
                cursor,
                signal,
            });
            return outcome.kind === 'succeeded'
                ? Object.freeze({
                    kind: 'succeeded' as const,
                    value: outcome.value,
                })
                : Object.freeze({ kind: 'failed' as const, failure: outcome.failure });
        },
        [serverId, accountId, resourceId],
    );

    return useTeamPagedList<TeamCredentialResourceActivityEventV1>({
        key: params.scope
            ? serverAccountScopedResourceKey(params.scope, 'team-credential-activity', resourceId)
            : '',
        enabled: params.enabled && serverId !== '' && accountId !== '' && resourceId !== '',
        loadPage,
    });
}

export type TeamCredentialSourceCandidatesProjection = Readonly<{
    candidates: readonly TeamCredentialSourceCandidatePresentationV1[];
    /**
     * The source families this Home can pin at all. A family missing from this
     * list is unsupported here, which is a different answer from owning none of
     * them and is why the chooser is told both.
     */
    supportedKinds: readonly TeamCredentialSourceCandidateV1['source']['kind'][];
    brokerPresentation: TeamCredentialSourceCandidateListOutputV1['brokerPresentation'];
    status: 'loading' | 'ready' | 'error';
    error: HomeDomainFailure | null;
    reload: () => Promise<void>;
}>;

const NO_CANDIDATES: readonly TeamCredentialSourceCandidateV1[] = Object.freeze([]);
const NO_KINDS: readonly TeamCredentialSourceCandidateV1['source']['kind'][] = Object.freeze([]);
const NO_BROKER_PRESENTATION: TeamCredentialSourceCandidateListOutputV1['brokerPresentation'] = Object.freeze({
    selectedTarget: null, eligibleTargets: [], selectedPool: null, eligiblePools: [],
});

/**
 * The sources this viewer may offer, read when the create surface opens.
 *
 * It is deliberately not part of the retained Team projection: only the offer
 * surface needs it, and a retained copy would age against Pools and Accounts the
 * owner changes in Connected Services, so a stale pin could be offered as
 * current.
 */
export function useTeamCredentialSourceCandidates(params: Readonly<{
    scope: ServerAccountScope | null;
    address: TeamAddress | null;
    enabled: boolean;
    providerSourceOffers?: readonly TeamCredentialProviderSourceOfferV1[];
}>): TeamCredentialSourceCandidatesProjection {
    const requestEpoch = React.useRef(0);
    const request = React.useRef<AbortController | null>(null);
    const [state, setState] = React.useState<Readonly<{
        candidates: readonly TeamCredentialSourceCandidateV1[];
        supportedKinds: readonly TeamCredentialSourceCandidateV1['source']['kind'][];
        brokerPresentation: TeamCredentialSourceCandidateListOutputV1['brokerPresentation'];
        status: TeamCredentialSourceCandidatesProjection['status'];
        error: HomeDomainFailure | null;
    }>>({ candidates: NO_CANDIDATES, supportedKinds: NO_KINDS, brokerPresentation: NO_BROKER_PRESENTATION, status: 'loading', error: null });
    const { scope, address } = params;
    const active = params.enabled && scope !== null && address !== null;

    const load = React.useCallback(async () => {
        if (!active || !scope || !address) return;
        const epoch = ++requestEpoch.current;
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        setState((previous) => ({ ...previous, status: 'loading', error: null }));
        const outcome = await listTeamCredentialSourceCandidates({ scope, address, signal: controller.signal }).catch(error => {
            if (controller.signal.aborted) return null;
            throw error;
        });
        if (!outcome || epoch !== requestEpoch.current) return;
        if (outcome.kind === 'succeeded') {
            setState({
                candidates: outcome.value.candidates,
                supportedKinds: outcome.value.supportedKinds,
                brokerPresentation: outcome.value.brokerPresentation,
                status: 'ready',
                error: null,
            });
            return;
        }
        // Sources already read stay selectable through a failed refresh; the
        // Home's refusal is reported beside them rather than replacing them.
        setState((previous) => ({ ...previous, status: 'error', error: outcome.failure }));
    }, [active, address, scope]);

    React.useEffect(() => {
        void load();
        return () => { requestEpoch.current += 1; request.current?.abort(); };
    }, [load]);

    return React.useMemo(() => Object.freeze({
        ...state,
        candidates: composeTeamCredentialProviderSourceOffer(
            state.candidates,
            state.supportedKinds.includes('provider_connection')
                ? params.providerSourceOffers ?? []
                : [],
        ),
        reload: load,
    }), [load, params.providerSourceOffers, state]);
}

export type TeamCredentialLimitsProjection = Readonly<{
    rows: readonly TeamCredentialUsageLimitV1[];
    status: 'loading' | 'ready' | 'error';
    error: HomeDomainFailure | null;
    reload: () => Promise<void>;
}>;

export type TeamCredentialRequestPolicySupportProjection = Readonly<{
    result: TeamCredentialRequestPolicySupportOutputV1 | null;
    status: 'loading' | 'ready' | 'error';
    error: HomeDomainFailure | null;
    reload: () => Promise<void>;
}>;

/** On-demand support projected by the exact source owner; never inferred by the client. */
export function useTeamCredentialRequestPolicySupport(params: Readonly<{
    scope: ServerAccountScope | null;
    input: TeamCredentialRequestPolicySupportInputV1 | null;
    enabled: boolean;
}>): TeamCredentialRequestPolicySupportProjection {
    const requestEpoch = React.useRef(0);
    const request = React.useRef<AbortController | null>(null);
    const [state, setState] = React.useState<Omit<TeamCredentialRequestPolicySupportProjection, 'reload'>>({
        result: null,
        status: 'loading',
        error: null,
    });
    const scope = params.scope;
    const inputKey = params.input === null ? '' : JSON.stringify(params.input);
    const inputRef = React.useRef(params.input);
    inputRef.current = params.input;
    const active = params.enabled && scope !== null && params.input !== null;
    const load = React.useCallback(async () => {
        const input = inputRef.current;
        if (!active || !scope || !input) return;
        const epoch = ++requestEpoch.current;
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        setState((previous) => ({ ...previous, status: 'loading', error: null }));
        const outcome = await getTeamCredentialRequestPolicySupport({ scope, input, signal: controller.signal }).catch(error => {
            if (controller.signal.aborted) return null;
            throw error;
        });
        if (!outcome || epoch !== requestEpoch.current) return;
        setState(outcome.kind === 'succeeded'
            ? { result: outcome.value, status: 'ready', error: null }
            : { result: null, status: 'error', error: outcome.failure });
    }, [active, inputKey, scope]);
    React.useEffect(() => {
        void load();
        return () => { requestEpoch.current += 1; request.current?.abort(); };
    }, [load]);
    return React.useMemo(() => ({ ...state, reload: load }), [load, state]);
}

/** Limits are an on-demand resource read; they are not part of the list cache. */
export function useTeamCredentialUsageLimits(params: Readonly<{
    scope: ServerAccountScope | null;
    resourceId: string;
    resourceRevision: number | null;
    enabled: boolean;
}>): TeamCredentialLimitsProjection {
    const requestEpoch = React.useRef(0);
    const request = React.useRef<AbortController | null>(null);
    const [state, setState] = React.useState<Readonly<{
        rows: readonly TeamCredentialUsageLimitV1[];
        status: TeamCredentialLimitsProjection['status'];
        error: HomeDomainFailure | null;
    }>>({ rows: Object.freeze([]), status: 'loading', error: null });
    const scope = params.scope;
    const active = params.enabled && scope !== null && params.resourceId !== '';
    const load = React.useCallback(async () => {
        if (!active || !scope) return;
        const epoch = ++requestEpoch.current;
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        setState((previous) => ({ ...previous, status: 'loading', error: null }));
        const outcome = await listTeamCredentialUsageLimits({ scope, resourceId: params.resourceId, signal: controller.signal }).catch(error => {
            if (controller.signal.aborted) return null;
            throw error;
        });
        if (!outcome || epoch !== requestEpoch.current) return;
        if (outcome.kind === 'succeeded') {
            setState({ rows: outcome.value.limits, status: 'ready', error: null });
        } else {
            setState((previous) => ({ ...previous, status: 'error', error: outcome.failure }));
        }
    }, [active, params.resourceId, params.resourceRevision, scope]);
    React.useEffect(() => {
        void load();
        return () => { requestEpoch.current += 1; request.current?.abort(); };
    }, [load]);
    return React.useMemo(() => Object.freeze({ ...state, reload: load }), [load, state]);
}

export type TeamCredentialUsageProjection = Readonly<{
    result: TeamCredentialUsageQueryResultV1 | null;
    status: 'loading' | 'ready' | 'error';
    /** A later page failed; the rows already shown are still authoritative. */
    partial: boolean;
    /**
     * Whether `result` was produced by the query currently being asked.
     *
     * A retained result stays visible across a range or breakdown change so the
     * screen does not blank, but it is the previous query's answer. Anything
     * that stamps the current query's labels on these numbers — the CSV export
     * above all — must consume this instead of `status`, which a failed refresh
     * flips to `error` while the old numbers are still on screen.
     */
    resultIsCurrentQuery: boolean;
    hasMore: boolean;
    loadingMore: boolean;
    error: HomeDomainFailure | null;
    reload: () => Promise<void>;
    loadMore: () => Promise<void>;
}>;

/** Resource usage keeps the query shape local to the route and reuses the canonical UsageEvent query owner. */
export function useTeamCredentialUsage(params: Readonly<{
    scope: ServerAccountScope | null;
    input: TeamCredentialUsageQueryInputV1;
    resourceRevision: number | null;
    enabled: boolean;
}>): TeamCredentialUsageProjection {
    const requestEpoch = React.useRef(0);
    const request = React.useRef<AbortController | null>(null);
    const [state, setState] = React.useState<Readonly<{
        key: string;
        continuityKey: string;
        /** The query identity `result` actually came from. */
        resultKey: string;
        result: TeamCredentialUsageQueryResultV1 | null;
        status: TeamCredentialUsageProjection['status'];
        partial: boolean;
        nextCursor: string | null;
        loadingMore: boolean;
        error: HomeDomainFailure | null;
    }>>({ key: '', continuityKey: '', resultKey: '', result: null, status: 'loading', partial: false, nextCursor: null, loadingMore: false, error: null });
    const scope = params.scope;
    const inputKey = JSON.stringify(params.input);
    const input = React.useMemo(() => params.input, [inputKey]);
    const active = params.enabled && scope !== null;
    const key = scope
        ? serverAccountScopedResourceKey(scope, 'team-credential-usage', `${params.resourceRevision ?? -1}:${inputKey}`)
        : '';
    const continuityKey = scope
        ? serverAccountScopedResourceKey(
            scope,
            'team-credential-usage-resource',
            `${params.resourceRevision ?? -1}:${JSON.stringify({ resourceId: params.input.resourceId, subject: params.input.subject })}`,
        )
        : '';
    const stateRef = React.useRef(state);
    stateRef.current = state;

    const load = React.useCallback(async (mode: 'reload' | 'more') => {
        if (!active || !scope) return;
        const current = stateRef.current;
        const continuing = mode === 'more' && current.key === key;
        const cursor = continuing ? current.nextCursor : null;
        if (mode === 'more' && (cursor === null || current.loadingMore)) return;
        const epoch = ++requestEpoch.current;
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        setState((previous) => continuing
            ? { ...previous, loadingMore: true, error: null }
            : {
                key,
                continuityKey,
                resultKey: previous.continuityKey === continuityKey ? previous.resultKey : '',
                result: previous.continuityKey === continuityKey ? previous.result : null,
                status: 'loading',
                partial: false,
                nextCursor: null,
                loadingMore: false,
                error: null,
            });
        const outcome = await queryTeamCredentialUsage({
            scope,
            input: cursor === null ? input : { ...input, cursor },
            signal: controller.signal,
        }).catch(error => {
            if (controller.signal.aborted) return null;
            throw error;
        });
        if (!outcome || epoch !== requestEpoch.current) return;
        if (outcome.kind === 'succeeded') {
            setState((previous) => ({
                key,
                continuityKey,
                resultKey: key,
                result: continuing && previous.key === key && previous.result
                    ? mergeTeamCredentialUsagePages(previous.result, outcome.value)
                    : outcome.value,
                status: 'ready',
                partial: false,
                nextCursor: outcome.value.nextCursor,
                loadingMore: false,
                error: null,
            }));
        } else {
            setState((previous) => previous.key !== key
                ? previous
                : {
                    ...previous,
                    ...(outcome.failure.retryable ? {} : { result: null, resultKey: '', nextCursor: null }),
                    status: 'error',
                    partial: outcome.failure.retryable && continuing && previous.result !== null,
                    loadingMore: false,
                    error: outcome.failure,
                });
        }
    }, [active, continuityKey, input, key, scope]);
    React.useEffect(() => {
        void load('reload');
        return () => { requestEpoch.current += 1; request.current?.abort(); };
    }, [load]);
    const reload = React.useCallback(() => load('reload'), [load]);
    const loadMore = React.useCallback(() => load('more'), [load]);
    const current = state.key === key || state.continuityKey === continuityKey
        ? state
        : { resultKey: '', result: null, status: 'loading' as const, partial: false, nextCursor: null, loadingMore: false, error: null };
    return React.useMemo(() => Object.freeze({
        result: current.result,
        status: current.status,
        partial: current.partial,
        resultIsCurrentQuery: current.result !== null && current.resultKey === key,
        hasMore: current.nextCursor !== null,
        loadingMore: current.loadingMore,
        error: current.error,
        reload,
        loadMore,
    }), [current.error, current.loadingMore, current.nextCursor, current.partial, current.result, current.resultKey, current.status, key, loadMore, reload]);
}

/**
 * Rereads a mounted resource usage view when its Home records new usage for
 * that resource (L10/07 L10.07-C step 5, "Mounted truth").
 *
 * `refresh` is the view's own explicit refresh, so a wake reads the same current
 * range the Refresh control would. Wakes that arrive while a read is in flight
 * collapse into one trailing read: a busy resource cannot queue a read per
 * request, and the last read still covers every write before it.
 */
export function useTeamCredentialUsageWriteRefresh(params: Readonly<{
    scope: ServerAccountScope | null;
    resourceId?: string;
    subject?: TeamCredentialUsageQueryInputV1['subject'];
    enabled: boolean;
    reading: boolean;
    refresh: () => void;
}>): void {
    const latest = React.useRef(params);
    latest.current = params;
    const pending = React.useRef(false);
    const serverId = params.enabled ? params.scope?.serverId ?? null : null;
    React.useEffect(() => {
        if (serverId === null) return;
        pending.current = false;
        return subscribeTeamCredentialUsageChanged({ serverId, resourceId: params.resourceId, subject: params.subject }, () => {
            if (latest.current.reading) {
                pending.current = true;
                return;
            }
            latest.current.refresh();
        });
    }, [params.resourceId, params.subject?.kind, params.subject?.kind === 'team' ? params.subject.teamId : null, serverId]);
    React.useEffect(() => {
        if (params.reading || !pending.current) return;
        pending.current = false;
        latest.current.refresh();
    }, [params.reading]);
}
