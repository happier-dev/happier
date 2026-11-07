import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';

// Only authenticated Home HTTP, daemon transport and device credential IO are replaced.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { createUiDeploymentActionDeps } = await import('./deploymentActions');
let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | null = null;
let serverId: string;

beforeEach(async () => {
    installHomeGovernanceBoundaries(homes);
    await homes.reset();
    serverId = await homes.addHome({ name: 'Deployment receipt observation', serverUrl: 'https://deployment-observation.test',
        serverIdentityId: 'srv_deployment_observation', accountId: 'owner', currentAccount: true, active: false });
    account = await captureLazyActionAccountContext(serverId);
});
afterEach(async () => { account?.dispose(); account = null; await homes.reset(); });

function requireAccount() {
    if (!account) throw new Error('Expected captured Account');
    return account;
}

function answerMachine(machineId: string) {
    const machine = { ...createPlainMachineRowFixture({ id: machineId, accountId: 'owner' }), installationId: `installation-${machineId}` };
    homes.answer(serverId, `/v1/machines/${machineId}`, { body: { machine } });
    homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
        body: await createMachineReadBatchResponseFixture(body, id => id === machineId ? machine : null).json(),
    }) });
}

describe('deployment receipt observation routing', () => {
    it('observes a compact provider receipt through the Environment controller', async () => {
        const base = createDeploymentEnvironmentDetailV1();
        const detail = createDeploymentEnvironmentDetailV1({ environment: {
            ...base.environment, controllerMachineId: 'receipt-controller',
        } });
        answerMachine(detail.environment.controllerMachineId);
        const environmentPath = `/v1/deployments/environments/${detail.environment.id}`;
        homes.answer(serverId, `GET ${environmentPath}`, { body: {
            ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
        } });
        const input = DeploymentActionInputSchemasV1['deployments.receipts.observe'].parse({
            serverId, environmentId: detail.environment.id, deploymentId: 'running-provider-receipt',
        });
        const result = DeploymentActionOutputSchemasV1['deployments.receipts.observe'].parse({
            ok: true, environmentId: detail.environment.id, revision: 2,
            deploymentId: input.deploymentId, deploymentRevision: 2, state: 'succeeded',
        });
        homes.answer(serverId, '/v1/actions/deployments.receipts.observe', { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(envelope.target).toEqual({ kind: 'machine', machineId: detail.environment.controllerMachineId });
            expect(envelope.input).toEqual(input);
            return { body: { v: 1, actionId: 'deployments.receipts.observe', requestId: envelope.requestId,
                execution: { ok: true, result } } };
        } });
        const before = homes.requests.length;
        expect(await createUiDeploymentActionDeps(requireAccount()).deploymentAction!('deployments.receipts.observe', input,
            { surface: 'ui', actionRequestId: 'observe-original' })).toEqual(result);
        expect(homes.requestsFor('/v1/actions/deployments.receipts.observe')).toHaveLength(1);
        expect(homes.requests.slice(before).filter(request => request.path.startsWith('/v1/deployments/'))
            .map(request => request.path)).toEqual([environmentPath]);
    });

    it('retains the controller refusal for a compact deployment observation read', async () => {
        const detail = createDeploymentEnvironmentDetailV1();
        answerMachine(detail.environment.controllerMachineId);
        homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
            ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
        } });
        const input = DeploymentActionInputSchemasV1['deployments.observation.get'].parse({
            serverId, environmentId: detail.environment.id, targetLinkId: detail.targetLinks[0]!.targetLink.id,
        });
        const result = DeploymentActionOutputSchemasV1['deployments.observation.get'].parse({
            ok: false, error: 'deployment_content_unavailable',
        });
        homes.answer(serverId, '/v1/actions/deployments.observation.get', { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(envelope.target).toEqual({ kind: 'machine', machineId: detail.environment.controllerMachineId });
            expect(envelope.input).toEqual(input);
            return { body: { v: 1, actionId: 'deployments.observation.get', requestId: envelope.requestId,
                execution: { ok: true, result } } };
        } });
        expect(await createUiDeploymentActionDeps(requireAccount()).deploymentAction!('deployments.observation.get', input,
            { surface: 'ui' })).toEqual(result);
        expect(homes.requestsFor('/v1/actions/deployments.observation.get')).toHaveLength(1);
    });
});
