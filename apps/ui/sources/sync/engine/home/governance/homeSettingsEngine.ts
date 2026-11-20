import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createScopedSnapshotLoader, type ScopedLoadTarget } from '@/sync/engine/scope/scopedSnapshotLoader';
import { getHomeSettings } from '@/sync/ops/home/homeGovernanceOperations';
import { isHomeAdministrationAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import {
    applyHomeSettingsFailure,
    applyHomeSettingsProjection,
    beginHomeSettingsLoad,
    getHomeSettingsSnapshot,
    invalidateHomeSettingsSnapshot,
    invalidateHomeSettingsSnapshotsForServer,
    retireHomeSettingsSnapshot,
} from '@/sync/store/home/governance/homeSettingsSnapshots';

type Target = ScopedLoadTarget & Readonly<{ scope: ServerAccountScope }>;
const targetFor = (scope: ServerAccountScope): Target => ({ key: serverAccountScopeKeySuffix(scope), serverId: scope.serverId, scope });

/** Registry reads share the existing exact-scope wake, single-flight and observer-gap lifecycle. */
const loader = createScopedSnapshotLoader<Target>({
    async load({ scope }, context) {
        const loading = beginHomeSettingsLoad(scope);
        const outcome = await getHomeSettings({ scope });
        // A settings write can adopt a newer admitted projection while this read is in flight.
        if (getHomeSettingsSnapshot(scope) !== loading) return;
        if (outcome.kind === 'succeeded') applyHomeSettingsProjection(scope, outcome.value, context.isCurrent());
        else applyHomeSettingsFailure(scope, outcome.failure);
    },
    shouldLoadOnObserve: ({ scope }) => {
        const current = getHomeSettingsSnapshot(scope);
        return !current || current.stale;
    },
    invalidateServer: invalidateHomeSettingsSnapshotsForServer,
    invalidateTarget: ({ scope }) => invalidateHomeSettingsSnapshot(scope),
    matchesWake: isHomeAdministrationAccountChange,
    onCredentialMutation: (event, { scope }) => {
        retireHomeSettingsSnapshot(scope);
        return event.kind === 'credentials_set';
    },
});

export function retainHomeSettingsInvalidation(scope: ServerAccountScope) {
    return loader.retain(targetFor(scope));
}

export function observeHomeSettings(scope: ServerAccountScope): () => void {
    return loader.observe(targetFor(scope));
}

/** Explicit refresh must trail a read that may predate a newly adopted write. */
export function refreshHomeSettings(scope: ServerAccountScope): Promise<void> {
    return loader.invalidate(targetFor(scope));
}

export function resetHomeSettingsEngineForTests(): void {
    loader.resetForTests();
}
