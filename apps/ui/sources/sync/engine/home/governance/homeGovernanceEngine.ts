import { bindHomeDomainActionHttpRequestV1, homeDomainActionOutputSchemaV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { HomeGovernanceProjectionV1Schema, type HomeGovernanceProjectionV1 } from '@happier-dev/protocol/home/governance/projection';

import {
    requestHomeDomain,
    type HomeDomainFailure,
} from '@/sync/api/home/homeServerActionTransport';
import {
    serverAccountScopeKeySuffix,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import {
    createScopedSnapshotLoader,
    type ScopedLoadTarget,
} from '@/sync/engine/scope/scopedSnapshotLoader';
import {
    applyHomeGovernanceFailure,
    applyHomeGovernanceProjection,
    beginHomeGovernanceLoad,
    getHomeGovernanceSnapshot,
    invalidateHomeGovernanceSnapshot,
    invalidateHomeGovernanceSnapshotsForServer,
    type HomeGovernanceSnapshotError,
} from '@/sync/store/home/governance/homeGovernanceSnapshots';
import { isHomeAdministrationAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

/**
 * Home governance loading.
 *
 * This module owns only *what* a governance read is and how its outcome is
 * published. *When* to read — first observation, Account-change wake, explicit
 * retry — belongs to the shared scoped-snapshot loader, so governance and Teams
 * cannot drift into two freshness policies.
 */

type HomeGovernanceTarget = ScopedLoadTarget & Readonly<{ scope: ServerAccountScope }>;

function targetFor(scope: ServerAccountScope): HomeGovernanceTarget {
    return { key: serverAccountScopeKeySuffix(scope), serverId: scope.serverId, scope };
}

/**
 * A transport answer becomes a retry-facing store error. `conflict` cannot arise
 * from this read-only projection; it is reported as `unknown` rather than
 * silently reinterpreted as a denial.
 */
function toSnapshotError(failure: HomeDomainFailure): HomeGovernanceSnapshotError {
    // Setup-required is a typed recovery state, but it also withdraws any
    // retained administration projection. Classifying it as authoritative at
    // this domain boundary prevents Refresh from briefly revealing obsolete
    // roles or policy after the error itself is cleared for the next load.
    if (failure.code === 'home_governance_setup_required') {
        return { kind: 'forbidden', retryable: false, code: failure.code };
    }
    const kind: HomeGovernanceSnapshotError['kind'] = failure.kind === 'conflict' || failure.kind === 'outcome_unknown'
        ? 'unknown'
        : failure.kind;
    return { kind, retryable: failure.retryable, code: failure.code };
}

const loader = createScopedSnapshotLoader<HomeGovernanceTarget>({
    load: async ({ scope }, loadContext) => {
        beginHomeGovernanceLoad(scope);
        const request = bindHomeDomainActionHttpRequestV1('home.governance.get', {});
        const actionOutputSchema = homeDomainActionOutputSchemaV1('home.governance.get');
        const result = await requestHomeDomain<HomeGovernanceProjectionV1>({
            scope,
            method: request.method,
            path: request.path,
            effect: 'read',
            input: request.body,
            schema: {
                safeParse: (value) => {
                    const actionOutput = actionOutputSchema.safeParse(value);
                    return actionOutput.success
                        ? HomeGovernanceProjectionV1Schema.safeParse(actionOutput.data)
                        : actionOutput;
                },
            },
        });
        if (result.ok) {
            applyHomeGovernanceProjection({
                scope,
                projection: result.value,
                observedAt: Date.now(),
                current: loadContext.isCurrent(),
            });
            return;
        }
        applyHomeGovernanceFailure({ scope, error: toSnapshotError(result.failure) });
    },
    shouldLoadOnObserve: ({ scope }) => {
        const current = getHomeGovernanceSnapshot(scope);
        if (!current) return true;
        if (current.stale) return true;
        return current.data === null && current.status !== 'loading';
    },
    invalidateServer: (serverId) => {
        invalidateHomeGovernanceSnapshotsForServer(serverId);
    },
    invalidateTarget: ({ scope }) => {
        invalidateHomeGovernanceSnapshot(scope);
    },
    matchesWake: isHomeAdministrationAccountChange,
});

/**
 * Registers a live consumer of one exact Home and Account. Returns the release
 * for the consumer's unmount.
 */
export function observeHomeGovernance(scope: ServerAccountScope): () => void {
    return loader.observe(targetFor(scope));
}

/** Explicit retry from a surface. Coalesces with an in-flight load. */
export async function refreshHomeGovernanceSnapshot(scope: ServerAccountScope): Promise<void> {
    await loader.refresh(targetFor(scope));
}

/** Test-only reset of the engine's observation and single-flight state. */
export function resetHomeGovernanceEngineForTests(): void {
    loader.resetForTests();
}
