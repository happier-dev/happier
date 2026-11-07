import type { ActionOperationGetV1Response, ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { DeploymentDomainHeaderV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';

export type DeploymentDomainFactsV1 = Readonly<{
    state: DeploymentDomainHeaderV1['state'] | 'cancelled' | 'outcome_unknown';
    retryRemoval: boolean;
    failure: NonNullable<ActionOperationSnapshotV1['error']> | null;
}>;

/** Desired placements remain persisted until native absence is observed. Only an
 * exact controller read's typed not_found establishes a lost operation; a pending
 * or unavailable read supplies no observation and cannot unlock removal. */
export function projectDeploymentDomainFactsV1(domain: DeploymentDomainHeaderV1, accountId: string,
    observation: ActionOperationGetV1Response | null): DeploymentDomainFactsV1 {
    const address = domain.operationAddress;
    if (address && domain.state === 'removing' && observation?.kind === 'not_found') {
        return { state: 'outcome_unknown', retryRemoval: true, failure: { errorCode: 'not_found', error: 'not_found' } };
    }
    const found = observation?.kind === 'found' ? observation.operation : null;
    const operation = address && found?.operationId === address.operationId && found.scope.accountId === accountId
        && found.scope.machineId === address.machineId ? found : null;
    const retryRemoval = domain.state === 'removing' && (operation?.state === 'failed' || operation?.state === 'cancelled');
    const failure = operation?.state === 'failed' ? operation.error ?? null : null;
    const state = operation?.state === 'failed' ? failure?.errorCode === 'outcome_unknown' ? 'outcome_unknown' : 'failed'
        : retryRemoval && operation?.state === 'cancelled' ? 'cancelled' : domain.state;
    return { state, retryRemoval, failure };
}
