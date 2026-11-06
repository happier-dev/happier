import * as React from 'react';
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
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { UsageWidgetQueryPlan } from './usageWidgetQueries';

export type UsageWidgetResource = Readonly<{ entry: UsageQueryResourceEntry | null; lifetime: ServerAccountScopeLifetime | null; plan: UsageWidgetQueryPlan }>;
export type UsageWidgetQueryIdentity = Readonly<{ query: UsageQuery; authority: ServerAccountScope }>;
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
    refresh(): Promise<void>;
}>;
const EMPTY_SNAPSHOT: PluginUiResourceSnapshot = Object.freeze({ freshness: 'unknown', pending: 'idle', subscription: 'ended' });
type UsageWidgetBodySnapshot = Readonly<Pick<PluginUiResourceSnapshot, 'freshness' | 'error'> & {
    pending: boolean; readActivity: boolean;
    current: boolean; authorityLost: boolean; slice: UsageQueryResultSlice | undefined;
}>;

/** One canonical batch Resource per mounted page; bodies select its already decoded slices. */
export function useUsageWidgetResource(input: Readonly<{
    credentials: AuthCredentials | null; enabled: boolean; plan: UsageWidgetQueryPlan;
    /** A mounted dashboard owns admitted reads while viewport membership changes. */
    retainPendingDemand?: boolean;
}>): UsageWidgetResource {
    const presented = useLayoutPresentationActive();
    const lifetime = captureActiveServerAccountScopeLifetime();
    const context = React.useMemo(() => input.enabled && input.credentials && lifetime?.isCurrent()
        && areServerAccountScopesEqual(input.plan.scope, lifetime.scope)
        ? captureUiUsageQueryAccountContext(input.credentials) : null,
    [input.enabled, input.credentials, lifetime, input.plan.scope.serverId, input.plan.scope.accountId]);
    const entry = React.useMemo(() => context && input.plan.input
        ? getUsageQueryResourceStore(context).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport(input.plan.input) }) : null,
    [context, input.plan.batchKey]);
    const admitted = React.useRef(new Set<() => void>());
    React.useLayoutEffect(() => () => {
        for (const release of admitted.current) release();
        admitted.current.clear();
    }, [context]);
    React.useLayoutEffect(() => {
        if (!entry || !input.retainPendingDemand || !presented) return;
        let retired = false;
        let unsubscribe = () => {};
        const release = () => { unsubscribe(); admitted.current.delete(release); };
        const settle = () => { if (retired && entry.getSnapshot().pending === 'idle') release(); };
        // This lease retains finite admitted work; presented bodies own the live watch.
        unsubscribe = entry.subscribe(settle, false);
        admitted.current.add(release);
        return () => { retired = true; settle(); };
    }, [entry, input.retainPendingDemand, presented]);
    return React.useMemo(() => ({ entry, lifetime: context?.accountLifetime ?? null, plan: input.plan }),
        [entry, context, input.plan]);
}
export function useUsageWidgetBodyModel(resource: UsageWidgetResource, instanceId: string): UsageWidgetBodyModel {
    const { entry, lifetime } = resource;
    const row = resource.plan.widgets.get(instanceId);
    const query = row?.query;
    const key = row?.key;
    const subscribe = useUsageWidgetResourceSubscription(entry, true);
    const getSnapshot = React.useMemo(() => {
        let previous: UsageWidgetBodySnapshot | undefined;
        return (): UsageWidgetBodySnapshot => {
            const snapshot = entry?.getSnapshot() ?? EMPTY_SNAPSHOT;
            const current = lifetime?.isCurrent() === true && query !== undefined && key !== undefined;
            const authorityLost = isPluginUiResourceReadAuthorityLost(snapshot);
            const projectedSlice = current && !authorityLost && snapshot.value
                ? decodeUsageQueryResource(snapshot.value).results.find(value => value.key === key) : undefined;
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
            const pending = current && (slice?.pending === true || readActivity || !slice && snapshot.pending !== 'idle');
            // The Resource retains unchanged slice references. Select before React
            // renders so sibling progress cannot repeat this body's model work.
            if (previous && previous.slice === slice && previous.current === current && previous.authorityLost === authorityLost
                && previous.pending === pending && previous.readActivity === readActivity
                && previous.freshness === freshness && previous.error === snapshot.error) {
                return previous;
            }
            previous = { slice, current, authorityLost, pending, readActivity, freshness, error: snapshot.error };
            return previous;
        };
    }, [entry, lifetime, query, key]);
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const { current, authorityLost, slice } = snapshot;
    const identity = React.useMemo<UsageWidgetQueryIdentity | null>(() => current && query && lifetime
        ? { query, authority: lifetime.scope } : null, [current, lifetime, key]);
    const prior = React.useRef<Readonly<{ instanceId: string; identity: UsageWidgetQueryIdentity;
        slice: UsageQueryResultSlice; lifetime: ServerAccountScopeLifetime }> | null>(null);
    const previous = prior.current;
    const periodContinuity = React.useMemo(() => {
        if (query === undefined || previous === null || previous.instanceId !== instanceId) {
            return { sameMeaning: false, changed: false };
        }
        const sameMeaning = getUsageQueryKey({ ...previous.identity.query, period: query.period }) === key;
        return { sameMeaning, changed: sameMeaning && getUsageQueryKey(previous.identity.query) !== key };
    }, [previous?.identity, previous?.instanceId, instanceId, key, query]);
    const retained = current && !authorityLost && previous !== null && previous.lifetime === lifetime
        && periodContinuity.sameMeaning ? previous : null;
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
    const refresh = React.useCallback(async () => { if (lifetime?.isCurrent()) await entry?.refresh(); }, [entry, lifetime]);
    // The batch may still be reading private detail or allowance after accounting
    // settles. Those sources keep their own pending state; they do not re-read
    // the already shown accounting. Before the first progress snapshot, retain
    // the entry's activity so an actual refresh is still visible immediately.
    // A quota-only body has no A response that can end its refresh indicator.
    return { requestedQuery: current ? identity : null,
        shownQuery: slice ? identity : retained?.identity ?? null, slice: shownSlice,
        pending: snapshot.pending,
        error: current ? error : null, freshness: snapshot.freshness,
        updatingPreviousPeriod: !slice && retained !== null && periodContinuity.changed,
        refreshing: shownSlice !== null && snapshot.readActivity, refresh };
}
