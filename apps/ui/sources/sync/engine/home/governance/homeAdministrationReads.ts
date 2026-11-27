import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';

import { isAuthoritativeScopedSnapshotRefusalKind } from '@/sync/domains/scope/scopedSnapshotFacts';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createScopedSnapshotLoader, type ScopedLoadTarget } from '@/sync/engine/scope/scopedSnapshotLoader';
import { subscribeAccountCatalogInvalidation } from '@/sync/engine/settings/accountCatalogInvalidation';
import type { HomeActionFailure } from '@/sync/ops/home/homeActionOutcome';
import { getHomeAccount, getHomeMailDelivery, getHomeReachability, type HomeGovernanceQueryOutcome } from '@/sync/ops/home/homeGovernanceOperations';
import { isHomeAdministrationAccountChange, type HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';
import { subscribeHomeSettingsAdoptions } from '@/sync/store/home/governance/homeSettingsSnapshots';

type Target = ScopedLoadTarget & Readonly<{ scope: ServerAccountScope; accountId: string }>;
type Snapshot<T> = Readonly<{ data: T | null; loading: boolean; failure: HomeActionFailure | null; stale: boolean }>;
type Read<T> = (target: Readonly<{ scope: ServerAccountScope; accountId: string; signal: AbortSignal }>) => Promise<HomeGovernanceQueryOutcome<T>>;

function createHomeAdministrationRead<T>(read: Read<T>, options?: Readonly<{
    settingsCompanion?: boolean;
    matchesWake?: (event: HomeAccountChangeEvent) => boolean;
}>) {
    const snapshots = new Map<string, Snapshot<T>>();
    const listeners = new Map<string, Set<() => void>>();
    const initial: Snapshot<T> = { data: null, loading: true, failure: null, stale: true };
    const get = (target: Target) => snapshots.get(target.key) ?? initial;
    function publish(target: Target, snapshot: Snapshot<T> | null) {
        if (snapshot) snapshots.set(target.key, snapshot);
        else if (!snapshots.delete(target.key)) return;
        listeners.get(target.key)?.forEach(listener => listener());
    }
    function invalidate(target: Target) {
        const previous = get(target);
        if (!previous.stale) publish(target, { ...previous, stale: true });
    }
    const loader = createScopedSnapshotLoader<Target>({
        subscribeRetainedInvalidation(target, handlers) {
            const stopAccount = subscribeAccountCatalogInvalidation(target, {
                ...handlers,
                retire() {
                    publish(target, null);
                    handlers.retire();
                },
            });
            const stopAdoption = options?.settingsCompanion
                ? subscribeHomeSettingsAdoptions(target.scope, () => handlers.invalidate()) : undefined;
            return () => { stopAccount(); stopAdoption?.(); };
        },
        async load(target, context) {
            const previous = get(target);
            const loading = { ...previous, loading: true, stale: true };
            publish(target, loading);
            const result = await read({ scope: target.scope, accountId: target.accountId, signal: context.signal });
            if (context.signal.aborted || get(target) !== loading) return;
            if (result.kind === 'succeeded') {
                publish(target, { data: result.value, loading: false, failure: null, stale: !context.isCurrent() });
                return;
            }
            const failure = result.failure;
            const withdrawn = isAuthoritativeScopedSnapshotRefusalKind(failure.kind) || failure.code === 'home_account_not_found';
            publish(target, { data: withdrawn ? null : previous.data, loading: false, failure, stale: !context.isCurrent() });
        },
        shouldLoadOnObserve: target => {
            const snapshot = get(target);
            return snapshot.stale || snapshot.failure?.retryable === true;
        },
        invalidateServer: () => {}, // Each wake invalidates its scoped targets through invalidateTarget.
        prepareWake: () => true,
        invalidateTarget: invalidate,
        matchesWake: options?.matchesWake ?? isHomeAdministrationAccountChange,
        onCredentialMutation(event, target) {
            publish(target, null);
            return event.kind === 'credentials_set';
        },
    });
    const targetFor = (scope: ServerAccountScope, accountId = ''): Target => ({
        key: JSON.stringify([serverAccountScopeKeySuffix(scope), accountId]),
        serverId: scope.serverId, scope, accountId,
    });
    return {
        initial,
        targetFor,
        get,
        observe: loader.observe,
        refresh: loader.refresh,
        adopt(target: Target, data: T) {
            publish(target, { data, failure: null, loading: false, stale: false });
        },
        subscribe(target: Target, listener: () => void) {
            const scoped = listeners.get(target.key) ?? new Set<() => void>();
            listeners.set(target.key, scoped);
            scoped.add(listener);
            return () => {
                scoped.delete(listener);
                if (!scoped.size) listeners.delete(target.key);
            };
        },
    };
}

export const homeMailDeliveryRead = createHomeAdministrationRead(getHomeMailDelivery, { settingsCompanion: true });
export const homeReachabilityRead = createHomeAdministrationRead(getHomeReachability, { settingsCompanion: true });
export const homeAccountDetailRead = createHomeAdministrationRead(getHomeAccount, {
    matchesWake: event => isHomeAdministrationAccountChange(event)
        || event.entityIds?.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1) === true,
});

export type HomeAdministrationRead<T> = ReturnType<typeof createHomeAdministrationRead<T>>;
