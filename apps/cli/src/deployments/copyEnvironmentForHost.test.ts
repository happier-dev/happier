import { describe, expect, it } from 'vitest';
import { DeploymentEnvironmentCreateInputV1Schema, DeploymentTemplateInstantiationPartialV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createEnvironmentWithCopyForHost } from './copyEnvironmentForHost';

describe('Copy acknowledged step result', () => {
    it('preserves the created Environment and binding continuation when the later binding Action is forbidden', async () => {
        const base = createDeploymentEnvironmentDetailV1();
        const binding = { purpose: 'variable' as const, name: 'PUBLIC', phase: 'runtime' as const,
            source: { kind: 'value' as const, value: 'included' } };
        const input = DeploymentEnvironmentCreateInputV1Schema.parse({ serverId: 'home', projectSourceId: 'destination',
            requestKey: 'copy', protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: 'controller', contentArtifactId: base.environment.contentArtifactId,
            contentHeaderVersion: base.environment.contentHeaderVersion, contentBodyVersion: base.environment.contentBodyVersion,
            copyIntentCommitment: 'A'.repeat(43),
            copyFrom: { environmentId: 'source', expectedRevision: 7, choices: { secrets: [],
                values: [{ binding: { purpose: 'variable', name: 'PUBLIC', phase: 'runtime' }, kind: 'include' }], data: [] } },
            copyPlan: { bindings: [binding] } });
        const invocations: unknown[] = [];
        const context: ActionExecutorContext = { hostReviewedChild: { async invoke(request) {
            invocations.push(request);
            return { ok: false, errorCode: 'action_forbidden', error: 'action_forbidden' };
        } } };
        // Backing Environment storage and the admitted child Action are process boundaries.
        const result = await createEnvironmentWithCopyForHost({ input, context }, {
            async create() { return { ok: true, environmentId: base.environment.id, revision: 1 }; },
            async readEnvironment() { return { environment: { ...base.environment, revision: 1 },
                content: { ...base.content, bindings: [] }, targetLinks: base.targetLinks.map(link => link.targetLink) }; },
        });
        expect(result).toMatchObject({ ok: false, errorCode: 'action_forbidden', details: {
            kind: 'partial', phase: 'bindings', errorCode: 'action_forbidden', savedSecrets: [],
            environmentId: base.environment.id, revision: 1,
            continuation: { actionId: 'deployments.bindings.set', input: { environmentId: base.environment.id,
                expectedRevision: 1, set: [binding], remove: [] } },
        } });
        if (!('details' in result)) throw new Error('Expected acknowledged partial result');
        expect(DeploymentTemplateInstantiationPartialV1Schema.safeParse(result.details).success).toBe(true);
        expect(invocations).toHaveLength(1);
    });
});
