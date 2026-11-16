import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { HomeGovernanceEligibilityV1Schema } from '@happier-dev/protocol/home/governance/projection';

import type { HomeActionFailure } from '@/sync/ops/home/homeActionOutcome';
import { queryHomeGovernanceAction } from '@/sync/ops/home/homeGovernanceActionExecution';
import type { ScopedSnapshotError } from '@/sync/domains/scope/scopedSnapshotFacts';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createScopedSnapshotLoader, type ScopedLoadTarget } from '@/sync/engine/scope/scopedSnapshotLoader';
import {
    applyHomeGovernanceEligibility,
    applyHomeGovernanceEligibilityFailure,
    beginHomeGovernanceEligibilityLoad,
    getHomeGovernanceEligibilitySnapshot,
    invalidateHomeGovernanceEligibilitySnapshot,
    invalidateHomeGovernanceEligibilitySnapshotsForServer,
} from '@/sync/store/home/governance/homeGovernanceEligibilitySnapshots';
import { isHomeAdministrationAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

type EligibilityTarget = ScopedLoadTarget & Readonly<{ scope: ServerAccountScope }>;

function targetFor(scope: ServerAccountScope): EligibilityTarget {
    return { key: serverAccountScopeKeySuffix(scope), serverId: scope.serverId, scope };
}

function toSnapshotError(failure: HomeActionFailure): ScopedSnapshotError {
    return {
        kind: failure.kind === 'conflict' || failure.kind === 'outcome_unknown' ? 'unknown' : failure.kind,
        retryable: failure.retryable,
        code: failure.code,
    };
}

const loader = createScopedSnapshotLoader<EligibilityTarget>({
    load: async ({ scope }, loadContext) => {
        beginHomeGovernanceEligibilityLoad(scope);
        const result = await queryHomeGovernanceAction({
            scope,
            actionId: 'home.governance.eligibility.get',
            input: {},
            parse: value => HomeGovernanceEligibilityV1Schema.safeParse(value),
            signal: loadContext.signal,
            isCurrent: loadContext.isCurrent,
        });
        if (loadContext.signal.aborted) return;
        if (result.kind === 'succeeded') {
            applyHomeGovernanceEligibility({
                scope,
                eligibility: result.value,
                observedAt: Date.now(),
                current: loadContext.isCurrent(),
            });
            return;
        }
        applyHomeGovernanceEligibilityFailure({ scope, error: toSnapshotError(result.failure) });
    },
    shouldLoadOnObserve: ({ scope }) => {
        const current = getHomeGovernanceEligibilitySnapshot(scope);
        return !current || current.stale || (current.data === null && current.status !== 'loading');
    },
    invalidateServer: invalidateHomeGovernanceEligibilitySnapshotsForServer,
    invalidateTarget: ({ scope }) => {
        invalidateHomeGovernanceEligibilitySnapshot(scope);
    },
    // Joining or leaving a Team changes whether this viewer is shown Teams.
    matchesWake: (event) => isHomeAdministrationAccountChange(event)
        || event.entityIds?.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1) === true,
});

export function observeHomeGovernanceEligibility(scope: ServerAccountScope): () => void {
    return loader.observe(targetFor(scope));
}

export async function refreshHomeGovernanceEligibility(scope: ServerAccountScope): Promise<void> {
    await loader.refresh(targetFor(scope));
}

export function resetHomeGovernanceEligibilityEngineForTests(): void {
    loader.resetForTests();
}
