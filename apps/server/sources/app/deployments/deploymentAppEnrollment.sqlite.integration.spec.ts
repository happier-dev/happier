import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent,
    encodePlainMachineStoredContent, createPluginInstallationManifestPublisherSigningInputV1,
    PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1, stringifyPluginInstallationManifestCanonicalJsonV1,
    signMachineInstallationProof, sealTerminalProvisioningV3TokenOnlyPayload } from '@happier-dev/protocol';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { currentAccountStoredContentCompatibilityHeaders } from '@/app/api/testkit/accountStoredContentCompatibility';
import { registerTerminalAuthRequestRoutes } from '@/app/api/routes/auth/registerTerminalAuthRequestRoutes';
import { resolveTerminalAuthRequestPolicyFromEnv } from '@/app/api/routes/auth/terminalAuthRequestPolicy';
import { observePrismaRequests } from '@/testkit/observeSqliteRequests';

describe('deployment App enrollment through ordinary registration', () => {
    const homeId = `srv_${'c'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-app-enrollment-', initAuth: true,
            initEncrypt: true, env: { HAPPIER_SERVER_IDENTITY_ID: homeId } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it('binds the admitted requester and receipt, then links only that Account’s installed child Machine', async () => {
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const keys = nacl.sign.keyPair();
        const controller = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
            installationId: randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey), metadata: '{}' } });
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: custodian.id,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ title: 'App' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: '{}' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        const reference = { contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const source = await db.projectSource.create({ data: { id: randomUUID(), createdByAccountId: custodian.id,
            name: 'Collector', owner: { kind: 'account', accountId: custodian.id }, audience: [], attachments: [] } });
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.id,
            createdByAccountId: custodian.id, controllerMachineId: controller.id, protection: 'nonProduction',
            purpose: 'standard', deployerMode: 'managers', ...reference } });
        const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
            createdByAccountId: custodian.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'configured', ...reference } });
        const receipt = await db.deployment.create({ data: { environmentId: environment.id, targetLinkId: link.id,
            requestedByAccountId: requester.id, requestKey: randomUUID(), actionOperationId: randomUUID(),
            operation: 'deploy', state: 'running', acceptedControllerMachineId: controller.id,
            acceptedControllerInstallationId: controller.installationId, ...reference } });
        const enrollment = { source: 'deploymentApp', homeId, environmentId: environment.id, deploymentId: receipt.id,
            actionOperationId: receipt.actionOperationId, controller: { machineId: controller.id,
                installationId: controller.installationId! } };
        const path = `/v1/deployments/environments/${environment.id}/deployments/${receipt.id}/app-enrollment`;
        const bearer = await auth.createToken(custodian.id, undefined, { kind: 'account', authority: 'present_user' });
        const requesterBearer = await auth.createToken(requester.id, undefined, { kind: 'account', authority: 'present_user' });
        const custodianPresentBearer = await auth.createToken(custodian.id, undefined, { kind: 'account', authority: 'present_user' });
        const publisher = (body: unknown, requestPath = path) => {
            const proof = { v: 1 as const, alg: 'ed25519-machine-installation-v1' as const,
                machineId: controller.id, installationId: controller.installationId!, issuedAt: Date.now(), nonce: randomUUID(),
                method: 'POST' as const, path: requestPath, bodySha256Base64Url: createHash('sha256')
                    .update(stringifyPluginInstallationManifestCanonicalJsonV1(body)).digest('base64url') };
            const signature = nacl.sign.detached(createPluginInstallationManifestPublisherSigningInputV1({ proof }), keys.secretKey);
            return encodeBase64(new TextEncoder().encode(JSON.stringify({ proof: { ...proof,
                signatureBase64Url: encodeBase64(signature, 'base64url') } })), 'base64url');
        };
        await withAuthenticatedTestApp(app => {
            registerDeploymentRoutes(app); machinesRoutes(app);
            const terminalAuthPolicy = resolveTerminalAuthRequestPolicyFromEnv({});
            registerTerminalAuthRequestRoutes(app, { terminalAuthPolicy,
                isTerminalAuthExpired: createdAt => Date.now() - createdAt.getTime() > terminalAuthPolicy.ttlMs });
        }, async app => {
            const controlKeys = nacl.sign.keyPair(), controlId = randomUUID(), controlInstallationId = randomUUID();
            const control = await app.inject({ method: 'POST', url: '/v1/machines',
                headers: { ...currentAccountStoredContentCompatibilityHeaders, authorization: `Bearer ${requesterBearer}` },
                payload: { id: controlId, metadata: encodePlainMachineStoredContent({ host: 'Control', platform: 'linux',
                    happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
                    dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, installationId: controlInstallationId,
                    installationPublicKey: encodeBase64(controlKeys.publicKey, 'base64url'),
                    installationProof: signMachineInstallationProof({ payload: { version: 1, machineId: controlId,
                        installationId: controlInstallationId, accountId: requester.id }, privateKey: controlKeys.secretKey }) } });
            expect(control.statusCode, control.body).toBe(200);
            const reads: { model?: string; action: string }[] = [];
            const stopObserving = observePrismaRequests(db, { before: read => { reads.push(read); } });
            try {
                const ordinary = await app.inject({ method: 'GET', url: `/v1/machines/${controlId}`,
                    headers: { ...currentAccountStoredContentCompatibilityHeaders, authorization: `Bearer ${requesterBearer}` } });
                expect(ordinary.statusCode, ordinary.body).toBe(200);
                expect(reads.filter(read => read.model === 'Deployment')).toHaveLength(0);
            } finally { stopObserving(); }
            const admit = (body: unknown = enrollment, signed = true, url = path) => app.inject({ method: 'POST', url, payload: body,
                headers: { authorization: `Bearer ${bearer}`,
                    ...(signed ? { [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: publisher(body, url) } : {}) } });
            const accepted = await admit();
            expect(accepted.statusCode, accepted.body).toBe(200);
            expect(accepted.json()).toMatchObject({ ok: true, enrollment, enrollmentAccountId: requester.id });
            expect((await admit(enrollment, false)).statusCode).toBe(403);
            const pairing = nacl.box.keyPair(), pairingPublicKey = privacyKit.encodeBase64(pairing.publicKey);
            const claimSecret = randomBytes(32).toString('base64url');
            expect((await app.inject({ method: 'POST', url: '/v1/auth/request', payload: { publicKey: pairingPublicKey,
                supportsV2: true, claimSecretHash: createHash('sha256').update(Buffer.from(claimSecret, 'base64url')).digest('base64url') } })).statusCode).toBe(200);
            const binding = { ...enrollment, pairingPublicKey };
            expect((await admit(binding)).statusCode).toBe(200);
            expect((await admit({ ...enrollment, existingMachineId: controlId })).statusCode).toBe(409);
            const redeploy = await db.deployment.create({ data: { environmentId: environment.id, targetLinkId: link.id,
                requestedByAccountId: requester.id, requestKey: randomUUID(), actionOperationId: randomUUID(),
                operation: 'deploy', state: 'running', acceptedControllerMachineId: controller.id,
                acceptedControllerInstallationId: controller.installationId, ...reference } });
            const nextEnrollment = { ...enrollment, deploymentId: redeploy.id, actionOperationId: redeploy.actionOperationId };
            const nextPath = `/v1/deployments/environments/${environment.id}/deployments/${redeploy.id}/app-enrollment`;
            expect((await admit({ ...nextEnrollment, pairingPublicKey }, true, nextPath)).statusCode).toBe(409);
            const response = privacyKit.encodeBase64(sealTerminalProvisioningV3TokenOnlyPayload({
                terminalEphemeralPublicKey: pairing.publicKey, pairingSecret: randomBytes(32), createdAtMs: Date.now(),
                expiresAtMs: Date.now() + 60_000, randomBytes: length => randomBytes(length) }));
            const approve = (token: string) => app.inject({ method: 'POST', url: '/v1/auth/response',
                headers: { authorization: `Bearer ${token}` }, payload: { publicKey: pairingPublicKey, response, responseKind: 'tokenOnly' } });
            const wrongApproval = await approve(custodianPresentBearer);
            expect(wrongApproval.statusCode).toBe(409);
            expect(wrongApproval.json()).toEqual({ error: 'enrollment_unavailable' });
            const approval = await approve(requesterBearer);
            expect(approval.statusCode, approval.body).toBe(200);
            const claimed = await app.inject({ method: 'POST', url: '/v1/auth/request/claim', payload: { publicKey: pairingPublicKey, claimSecret } });
            expect(claimed.statusCode, claimed.body).toBe(200);
            const terminalBearer = claimed.json().token as string;
            const childKeys = nacl.sign.keyPair();
            const childId = randomUUID(), installationId = randomUUID();
            const register = async (accountId: string, token: string) => app.inject({ method: 'POST', url: '/v1/machines',
                headers: { ...currentAccountStoredContentCompatibilityHeaders, authorization: `Bearer ${token}` },
                payload: { id: childId, metadata: encodePlainMachineStoredContent({ host: 'Collector', platform: 'linux',
                    happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
                    dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, installationId,
                    installationPublicKey: encodeBase64(childKeys.publicKey, 'base64url'),
                    installationProof: signMachineInstallationProof({ payload: { version: 1, machineId: childId,
                        installationId, accountId }, privateKey: childKeys.secretKey }), managedEnrollment: enrollment } });
            expect((await register(custodian.id, bearer)).statusCode).toBe(409);
            expect((await register(requester.id, requesterBearer)).statusCode).toBe(409);
            expect(await db.machine.findUnique({ where: { id: childId } })).toBeNull();
            const enrolled = await register(requester.id, terminalBearer);
            expect(enrolled.statusCode, enrolled.body).toBe(200);
            await db.terminalAuthRequest.deleteMany({ where: { publicKey: privacyKit.encodeHex(pairing.publicKey) } });
            await db.deployment.update({ where: { id: receipt.id }, data: { state: 'succeeded' } });
            expect((await register(requester.id, terminalBearer)).statusCode).toBe(200);
            await db.deployment.update({ where: { id: receipt.id }, data: { state: 'running' } });
            expect((await admit({ ...enrollment, existingMachineId: childId })).json()).toMatchObject({ ok: true, machineId: childId });
            reads.length = 0;
            const stopAppObserving = observePrismaRequests(db, { before: read => { reads.push(read); } });
            const published = await (async () => {
                try {
                    return await app.inject({ method: 'GET', url: `/v1/machines/${childId}`,
                        headers: { ...currentAccountStoredContentCompatibilityHeaders, authorization: `Bearer ${terminalBearer}` } });
                } finally { stopAppObserving(); }
            })();
            expect(published.statusCode, published.body).toBe(200);
            expect(reads.filter(read => read.model === 'Deployment' && read.action === 'findMany')).toHaveLength(1);
            expect(published.json().machine.deploymentApp).toEqual({ environmentId: environment.id,
                deploymentId: receipt.id, targetLinkId: link.id, controller: enrollment.controller });
            const { readDeploymentAppEnrollmentForMachineInTx } = await import('./deploymentAppEnrollment');
            const { inTx } = await import('@/storage/inTx');
            expect(await inTx(tx => readDeploymentAppEnrollmentForMachineInTx(tx, { machineId: childId })))
                .toMatchObject({ environmentId: environment.id, deploymentId: receipt.id, targetLinkId: link.id,
                    controller: enrollment.controller });
            const otherEnvironment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.id,
                createdByAccountId: custodian.id, controllerMachineId: controller.id, protection: 'nonProduction',
                purpose: 'standard', deployerMode: 'managers', ...reference } });
            const otherLink = await db.deploymentTargetLink.create({ data: { environmentId: otherEnvironment.id,
                createdByAccountId: custodian.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
                targetKind: 'ownServer', state: 'configured', ...reference } });
            const otherReceipt = await db.deployment.create({ data: { environmentId: otherEnvironment.id, targetLinkId: otherLink.id,
                requestedByAccountId: requester.id, requestKey: randomUUID(), actionOperationId: randomUUID(),
                operation: 'deploy', state: 'running', acceptedControllerMachineId: controller.id,
                acceptedControllerInstallationId: controller.installationId, ...reference } });
            const otherEnrollment = { ...enrollment, environmentId: otherEnvironment.id, deploymentId: otherReceipt.id,
                actionOperationId: otherReceipt.actionOperationId, existingMachineId: childId };
            expect((await admit(otherEnrollment, true,
                `/v1/deployments/environments/${otherEnvironment.id}/deployments/${otherReceipt.id}/app-enrollment`)).statusCode).toBe(409);
            const rebound = await admit({ ...nextEnrollment, existingMachineId: childId }, true, nextPath);
            expect(rebound.statusCode, rebound.body).toBe(200);
            expect(rebound.json()).toMatchObject({ ok: true, machineId: childId });
            expect(await inTx(tx => readDeploymentAppEnrollmentForMachineInTx(tx, { machineId: childId })))
                .toMatchObject({ deploymentId: redeploy.id });
            await db.deployment.update({ where: { id: receipt.id }, data: { cancelRequestedAt: new Date() } });
            expect((await admit()).statusCode).toBe(409);
        }, { authentication: 'real' });
    });
});
