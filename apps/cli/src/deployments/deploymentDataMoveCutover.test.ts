import { describe, expect, it } from 'vitest';

import { DeploymentBackupRestoreResultV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupRestoreV1';
import { createDeploymentDataMoveWorkflowV1 } from '@happier-dev/protocol/workflows/builtins/deploymentMoveV1';
import { walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowV1';

import { evaluateWorkflowCondition, type WorkflowValueResolutionRuntime } from '@/daemon/workflows/input';

const definition = createDeploymentDataMoveWorkflowV1();
const blocks = walkWorkflowBlocks(definition.blocks);
const noAmcheck = DeploymentBackupRestoreResultV1Schema.parse({
    kind: 'restored', verified: false, nextAction: 'installAmcheckAndRunIntegrityCheck', evidence: {},
    integrity: { kind: 'unavailable', reason: 'amcheck_extension_missing', nextAction: 'installAmcheckAndRunIntegrityCheck' },
});
const verified = DeploymentBackupRestoreResultV1Schema.parse({ kind: 'restored', verified: true, nextAction: 'none', evidence: {} });

function conditionBlock(id: string) {
    const block = blocks.find(block => block.id === id);
    if (block?.kind !== 'if') throw new Error(`Missing Data Move condition: ${id}`);
    return block;
}

function observations(restore = noAmcheck, health = 'healthy', freshness = 'current', transferred = true): WorkflowValueResolutionRuntime {
    const values = { restore, verify: { kind: 'verified', verified: transferred }, destinationHealth: { health, freshness } };
    return {
        inputs: {},
        resolveResult: async ({ blockId }) => {
            if (!Object.hasOwn(values, blockId)) throw new Error(`Unexpected Data Move dependency: ${blockId}`);
            return values[blockId as keyof typeof values];
        },
        resolveWorkspace: async () => { throw new Error('The cutover review does not read a workspace'); },
    };
}

describe('Data Move cutover review', () => {
    it('shows the missing amcheck warning at the person’s review before applying the Connect patch', async () => {
        const runtime = observations();
        await expect(evaluateWorkflowCondition(conditionBlock('verifySucceeded').when, runtime)).resolves.toBe(true);
        await expect(evaluateWorkflowCondition(conditionBlock('restoreSucceeded').when, runtime)).resolves.toBe(true);
        const healthy = conditionBlock('destinationHealthSucceeded');
        await expect(evaluateWorkflowCondition(healthy.when, runtime)).resolves.toBe(true);
        const [review, cutover] = healthy.then;
        expect(review).toMatchObject({ kind: 'wait', document: { text: expect.stringMatching(/amcheck.*missing|missing.*amcheck/i) } });
        expect(cutover).toMatchObject({ kind: 'action', id: 'cutover' });
        if (review?.kind !== 'wait' || !review.onlyWhen) throw new Error('Missing conditional human review');
        await expect(evaluateWorkflowCondition(review.onlyWhen, runtime)).resolves.toBe(true);
        await expect(evaluateWorkflowCondition(review.onlyWhen, observations(verified))).resolves.toBe(false);
    });

    it.each(['rolledBack', 'outcome_unknown', 'recoveryRequired'] as const)('keeps source recovery for %s instead of offering cutover', async kind => {
        const failed = DeploymentBackupRestoreResultV1Schema.parse({ kind, verified: false, nextAction: 'inspect', evidence: {} });
        const restore = conditionBlock('restoreSucceeded');
        await expect(evaluateWorkflowCondition(restore.when, observations(failed))).resolves.toBe(false);
        expect(restore.otherwise[0]).toMatchObject({ kind: 'wait', id: 'restoreRecovery' });
        expect(walkWorkflowBlocks(restore.otherwise).some(block => block.id === 'cutover')).toBe(false);
    });

    it('keeps the exceptional review behind verified transfer and current healthy destination checks', async () => {
        const verify = conditionBlock('verifySucceeded');
        await expect(evaluateWorkflowCondition(verify.when, observations(noAmcheck, 'healthy', 'current', false))).resolves.toBe(false);
        const healthy = conditionBlock('destinationHealthSucceeded');
        for (const result of [observations(noAmcheck, 'unhealthy'), observations(noAmcheck, 'healthy', 'stale')]) {
            await expect(evaluateWorkflowCondition(healthy.when, result)).resolves.toBe(false);
        }
        expect(walkWorkflowBlocks([...verify.otherwise, ...healthy.otherwise]).some(block => block.id === 'cutover')).toBe(false);
    });
});
