import { describe, expect, it } from 'vitest';

import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { DeploymentBackupRestoreResultV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupRestoreV1';
import { createDeploymentDataMoveWorkflowV1 } from '@happier-dev/protocol/workflows/builtins/deploymentMoveV1';
import { walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowV1';

import { evaluateWorkflowCondition, type WorkflowValueResolutionRuntime } from '@/daemon/workflows/input';

// Reviewer guard (SEC-WORKFLOW-STEP-AUTHZ-1125): a saved approval choice can waive the cutover's Action Ask. The
// unverified-restore integrity decision is therefore the Workflow wait before it, which no Action setting reaches.
const actionId = ActionIdSchema.parse('deployments.environments.update');
const cutoverInput = { serverId: 'home', environmentId: 'environment', expectedRevision: 3, contentArtifactId: 'content',
    contentHeaderVersion: 1, contentBodyVersion: 1, patch: { retainPreviousDeployments: 2 } };
const workflowStep = { surface: 'agent' as const, actionCaller: { kind: 'workflowRun' as const, runId: 'run' } };
const unverified = DeploymentBackupRestoreResultV1Schema.parse({
    kind: 'restored', verified: false, nextAction: 'installAmcheckAndRunIntegrityCheck', evidence: {},
    integrity: { kind: 'unavailable', reason: 'amcheck_extension_missing', nextAction: 'installAmcheckAndRunIntegrityCheck' },
});
const verified = DeploymentBackupRestoreResultV1Schema.parse({ kind: 'restored', verified: true, nextAction: 'none', evidence: {} });
const waivers = [
    ['Account-wide agent waiver', normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: ['agent'] } }), undefined],
    ['this Environment', normalizeActionsSettingsV1({ v: 1, scopedApprovalPreferences: [{ actionId,
        scope: { kind: 'environment', environmentId: 'environment' }, approvalRequiredSurfaces: [], approvalWaivedSurfaces: ['agent'] }] }),
        { kind: 'environment', environmentId: 'environment' }],
] as const;

function restoreRuntime(restore: typeof unverified | typeof verified): WorkflowValueResolutionRuntime {
    return { inputs: {}, resolveResult: async ({ blockId }) => {
        if (blockId !== 'restore') throw new Error(`Unexpected dependency: ${blockId}`);
        return restore;
    }, resolveWorkspace: async () => { throw new Error('No workspace'); } };
}

describe('unverified Data Move cutover under a saved approval choice', () => {
    it('fixtures parse (guards a vacuous negative)', () => {
        expect(normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: ['agent'] } }).approvalWaivedSurfaces)
            .toEqual({ [actionId]: ['agent'] });
    });

    it.each(waivers)('%s waives the cutover Ask itself', (_label, settings, scope) => {
        expect(isApprovalRequiredByActionsSettings(actionId, settings, workflowStep as never,
            undefined, undefined, cutoverInput, undefined, undefined, undefined, scope as never)).toBe(false);
    });

    it('still holds an unverified restore at the integrity wait, a Workflow block no Action setting can waive', async () => {
        const blocks = walkWorkflowBlocks(createDeploymentDataMoveWorkflowV1().blocks);
        const healthy = blocks.find(block => block.kind === 'if' && block.id === 'destinationHealthSucceeded');
        if (healthy?.kind !== 'if') throw new Error('Missing destination health condition');
        const [wait, cutover] = healthy.then;
        expect(wait).toMatchObject({ kind: 'wait', id: 'reviewCutover' });
        expect(cutover).toMatchObject({ kind: 'action', id: 'cutover', actionId });
        if (wait?.kind !== 'wait' || !wait.onlyWhen) throw new Error('The integrity wait must be conditional on the restore');
        // A wait carries no Action id, so approval preferences cannot address it; only the restore fact decides it.
        expect('actionId' in wait).toBe(false);
        await expect(evaluateWorkflowCondition(wait.onlyWhen, restoreRuntime(unverified))).resolves.toBe(true);
        await expect(evaluateWorkflowCondition(wait.onlyWhen, restoreRuntime(verified))).resolves.toBe(false);
    });
});
