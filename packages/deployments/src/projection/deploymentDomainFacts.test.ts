import { describe, expect, it } from 'vitest';
import { ActionOperationGetV1ResponseSchema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { DeploymentDomainHeaderV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { projectDeploymentDomainFactsV1 } from './deploymentDomainFacts';

const domain: DeploymentDomainHeaderV1 = { v: 1, id: 'domain', environmentId: 'environment', targetLinkId: 'link',
    state: 'removing', revision: 2, createdByAccountId: 'account', createdAtMs: 1, updatedAtMs: 2,
    contentArtifactId: 'artifact', contentHeaderVersion: 1, contentBodyVersion: 1,
    operationAddress: { serverId: 'home', machineId: 'controller', operationId: 'removal' } };
const operation: ActionOperationSnapshotV1 = { version: 1, operationId: 'removal', revision: 1,
    actionId: 'deployments.domains.remove', state: 'running', scope: { accountId: 'account', machineId: 'controller' },
    title: 'Remove Domain', createdAt: 1, startedAt: 2, cancellation: 'supported' };

describe('Domain lifecycle projection', () => {
    it('makes typed not_found recoverable without claiming native removal or changing persisted intent', () => {
        const result = projectDeploymentDomainFactsV1(domain, 'account', ActionOperationGetV1ResponseSchema.parse({ kind: 'not_found' }));
        expect(result).toMatchObject({ state: 'outcome_unknown', retryRemoval: true, failure: { errorCode: 'not_found' } });
        expect(domain.state).toBe('removing');
    });

    it('keeps pending/unavailable reads and a running or succeeded operation unresolved', () => {
        for (const read of [null, { kind: 'found' as const, operation },
            { kind: 'found' as const, operation: { ...operation, state: 'succeeded' as const, settledAt: 3 } }]) {
            expect(projectDeploymentDomainFactsV1(domain, 'account', read))
                .toEqual({ state: 'removing', retryRemoval: false, failure: null });
        }
    });

    it('uses only the exact operation and Account/controller scope for failure recovery', () => {
        const failed = { ...operation, state: 'failed' as const, settledAt: 3,
            error: { errorCode: 'outcome_unknown', error: 'outcome_unknown' } };
        expect(projectDeploymentDomainFactsV1(domain, 'account', { kind: 'found', operation: failed }))
            .toMatchObject({ state: 'outcome_unknown', retryRemoval: true, failure: failed.error });
        for (const other of [{ ...failed, operationId: 'other' },
            { ...failed, scope: { ...failed.scope, accountId: 'other' } },
            { ...failed, scope: { ...failed.scope, machineId: 'other' } }]) {
            expect(projectDeploymentDomainFactsV1(domain, 'account', { kind: 'found', operation: other }))
                .toEqual({ state: 'removing', retryRemoval: false, failure: null });
        }
    });

    it('does not reinterpret a missing Add or a legacy Domain without a recorded operation as failed removal', () => {
        for (const header of [{ ...domain, state: 'active' as const }, { ...domain, operationAddress: undefined }]) {
            expect(projectDeploymentDomainFactsV1(header, 'account', { kind: 'not_found' }))
                .toEqual({ state: header.state, retryRemoval: false, failure: null });
        }
    });
});
