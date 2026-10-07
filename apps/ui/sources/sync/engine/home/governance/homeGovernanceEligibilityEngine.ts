import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { bindHomeDomainActionHttpRequestV1, homeDomainActionOutputSchemaV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { HomeGovernanceEligibilityV1Schema, type HomeGovernanceEligibilityV1 } from '@happier-dev/protocol/home/governance/projection';

import { requestHomeDomain, type HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
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

function toSnapshotError(failure: HomeDomainFailure): ScopedSnapshotError {
    return {
        kind: failure.kind === 'conflict' || failure.kind === 'outcome_unknown' ? 'unknown' : failure.kind,
        retryable: failure.retryable,
    };
}

const loader = createScopedSnapshotLoader<EligibilityTarget>({
    load: async ({ scope }, loadContext) => {
        beginHomeGovernanceEligibilityLoad(scope);
        const request = bindHomeDomainActionHttpRequestV1('home.governance.eligibility.get', {});
        const actionOutputSchema = homeDomainActionOutputSchemaV1('home.governance.eligibility.get');
        const result = await requestHomeDomain<HomeGovernanceEligibilityV1>({
            scope,
            method: request.method,
            path: request.path,
            effect: 'read',
            input: request.body,
            schema: {
                safeParse: (value) => {
                    const actionOutput = actionOutputSchema.safeParse(value);
                    return actionOutput.success
                        ? HomeGovernanceEligibilityV1Schema.safeParse(actionOutput.data)
                        : actionOutput;
                },
            },
        });
        if (result.ok) {
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
