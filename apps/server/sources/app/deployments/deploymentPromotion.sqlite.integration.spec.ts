import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import * as privacyKit from 'privacy-kit';
import nacl from 'tweetnacl';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, computeDeploymentTransitionRequestDigestV1, encodePlainArtifactStoredContent, DeploymentPromoteAdmissionInputV1Schema,
    type DeploymentTransitionInputV1 } from '@happier-dev/protocol';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createAccountTokenForTests } from '@/testkit/lightSqliteHarness';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';
import { auth } from '@/app/auth/auth';
import { initEncrypt } from '@/modules/encrypt';
import { createSignedExternalActionPostHeadersForTests } from '@/testkit/externalActionExecution';
import { db } from '@/storage/db';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { inTx } from '@/storage/inTx';
import { createDeploymentEnvironmentInTx } from './deploymentEnvironmentService';
import { linkDeploymentTargetInTx } from './deploymentTargetLinkService';
import { readDeploymentAcceptedExecution } from './deploymentAcceptedExecution';
import { promoteDeploymentInTx } from './deploymentPromotionService';
import { transitionDeploymentInTx } from './deploymentService';
import { observePrismaRequests } from '@/testkit/observeSqliteRequests';
import { encodeExternalActionResolvedTargetV1, signExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';

describe('stored promotion storage composition', () => {
    const serverId = `srv_${'a'.repeat(32)}`;
    const repository = { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
        repository: { nameWithOwner: 'owner/promotion', cloneUrl: 'https://github.com/owner/promotion.git' }, protocol: 'https' };
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
    beforeAll(async () => { harness = await createDatabaseIntegrationHarness({ tempDirPrefix: 'happier-promotion-',
        env: { HAPPIER_SERVER_IDENTITY_ID: serverId, AUTH_REQUIRED_LOGIN_PROVIDERS: '',
            HANDY_MASTER_SECRET: 'happier-disposable-promotion-contract-master',
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
        await auth.init();
        await initEncrypt();
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it('refuses a readable Source audience member without deploy permission before opening any destination', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, reader.id);
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId, requestKey: randomUUID(),
            name: 'Readable source', repository, audience: [{ principal: { kind: 'account', accountId: reader.id }, level: 'view' }] }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: '{}', installationId: randomUUID() } });
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Source' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({})),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const content = { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: owner.id, controllerMachineId: machine.id, protection: 'nonProduction', purpose: 'standard',
            deployerMode: 'managers', ...content } });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v1/deployments/environments/destination/promote',
                headers: { 'x-test-user-id': reader.id }, payload: { serverId, environmentId: 'destination', expectedRevision: 1,
                    targetLinkId: 'destination-link', expectedTargetLinkRevision: 1, requestKey: randomUUID(), actionOperationId: randomUUID(),
                    sourceEnvironmentId: environment.id, sourceDeploymentId: 'retained-receipt',
                    artifact: 'image', destinationContent: content, ...content } });
            expect(response.statusCode, response.body).toBe(403);
            expect(response.json()).toEqual({ ok: false, error: 'deployment_access_denied' });
        });
    });

    async function promotionFixture() {
        const keys = nacl.sign.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId, requestKey: randomUUID(),
            name: 'Promotion', repository, audience: [] }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: encodePlainMachineStoredContent({ host: 'promotion-controller', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            installationId: randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey) } });
        const artifact = async (kind: string, content: unknown) => {
            const created = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Promotion fixture' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(content) })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!created.ok) throw new Error(created.error);
            return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const definition = (document: string, contentRevision: number) => ({ kind: 'stored' as const, document, contentRevision,
            composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['app'] });
        const sourceDefinition = definition('{"services":{"app":{"image":"example/app:X"}}}', 19);
        const current = createDeploymentEnvironmentDetailV1().content;
        current.definition = definition('{"services":{"app":{"image":"example/app:A"}}}', 3);
        current.bindings = [{ purpose: 'variable', name: 'DESTINATION', phase: 'runtime', source: { kind: 'value', value: 'production' } }];
        current.ownServer = { rollout: 'startFirst', autoRestorePreviousRelease: false };
        const createEnvironment = async (content: typeof current) => {
            const environmentArtifact = await artifact('deployment-environment.v1', content);
            const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, { serverId, requestKey: randomUUID(),
                projectSourceId: source.source.id, controllerMachineId: machine.id, buildMachineId: machine.id,
                protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', ...environmentArtifact }));
            if (!created.ok) throw new Error(created.error);
            const linkArtifact = await artifact('deployment-target-link.v1', {});
            const linked = await inTx(tx => linkDeploymentTargetInTx(tx, owner.id, { serverId, environmentId: created.environmentId,
                expectedRevision: created.revision, requestKey: randomUUID(), targetId: 'own-server', role: 'runtime',
                machines: [{ machineId: machine.id, installationId: machine.installationId! }], ...linkArtifact }));
            if (!linked.ok) throw new Error(linked.error);
            return linked;
        };
        const from = await createEnvironment({ ...current, definition: sourceDefinition });
        const to = await createEnvironment(current);
        const receiptContent = createDeploymentReceiptDetailV1().content;
        receiptContent.sourceIntent = sourceDefinition;
        receiptContent.machines = [machine.id]; receiptContent.buildMachineId = machine.id; receiptContent.machineResults = [];
        const retained = await db.deployment.create({ data: { environmentId: from.environmentId, targetLinkId: from.targetLinkId,
            operation: 'deploy', state: 'succeeded', requestKey: randomUUID(), requestedByAccountId: owner.id,
            actionOperationId: randomUUID(), ...await artifact('deployment-receipt.v1', receiptContent) } });
        const serving = await db.deployment.create({ data: { environmentId: to.environmentId, targetLinkId: to.targetLinkId,
            operation: 'deploy', state: 'succeeded', requestKey: randomUUID(), requestedByAccountId: owner.id,
            actionOperationId: randomUUID(), ...await artifact('deployment-receipt.v1', { ...receiptContent, sourceIntent: current.definition }) } });
        await db.deploymentTargetLink.update({ where: { id: to.targetLinkId }, data: { activeDeploymentId: serving.id } });
        const candidate = { ...current, definition: { ...sourceDefinition, contentRevision: 4 } };
        const destinationContent = await artifact('deployment-environment.v1', candidate);
        const input = { serverId, environmentId: to.environmentId, expectedRevision: to.revision,
            targetLinkId: to.targetLinkId, expectedTargetLinkRevision: to.targetLinkRevision,
            requestKey: randomUUID(), actionOperationId: randomUUID(), sourceEnvironmentId: from.environmentId,
            sourceDeploymentId: retained.id,
            artifact: 'image', destinationContent, ...await artifact('deployment-receipt.v1', {
                ...receiptContent, sourceIntent: candidate.definition }) };
        return { owner, machine, keys, to, retained, serving, destinationContent, input };
    }

    it('spends compact Promote source reads through the real signed HTTP decider without admitting unrelated Environments', async () => {
        const { owner, machine, keys, to, input } = await promotionFixture();
        await withAuthenticatedTestApp(app => { registerExternalActionRoutes(app); registerDeploymentRoutes(app); }, async app => {
            const actionId = 'deployments.promote';
            const token = await createAccountTokenForTests(owner.id, { kind: 'account', authority: 'present_user' });
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: 'Bearer ' + token }, payload: { v: 1, machineId: machine.id,
                    envelope: { v: 1, requestId: randomUUID(), target: { kind: 'machine', machineId: machine.id },
                        input: { serverId, environmentId: to.environmentId, sourceEnvironmentId: input.sourceEnvironmentId,
                            sourceDeploymentId: input.sourceDeploymentId, artifact: 'image', requestKey: randomUUID() } } } });
            expect(minted.statusCode, minted.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const read = async (effectActionId: string, path: string) => app.inject({ method: 'GET', url: path, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                    effectActionId, target: root.binding.target, installationId: machine.installationId!,
                    requestId: root.binding.requestId, method: 'GET', path, privateKey: keys.secretKey }),
            } });
            for (const [effect, path] of [
                ['deployments.environments.get', '/v1/deployments/environments/' + input.sourceEnvironmentId + '?serverId=' + serverId],
                ['deployments.receipts.get', '/v1/deployments/receipts/' + input.sourceDeploymentId + '?serverId=' + serverId + '&environmentId=' + input.sourceEnvironmentId],
                ['deployments.receipts.get', '/v1/deployments/receipts/' + input.sourceDeploymentId + '?serverId=' + serverId],
                ['deployments.environments.get', '/v1/deployments/environments/' + to.environmentId + '?serverId=' + serverId],
            ]) {
                const response = await read(effect!, path!);
                expect.soft(response.statusCode, response.body).toBe(200);
            }
            const sourceReceipt = await db.deployment.findUniqueOrThrow({ where: { id: input.sourceDeploymentId } });
            const sibling = await db.deployment.create({ data: { environmentId: input.sourceEnvironmentId,
                targetLinkId: sourceReceipt.targetLinkId, operation: 'deploy', state: 'succeeded', requestKey: randomUUID(),
                requestedByAccountId: owner.id, actionOperationId: randomUUID(), contentArtifactId: sourceReceipt.contentArtifactId,
                contentHeaderVersion: sourceReceipt.contentHeaderVersion, contentBodyVersion: sourceReceipt.contentBodyVersion } });
            const unrelatedReceipt = await read('deployments.receipts.get', '/v1/deployments/receipts/' + sibling.id + '?serverId=' + serverId);
            expect(unrelatedReceipt.statusCode, unrelatedReceipt.body).toBe(401);
            const other = await promotionFixture();
            const refused = await read('deployments.environments.get', '/v1/deployments/environments/' + other.to.environmentId + '?serverId=' + serverId);
            expect(refused.statusCode, refused.body).toBe(401);
            const foreignSource = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: 'Bearer ' + token }, payload: { v: 1, machineId: machine.id,
                    envelope: { v: 1, requestId: randomUUID(), target: { kind: 'machine', machineId: machine.id },
                        input: { serverId, environmentId: to.environmentId, sourceEnvironmentId: other.input.sourceEnvironmentId,
                            sourceDeploymentId: other.input.sourceDeploymentId, artifact: 'image', requestKey: randomUUID() } } } });
            expect(foreignSource.statusCode, foreignSource.body).toBe(403);
            expect(foreignSource.json()).toMatchObject({ error: 'credential_scope_denied' });
        }, { authentication: 'real' });
    });

    it('admits promotion resources once and opens receipt content only for a content update', async () => {
        const { owner, machine, keys, to, input } = await promotionFixture();
        await withAuthenticatedTestApp(registerExternalActionRoutes, async app => {
            const token = await createAccountTokenForTests(owner.id, { kind: 'account', authority: 'present_user' });
            const { actionOperationId: _operation, ...actionInput } = input;
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('deployments.promote'),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: machine.id,
                    envelope: { v: 1, requestId: randomUUID(), target: { kind: 'machine', machineId: machine.id }, input: actionInput } } });
            expect(minted.statusCode, minted.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(await inTx(tx => promoteDeploymentInTx(tx, owner.id, DeploymentPromoteAdmissionInputV1Schema.parse(input), {},
                { ...root.binding, installationId: randomUUID() }))).toMatchObject({ ok: false, error: 'machine_unavailable', role: 'controller' });
            expect(await db.deployment.count({ where: { environmentId: to.environmentId, operation: 'promote' } })).toBe(0);
            const queries: string[] = [];
            const stop = observePrismaRequests(db, { before: request => { queries.push(`${request.model}.${request.action}`); } });
            try {
                const result = await inTx(tx => promoteDeploymentInTx(tx, owner.id, DeploymentPromoteAdmissionInputV1Schema.parse(input), {}, root.binding));
                expect(result).toMatchObject({ ok: true, state: 'queued' });
                if (!result.ok || !('deploymentId' in result)) throw new Error('Expected admitted promotion');
                expect.soft(queries.filter(query => query === 'ProjectSource.findUnique'), 'source and destination each admit Source access once').toHaveLength(2);
                // Two decisions, each one set read plus one permission read: the receipt's Source-custody admission,
                // and the definition write's admission of the person's own Machine authority (717576ac290).
                expect.soft(queries.filter(query => query === 'Machine.findMany'), 'receipt and definition admissions each read the set once').toHaveLength(4);
                const receipt = await db.deployment.findUniqueOrThrow({ where: { id: result.deploymentId } });
                const transition = async (contentUpdate?: DeploymentTransitionInputV1['contentUpdate']) => {
                    const body: Omit<DeploymentTransitionInputV1, 'proof'> = { serverId, environmentId: to.environmentId,
                        deploymentId: receipt.id, actionOperationId: receipt.actionOperationId, expectedRevision: receipt.revision,
                        machineId: machine.id, installationId: machine.installationId!, kind: 'stage', state: 'running',
                        ...(contentUpdate ? { contentUpdate } : {}) };
                    const proof = signMachineInstallationProof({ payload: { version: 1, accountId: owner.id,
                        machineId: machine.id, installationId: machine.installationId!, deploymentTransition: {
                            serverId, environmentId: to.environmentId, deploymentId: receipt.id, expectedRevision: receipt.revision,
                            actionOperationId: receipt.actionOperationId, requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) } },
                        privateKey: keys.secretKey });
                    queries.length = 0;
                    return inTx(tx => transitionDeploymentInTx(tx, owner.id, { ...body, proof }));
                };
                const refused = await transition({ body: encodePlainArtifactStoredContent({ body: '{}' }), expectedBodyVersion: 2 });
                expect(refused).toEqual({ ok: false, error: 'deployment_conflict' });
                expect(queries.some(query => query.startsWith('Artifact.')), 'content changes still enter Artifact admission').toBe(true);
                const running = await transition();
                expect(running).toMatchObject({ ok: true, state: 'running' });
                expect.soft(queries.filter(query => query.startsWith('Artifact.')), 'stage-only transition reuses pinned content').toHaveLength(0);
                expect(await db.deployment.findUniqueOrThrow({ where: { id: receipt.id } })).toMatchObject({
                    state: 'running', contentArtifactId: receipt.contentArtifactId, contentBodyVersion: receipt.contentBodyVersion });
            } finally { stop(); }
        }, { authentication: 'real' });
    });

    it('leaves the destination candidate unchanged when an ordinary deploy already owns the receipt slot', async () => {
        const { owner, to, serving, input } = await promotionFixture();
        const incumbent = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: to.environmentId } });
        const queued = await db.deployment.create({ data: { environmentId: to.environmentId, targetLinkId: to.targetLinkId,
            operation: 'deploy', state: 'queued', requestKey: randomUUID(), requestedByAccountId: owner.id,
            actionOperationId: randomUUID(), contentArtifactId: input.contentArtifactId,
            contentHeaderVersion: input.contentHeaderVersion, contentBodyVersion: input.contentBodyVersion } });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: `/v1/deployments/environments/${to.environmentId}/promote`,
                headers: { 'x-test-user-id': owner.id }, payload: input });
            expect(response.statusCode, response.body).toBe(409);
            expect(response.json()).toMatchObject({ ok: false, error: 'deployment_in_progress', deploymentId: queued.id });
            expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: to.environmentId } })).toEqual(incumbent);
            expect((await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: to.targetLinkId } })).activeDeploymentId).toBe(serving.id);
            expect(await db.deployment.count({ where: { environmentId: to.environmentId, operation: 'promote' } })).toBe(0);
        });
    });

    it('promotes an immutable receipt after the source Environment changes and retains its destination candidate after activation fails', async () => {
        const { owner, machine, keys, to, retained, serving, destinationContent, input } = await promotionFixture();
        await db.deploymentEnvironment.update({ where: { id: input.sourceEnvironmentId }, data: { revision: { increment: 1 } } });
        await withAuthenticatedTestApp(app => {
            registerExternalActionRoutes(app);
            registerDeploymentRoutes(app);
        }, async app => {
            const token = await createAccountTokenForTests(owner.id, { kind: 'account', authority: 'present_user' });
            const headers = { authorization: `Bearer ${token}` };
            const path = `/v1/deployments/environments/${to.environmentId}/promote`;
            const { actionOperationId: _actionOperationId, ...actionInput } = input;
            const promote = async () => app.inject({ method: 'POST', url: path,
                headers: await createSignedExternalActionPostHeadersForTests(app, { accountId: owner.id,
                    machineId: machine.id, installationId: machine.installationId!, privateKey: keys.secretKey,
                    actionId: 'deployments.promote', actionInput, path, body: input }), payload: input });
            const response = await promote();
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ ok: true, state: 'queued' });
            const receipt = await db.deployment.findUniqueOrThrow({ where: { id: response.json().deploymentId } });
            expect(receipt).toMatchObject({ operation: 'promote', promotedFromDeploymentId: retained.id, predecessorDeploymentId: serving.id });
            const read = await app.inject({ method: 'GET',
                url: `/v1/deployments/environments/${to.environmentId}/deployments/${receipt.id}?serverId=${serverId}`,
                headers });
            expect(read.statusCode, read.body).toBe(200);
            expect(read.json()).toMatchObject({ ok: true, deployment: {
                promotedFromDeploymentId: retained.id, predecessorDeploymentId: serving.id } });
            const destination = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: to.environmentId } });
            expect(readDeploymentAcceptedExecution(receipt)).toEqual({ v: 1,
                controller: { machineId: machine.id, installationId: machine.installationId },
                builder: { machineId: machine.id, installationId: machine.installationId } });
            expect(destination).toMatchObject({ ...destinationContent, revision: to.revision + 2,
                controllerMachineId: machine.id, buildMachineId: machine.id });
            expect((await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: to.targetLinkId } })).activeDeploymentId).toBe(serving.id);
            expect((await promote()).json()).toEqual(response.json());
            expect(await db.deployment.count({ where: { environmentId: to.environmentId, operation: 'promote' } })).toBe(1);
            const transition = async (state: 'running' | 'failed', expectedRevision: number) => {
                const body: Omit<DeploymentTransitionInputV1, 'proof'> = { serverId, environmentId: to.environmentId,
                    deploymentId: receipt.id, expectedRevision, actionOperationId: receipt.actionOperationId,
                    machineId: machine.id, installationId: machine.installationId!,
                    kind: state === 'running' ? 'stage' : 'settle', state };
                const proof = signMachineInstallationProof({ payload: { version: 1, accountId: owner.id,
                    machineId: machine.id, installationId: machine.installationId!, deploymentTransition: {
                        serverId, environmentId: to.environmentId, deploymentId: receipt.id, expectedRevision,
                        actionOperationId: receipt.actionOperationId, requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) } },
                    privateKey: keys.secretKey });
                const result = await app.inject({ method: 'POST',
                    url: `/v1/deployments/environments/${to.environmentId}/deployments/${receipt.id}/transitions`,
                    headers, payload: { ...body, proof } });
                expect(result.statusCode, result.body).toBe(200);
                return result.json();
            };
            const running = await transition('running', receipt.revision);
            await transition('failed', running.deploymentRevision);
            expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: to.environmentId } })).toEqual(destination);
            expect((await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: to.targetLinkId } })).activeDeploymentId).toBe(serving.id);
            expect(await db.deployment.findUniqueOrThrow({ where: { id: receipt.id } })).toMatchObject({
                state: 'failed', promotedFromDeploymentId: retained.id, predecessorDeploymentId: serving.id });
        }, { authentication: 'real' });
    });
});
