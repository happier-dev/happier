import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createScopedSnapshotLoader, type ScopedLoadTarget } from '@/sync/engine/scope/scopedSnapshotLoader';
import { listHomeAccounts } from '@/sync/ops/home/homeGovernanceOperations';
import { subscribeAccountCatalogInvalidation } from '@/sync/engine/settings/accountCatalogInvalidation';
import { isHomeAdministrationAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import {
    applyHomeAccountRosterFailure,
    applyHomeAccountRosterPage,
    beginHomeAccountRosterLoad,
    getHomeAccountRosterSnapshot,
    invalidateHomeAccountRosterSnapshot,
    invalidateHomeAccountRosterSnapshotsForServer,
    retireHomeAccountRosterSnapshot,
} from '@/sync/store/home/governance/homeAccountRosterSnapshots';

type RosterTarget = ScopedLoadTarget & Readonly<{ scope: ServerAccountScope }>;
const targetFor = (scope: ServerAccountScope): RosterTarget => ({ key: serverAccountScopeKeySuffix(scope), serverId: scope.serverId, scope });

/** One paged resource for every People list and rail on the exact Home/Account. */
const loader = createScopedSnapshotLoader<RosterTarget>({
    subscribeRetainedInvalidation: subscribeAccountCatalogInvalidation,
    load: async ({ scope }, context) => {
        const previous = getHomeAccountRosterSnapshot(scope);
        const more = previous?.status === 'loading_more' && !previous.stale;
        const cursor = more ? previous.cursor : null;
        if (!more) beginHomeAccountRosterLoad(scope, false);
        const outcome = await listHomeAccounts({ scope, ...(cursor ? { cursor } : {}), signal: context.signal });
        if (context.signal.aborted) return;
        if (outcome.kind === 'failed') applyHomeAccountRosterFailure(scope, outcome.failure);
        else applyHomeAccountRosterPage(scope, outcome.value, more, context.isCurrent());
    },
    shouldLoadOnObserve: ({ scope }) => {
        const snapshot = getHomeAccountRosterSnapshot(scope);
        return !snapshot || snapshot.stale;
    },
    invalidateServer: invalidateHomeAccountRosterSnapshotsForServer,
    invalidateTarget: ({ scope }) => invalidateHomeAccountRosterSnapshot(scope),
    matchesWake: isHomeAdministrationAccountChange,
    onCredentialMutation: (event, { scope }) => {
        retireHomeAccountRosterSnapshot(scope);
        return event.kind === 'credentials_set';
    },
});

export function observeHomeAccountRoster(scope: ServerAccountScope): () => void {
    return loader.observe(targetFor(scope));
}

export function loadMoreHomeAccountRoster(scope: ServerAccountScope): Promise<void> {
    const snapshot = getHomeAccountRosterSnapshot(scope);
    if (!snapshot || snapshot.stale || !snapshot.hasMore || snapshot.status === 'loading' || snapshot.status === 'loading_more') {
        return Promise.resolve();
    }
    // Claim the continuation synchronously before a sibling can ask for it.
    beginHomeAccountRosterLoad(scope, true);
    return loader.refresh(targetFor(scope));
}

export function refreshHomeAccountRoster(scope: ServerAccountScope): Promise<void> {
    const status = getHomeAccountRosterSnapshot(scope)?.status;
    const readInFlight = status === 'loading' || status === 'loading_more';
    invalidateHomeAccountRosterSnapshot(scope);
    // Refresh during any older read requires a new first-page answer after it.
    return readInFlight ? loader.invalidate(targetFor(scope)) : loader.refresh(targetFor(scope));
}

export function resetHomeAccountRosterEngineForTests(): void {
    loader.resetForTests();
}
