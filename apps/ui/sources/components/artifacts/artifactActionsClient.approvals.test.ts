import { describe, expect, it } from 'vitest';
import {
    createActionExecutor,
    isApprovalRequiredByActionsSettings,
    normalizeActionsSettingsV1,
    type ApprovalRequest,
} from '@happier-dev/protocol';

import { createArtifactActionsClient } from './artifactActionsClient';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';

describe('Artifact surface pending approvals', () => {
    it.each(['create', 'update', 'restore', 'delete'] as const)('recognizes a durable %s approval before parsing the final acknowledgement', async (operation) => {
        const settings = normalizeActionsSettingsV1({ v: 1, actions: {
            'artifact.create': { approvalRequiredSurfaces: ['ui'] },
            'artifact.update': { approvalRequiredSurfaces: ['ui'] },
            'artifact.revisions.restore': { approvalRequiredSurfaces: ['ui'] },
            'artifact.delete': { approvalRequiredSurfaces: ['ui'] },
        } });
        const persisted: ApprovalRequest[] = [];
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context),
            // Only approval persistence is substituted. Routing, admission and result creation stay real.
            approvalsCreate: async ({ request }) => {
                persisted.push(request);
                return { artifactId: 'pending-artifact-approval' };
            },
        }));
        const client = createArtifactActionsClient({ serverId: 'home-1', accountId: 'owner-1' },
            (actionId, input, context) => executor.execute(actionId, input, {
                ...context, authority: 'present_user', actionCaller: { kind: 'host' },
                runtimeAccountId: 'owner-1', actionRequestId: 'request-1',
            }));
        const input = { artifactId: 'document-1', expectedRevision: { headerVersion: 2, bodyVersion: 3 } };
        const draft = { header: { kind: 'artifact.legacy', title: 'Draft' }, body: 'Draft body' };
        const outcome = operation === 'create' ? await client.createArtifact(draft)
            : operation === 'update' ? await client.updateArtifact({ ...input, ...draft })
            : operation === 'restore'
            ? await client.restoreRevision({ ...input, bodyVersion: 1 })
            : await client.deleteArtifact(input);
        expect(persisted).toMatchObject([{ status: 'open',
            actionId: operation === 'restore' ? 'artifact.revisions.restore' : `artifact.${operation}`,
            actionArgs: operation === 'create' ? draft : operation === 'update' ? { ...input, ...draft }
                : operation === 'restore' ? { ...input, bodyVersion: 1 } : input }]);
        expect(outcome).toEqual({ approvalId: 'pending-artifact-approval' });
    });
});
