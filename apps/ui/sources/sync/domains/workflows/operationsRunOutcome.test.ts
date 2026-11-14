import { describe, expect, it } from 'vitest';
import { createDeploymentReceiptDetailV1, createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { projectDeploymentHealthAggregateV1 } from '@happier-dev/deployments';
import { projectOperationsRunOutcome } from './operationsRunOutcome';

describe('operations outcomes keep findings, proposals, effects and current health separate', () => {
    const receipt = createDeploymentReceiptDetailV1().deployment;
    const subject = { kind: 'deploymentReceipt', serverId: 'home', environmentId: receipt.environmentId, deploymentId: receipt.id } as const;
    const finding = { kind: 'workflow', runId: 'workflow-run', result: null } as const;
    const detail = createDeploymentEnvironmentDetailV1();
    const link = detail.targetLinks[0]!.targetLink;
    const health = { healthFeed: { environmentId: detail.environment.id, status: 'ready', members: [] },
        healthAggregate: projectDeploymentHealthAggregateV1({ environment: detail.environment, targetLink: link, observations: [] }) } as const;

    it('carries produced approval and new receipt references without upgrading them to observed recovery', () => {
        const approval = { kind: 'approval_request_created', artifactId: 'review', actionId: 'deployments.deploy' } as const;
        const produced = { pullRequests: [], approvals: [{ serverId: 'home', request: approval }], operations: [], pendingOperations: [],
            receipts: [{ serverId: 'home', environmentId: subject.environmentId, deploymentId: 'repair', state: 'succeeded' as const }] };
        const result = projectOperationsRunOutcome({ subject, finding, produced });
        expect(result.proposal.approval).toEqual(approval);
        expect(result.appliedEffect.receiptReference).toEqual(produced.receipts[0]);
        expect(result.recovery).toEqual({ kind: 'unavailable', reason: 'health_unavailable' });
    });

    it('never treats an applied receipt or pending approval as a finding or recovery', () => {
        const result = projectOperationsRunOutcome({ subject, finding, receipt,
            approval: { kind: 'approval_request_created', artifactId: 'pending-review', actionId: 'deployments.deploy' } });
        expect(result.finding).toBe(finding);
        expect(result.proposal.approval?.artifactId).toBe('pending-review');
        expect(result.appliedEffect.receipt).toBe(receipt);
        expect(result.recovery).toEqual({ kind: 'unavailable', reason: 'health_unavailable' });
    });

    it('does not attribute another Environment or runtime link health to the investigated receipt', () => {
        const result = projectOperationsRunOutcome({ subject: { ...subject, environmentId: 'another-env' }, finding, healthServerId: 'home', health });
        expect(result.recovery).toEqual({ kind: 'unavailable', reason: 'subject_mismatch' });
        expect(projectOperationsRunOutcome({ subject, finding, subjectReceipt: { ...receipt, targetLinkId: 'old-link' }, healthServerId: 'home',
            health: { ...health, healthFeed: { ...health.healthFeed, environmentId: subject.environmentId },
                healthAggregate: { ...health.healthAggregate, environmentId: subject.environmentId } } }).recovery)
            .toEqual({ kind: 'unavailable', reason: 'subject_mismatch' });
    });

    it('keeps unknown current health unknown while the finding and proposal remain readable', () => {
        const result = projectOperationsRunOutcome({ subject, finding, subjectReceipt: receipt, healthServerId: 'home',
            health: { ...health, healthFeed: { ...health.healthFeed, environmentId: subject.environmentId },
                healthAggregate: { ...health.healthAggregate, environmentId: subject.environmentId, targetLinkId: receipt.targetLinkId } } });
        expect(result.recovery).toMatchObject({ kind: 'observed', health: { status: 'unknown' } });
        expect(result.finding.result).toBeNull();
        expect(result.proposal).toEqual({ pullRequest: null, approval: null });
    });
    it('reads only the same Machine/service from live health and preserves partial coverage', () => {
        const subject = { kind: 'service', target: { kind: 'host', page: 'machine_service',
            machine: { serverId: 'home', machineId: 'a' }, service: { kind: 'deployment', machineId: 'a',
                environmentId: 'env', environmentInstanceId: 'instance', composeService: 'web', serviceId: 'instance/web' },
            environment: { serverId: 'home', projectSourceId: 'source', environmentId: 'env' } } } as const;
        const current = { serviceId: 'instance/web', state: 'down', observedAt: 12, reason: null } as const;
        const health = { healthFeed: { environmentId: 'env', status: 'partial', members: [
            { machineId: 'b', installationId: 'b', status: 'ready', services: [{ ...current, state: 'up' }] },
            { machineId: 'a', installationId: 'a', status: 'ready', services: [current] },
        ] } } as const;
        expect(projectOperationsRunOutcome({ subject, finding, healthServerId: 'home', health }).recovery)
            .toEqual({ kind: 'service', health: current, coverage: 'partial' });
        expect(projectOperationsRunOutcome({ subject, finding, healthServerId: 'home', health: { ...health, healthFeed: { ...health.healthFeed, members: health.healthFeed.members.slice(0, 1) } } }).recovery)
            .toEqual({ kind: 'unavailable', reason: 'health_unavailable' });
    });

    it('does not borrow a matching Environment id from a different Home', () => {
        expect(projectOperationsRunOutcome({ subject, finding, receipt, healthServerId: 'other-home',
            health: { ...health, healthFeed: { ...health.healthFeed, environmentId: subject.environmentId },
                healthAggregate: { ...health.healthAggregate, environmentId: subject.environmentId, targetLinkId: receipt.targetLinkId } } }).recovery)
            .toEqual({ kind: 'unavailable', reason: 'subject_mismatch' });
    });

    it('keeps a remediation receipt separate from the failed subject while reading that subject current health', () => {
        const applied = { ...receipt, id: 'remediation-receipt' };
        const result = projectOperationsRunOutcome({ subject, finding, subjectReceipt: receipt, receipt: applied,
            healthServerId: 'home', health: { ...health, healthFeed: { ...health.healthFeed, environmentId: subject.environmentId },
                healthAggregate: { ...health.healthAggregate, environmentId: subject.environmentId, targetLinkId: receipt.targetLinkId } } });
        expect(result.appliedEffect.receipt).toBe(applied);
        expect(result.recovery).toMatchObject({ kind: 'observed', health: { status: 'unknown' } });
    });

});
