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

    it('continues the admitted Promote without re-admitting the prior Environment', async () => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('promote');
        const priorEnvironment = structuredClone(fixture.state.environment);
        priorEnvironment.environment.id = 'source-environment';
        priorEnvironment.environment.capabilities.deploy = false;
        const priorReceipt = structuredClone(fixture.state.receipt);
        priorReceipt.deployment.id = 'source-deployment';
        priorReceipt.deployment.environmentId = priorEnvironment.environment.id;
        priorReceipt.content.platform!.observation.providerDeploymentId = 'source-provider-deployment';
        fixture.state.receipt.deployment.operation = 'promote';
        fixture.state.receipt.deployment.promotedFromDeploymentId = priorReceipt.deployment.id;
        const input = normalizeStrictJsonValue({ ...fixture.input, priorDeployment: {
            environmentId: priorEnvironment.environment.id, deploymentId: priorReceipt.deployment.id,
            expectedRevision: priorReceipt.deployment.revision, providerDeploymentId: 'source-provider-deployment',
        } });
        const request = { ...fixture.request, input };
        let priorEnvironmentReads = 0;
        const host = { ...fixture.host,
            readEnvironment: async (params: Parameters<typeof fixture.host.readEnvironment>[0]) => {
                if (params.environmentId === priorEnvironment.environment.id) {
                    priorEnvironmentReads++;
                    return priorEnvironment;
                }
                return fixture.host.readEnvironment(params);
            },
            readReceipt: async (params: Parameters<typeof fixture.host.readReceipt>[0]) =>
                params.environmentId === priorEnvironment.environment.id ? priorReceipt : fixture.host.readReceipt(params),
        };
        const action = { pluginId: request.pluginId, localId: request.localId };
        const portFor = (environmentId: string, admitted: boolean) => createHostReviewedChildPortV1({
            actionId: 'deployments.promote', input: { serverId: fixture.input.serverId, environmentId,
                targetLinkId: fixture.input.targetLinkId, sourceEnvironmentId: priorEnvironment.environment.id,
                sourceDeploymentId: priorReceipt.deployment.id, artifact: 'image', requestKey: 'promote' },
            context: request.context, ...(admitted ? { reviewAdmitted: true } : {}),
            plan: { children: [{ action, role: 'promote', input }] },
            policies: [{ action, role: 'promote', surface: 'cli' }],
            async execute(_envelope, context) {
                const result = await admitDeploymentTargetRoleForHost({ ...request, context }, host);
                return { ok: true, result: normalizeStrictJsonValue({ role: result.role }) };
            },
        });
        const refusal = { code: 'deployment_access_denied', data: { failureCause: {
            phase: 'deployment.target.admission.prior_environment' } } };
        await expect(admitDeploymentTargetRoleForHost(request, host)).rejects.toMatchObject(refusal);
        for (const port of [portFor(fixture.input.environmentId, false), portFor('sibling-environment', true)]) {
            await expect(admitDeploymentTargetRoleForHost({ ...request,
                context: { ...request.context, hostReviewedChild: port } }, host)).rejects.toMatchObject(refusal);
        }
        const port = portFor(fixture.input.environmentId, true);
        const beforeContinuation = priorEnvironmentReads;
        await expect(port.invoke({ action, role: 'promote', input }))
            .resolves.toMatchObject({ ok: true, result: { role: 'promote' } });
        expect(priorEnvironmentReads).toBe(beforeContinuation);
        priorReceipt.content.platform!.observation.providerDeploymentId = 'substituted-deployment';
        await expect(port.invoke({ action, role: 'promote', input }))
            .rejects.toMatchObject({ code: 'deployment_conflict' });
    });

});
