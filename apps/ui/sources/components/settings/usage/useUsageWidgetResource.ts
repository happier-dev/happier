import * as React from 'react';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { isPluginUiResourceReadAuthorityLost } from '@happier-dev/plugin-ui/advanced';
import type { PluginUiResourceSnapshot } from '@happier-dev/plugin-ui/hostApi';
import { getUsageQueryKey, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ServerAccountScopeLifetime, ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { captureUiUsageQueryAccountContext, decodeUsageQueryResource, getUsageQueryResourceStore, type UsageQueryResourceEntry } from '@/sync/api/account/usageQueryResource';
import { getUsagePeriodDefinition } from '@/sync/api/account/usagePeriods';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { UsageWidgetQueryPlan } from './usageWidgetQueries';

export type UsageWidgetResource = Readonly<{ entry: UsageQueryResourceEntry | null; lifetime: ServerAccountScopeLifetime | null; plan: UsageWidgetQueryPlan }>;
export type UsageWidgetQueryIdentity = Readonly<{ query: UsageQuery; authority: ServerAccountScope }>;
/** A body selects its consumed facts and source facets; shared Resource authority and transport lifecycle stay intact. */
export type UsageWidgetSliceProjection = (slice: UsageQueryResultSlice, previous: UsageQueryResultSlice | undefined) => UsageQueryResultSlice;
const identitySlice: UsageWidgetSliceProjection = slice => slice;
/** Hidden retained bodies and page chrome admit no live or static reads. */
export function useUsageWidgetResourceSubscription(entry: UsageQueryResourceEntry | null, live: boolean) {
    const presented = useLayoutPresentationActive();
    return React.useCallback((listener: () => void) => presented ? entry?.subscribe(listener, live) ?? (() => {}) : () => {},
        [entry, live, presented]);
}
/** The visual lane consumes these facts directly; no widget computes accounting or source state. */
export type UsageWidgetBodyModel = Readonly<{
    requestedQuery: UsageWidgetQueryIdentity | null; shownQuery: UsageWidgetQueryIdentity | null;
    slice: UsageQueryResultSlice | null; pending: boolean; error: PluginUiResourceSnapshot['error'] | null;
    freshness: PluginUiResourceSnapshot['freshness']; updatingPreviousPeriod: boolean;
    /** The shown facts' own read is in flight. Another source still outstanding is that source's state, not this. */
    refreshing: boolean;
    refresh(callerContext?: ActionExecutorContext): Promise<void>;
}>;
const EMPTY_SNAPSHOT: PluginUiResourceSnapshot = Object.freeze({ freshness: 'unknown', pending: 'idle', subscription: 'ended' });
type UsageWidgetBodySnapshot = Readonly<Pick<PluginUiResourceSnapshot, 'freshness' | 'error'> & {
    pending: boolean; readActivity: boolean;
    current: boolean; authorityLost: boolean; presentationReady: boolean; slice: UsageQueryResultSlice | undefined;
    row: UsageWidgetQueryRow | undefined;
    identity: UsageWidgetQueryIdentity | null;
    retained: UsageWidgetPrior | null;
    periodContinuity: Readonly<{ sameMeaning: boolean; changed: boolean }>;
}>;
type UsageWidgetPrior = Readonly<{ instanceId: string; identity: UsageWidgetQueryIdentity;
    slice: UsageQueryResultSlice; lifetime: ServerAccountScopeLifetime }>;
type UsageWidgetQueryRow = Readonly<{ query?: UsageQuery; key?: string }>;
const NO_QUERY_ROWS: readonly UsageWidgetQueryRow[] = Object.freeze([]);
const acceptsEverySlice = () => true;
const selectBodySnapshot = (snapshot: UsageWidgetBodySnapshot) => snapshot;

function getPeriodAdjustedUsageQueryKey(previous: UsageQuery, query: UsageQuery): string {
    const followsPeriodGranularity = typeof previous.period.relative === 'string' && typeof query.period.relative === 'string'
        && previous.granularity === getUsagePeriodDefinition(previous.period.relative).granularity
        && query.granularity === getUsagePeriodDefinition(query.period.relative).granularity;
    return getUsageQueryKey({ ...previous, period: query.period,
        ...(followsPeriodGranularity ? { granularity: query.granularity } : {}) });
}

/** One canonical batch Resource per mounted page; bodies select its already decoded slices. */
export function useUsageWidgetResource(input: Readonly<{
    credentials: AuthCredentials | null; enabled: boolean; plan: UsageWidgetQueryPlan;
    /** A mounted dashboard owns admitted reads while viewport membership changes. */
    retainPendingDemand?: boolean;
    callerContext?: ActionExecutorContext;
    /** Existing page selection identity; unrelated later plan changes are UI observations. */
    callerQuery?: UsageQuery;
}>): UsageWidgetResource {
    const presented = useLayoutPresentationActive();
    const lifetime = captureActiveServerAccountScopeLifetime();
    const context = React.useMemo(() => input.enabled && input.credentials && lifetime?.isCurrent()
        && areServerAccountScopesEqual(input.plan.scope, lifetime.scope)
        ? captureUiUsageQueryAccountContext(input.credentials) : null,
    [input.enabled, input.credentials, lifetime, input.plan.scope.serverId, input.plan.scope.accountId]);
    const consumedOrigin = React.useRef<UsageQuery | ActionExecutorContext | undefined>(undefined);
    const entry = React.useMemo(() => {
        if (!context || !input.plan.input) return null;
        const origin = input.callerQuery ?? input.callerContext;
        const callerContext = origin && origin !== consumedOrigin.current ? input.callerContext : undefined;
        const acquired = getUsageQueryResourceStore(context).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport(input.plan.input) }, callerContext);
        if (!callerContext) return acquired;
        return Object.freeze({ ...acquired, subscribe(listener: () => void, live: boolean) {
            consumedOrigin.current = origin;
            return acquired.subscribe(listener, live);
        } });
    }, [context, input.plan.batchKey, input.callerContext, input.callerQuery]);
    const admitted = React.useRef(new Map<UsageWidgetQueryPlan['batchKey'], () => void>());
    React.useLayoutEffect(() => () => {
        for (const release of admitted.current.values()) release();
        admitted.current.clear();
    }, [context, presented]);
    React.useLayoutEffect(() => {
        if (!entry || !input.retainPendingDemand || !presented) return;
        let retired = false;
        let unsubscribe = () => {};
        const key = input.plan.batchKey;
        const release = () => {
            unsubscribe();
            if (admitted.current.get(key) === release) admitted.current.delete(key);
        };
        const settle = () => { if (retired && entry.getSnapshot().pending === 'idle') release(); };
        // Retain admitted work across visible widget changes; leaving releases page demand.
        unsubscribe = entry.subscribe(settle, false);
        const previous = admitted.current.get(key);
        admitted.current.set(key, release);
        // Transfer this page's demand after subscribing, so revisiting a pending
        // Resource cannot cancel its admitted read or retain another borrower.
        previous?.();
        return () => { retired = true; settle(); };
    }, [entry, input.retainPendingDemand, input.plan.batchKey, presented]);
    return React.useMemo(() => ({ entry, lifetime: context?.accountLifetime ?? null, plan: input.plan }),
        [entry, context, input.plan]);
}
export function useUsageWidgetBodyModel(resource: UsageWidgetResource, instanceId: string,
    projectSlice: UsageWidgetSliceProjection = identitySlice): UsageWidgetBodyModel {
    const row = resource.plan.widgets.get(instanceId);
    const rows = React.useMemo(() => row ? [row] : NO_QUERY_ROWS, [row]);
    return useUsageWidgetQueryModel(resource, instanceId, rows, acceptsEverySlice, projectSlice);
}

/** Bodies and page choices share the same query identity and period continuity. */
export function useUsageWidgetQueryModel(resource: UsageWidgetResource | null, instanceId: string,
    rows: readonly UsageWidgetQueryRow[], acceptsSlice: (slice: UsageQueryResultSlice) => boolean = acceptsEverySlice,
    projectSlice: UsageWidgetSliceProjection = identitySlice): UsageWidgetBodyModel {
    return useUsageWidgetQueryModelSelection(resource, instanceId, rows, acceptsSlice, projectSlice,
        selectBodySnapshot, Object.is).model;
}

/** Select the shown query's consumed facts before React, sharing the body's period and authority owner. */
export function useUsageWidgetQuerySliceSelection<T>(resource: UsageWidgetResource | null, instanceId: string,
    rows: readonly UsageWidgetQueryRow[], selectSlice: (slice: UsageQueryResultSlice | null) => T,
    equal: (left: T, right: T) => boolean, acceptsSlice: (slice: UsageQueryResultSlice) => boolean = acceptsEverySlice): T {
    const select = React.useCallback((snapshot: UsageWidgetBodySnapshot) =>
        selectSlice(snapshot.slice ?? snapshot.retained?.slice ?? null), [selectSlice]);
    return useUsageWidgetQueryModelSelection(resource, instanceId, rows, acceptsSlice, identitySlice, select, equal).selection;
}

function useUsageWidgetQueryModelSelection<T>(resource: UsageWidgetResource | null, instanceId: string,
    rows: readonly UsageWidgetQueryRow[], acceptsSlice: (slice: UsageQueryResultSlice) => boolean,
    projectSlice: UsageWidgetSliceProjection, select: (snapshot: UsageWidgetBodySnapshot) => T,
    equal: (left: T, right: T) => boolean): Readonly<{ model: UsageWidgetBodyModel; selection: T }> {
    const entry = resource?.entry ?? null;
    const lifetime = resource?.lifetime ?? null;
    const prior = React.useRef<UsageWidgetPrior | null>(null);
    const queryIdentity = React.useRef<Readonly<{ key: string; lifetime: ServerAccountScopeLifetime;
        value: UsageWidgetQueryIdentity }> | null>(null);
    const subscribe = useUsageWidgetResourceSubscription(entry, true);
    const getSnapshot = React.useMemo(() => {
        let previous: UsageWidgetBodySnapshot | undefined;
        return (): UsageWidgetBodySnapshot => {
            const snapshot = entry?.getSnapshot() ?? EMPTY_SNAPSHOT;
            const authorityLost = isPluginUiResourceReadAuthorityLost(snapshot);
            const presentationReady = entry?.isPresentationReady() !== false;
            const slices = presentationReady && lifetime?.isCurrent() === true && !authorityLost && snapshot.value
                ? decodeUsageQueryResource(snapshot.value).results : [];
            const matchedSlice = slices.find(value => acceptsSlice(value) && rows.some(row => row.key === value.key));
            const projectedSlice = matchedSlice && projectSlice(matchedSlice, previous?.slice);
            // Available facts pick their own query. While acquiring a period, only
            // a still-present query with the same meaning may retain its facts.
            const priorQuery = prior.current?.instanceId === instanceId ? prior.current.identity.query : undefined;
            const row = rows.find(candidate => candidate.key === projectedSlice?.key)
                ?? rows.find(candidate => priorQuery && candidate.query
                    && getPeriodAdjustedUsageQueryKey(priorQuery, candidate.query) === candidate.key)
                ?? rows[0];
            const query = row?.query;
            const key = row?.key;
            const current = lifetime?.isCurrent() === true && query !== undefined && key !== undefined;
            // Source-only progress belongs to page chrome until this body has facts.
            const slice = projectedSlice?.pending && !projectedSlice.accounting && !projectedSlice.quota?.length
                && !projectedSlice.sources.some(source => source.asOfMs !== undefined || source.status === 'error')
                ? undefined : projectedSlice;
            const allowanceReadPending = query?.includeAccounting === false && entry?.isAllowanceReadPending() === true;
            // Keep the Resource's admitted freshness during a sibling-only
            // read. Transport failures and authority changes still use its
            // current snapshot; an unchanged slice does not manufacture fresh.
            const siblingSnapshot = query?.includeAccounting === false && !allowanceReadPending
                && snapshot.pending !== 'idle' && snapshot.subscription === 'live' && !snapshot.error
                && slice !== undefined && previous?.slice === slice ? previous : undefined;
            const freshness = slice?.sources.some(source => source.errorCode || source.status === 'stale') ? 'stale'
                : siblingSnapshot ? siblingSnapshot.freshness : snapshot.freshness;
            // Select the shown facts' own acquisition, rather than the batch's
            // lifecycle representation. Before progress, preserve immediate
            // refresh activity; presentation below gates it on shown facts.
            const shownReadPending = query?.includeAccounting === false ? allowanceReadPending : !slice
                || slice.sources.some(source => source.source === 'accounting' && source.status === 'pending')
                || slice.comparison?.source.status === 'pending';
            const readActivity = current && snapshot.pending !== 'idle' && shownReadPending;
            const pending = current && (!presentationReady || slice?.pending === true || readActivity || !slice && snapshot.pending !== 'idle');
            // The Resource retains unchanged slice references. Select before React
            // renders so sibling progress cannot repeat this body's model work.
            if (previous && previous.slice === slice && previous.current === current && previous.authorityLost === authorityLost
                && previous.presentationReady === presentationReady
                && previous.pending === pending && previous.readActivity === readActivity
                && previous.freshness === freshness && previous.error === snapshot.error && previous.row === row) {
                return previous;
            }
            if (current && query && key && lifetime && (queryIdentity.current?.key !== key || queryIdentity.current.lifetime !== lifetime))
                queryIdentity.current = { key, lifetime, value: { query, authority: lifetime.scope } };
            const identity = current ? queryIdentity.current?.value ?? null : null;
            const priorValue = prior.current;
            const sameMeaning = query !== undefined && priorValue?.instanceId === instanceId
                && getPeriodAdjustedUsageQueryKey(priorValue.identity.query, query) === key;
            const periodContinuity = { sameMeaning,
                changed: sameMeaning && getUsageQueryKey(priorValue!.identity.query) !== key };
            const retained = current && !authorityLost && priorValue?.lifetime === lifetime && sameMeaning ? priorValue : null;
            previous = { row, slice, current, authorityLost, presentationReady, pending, readActivity, freshness, error: snapshot.error,
                identity, retained, periodContinuity };
            return previous;
        };
    }, [entry, lifetime, rows, acceptsSlice, projectSlice, instanceId]);
    const getSelectedSnapshot = React.useMemo(() => {
        let previous: { value: T } | undefined;
        return () => {
            const value = select(getSnapshot());
            if (previous && equal(previous.value, value)) return previous.value;
            previous = { value };
            return value;
        };
    }, [getSnapshot, select, equal]);
    const selection = React.useSyncExternalStore(subscribe, getSelectedSnapshot, getSelectedSnapshot);
    const snapshot = getSnapshot();
    const { current, authorityLost, slice, identity, retained, periodContinuity } = snapshot;
    // This is a mounted presentation continuity ref, not a second query cache or source of facts.
    React.useEffect(() => {
        if (!current || authorityLost) { prior.current = null; return; }
        if (slice && identity && lifetime) prior.current = { instanceId, identity, slice, lifetime };
        else if (!periodContinuity.sameMeaning) prior.current = null;
    }, [current, authorityLost, slice, identity, lifetime, instanceId, periodContinuity.sameMeaning]);
    const shownSlice = slice ?? retained?.slice ?? null;
    const sourceError = slice?.sources.find(source => source.errorCode);
    const error = React.useMemo(() => snapshot.error ?? (sourceError
        ? { code: sourceError.errorCode!, message: sourceError.errorCode! } : null), [snapshot.error, sourceError]);
    const refresh = React.useCallback(async (callerContext?: ActionExecutorContext) => { if (lifetime?.isCurrent()) await entry?.refresh({ callerContext }); }, [entry, lifetime]);
    // The batch may still be reading private detail or allowance after accounting
    // settles. Those sources keep their own pending state; they do not re-read
    // the already shown accounting. Before the first progress snapshot, retain
    // the entry's activity so an actual refresh is still visible immediately.
    // A quota-only body has no A response that can end its refresh indicator.
    return { selection, model: { requestedQuery: current ? identity : null,
        shownQuery: slice ? identity : retained?.identity ?? null, slice: shownSlice,
        pending: snapshot.pending,
        error: current ? error : null, freshness: snapshot.freshness,
        updatingPreviousPeriod: !slice && retained !== null && periodContinuity.changed,
        refreshing: shownSlice !== null && snapshot.readActivity, refresh } };
}
