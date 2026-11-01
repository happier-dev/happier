import { describe, expect, it } from 'vitest';
import { ExternalActionTargetV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { WorkflowWorkspaceDescriptorV1Schema } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';

import { projectAcceptedWorkflowRunTarget } from './projectAcceptedWorkflowRunTarget';

describe('projectAcceptedWorkflowRunTarget', () => {
    it('projects only the original signed project target fields for a reviewed new whole Run', () => {
        const accepted = WorkflowWorkspaceDescriptorV1Schema.parse({
            machineId: 'machine-1',
            directory: '/repo/packages/app',
            workspaceRefId: 'workspace-1',
            checkoutRootPath: '/repo',
            checkout: { kind: 'git_worktree', branchName: 'previous-run' },
            sourceInvocation: {
                producer: { blockId: 'previous-step', scope: { kind: 'current' } },
                invocationRecordId: 'previous-invocation',
            },
        });
        const project = projectAcceptedWorkflowRunTarget(accepted);

        expect(project).toEqual({
            machineId: 'machine-1',
            directory: '/repo/packages/app',
            workspaceRefId: 'workspace-1',
        });
        expect(ExternalActionTargetV1Schema.safeParse({
            kind: 'machine', machineId: project.machineId, project,
        }).success).toBe(true);
    });
});
