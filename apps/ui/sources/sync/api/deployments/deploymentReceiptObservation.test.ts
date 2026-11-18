import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentReceiptArtifactHeaderV1 } from '@happier-dev/deployment-protocol/v1';
import { createLegacyAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { createHomeGovernanceHarness, createAccountTokenForTests, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';

// Only authenticated Home HTTP, daemon transport and device credential IO are replaced.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { createUiDeploymentActionDeps } = await import('./deploymentActions');
const uiHost = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
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

describe('deployment receipt observation routing', () => {
    it.each(['plain', 'e2ee'] as const)('opens exact %s receipt investigation without a controller', async mode => {
        if (mode === 'e2ee') {
            account?.dispose();
            const secret = new Uint8Array(32).fill(37);
            serverId = await homes.addHome({ name: 'Encrypted receipt', serverUrl: 'https://encrypted-receipt.test',
                serverIdentityId: 'srv_encrypted_receipt', accountId: 'owner', currentAccount: true, active: false,
                accountEncryptionMode: 'e2ee', credentials: { token: createAccountTokenForTests('owner', { currentAccount: true }),
                    secret: encodeBase64(secret, 'base64url') } });
            homes.answer(serverId, 'GET /v1/account/encryption/currentness', {
                body: createLegacyAccountEncryptionCurrentnessFixture({ secret }),
            });
            account = await captureLazyActionAccountContext(serverId);
        }
        const writer = requireAccount();
        const base = createDeploymentReceiptDetailV1();
        const failure = { phase: 'build', code: 'build_failed', failureCause: {
            phase: 'deployment.native.build.build_failed', errorClass: 'Error', errorCode: 'deployment_disk_full', httpStatus: null,
        } } as const;
        const content = { ...base.content, failure };
        const created = await writer.createArtifactDocument({
            header: createDeploymentReceiptArtifactHeaderV1('Private receipt', content), body: JSON.stringify(content),
        });
        const deployment = { ...base.deployment, state: 'failed' as const, contentArtifactId: created.artifactId,
            contentHeaderVersion: created.revision.headerVersion, contentBodyVersion: created.revision.bodyVersion };
        const path = `/v1/deployments/receipts/${deployment.id}`;
        homes.answer(serverId, `GET ${path}`, { select: (_body, request) => {
            expect(new URL(request.url).searchParams.has('projection')).toBe(false);
            return { body: { ok: true, deployment } };
        } });
        const deps = createUiDeploymentActionDeps(writer);
        const input = { serverId, environmentId: deployment.environmentId, deploymentId: deployment.id };
        const before = homes.requests.length;
        expect(await deps.deploymentAction!('deployments.receipts.get', input, {})).toEqual({ ok: true, deployment });
        expect(homes.requests.slice(before).filter(request => request.path.startsWith('/v1/artifacts/'))).toEqual([]);
        const result = DeploymentActionOutputSchemasV1['deployments.receipts.get'].parse(await deps.deploymentAction!(
            'deployments.receipts.get', { ...input, projection: 'investigation' }, {}));
        const source = base.content.sourceIntent;
        if (source.kind !== 'repository') throw new Error('Expected repository receipt fixture');
        expect(result).toEqual({ ok: true, deployment, failureSummary: expect.objectContaining({
            phase: failure.phase, code: failure.code,
        }), investigation: {
            source: { kind: 'repository', projectSourceId: source.projectSourceId, sourceRevision: source.sourceRevision, sha: source.sha },
            failure,
        } });
        expect(JSON.stringify(result)).not.toContain('sourceIntent');
        expect(homes.requests.slice(before).filter(request => request.path.startsWith('/v1/actions/'))).toEqual([]);
        homes.answer(serverId, `GET ${path}`, { body: { ok: true,
            deployment: { ...deployment, contentBodyVersion: deployment.contentBodyVersion + 1 } } });
        expect(await deps.deploymentAction!('deployments.receipts.get', { ...input, projection: 'investigation' }, {}))
            .toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
    });

    it('observes a compact provider receipt through the Environment controller', async () => {
        const base = createDeploymentEnvironmentDetailV1();
        const detail = createDeploymentEnvironmentDetailV1({ environment: {
            ...base.environment, controllerMachineId: 'receipt-controller',
        } });
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
        await answerExternalActionAccountForHome(homes, serverId, {
            machineId: detail.environment.controllerMachineId, actionId: 'deployments.receipts.observe', tokenEpoch: 0,
            execute: (received, context) => {
                expect(context.target).toEqual({ kind: 'machine', machineId: detail.environment.controllerMachineId });
                expect(received).toEqual(input);
                return result;
            },
        });
        const before = homes.requests.length;
        expect(await createUiDeploymentActionDeps(requireAccount()).deploymentAction!('deployments.receipts.observe', input,
            { ...uiHost, actionRequestId: 'observe-original' })).toEqual(result);
        expect(homes.requestsFor('/v1/actions/deployments.receipts.observe')).toHaveLength(1);
        expect(homes.requests.slice(before).filter(request => request.path.startsWith('/v1/deployments/'))
            .map(request => new URL(request.path, requireAccount().endpointUrl).pathname)).toEqual([environmentPath]);
    });

    it('retains the controller refusal for a compact deployment observation read', async () => {
        const detail = createDeploymentEnvironmentDetailV1();
        homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
            ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
        } });
        const input = DeploymentActionInputSchemasV1['deployments.observation.get'].parse({
            serverId, environmentId: detail.environment.id, targetLinkId: detail.targetLinks[0]!.targetLink.id,
        });
        const result = DeploymentActionOutputSchemasV1['deployments.observation.get'].parse({
            ok: false, error: 'deployment_content_unavailable',
        });
        await answerExternalActionAccountForHome(homes, serverId, {
            machineId: detail.environment.controllerMachineId, actionId: 'deployments.observation.get', tokenEpoch: 0,
            execute: (received, context) => {
                expect(context.target).toEqual({ kind: 'machine', machineId: detail.environment.controllerMachineId });
                expect(received).toEqual(input);
                return result;
            },
        });
        expect(await createUiDeploymentActionDeps(requireAccount()).deploymentAction!('deployments.observation.get', input,
            uiHost)).toEqual(result);
        expect(homes.requestsFor('/v1/actions/deployments.observation.get')).toHaveLength(1);
    });
});
