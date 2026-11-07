import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import nacl from 'tweetnacl';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, computeDeploymentTransitionRequestDigestV1, encodePlainArtifactStoredContent,
    type DeploymentTransitionInputV1 } from '@happier-dev/protocol';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createAccountTokenForTests, createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedExternalActionPostHeadersForTests } from '@/testkit/externalActionExecution';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { readDeploymentAcceptedExecution } from './deploymentAcceptedExecution';
import { linkDeploymentTargetInTx } from './deploymentTargetLinkService';

describe('storage-only cancellation through the sole receipt transition route', () => {
    const serverId = `srv_${'d'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-deployment-cancel-', initEncrypt: true, initAuth: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: serverId, AUTH_REQUIRED_LOGIN_PROVIDERS: '',
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it.each(['platform', 'platform-retained-builder', 'own-server', 'own-server-alias'] as const)(
        'captures and settles %s from persisted target custody through signed HTTP', async target => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const keys = nacl.sign.keyPair();
        const machineId = crypto.randomUUID();
        const installationId = crypto.randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: owner.id, installationId,
            installationPublicKey: new Uint8Array(keys.publicKey), active: true,
            metadata: encodePlainMachineStoredContent({ host: 'platform-controller', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Target custody', audience: [],
        }));
        if (!source.ok) throw new Error(source.error);
        const artifact = async (kind: string) => {
            const created = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Target custody' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({})),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!created.ok) throw new Error(created.error);
            return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        // Retained builder configuration is not native authority for a plugin link.
        const staleBuilder = target === 'platform-retained-builder' ? await db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: owner.id, metadata: '{}', installationId: crypto.randomUUID(), revokedAt: new Date(),
        } }) : null;
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: owner.id, controllerMachineId: machineId, buildMachineId: staleBuilder?.id,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            ...await artifact('deployment-environment.v1') } });
        const native = target.startsWith('own-server');
        const linkContent = await artifact('deployment-target-link.v1');
        const linked = await inTx(tx => linkDeploymentTargetInTx(tx, owner.id, { serverId,
            environmentId: environment.id, expectedRevision: environment.revision, requestKey: crypto.randomUUID(), role: 'runtime',
            ...(native ? { targetId: target } : { targetId: 'platform-test', source: { kind: 'plugin' as const,
                contribution: { pluginId: 'deployment-platform-test', localId: 'runtime' } }, targetKind: 'platform' }),
            machines: native ? [{ machineId, installationId }] : [], ...linkContent }));
        if (!linked.ok) throw new Error(linked.error);
        const input = { serverId, environmentId: environment.id, expectedRevision: linked.revision,
            targetLinkId: linked.targetLinkId, expectedTargetLinkRevision: linked.targetLinkRevision,
            requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), ...await artifact('deployment-receipt.v1') };
        await withAuthenticatedTestApp(app => { registerExternalActionRoutes(app); registerDeploymentRoutes(app); }, async app => {
            const path = `/v1/deployments/environments/${environment.id}/deploy`;
            const { actionOperationId: _actionOperationId, ...actionInput } = input;
            const reserve = async () => app.inject({ method: 'POST', url: path, payload: input,
                headers: await createSignedExternalActionPostHeadersForTests(app, { accountId: owner.id, machineId, installationId,
                    privateKey: keys.secretKey, actionId: 'deployments.deploy', actionInput, path, body: input }) });
            if (native) {
                expect((await reserve()).statusCode).toBe(403);
                expect(await db.deployment.count({ where: { environmentId: environment.id } })).toBe(0);
                await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { buildMachineId: machineId } });
            }
            const admitted = await reserve();
            expect(admitted.statusCode, admitted.body).toBe(200);
            const receipt = await db.deployment.findUniqueOrThrow({ where: { id: admitted.json().deploymentId } });
            expect(readDeploymentAcceptedExecution(receipt)).toEqual({ v: 1,
                controller: { machineId, installationId }, ...(native ? { builder: { machineId, installationId } } : {}) });
            const seq = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
            expect((await reserve()).json()).toEqual(admitted.json());
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(seq);
            const token = await createAccountTokenForTests(owner.id, { kind: 'account', authority: 'present_user' });
            const transition = async (body: Omit<DeploymentTransitionInputV1, 'proof'>) => {
                const proof = signMachineInstallationProof({ payload: { version: 1, accountId: owner.id,
                    machineId: body.machineId, installationId: body.installationId,
                    deploymentTransition: { serverId, environmentId: environment.id, deploymentId: receipt.id,
                        expectedRevision: body.expectedRevision, actionOperationId: receipt.actionOperationId,
                        requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) } }, privateKey: keys.secretKey });
                return app.inject({ method: 'POST', url: `/v1/deployments/environments/${environment.id}/deployments/${receipt.id}/transitions`,
                    headers: { authorization: `Bearer ${token}` }, payload: { ...body, proof } });
            };
            const stage: Omit<DeploymentTransitionInputV1, 'proof'> = { serverId, environmentId: environment.id,
                deploymentId: receipt.id, expectedRevision: receipt.revision, actionOperationId: receipt.actionOperationId,
                machineId, installationId, kind: 'stage', state: 'running' };
            // The URL uses the existing sole receipt transition route.
            const running = await transition(stage);
            expect(running.statusCode, running.body).toBe(200);
            const nextController = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
                metadata: '{}', installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey) } });
            const reassigned = await app.inject({ method: 'POST', url: `/v1/deployments/environments/${environment.id}/controller`,
                headers: { authorization: `Bearer ${token}` }, payload: { serverId, environmentId: environment.id,
                    expectedRevision: admitted.json().revision, controllerMachineId: nextController.id } });
            expect(reassigned.statusCode, reassigned.body).toBe(200);
            const complete: Omit<DeploymentTransitionInputV1, 'proof'> = { ...stage, kind: 'settle', state: 'succeeded',
                expectedRevision: running.json().deploymentRevision,
                expectedTargetLinkRevision: linked.targetLinkRevision };
            const stale = await transition({ ...complete, expectedTargetLinkRevision: linked.targetLinkRevision + 1 });
            expect(stale.statusCode).toBe(409);
            const { expectedTargetLinkRevision: _expectedTargetLinkRevision, ...missingLinkRevision } = complete;
            expect((await transition(missingLinkRevision)).statusCode).toBe(409);
            const changedInstallation = await transition({ ...complete, installationId: crypto.randomUUID() });
            expect(changedInstallation.statusCode).toBe(403);
            expect((await transition({ ...complete, machineId: nextController.id,
                installationId: nextController.installationId! })).statusCode).toBe(403);
            expect((await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: linked.targetLinkId } })).activeDeploymentId).toBeNull();
            const settled = await transition(complete);
            expect(settled.statusCode, settled.body).toBe(200);
            expect(settled.json()).toMatchObject({ ok: true, state: 'succeeded' });
            const currentLink = await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: linked.targetLinkId } });
            expect(currentLink).toMatchObject({ activeDeploymentId: receipt.id, revision: linked.targetLinkRevision + 1 });
            const settledSeq = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
            expect((await transition(complete)).json()).toEqual(settled.json());
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(settledSeq);
            expect(await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: linked.targetLinkId } })).toEqual(currentLink);
        }, { authentication: 'real' });
    });

    it('releases the effect slot without a controller reply or any rewrite of protected member evidence', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const keys = nacl.sign.keyPair();
        const machineId = crypto.randomUUID();
        const installationId = crypto.randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: owner.id,
            metadata: encodePlainMachineStoredContent({ host: 'cancel-controller', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), installationId,
            installationPublicKey: new Uint8Array(keys.publicKey), active: true } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Cancel rollout', audience: [],
            repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'cancel/app', cloneUrl: 'https://github.com/cancel/app.git' }, protocol: 'https' },
        }));
        if (!source.ok) throw new Error(source.error);
        const artifact = async (kind: string, value: unknown) => {
            const result = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Private rollout' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent(value)),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!result.ok) throw new Error(result.error);
            return { contentArtifactId: result.artifact.id, contentHeaderVersion: result.artifact.headerVersion,
                contentBodyVersion: result.artifact.bodyVersion };
        };
        const environmentRef = await artifact('deployment-environment.v1', { private: 'unchanged' });
        const linkRef = await artifact('deployment-target-link.v1', {});
        const receiptRef = await artifact('deployment-receipt.v1', createDeploymentReceiptDetailV1().content);
        const environment = await db.deploymentEnvironment.create({ data: {
            projectSourceId: source.source.id, createdByAccountId: owner.id, protection: 'production', purpose: 'standard',
            deployerMode: 'managers', controllerMachineId: machineId, buildMachineId: machineId, ...environmentRef,
        } });
        const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
            createdByAccountId: owner.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'deployed', ...linkRef,
            machines: { create: [{ machineId, installationId, position: 0, state: 'active' }] },
        } });
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: link.id } });
        const uniform = await db.deployment.create({ data: { environmentId: environment.id, targetLinkId: link.id,
            operation: 'deploy', state: 'succeeded', requestKey: crypto.randomUUID(), requestedByAccountId: owner.id,
            actionOperationId: crypto.randomUUID(), ...receiptRef } });
        await db.deploymentTargetLink.update({ where: { id: link.id }, data: { activeDeploymentId: uniform.id } });
        await withAuthenticatedTestApp(app => {
            registerExternalActionRoutes(app);
            registerDeploymentRoutes(app);
        }, async app => {
            const token = await createAccountTokenForTests(owner.id, { kind: 'account', authority: 'present_user' });
            const outsiderToken = await createAccountTokenForTests(outsider.id, { kind: 'account', authority: 'present_user' });
            const headers = { authorization: `Bearer ${token}` };
            const deployPath = `/v1/deployments/environments/${environment.id}/deploy`;
            const reserve = async (input: Record<string, unknown>) => {
                const { actionOperationId: _actionOperationId, ...actionInput } = input;
                return app.inject({ method: 'POST', url: deployPath, payload: input,
                    headers: await createSignedExternalActionPostHeadersForTests(app, { accountId: owner.id,
                        machineId, installationId, privateKey: keys.secretKey, actionId: 'deployments.deploy',
                        actionInput, path: deployPath, body: input }) });
            };
            const admitted = await reserve({ serverId, environmentId: environment.id, expectedRevision: environment.revision,
                targetLinkId: link.id, expectedTargetLinkRevision: link.revision, requestKey: crypto.randomUUID(),
                actionOperationId: crypto.randomUUID(), ...receiptRef });
            expect(admitted.statusCode, admitted.body).toBe(200);
            const queued = await db.deployment.findUniqueOrThrow({ where: { id: admitted.json().deploymentId } });
            const path = `/v1/deployments/environments/${environment.id}/deployments/${queued.id}/transitions`;
            const transition = async (body: Omit<DeploymentTransitionInputV1, 'proof'>) => {
                const proof = signMachineInstallationProof({ payload: { version: 1, accountId: owner.id, machineId, installationId,
                    deploymentTransition: { serverId, environmentId: environment.id, deploymentId: queued.id,
                        expectedRevision: body.expectedRevision, actionOperationId: queued.actionOperationId,
                        requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) } }, privateKey: keys.secretKey });
                return app.inject({ method: 'POST', url: path, headers, payload: { ...body, proof } });
            };
            const running = await transition({ serverId, environmentId: environment.id, deploymentId: queued.id,
                expectedRevision: queued.revision, actionOperationId: queued.actionOperationId,
                machineId, installationId, kind: 'stage', state: 'running' });
            expect(running.statusCode, running.body).toBe(200);
            const receipt = await db.deployment.findUniqueOrThrow({ where: { id: queued.id } });
            expect(readDeploymentAcceptedExecution(receipt)).toEqual({ v: 1,
                controller: { machineId, installationId }, builder: { machineId, installationId } });
            // The receipt has genuine captured custody before its controller disappears.
            await db.machine.update({ where: { id: machineId }, data: { active: false } });
            const beforeArtifact = await db.artifact.findUniqueOrThrow({ where: { id: receiptRef.contentArtifactId } });
            const beforeMembers = await db.deploymentTargetLinkMachine.findMany({ where: { targetLinkId: link.id } });
            const body = { serverId, environmentId: environment.id, deploymentId: receipt.id,
                expectedReceiptRevision: receipt.revision, kind: 'cancel' };
            const denied = await app.inject({ method: 'POST', url: path,
                headers: { authorization: `Bearer ${outsiderToken}` }, payload: body });
            expect(denied.statusCode).toBe(404);
            const cancelled = await app.inject({ method: 'POST', url: path, headers, payload: body });
            expect(cancelled.statusCode, cancelled.body).toBe(200);
            expect(cancelled.json()).toMatchObject({ ok: true, deploymentId: receipt.id, state: 'outcome_unknown',
                deploymentRevision: receipt.revision + 1 });
            const after = await db.deployment.findUniqueOrThrow({ where: { id: receipt.id } });
            expect(after.cancelRequestedAt).toBeInstanceOf(Date);
            expect(after.settledAt).toBeNull();
            expect(await db.artifact.findUniqueOrThrow({ where: { id: receiptRef.contentArtifactId } })).toEqual(beforeArtifact);
            expect(await db.deploymentTargetLinkMachine.findMany({ where: { targetLinkId: link.id } })).toEqual(beforeMembers);
            expect((await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: link.id } })).activeDeploymentId).toBe(uniform.id);
            const sequence = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
            expect((await app.inject({ method: 'POST', url: path, headers, payload: body })).json()).toEqual(cancelled.json());
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(sequence);
            expect((await app.inject({ method: 'POST', url: path, headers,
                payload: { ...body, expectedReceiptRevision: 99 } })).json()).toEqual(cancelled.json());
            expect((await app.inject({ method: 'POST', url: path, headers,
                payload: { ...body, contentUpdate: { body: 'forged', expectedBodyVersion: 1 } } })).statusCode).toBe(400);
            const resumed: Omit<DeploymentTransitionInputV1, 'proof'> = { serverId, environmentId: environment.id,
                deploymentId: receipt.id, expectedRevision: after.revision, actionOperationId: receipt.actionOperationId,
                machineId, installationId, kind: 'stage', state: 'running' };
            expect((await transition(resumed)).statusCode).toBe(409);
            const next = await reserve({ serverId, environmentId: environment.id, expectedRevision: admitted.json().revision,
                targetLinkId: link.id, expectedTargetLinkRevision: link.revision, requestKey: crypto.randomUUID(),
                actionOperationId: crypto.randomUUID(), ...await artifact('deployment-receipt.v1', createDeploymentReceiptDetailV1().content) });
            expect(next.statusCode, next.body).toBe(200);
            expect((await transition(resumed)).statusCode).toBe(409);
            expect((await db.deployment.findUniqueOrThrow({ where: { id: next.json().deploymentId } })).state).toBe('queued');
            const native: Omit<DeploymentTransitionInputV1, 'proof'> = { serverId, environmentId: environment.id,
                deploymentId: receipt.id, expectedRevision: after.revision, actionOperationId: receipt.actionOperationId,
                machineId, installationId, kind: 'settle', state: 'succeeded',
                expectedTargetLinkRevision: link.revision };
            expect((await transition(native)).statusCode).toBe(409);
            expect((await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: link.id } })).activeDeploymentId).toBe(uniform.id);
            const { expectedTargetLinkRevision: _expectedTargetLinkRevision, ...stoppedBody } = native;
            const stopped = await transition({ ...stoppedBody, state: 'cancelled' });
            expect(stopped.statusCode, stopped.body).toBe(200);
            expect((await app.inject({ method: 'POST', url: path, headers,
                payload: { ...body, expectedReceiptRevision: 99 } })).json()).toEqual(stopped.json());
        }, { authentication: 'real' });
    });
});
