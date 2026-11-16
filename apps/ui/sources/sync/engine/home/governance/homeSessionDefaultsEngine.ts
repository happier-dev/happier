import { HomeSessionDefaultsProjectionV1Schema } from '@happier-dev/protocol/home/governance/projection';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createScopedSnapshotLoader, type ScopedLoadTarget } from '@/sync/engine/scope/scopedSnapshotLoader';
import { queryHomeGovernanceAction } from '@/sync/ops/home/homeGovernanceActionExecution';
import { isHomeAdministrationAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import {
    applyHomeSessionDefaultsFailure,
    applyHomeSessionDefaultsProjection,
    getHomeSessionDefaultsSnapshot,
    invalidateHomeSessionDefaultsSnapshot,
    invalidateHomeSessionDefaultsSnapshotsForServer,
} from '@/sync/store/home/governance/homeSessionDefaultsSnapshots';

type DefaultsTarget = ScopedLoadTarget & Readonly<{ scope: ServerAccountScope }>;
const loader = createScopedSnapshotLoader<DefaultsTarget>({
    load: async ({ scope }, context) => {
        const result = await queryHomeGovernanceAction({
            scope, actionId: 'home.governance.get', input: { projection: 'session_defaults' },
            parse: value => HomeSessionDefaultsProjectionV1Schema.safeParse(value),
            signal: context.signal, isCurrent: context.isCurrent,
        });
        if (context.signal.aborted) return;
        if (result.kind === 'succeeded') {
            applyHomeSessionDefaultsProjection(scope, result.value, context.isCurrent());
        } else {
            const failure = result.failure;
            applyHomeSessionDefaultsFailure(scope, {
                kind: failure.kind === 'conflict' || failure.kind === 'outcome_unknown' ? 'unknown' : failure.kind,
                retryable: failure.retryable, code: failure.code,
            });
        }
    },
    shouldLoadOnObserve: ({ scope }) => {
        const current = getHomeSessionDefaultsSnapshot(scope);
        return !current || current.stale || current.error?.retryable === true;
    },
    invalidateServer: invalidateHomeSessionDefaultsSnapshotsForServer,
    invalidateTarget: ({ scope }) => invalidateHomeSessionDefaultsSnapshot(scope),
    matchesWake: isHomeAdministrationAccountChange,
});

/** The shared loader owns first load, returning observers, push and cancellation. */
export function observeHomeSessionDefaults(scope: ServerAccountScope): () => void {
    return loader.observe({ key: serverAccountScopeKeySuffix(scope), serverId: scope.serverId, scope });
}

export function resetHomeSessionDefaultsEngineForTests(): void {
    loader.resetForTests();
}
