import * as React from 'react';
import type { PluginUiResourceEntry } from '@happier-dev/plugin-ui/advanced';
import { isPluginUiResourceReadAuthorityLost } from '@happier-dev/plugin-ui/advanced';
import type { PluginUiResourceSnapshot } from '@happier-dev/plugin-ui/hostApi';
import { getUsageQueryBatchKey, getUsageQueryKey, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ServerAccountScopeLifetime, ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { captureUiUsageQueryAccountContext, decodeUsageQueryResource, getUsageQueryResourceStore } from '@/sync/api/account/usageQueryResource';
import type { UsageWidgetQueryPlan } from './usageWidgetQueries';

export type UsageWidgetResource = Readonly<{ entry: PluginUiResourceEntry | null; lifetime: ServerAccountScopeLifetime | null; plan: UsageWidgetQueryPlan }>;
export type UsageWidgetQueryIdentity = Readonly<{ query: UsageQuery; authority: ServerAccountScope }>;
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

/** One canonical batch Resource per mounted page; bodies select its already decoded slices. */
export function useUsageWidgetResource(input: Readonly<{
    credentials: AuthCredentials | null; enabled: boolean; plan: UsageWidgetQueryPlan;
}>): UsageWidgetResource {
    const lifetime = captureActiveServerAccountScopeLifetime();
    const context = React.useMemo(() => input.enabled && input.credentials && lifetime?.isCurrent()
        && areServerAccountScopesEqual(input.plan.scope, lifetime.scope)
        ? captureUiUsageQueryAccountContext(input.credentials) : null,
    [input.enabled, input.credentials, lifetime, input.plan.scope.serverId, input.plan.scope.accountId]);
    const key = input.plan.input ? getUsageQueryBatchKey(input.plan.input) : null;
    const entry = React.useMemo(() => context && input.plan.input
        ? getUsageQueryResourceStore(context).getEntry({ hostRead: 'usage.query', input: input.plan.input }) : null,
    [context, key]);
    return React.useMemo(() => ({ entry, lifetime: context?.accountLifetime ?? null, plan: input.plan }),
        [entry, context, input.plan]);
}
export function useUsageWidgetBodyModel(resource: UsageWidgetResource, instanceId: string): UsageWidgetBodyModel {
    const { entry, lifetime } = resource;
    const subscribe = React.useCallback((listener: () => void) => entry?.subscribe(listener, true) ?? (() => {}), [entry]);
    const getSnapshot = React.useCallback(() => entry?.getSnapshot() ?? EMPTY_SNAPSHOT, [entry]);
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const row = resource.plan.widgets.get(instanceId);
    const query = row?.query;
    const key = row?.key;
    const current = lifetime?.isCurrent() === true && query !== undefined && key !== undefined;
    const authorityLost = isPluginUiResourceReadAuthorityLost(snapshot);
    const slice = current && !authorityLost && snapshot.value
        ? decodeUsageQueryResource(snapshot.value).results.find(value => value.key === key) : undefined;
    const identity = React.useMemo<UsageWidgetQueryIdentity | null>(() => current && query && lifetime
        ? { query, authority: lifetime.scope } : null, [current, lifetime, key]);
    const prior = React.useRef<Readonly<{ instanceId: string; identity: UsageWidgetQueryIdentity;
        slice: UsageQueryResultSlice; lifetime: ServerAccountScopeLifetime }> | null>(null);
    const previous = prior.current;
    const sameMeaningExceptPeriod = query !== undefined && previous !== null
        && previous.instanceId === instanceId
        && getUsageQueryKey({ ...previous.identity.query, period: query.period }) === key;
    const retained = current && !authorityLost && previous !== null && previous.lifetime === lifetime
        && sameMeaningExceptPeriod && getUsageQueryKey(previous.identity.query) !== key ? previous : null;
    // This is a mounted presentation continuity ref, not a second query cache or source of facts.
    React.useEffect(() => {
        if (!current || authorityLost) { prior.current = null; return; }
        if (slice && identity && lifetime) prior.current = { instanceId, identity, slice, lifetime };
        else if (!sameMeaningExceptPeriod) prior.current = null;
    }, [current, authorityLost, slice, identity, lifetime, instanceId, sameMeaningExceptPeriod]);
    const shownSlice = slice ?? retained?.slice ?? null;
    const sourceError = slice?.sources.find(source => source.errorCode);
    const error = React.useMemo(() => snapshot.error ?? (sourceError
        ? { code: sourceError.errorCode!, message: sourceError.errorCode! } : null), [snapshot.error, sourceError]);
    const refresh = React.useCallback(async () => { if (lifetime?.isCurrent()) await entry?.refresh(); }, [entry, lifetime]);
    return { requestedQuery: current ? identity : null,
        shownQuery: slice ? identity : retained?.identity ?? null, slice: shownSlice,
        pending: current && (snapshot.pending !== 'idle' || slice?.pending === true),
        error: current ? error : null, freshness: shownSlice && sourceError ? 'stale' : snapshot.freshness,
        updatingPreviousPeriod: !slice && retained !== null,
        refreshing: current && shownSlice !== null && snapshot.pending !== 'idle', refresh };
}
