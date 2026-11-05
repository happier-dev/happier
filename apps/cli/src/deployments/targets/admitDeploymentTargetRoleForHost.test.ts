import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { describe, expect, it } from 'vitest';
import { admitDeploymentTargetRoleForHost } from './admitDeploymentTargetRoleForHost';
import { createDeploymentTargetRoleAdmissionFixture } from './deploymentTargetRoleAdmission.testkit';

describe('deployment role host admission', () => {
    it.each(['deploy', 'uploadDeploy'] as const)('continues admitted %s from a custody-only Environment read', async role => {
        const fixture = createDeploymentTargetRoleAdmissionFixture(role);
        if (role === 'uploadDeploy') fixture.state.receipt.content.sourceMethod = 'upload';
        fixture.state.environment.environment.capabilities.deploy = false;
        const action = { pluginId: fixture.request.pluginId, localId: fixture.request.localId };
        const input = normalizeStrictJsonValue(fixture.input);
        const parentInput = { serverId: fixture.input.serverId, environmentId: fixture.input.environmentId,
            targetLinkId: fixture.input.targetLinkId };
        const portFor = (environmentId: string, admitted: boolean) => createHostReviewedChildPortV1({
            actionId: 'deployments.deploy', input: { ...parentInput, environmentId },
            context: fixture.request.context, ...(admitted ? { reviewAdmitted: true } : {}),
            plan: { children: [{ action, role, input }] }, policies: [{ action, role, surface: 'cli' }],
            async execute(_envelope, context) {
                const result = await admitDeploymentTargetRoleForHost({ ...fixture.request, context }, fixture.host);
                return { ok: true, result: normalizeStrictJsonValue({ role: result.role }) };
            },
        });
        await expect(admitDeploymentTargetRoleForHost(fixture.request, fixture.host))
            .rejects.toMatchObject({ code: 'deployment_access_denied' });
        for (const port of [portFor(parentInput.environmentId, false), portFor('sibling-environment', true)]) {
            await expect(admitDeploymentTargetRoleForHost({ ...fixture.request,
                context: { ...fixture.request.context, hostReviewedChild: port } }, fixture.host))
                .rejects.toMatchObject({ code: 'deployment_access_denied' });
        }
        const port = portFor(parentInput.environmentId, true);
        await expect(admitDeploymentTargetRoleForHost({ ...fixture.request,
            context: { ...fixture.request.context, hostReviewedChild: port } }, fixture.host))
            .resolves.toMatchObject({ role });
        await expect(port.invoke({ action, role, input })).resolves.toMatchObject({ ok: true, result: { role } });
        fixture.state.receipt.content.platform!.providerIdentity.providerResourceId = 'foreign-provider-project';
        await expect(admitDeploymentTargetRoleForHost({ ...fixture.request,
            context: { ...fixture.request.context, hostReviewedChild: port } }, fixture.host))
            .rejects.toMatchObject({ code: 'deployment_access_denied' });
    });

});
