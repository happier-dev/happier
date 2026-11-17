import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent,
    encodePlainMachineStoredContent, createPluginInstallationManifestPublisherSigningInputV1,
    PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1, stringifyPluginInstallationManifestCanonicalJsonV1,
    signMachineInstallationProof, sealTerminalProvisioningV3TokenOnlyPayload,
    computeDeploymentTransitionRequestDigestV1, type DeploymentTransitionInputV1 } from '@happier-dev/protocol';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { db, initDbPostgres, initDbMysql } from '@/storage/db';
import { initEncrypt } from '@/modules/encrypt';
import { auth } from '@/app/auth/auth';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { currentAccountStoredContentCompatibilityHeaders } from '@/app/api/testkit/accountStoredContentCompatibility';
import { registerTerminalAuthRequestRoutes } from '@/app/api/routes/auth/registerTerminalAuthRequestRoutes';
import { resolveTerminalAuthRequestPolicyFromEnv } from '@/app/api/routes/auth/terminalAuthRequestPolicy';
import { observePrismaRequests } from '@/testkit/observeSqliteRequests';
import { io as ioClient } from 'socket.io-client';
import { startSocket } from '@/app/api/socket';
import { stopLocalMachinePresenceTimeout } from '@/app/presence/timeout';

describe('deployment App enrollment through ordinary registration', () => {
    const homeId = `srv_${'c'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        if (process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID) {
            const provider = process.env.HAPPIER_DB_PROVIDER;
            const target = provider === 'postgres' ? process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
                : provider === 'mysql' ? process.env.HAPPIER_TEST_MYSQL_DATABASE_URL : undefined;
            if (!target || process.env.DATABASE_URL !== target) throw new Error('Run with the disposable native DB-contract harness');
            process.env.HAPPIER_SERVER_IDENTITY_ID = homeId;
            process.env.HANDY_MASTER_SECRET ??= 'app-enrollment-disposable-contract';
            if (provider === 'postgres') initDbPostgres();
            else await initDbMysql();
            await db.$connect();
            await auth.init();
            await initEncrypt();
            return;
        }
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-app-enrollment-', initAuth: true,
            initEncrypt: true, env: { HAPPIER_SERVER_IDENTITY_ID: homeId } });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); else await db.$disconnect(); });

    it.each(['teardown', 'delete'] as const)('binds the requester’s App on another member’s host and revokes its Account credential on %s', async disposition => {
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const keys = nacl.sign.keyPair();
        const controller = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
            installationId: randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey),
            metadata: encodePlainMachineStoredContent({ host: 'Controller', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
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
            targetKind: 'ownServer', machineId: controller.id, installationId: controller.installationId,
            state: 'configured', ...reference } });
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: link.id } });
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
        const ordinaryTerminalBearer = await auth.createToken(requester.id, { session: randomUUID() },
            { kind: 'terminal', authority: 'account_automation' });
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
        const sockets: ReturnType<typeof ioClient>[] = [];
        let closeSocketServer: (() => Promise<void>) | undefined;
        await withAuthenticatedTestApp(app => {
            closeSocketServer = startSocket(app);
            registerDeploymentRoutes(app); machinesRoutes(app);
            const terminalAuthPolicy = resolveTerminalAuthRequestPolicyFromEnv({});
            registerTerminalAuthRequestRoutes(app, { terminalAuthPolicy,
                isTerminalAuthExpired: createdAt => Date.now() - createdAt.getTime() > terminalAuthPolicy.ttlMs });
        }, async app => {
            try {
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
            const pairingRequest = await db.terminalAuthRequest.findUniqueOrThrow({ where: { publicKey: privacyKit.encodeHex(pairing.publicKey) } });
            const preMarkerBearer = await auth.createToken(requester.id, { session: pairingRequest.id },
                { kind: 'terminal', authority: 'account_automation' });
            await app.listen({ port: 0, host: '127.0.0.1' });
            const address = app.server.address();
            if (!address || typeof address === 'string') throw new Error('Missing socket listener');
            const connect = async (token: string) => {
                const socket = ioClient(`http://127.0.0.1:${address.port}`, { path: '/v1/updates',
                    transports: ['websocket'], reconnection: false, autoConnect: false,
                    auth: { token, clientType: 'user-scoped' } });
                sockets.push(socket);
                const connected = new Promise<void>((resolve, reject) => {
                    socket.once('connect', resolve); socket.once('connect_error', reject);
                });
                socket.connect();
                await connected;
                await socket.timeout(5_000).emitWithAck('ping');
                return socket;
            };
            const pendingSocketOutcome = await connect(terminalBearer).then(() => ({ status: 'connected' }),
                (error: unknown) => ({ status: 'refused', data: (error as { data?: unknown }).data }));
            expect(pendingSocketOutcome).toMatchObject({ status: 'refused', data: { statusCode: 401, error: 'invalid-token' } });
            // An unmarked terminal can have an open stream before ordinary App registration binds its selector.
            const preMarkerSocket = await connect(preMarkerBearer);
            const childKeys = nacl.sign.keyPair();
            const childId = randomUUID(), installationId = randomUUID();
            const register = async (accountId: string, token: string, machineId = childId, registeredInstallationId = installationId) => app.inject({ method: 'POST', url: '/v1/machines',
                headers: { ...currentAccountStoredContentCompatibilityHeaders, authorization: `Bearer ${token}` },
                payload: { id: machineId, metadata: encodePlainMachineStoredContent({ host: 'Collector', platform: 'linux',
                    happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
                    dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, installationId: registeredInstallationId,
                    installationPublicKey: encodeBase64(childKeys.publicKey, 'base64url'),
                    installationProof: signMachineInstallationProof({ payload: { version: 1, machineId,
                        installationId: registeredInstallationId, accountId }, privateKey: childKeys.secretKey }), managedEnrollment: enrollment } });
            expect((await register(custodian.id, bearer)).statusCode).toBe(409);
            expect((await register(requester.id, requesterBearer)).statusCode).toBe(409);
            expect(await db.machine.findUnique({ where: { id: childId } })).toBeNull();
            if (disposition === 'teardown') {
                // A fresh enrollment can retain the pre-binding Home's existing Machine identity.
                await db.machine.create({ data: { id: childId, accountId: requester.id, installationId,
                    installationPublicKey: new Uint8Array(childKeys.publicKey), deploymentAppDeploymentId: receipt.id,
                    metadata: encodePlainMachineStoredContent({ host: 'Collector', platform: 'linux', happyCliVersion: 'test',
                        homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
                    dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
            }
            const enrolled = await register(requester.id, disposition === 'delete' ? preMarkerBearer : terminalBearer);
            expect(enrolled.statusCode, enrolled.body).toBe(200);
            expect(await db.machine.findUniqueOrThrow({ where: { id: childId } }))
                .toMatchObject({ terminalAuthRequestId: pairingRequest.id });
            const appSocket = await connect(terminalBearer);
            const ordinarySocket = await connect(ordinaryTerminalBearer);
            const packetReads: { model?: string; action: string }[] = [];
            const stopPacketObserving = observePrismaRequests(db, { before: request => { packetReads.push(request); } });
            try {
                await appSocket.timeout(5_000).emitWithAck('ping');
                await preMarkerSocket.timeout(5_000).emitWithAck('ping');
                expect(packetReads.filter(request => request.model === 'Machine' || request.model === 'Deployment')).toEqual([]);
            } finally { stopPacketObserving(); }
            if (!process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID) {
                const bindingPlan = await db.$queryRawUnsafe<{ detail: string }[]>('EXPLAIN QUERY PLAN SELECT "id" FROM "Machine" WHERE "terminalAuthRequestId" = ?', pairingRequest.id);
                expect(bindingPlan.map(row => row.detail).join('\n')).toContain('Machine_terminalAuthRequestId_key');
                const lifecyclePlan = await db.$queryRawUnsafe<{ detail: string }[]>('EXPLAIN QUERY PLAN SELECT "id" FROM "Machine" WHERE "deploymentAppDeploymentId" = ?', receipt.id);
                expect(lifecyclePlan.map(row => row.detail).join('\n')).toContain('Machine_deploymentAppDeploymentId_idx');
            }
            const otherChildId = randomUUID();
            expect((await register(requester.id, terminalBearer, otherChildId, randomUUID())).statusCode).toBe(409);
            expect(await db.machine.findUnique({ where: { id: otherChildId } })).toBeNull();
            await db.terminalAuthRequest.deleteMany({ where: { publicKey: privacyKit.encodeHex(pairing.publicKey) } });
            await db.deployment.update({ where: { id: receipt.id }, data: { state: 'succeeded' } });
            expect((await register(requester.id, terminalBearer)).statusCode).toBe(200);
            // Existing Home volumes predate the durable selector. Retention must not
            // break their idempotent registration or invent a credential binding.
            const legacySession = randomUUID(), legacyId = randomUUID(), legacyInstallationId = randomUUID();
            const legacyBearer = await auth.createToken(requester.id, { session: legacySession },
                { kind: 'terminal', authority: 'account_automation' });
            await db.machine.create({ data: { id: legacyId, accountId: requester.id,
                metadata: encodePlainMachineStoredContent({ host: 'Collector', platform: 'linux', happyCliVersion: 'test',
                    homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
                dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
                installationId: legacyInstallationId, installationPublicKey: new Uint8Array(childKeys.publicKey),
                deploymentAppDeploymentId: receipt.id } });
            const legacyRegistration = await register(requester.id, legacyBearer, legacyId, legacyInstallationId);
            expect(legacyRegistration.statusCode, legacyRegistration.body).toBe(200);
            expect(await db.machine.findUniqueOrThrow({ where: { id: legacyId } })).toMatchObject({ terminalAuthRequestId: null });
            // A selector already bound to another child cannot adopt the legacy row.
            expect((await register(requester.id, terminalBearer, legacyId, legacyInstallationId)).statusCode).toBe(409);
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
            const unrelatedApp = await db.machine.create({ data: { id: randomUUID(), accountId: requester.id,
                metadata: '{}', installationId: randomUUID(), deploymentAppDeploymentId: otherReceipt.id } });
            const siblingLink = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
                createdByAccountId: custodian.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
                targetKind: 'ownServer', state: 'configured', ...reference } });
            const siblingReceipt = await db.deployment.create({ data: { environmentId: environment.id, targetLinkId: siblingLink.id,
                requestedByAccountId: requester.id, requestKey: randomUUID(), actionOperationId: randomUUID(),
                operation: 'deploy', state: 'succeeded', acceptedControllerMachineId: controller.id,
                acceptedControllerInstallationId: controller.installationId, ...reference } });
            const siblingApp = await db.machine.create({ data: { id: randomUUID(), accountId: requester.id,
                metadata: '{}', installationId: randomUUID(), deploymentAppDeploymentId: siblingReceipt.id } });
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
            // Use an unrelated Machine read: refusing the revoked Machine's own route alone
            // would not prove that the persisted full-Account terminal bearer was retired.
            const accountRead = (token: string) => app.inject({ method: 'GET', url: `/v1/machines/${controlId}`,
                headers: { ...currentAccountStoredContentCompatibilityHeaders, authorization: `Bearer ${token}` } });
            expect((await accountRead(terminalBearer)).statusCode).toBe(200);
            expect((await accountRead(preMarkerBearer)).statusCode).toBe(200);
            const unboundPairing = nacl.box.keyPair();
            const unboundPublicKey = privacyKit.encodeBase64(unboundPairing.publicKey);
            const unboundClaimSecret = randomBytes(32).toString('base64url');
            expect((await app.inject({ method: 'POST', url: '/v1/auth/request', payload: { publicKey: unboundPublicKey,
                supportsV2: true, claimSecretHash: createHash('sha256').update(Buffer.from(unboundClaimSecret, 'base64url')).digest('base64url') } })).statusCode).toBe(200);
            expect((await admit({ ...nextEnrollment, pairingPublicKey: unboundPublicKey }, true, nextPath)).statusCode).toBe(200);
            expect((await app.inject({ method: 'POST', url: '/v1/auth/response',
                headers: { authorization: `Bearer ${requesterBearer}` }, payload: { publicKey: unboundPublicKey,
                    response: privacyKit.encodeBase64(sealTerminalProvisioningV3TokenOnlyPayload({
                        terminalEphemeralPublicKey: unboundPairing.publicKey, pairingSecret: randomBytes(32), createdAtMs: Date.now(),
                        expiresAtMs: Date.now() + 60_000, randomBytes: length => randomBytes(length) })), responseKind: 'tokenOnly' } })).statusCode).toBe(200);
            const unboundClaim = await app.inject({ method: 'POST', url: '/v1/auth/request/claim',
                payload: { publicKey: unboundPublicKey, claimSecret: unboundClaimSecret } });
            expect(unboundClaim.statusCode, unboundClaim.body).toBe(200);
            const unboundBearer = unboundClaim.json().token as string;
            expect((await accountRead(unboundBearer)).statusCode).toBe(200);
            await db.deployment.updateMany({ where: { environmentId: environment.id }, data: { state: 'succeeded' } });
            if (disposition === 'teardown') {
                const peer = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
                    metadata: '{}', installationId: randomUUID() } });
                const members = [controller, peer].map(machine => ({ machineId: machine.id, installationId: machine.installationId! }));
                await db.deploymentTargetLinkMachine.createMany({ data: members.map((member, position) => ({
                    targetLinkId: link.id, ...member, position, state: 'active' })) });
                const peerReceipt = await db.deployment.create({ data: { environmentId: environment.id, targetLinkId: link.id,
                    requestedByAccountId: requester.id, requestKey: randomUUID(), actionOperationId: randomUUID(),
                    operation: 'deploy', state: 'succeeded', acceptedControllerMachineId: peer.id,
                    acceptedControllerInstallationId: peer.installationId, ...reference } });
                const peerApp = await db.machine.create({ data: { id: randomUUID(), accountId: requester.id,
                    metadata: '{}', installationId: randomUUID(), deploymentAppDeploymentId: peerReceipt.id } });
                const settleTeardown = async (selected: typeof members, partial = false) => {
                    const teardown = await db.deployment.create({ data: { environmentId: environment.id, targetLinkId: link.id,
                        requestedByAccountId: custodian.id, requestKey: randomUUID(), actionOperationId: randomUUID(),
                        operation: 'teardown', state: 'running', acceptedControllerMachineId: controller.id,
                        acceptedControllerInstallationId: controller.installationId,
                        ...(partial ? { teardownProof: { admittedMachines: selected } } : {}), ...reference } });
                    const body: Omit<DeploymentTransitionInputV1, 'proof'> = { serverId: homeId,
                        environmentId: environment.id, deploymentId: teardown.id, expectedRevision: teardown.revision,
                        actionOperationId: teardown.actionOperationId, machineId: controller.id,
                        installationId: controller.installationId!, kind: 'settle', state: 'succeeded',
                        teardownProof: { targetLinkRevision: link.revision,
                            machines: selected,
                            workloadAbsent: true, retainedProviderResource: false,
                            steps: ['admit', 'settleDeploy', 'removeTarget', 'removeDomain', 'removeRelease', 'withdrawBindings', 'verify'] } };
                    const settled = await app.inject({ method: 'POST',
                        url: `/v1/deployments/environments/${environment.id}/deployments/${teardown.id}/transitions`,
                        headers: { authorization: `Bearer ${bearer}` }, payload: { ...body,
                            proof: signMachineInstallationProof({ payload: { version: 1, accountId: custodian.id,
                                machineId: controller.id, installationId: controller.installationId!, deploymentTransition: {
                                    serverId: homeId, environmentId: environment.id, deploymentId: teardown.id,
                                    actionOperationId: teardown.actionOperationId, expectedRevision: teardown.revision,
                                    requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) } }, privateKey: keys.secretKey }) } });
                    expect(settled.statusCode, settled.body).toBe(200);
                };
                await settleTeardown([members[1]!], true);
                expect((await accountRead(terminalBearer)).statusCode).toBe(200);
                expect.soft(await db.machine.findUniqueOrThrow({ where: { id: peerApp.id } })).toMatchObject({ revokedAt: expect.any(Date) });
                await settleTeardown(members);
            } else {
                const removed = await app.inject({ method: 'POST', url: `/v1/deployments/environments/${environment.id}/delete`,
                    headers: { authorization: `Bearer ${custodianPresentBearer}` }, payload: { serverId: homeId,
                        environmentId: environment.id, expectedRevision: environment.revision, requestKey: randomUUID(),
                        detachKeepRunning: true } });
                expect(removed.statusCode, removed.body).toBe(200);
            }
            reads.length = 0;
            const stopRefusalObserving = observePrismaRequests(db, { before: read => { reads.push(read); } });
            try {
                expect((await accountRead(terminalBearer)).statusCode).toBe(401);
                console.info('Revoked App credential request-boundary cost', {
                    selectorLookups: reads.filter(read => read.model === 'Machine' && read.action === 'findUnique').length,
                });
            } finally { stopRefusalObserving(); }
            expect((await accountRead(preMarkerBearer)).statusCode).toBe(401);
            expect((await accountRead(unboundBearer)).statusCode).toBe(401);
            expect((await accountRead(requesterBearer)).statusCode).toBe(200);
            expect((await accountRead(ordinaryTerminalBearer)).statusCode).toBe(200);
            await expect.poll(() => appSocket.connected).toBe(false);
            await expect.poll(() => preMarkerSocket.connected).toBe(false);
            expect(ordinarySocket.connected).toBe(true);
            await ordinarySocket.timeout(5_000).emitWithAck('ping');
            const reconnectOutcome = await connect(terminalBearer).then(() => ({ status: 'connected' }),
                (error: unknown) => ({ status: 'refused', data: (error as { data?: unknown }).data }));
            expect(reconnectOutcome).toMatchObject({ status: 'refused', data: { statusCode: 401, error: 'invalid-token' } });
            expect(await db.machine.findUniqueOrThrow({ where: { id: childId } })).toMatchObject({ revokedAt: expect.any(Date) });
            expect(await db.machine.findUniqueOrThrow({ where: { id: controlId } })).toMatchObject({ revokedAt: null });
            expect(await db.machine.findUniqueOrThrow({ where: { id: controller.id } })).toMatchObject({ revokedAt: null });
            expect(await db.machine.findUniqueOrThrow({ where: { id: unrelatedApp.id } })).toMatchObject({ revokedAt: null });
            expect(await db.machine.findUniqueOrThrow({ where: { id: siblingApp.id } }))
                .toMatchObject({ revokedAt: disposition === 'delete' ? expect.any(Date) : null });
            } finally {
                for (const socket of sockets) socket.disconnect();
                await closeSocketServer?.();
                await stopLocalMachinePresenceTimeout();
            }
        }, { authentication: 'real' });
    });
});
