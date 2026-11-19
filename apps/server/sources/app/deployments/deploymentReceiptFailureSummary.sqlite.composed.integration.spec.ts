import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1, DeploymentReceiptGetResultV1Schema,
    encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { createDaemonDeploymentActionDeps } from '../../../../cli/src/deployments/createDaemonDeploymentActionDeps';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { setArtifactAccessGrantInTx } from '@/app/artifacts/artifactAccessService';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerAccountEncryptionRoutes } from '@/app/api/routes/account/registerAccountEncryptionRoutes';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { createReviewedChildAuthorizationFixture } from '@/app/api/routes/actions/reviewedChildAuthorization.composed.testkit';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { createDeploymentEnvironmentInTx, loadDeploymentEnvironmentInTx, projectDeploymentEnvironmentHeader } from './deploymentEnvironmentService';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '../../../../cli/src/api/clientCompatibility/cliClientCompatibility';

describe('signed deployment receipt failure summary', () => {
    const serverId = 'srv_receipt_failure_summary';
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-receipt-summary-',
            initAuth: true, initEncrypt: true, env: { HAPPIER_SERVER_IDENTITY_ID: serverId, AUTH_REQUIRED_LOGIN_PROVIDERS: '' } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it('opens a failed receipt through its publicly issued read root and returns only structural failure facts', async () => {
        const f = await createReviewedChildAuthorizationFixture();
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        const requests: Array<{ method: string; path: string; status: number; effect: unknown }> = [];
        app.addHook('onResponse', async (request, reply) => {
            requests.push({ method: request.method, path: request.url, status: reply.statusCode,
                effect: request.headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER] });
        });
        registerAccountEncryptionRoutes(app);
        registerDeploymentRoutes(app);
        await artifactsRoutes(app);
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        try {
            const source = await inTx(tx => createProjectSourceInTx(tx, f.account.id, { serverId,
                requestKey: crypto.randomUUID(), name: 'Receipt summary', audience: [] }));
            if (!source.ok) throw new Error(source.error);
            async function content(kind: string, value: unknown, storedKind?: string) {
                const result = await createArtifact({ actorUserId: f.account.id, artifactId: crypto.randomUUID(),
                    ...(storedKind ? { kind: storedKind } : {}),
                    header: decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Private deployment' })),
                    body: decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(value) })),
                    dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
                if (!result.ok) throw new Error(result.error);
                return { contentArtifactId: result.artifact.id, contentHeaderVersion: result.artifact.headerVersion,
                    contentBodyVersion: result.artifact.bodyVersion };
            }
            const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
                createdByAccountId: f.account.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                controllerMachineId: f.machine.id,
                ...await content('deployment-environment.v1', createDeploymentEnvironmentDetailV1().content) } });
            const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id, createdByAccountId: f.account.id,
                role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'deployed',
                ...await content('deployment-target-link.v1', {}) } });
            await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: link.id } });
            const privateContent = createDeploymentReceiptDetailV1().content;
            privateContent.commitSubject = 'Private deployment detail must stay inside receipt custody';
            privateContent.failure = { phase: 'build', code: 'build_failed', sourceAdmission: {
                phase: 'deployment_source_admission', reason: 'requester_authority_unavailable',
                requiredFact: 'verified_root_requester', remedy: 'retry_original_request' } };
            const receipt = await db.deployment.create({ data: { environmentId: environment.id, targetLinkId: link.id,
                operation: 'deploy', state: 'succeeded', requestKey: crypto.randomUUID(), requestedByAccountId: f.account.id,
                actionOperationId: crypto.randomUUID(),
                ...await content('deployment-receipt.v1', privateContent, DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1) } });
            const deps = createDaemonDeploymentActionDeps({ credentials: { token: f.presentUserToken, encryption: null },
                serverId, serverHttpBaseUrl: origin, machineId: f.machine.id,
                resolveRequesterIdentity: async () => { throw new Error('Receipt reads do not resolve a deployment Source'); },
                runtime: { async acquire() { throw new Error('Receipt reads do not acquire a deployment runtime'); } } });
            const input = { serverId, environmentId: environment.id, deploymentId: receipt.id };
            async function read() {
                const root = await f.withAccountProjection(await f.root('deployments.receipts.get', input));
                expect(root.binding.actionId).toBe('deployments.receipts.get');
                return deps.deploymentAction('deployments.receipts.get', input, f.context(root));
            }
            const healthy = await read();
            expect(healthy, JSON.stringify({ healthy, requests })).toMatchObject({ ok: true, deployment: { id: receipt.id, state: 'succeeded' } });
            expect(requests.filter(request => request.path.startsWith('/v1/artifacts/'))).toEqual([]);
            await db.deployment.update({ where: { id: receipt.id }, data: { state: 'failed', settledAt: new Date() } });
            const failed = await read();
            expect(failed, JSON.stringify({ failed, requests })).toMatchObject({ ok: true, deployment: { id: receipt.id, state: 'failed' },
                failureSummary: { phase: 'build', code: 'build_failed', requiredFact: 'verified_root_requester', remedy: 'retry_original_request' } });
            const detail = DeploymentReceiptGetResultV1Schema.parse(failed);
            if (!detail.ok) throw new Error('Expected the signed failed receipt read to succeed');
            expect(detail.failureSummary).toEqual({ phase: 'build', code: 'build_failed', requiredFact: 'verified_root_requester', remedy: 'retry_original_request' });
            expect(detail).not.toHaveProperty('content');
            expect(detail.deployment).not.toHaveProperty('content');
            expect(JSON.stringify(detail)).not.toContain(privateContent.commitSubject);
            expect(requests.filter(request => request.path.startsWith('/v1/artifacts/'))).toEqual([
                { method: 'GET', path: `/v1/artifacts/${encodeURIComponent(receipt.contentArtifactId)}`, status: 200, effect: 'deployments.receipts.get' },
            ]);
        } finally { await app.close(); await f.app.close(); }
    });
    it('returns a teammate failed receipt summary to an admitted Team deployer while retaining resource boundaries', async () => {
        const owner = await createReviewedChildAuthorizationFixture();
        const deployer = await createReviewedChildAuthorizationFixture();
        const outsider = await createReviewedChildAuthorizationFixture();
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        const requests: Array<{ method: string; path: string; status: number }> = [];
        app.addHook('onResponse', async (request, reply) => {
            requests.push({ method: request.method, path: request.url, status: reply.statusCode });
        });
        registerAccountEncryptionRoutes(app);
        registerDeploymentRoutes(app);
        await artifactsRoutes(app);
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        try {
            const team = await db.team.create({ data: { name: 'Receipt readers' } });
            await db.teamMembership.createMany({ data: [
                { teamId: team.id, accountId: owner.account.id, role: 'owner' },
                { teamId: team.id, accountId: deployer.account.id, role: 'member' },
            ] });
            const source = await inTx(tx => createProjectSourceInTx(tx, owner.account.id, { serverId,
                requestKey: crypto.randomUUID(), name: 'Team receipt summary', owner: { kind: 'team', teamId: team.id }, audience: [] }));
            if (!source.ok) throw new Error(source.error);
            expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: owner.account.id,
                machineId: owner.machine.id, principal: { kind: 'team', teamId: team.id }, level: 'view' }))).toMatchObject({ kind: 'saved' });
            async function content(kind: string, value: unknown, storedKind?: string) {
                const result = await createArtifact({ actorUserId: owner.account.id, artifactId: crypto.randomUUID(),
                    ...(storedKind ? { kind: storedKind } : {}),
                    header: decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Team deployment' })),
                    body: decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(value) })),
                    dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
                if (!result.ok) throw new Error(result.error);
                expect(await inTx(tx => setArtifactAccessGrantInTx(tx, { actorAccountId: owner.account.id,
                    artifactId: result.artifact.id, principal: { kind: 'team', teamId: team.id }, accessLevel: 'admin' }))).toMatchObject({ ok: true });
                return { contentArtifactId: result.artifact.id, contentHeaderVersion: result.artifact.headerVersion,
                    contentBodyVersion: result.artifact.bodyVersion };
            }
            const environmentContent = await content('deployment-environment.v1', createDeploymentEnvironmentDetailV1().content);
            const environment = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.account.id, { serverId,
                projectSourceId: source.source.id, requestKey: crypto.randomUUID(), protection: 'nonProduction', purpose: 'standard',
                deployerMode: 'members', controllerMachineId: owner.machine.id,
                ...environmentContent }));
            if (!environment.ok) throw new Error(environment.error);
            const loaded = await inTx(tx => loadDeploymentEnvironmentInTx(tx, deployer.account.id, serverId, environment.environmentId));
            if (!loaded.ok) throw new Error(loaded.error);
            expect(projectDeploymentEnvironmentHeader(loaded.row, serverId, loaded.admission))
                .toMatchObject({ capabilities: { role: 'deployer', read: true, deploy: true, manage: false } });
            const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.environmentId,
                createdByAccountId: owner.account.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
                targetKind: 'ownServer', state: 'deployed', ...await content('deployment-target-link.v1', {}) } });
            const privateContent = createDeploymentReceiptDetailV1().content;
            privateContent.failure = { phase: 'build', code: 'build_failed', sourceAdmission: {
                phase: 'deployment_source_admission', reason: 'requester_authority_unavailable',
                requiredFact: 'verified_root_requester', remedy: 'retry_original_request' } };
            const settledAt = new Date();
            const receipt = await db.deployment.create({ data: { environmentId: environment.environmentId, targetLinkId: link.id,
                operation: 'deploy', state: 'failed', requestKey: crypto.randomUUID(), requestedByAccountId: owner.account.id,
                actionOperationId: crypto.randomUUID(), requestedAt: settledAt, settledAt,
                ...await content('deployment-receipt.v1', privateContent, DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1) } });
            const otherEnvironment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
                createdByAccountId: owner.account.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'members',
                controllerMachineId: owner.machine.id,
                ...await content('deployment-environment.v1', createDeploymentEnvironmentDetailV1().content) } });
            const otherLink = await db.deploymentTargetLink.create({ data: { environmentId: otherEnvironment.id,
                createdByAccountId: owner.account.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
                targetKind: 'ownServer', state: 'deployed', ...await content('deployment-target-link.v1', {}) } });
            const otherReceipt = await db.deployment.create({ data: { ...receipt, id: crypto.randomUUID(),
                environmentId: otherEnvironment.id, targetLinkId: otherLink.id,
                requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(),
                ...await content('deployment-receipt.v1', privateContent, DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1) } });
            const input = { serverId, environmentId: environment.environmentId, deploymentId: receipt.id };
            const root = await deployer.withAccountProjection(await deployer.root('deployments.receipts.get', input));
            expect(root.binding.accountId).toBe(deployer.account.id);
            expect(receipt.requestedByAccountId).toBe(owner.account.id);
            const foreignPath = `/v1/artifacts/${otherReceipt.contentArtifactId}`;
            const foreign = await app.inject({ method: 'GET', url: foreignPath,
                headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                    ...await deployer.headers(root, { effectActionId: 'deployments.receipts.get', method: 'GET', path: foreignPath }) } });
            expect(foreign.statusCode, foreign.body).toBe(401);
            const metadataPath = `/v1/deployments/receipts/${receipt.id}?serverId=${serverId}&environmentId=${environment.environmentId}`;
            const unavailable = await app.inject({ method: 'GET', url: metadataPath,
                headers: { authorization: `Bearer ${outsider.presentUserToken}` } });
            expect(unavailable.statusCode, unavailable.body).toBe(404);
            const inaccessible = await app.inject({ method: 'GET', url: `/v1/artifacts/${receipt.contentArtifactId}`,
                headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), authorization: `Bearer ${outsider.presentUserToken}` } });
            expect(inaccessible.statusCode, inaccessible.body).toBe(404);
            const deps = createDaemonDeploymentActionDeps({ credentials: { token: deployer.presentUserToken, encryption: null },
                serverId, serverHttpBaseUrl: origin, machineId: deployer.machine.id,
                resolveRequesterIdentity: async () => { throw new Error('Receipt reads do not resolve a deployment Source'); },
                runtime: { async acquire() { throw new Error('Receipt reads do not acquire a deployment runtime'); } } });
            const result = await deps.deploymentAction('deployments.receipts.get', input, deployer.context(root));
            expect(result, JSON.stringify({ result, requests })).toMatchObject({ ok: true, deployment: { id: receipt.id, state: 'failed' } });
            const detail = DeploymentReceiptGetResultV1Schema.parse(result);
            if (!detail.ok) throw new Error('Expected the admitted Team deployer to read the teammate receipt');
            expect(detail.failureSummary).toEqual({ phase: 'build', code: 'build_failed',
                requiredFact: 'verified_root_requester', remedy: 'retry_original_request' });
            expect(requests).toContainEqual({ method: 'GET', path: `/v1/artifacts/${receipt.contentArtifactId}`, status: 200 });
        } finally { await app.close(); await outsider.app.close(); await deployer.app.close(); await owner.app.close(); }
    });
});
