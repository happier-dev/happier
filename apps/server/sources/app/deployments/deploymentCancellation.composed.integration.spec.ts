import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import nacl from 'tweetnacl';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, computeDeploymentTransitionRequestDigestV1, encodePlainArtifactStoredContent,
    DEPLOYMENT_STOP_ACCEPTED_HEADER_V1, ExternalActionExecutionAuthorizationV1Schema,
    bindExternalActionExecutionAuthorizationHttpPathV1, encodeExternalActionResolvedTargetV1,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER, signExternalActionMachineRequestV1,
    type DeploymentTransitionInputV1 } from '@happier-dev/protocol';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { DEPLOYMENT_CANCEL_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { db } from '@/storage/db';
import { recordMachineDisconnect } from '@/app/presence/timeout';
import { inTx } from '@/storage/inTx';
import { createAccountTokenForTests, createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedExternalActionPostHeadersForTests } from '@/testkit/externalActionExecution';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { verifyExternalActionDomainExecutionRequest } from '@/app/auth/externalActionExecutionAuthorization';
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

    it.each(['platform', 'platform-retained-builder', 'own-server-disconnect', 'own-server', 'own-server-alias', 'late platform Stop', 'superseded platform Stop', 'provider Cancel', 'provider already live'] as const)(
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
        const staleBuilder = target === 'platform-retained-builder' ? await db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: owner.id, installationId: crypto.randomUUID(), revokedAt: new Date(),
            metadata: encodePlainMachineStoredContent({ host: 'fixture', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
        } }) : null;
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: owner.id, controllerMachineId: machineId, buildMachineId: staleBuilder?.id,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            ...await artifact('deployment-environment.v1') } });
        const native = target.startsWith('own-server');
        const linkContent = await artifact('deployment-target-link.v1');
        const linked = await inTx(tx => linkDeploymentTargetInTx(tx, owner.id, { serverId,
            environmentId: environment.id, expectedRevision: environment.revision, requestKey: crypto.randomUUID(), role: 'runtime',
            ...(native ? { targetId: target === 'own-server-disconnect' ? 'own-server' : target } : { targetId: 'platform-test', source: { kind: 'plugin' as const,
                contribution: { pluginId: 'example.deploy', localId: 'runtime' } }, targetKind: 'platform' }),
            machines: native ? [{ machineId, installationId }] : [], ...linkContent }));
        if (staleBuilder) {
            // A revoked retained builder is current placement: linking is new work, so it is
            // refused at this boundary with a typed, recoverable choice (O-DEPLOY 2026-11-12).
            expect(linked).toMatchObject({ ok: false, error: 'machine_unavailable', role: 'build', machineIds: [staleBuilder.id],
                nextActions: expect.arrayContaining(['chooseAnother']), diagnostic: { reason: 'machine_revoked' } });
            expect(await db.deploymentTargetLink.count({ where: { environmentId: environment.id } })).toBe(0);
            return;
        }
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
            if (target === 'own-server-disconnect') {
                await recordMachineDisconnect({ accountId: owner.id, machineId }, async () => false, async () => {});
                expect((await db.deployment.findUniqueOrThrow({ where: { id: receipt.id } })).state).toBe('running');
                await recordMachineDisconnect({ accountId: owner.id, machineId }, async () => true, async () => {});
                const settled = await db.deployment.findUniqueOrThrow({ where: { id: receipt.id } });
                expect(settled).toMatchObject({ state: 'outcome_unknown', settledAt: expect.any(Date),
                    revision: running.json().deploymentRevision + 1, cancelRequestedAt: null });
                return;
            }
            if (target === 'provider Cancel' || target === 'provider already live') {
                const expectedReceiptRevision = running.json().deploymentRevision;
                const cancelPath = `/v1/deployments/environments/${environment.id}/deployments/${receipt.id}/transitions`;
                const actionInput = { serverId, environmentId: environment.id, deploymentId: receipt.id, expectedReceiptRevision };
                const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(DEPLOYMENT_CANCEL_ACTION_ID_V1),
                    headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId, envelope: { v: 1,
                        requestId: crypto.randomUUID(), target: { kind: 'machine', machineId }, input: actionInput } } });
                expect(minted.statusCode, minted.body).toBe(200);
                const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
                expect(root.binding).toMatchObject({ environmentId: environment.id,
                    deploymentStopReceipt: { deploymentId: receipt.id, expectedReceiptRevision } });
                const signedPost = (url: string, body: Record<string, unknown>) => app.inject({ method: 'POST', url, payload: body,
                    headers: { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                        [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: DEPLOYMENT_CANCEL_ACTION_ID_V1,
                        [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                        [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                            effectActionId: DEPLOYMENT_CANCEL_ACTION_ID_V1, target: root.binding.target, installationId,
                            requestId: root.binding.requestId, method: 'POST', path: url, body, privateKey: keys.secretKey }) } });
                const materialPath = '/v2/teams/stop-test-team/credential-resources/stop-test-resource/direct-material';
                const consumer = { kind: 'platform_operation', deploymentId: receipt.id,
                    environmentId: environment.id, operationId: receipt.actionOperationId };
                const material = { resourceId: 'stop-test-resource', consumer,
                    slot: { kind: 'connected_service_purpose',
                        purpose: { purpose: 'deploy', consumer: { pluginId: 'example.deploy', localId: 'cancel' } } },
                    disclosedMember: { service: { pluginId: 'example.deploy', localId: 'service' }, accountId: 'fixture' } };
                const verifyMaterial = (body: typeof material) => verifyExternalActionDomainExecutionRequest({
                    authorizationToken: root.token, effectActionId: DEPLOYMENT_CANCEL_ACTION_ID_V1,
                    encodedTarget: encodeExternalActionResolvedTargetV1(root.binding.target), method: 'POST', path: materialPath, body,
                    machineSignature: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                        effectActionId: DEPLOYMENT_CANCEL_ACTION_ID_V1, target: root.binding.target, installationId,
                        requestId: root.binding.requestId, method: 'POST', path: materialPath, body, privateKey: keys.secretKey }),
                });
                expect(await verifyMaterial(material)).toBeNull();
                const stop = { ...actionInput, kind: 'cancel' };
                expect((await signedPost(cancelPath, { ...stop, expectedReceiptRevision: expectedReceiptRevision + 1 })).statusCode).toBe(401);
                const otherId = crypto.randomUUID();
                const otherPath = `/v1/deployments/environments/${environment.id}/deployments/${otherId}/transitions`;
                expect((await signedPost(otherPath, { ...stop, deploymentId: otherId })).statusCode).toBe(401);
                const state = target === 'provider Cancel' ? 'cancelled' : 'succeeded';
                const settled: Omit<DeploymentTransitionInputV1, 'proof'> = { ...stage, kind: 'settle', state,
                    expectedRevision: expectedReceiptRevision + 1,
                    ...(state === 'succeeded' ? { expectedTargetLinkRevision: linked.targetLinkRevision } : {}) };
                const settle = (body: Omit<DeploymentTransitionInputV1, 'proof'>) => {
                    const proof = signMachineInstallationProof({ payload: { version: 1, machineId, installationId, accountId: owner.id,
                        deploymentTransition: { serverId, environmentId: environment.id, deploymentId: body.deploymentId,
                            actionOperationId: body.actionOperationId, expectedRevision: body.expectedRevision,
                            requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) } }, privateKey: keys.secretKey });
                    return signedPost(cancelPath, { ...body, proof });
                };
                expect((await settle(settled)).statusCode).toBe(401);
                const pending = await signedPost(cancelPath, stop);
                expect(pending.statusCode, pending.body).toBe(200);
                expect(pending.headers[DEPLOYMENT_STOP_ACCEPTED_HEADER_V1]).toBe('1');
                expect(pending.json()).toMatchObject({ ok: true, state: 'outcome_unknown', deploymentRevision: expectedReceiptRevision + 1 });
                expect((await signedPost(cancelPath, stop)).headers[DEPLOYMENT_STOP_ACCEPTED_HEADER_V1]).toBeUndefined();
                expect(await verifyMaterial(material)).toMatchObject({ acceptedDeploymentReceipt: { platformMaterial: { consumer } } });
                expect(await verifyMaterial({ ...material, consumer: { ...consumer, deploymentId: otherId } })).toBeNull();
                expect(await verifyMaterial({ ...material, slot: { ...material.slot, purpose: { ...material.slot.purpose,
                    consumer: { pluginId: 'other.deploy', localId: 'cancel' } } } })).toBeNull();
                expect((await settle({ ...settled, expectedRevision: settled.expectedRevision + 1 })).statusCode).toBe(401);
                const confirmed = await settle(settled);
                expect(confirmed.statusCode, confirmed.body).toBe(200);
                expect(confirmed.json()).toMatchObject({ ok: true, state, deploymentRevision: expectedReceiptRevision + 2 });
                expect(await verifyMaterial(material)).toBeNull();
                expect((await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: linked.targetLinkId } })).activeDeploymentId)
                    .toBe(state === 'succeeded' ? receipt.id : null);
                return;
            }
            if (target === 'late platform Stop' || target === 'superseded platform Stop') {
                const receiptRevision = running.json().deploymentRevision;
                const cancelPath = `/v1/deployments/environments/${environment.id}/deployments/${receipt.id}/transitions`;
                await db.deploymentTargetLink.update({ where: { id: linked.targetLinkId }, data: { revision: { increment: 1 } } });
                const cancelled = await app.inject({ method: 'POST', url: cancelPath,
                    headers: { authorization: `Bearer ${token}` },
                    payload: { serverId, environmentId: environment.id, deploymentId: receipt.id, kind: 'cancel',
                        expectedReceiptRevision: receiptRevision } });
                expect(cancelled.json()).toMatchObject({ ok: true, state: 'outcome_unknown', deploymentRevision: receiptRevision + 1 });
                const confirmed: Omit<DeploymentTransitionInputV1, 'proof'> = { ...stage, kind: 'settle', state: 'succeeded',
                    expectedRevision: receiptRevision + 1, expectedTargetLinkRevision: linked.targetLinkRevision + 1 };
                // An ordinary signed deployment continuation cannot undo a Stop.
                expect((await transition(confirmed)).statusCode).toBe(409);
                if (target === 'superseded platform Stop') {
                    const next = { ...input, expectedRevision: cancelled.json().revision,
                        expectedTargetLinkRevision: confirmed.expectedTargetLinkRevision,
                        requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), ...await artifact('deployment-receipt.v1') };
                    const { actionOperationId: _nextOperation, ...nextAction } = next;
                    const newer = await app.inject({ method: 'POST', url: path, payload: next,
                        headers: await createSignedExternalActionPostHeadersForTests(app, { accountId: owner.id, machineId,
                            installationId, privateKey: keys.secretKey, actionId: 'deployments.deploy',
                            actionInput: nextAction, path, body: next }) });
                    expect(newer.statusCode, newer.body).toBe(200);
                }
                const proof = signMachineInstallationProof({ payload: { version: 1, machineId, installationId, accountId: owner.id,
                    deploymentTransition: { serverId, environmentId: environment.id, deploymentId: receipt.id,
                        actionOperationId: receipt.actionOperationId, expectedRevision: confirmed.expectedRevision,
                        requestBodyDigest: computeDeploymentTransitionRequestDigestV1(confirmed) } }, privateKey: keys.secretKey });
                const payload = { ...confirmed, proof };
                const observed = await app.inject({ method: 'POST', url: cancelPath, payload,
                    headers: await createSignedExternalActionPostHeadersForTests(app, { accountId: owner.id, machineId,
                        installationId, privateKey: keys.secretKey, actionId: 'deployments.receipts.observe',
                        actionInput: { serverId, environmentId: environment.id, deploymentId: receipt.id }, path: cancelPath, body: payload }) });
                if (target === 'superseded platform Stop') {
                    expect(observed.statusCode, observed.body).toBe(409);
                    expect((await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: linked.targetLinkId } })).activeDeploymentId).toBeNull();
                    return;
                }
                expect(observed.statusCode, observed.body).toBe(200);
                expect(observed.json()).toMatchObject({ ok: true, state: 'succeeded', deploymentRevision: receiptRevision + 2 });
                expect(await db.deployment.findUniqueOrThrow({ where: { id: receipt.id } })).toMatchObject({
                    state: 'succeeded', cancelRequestedAt: expect.any(Date), settledAt: expect.any(Date) });
                expect(await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: linked.targetLinkId } }))
                    .toMatchObject({ activeDeploymentId: receipt.id, revision: linked.targetLinkRevision + 2 });
                return;
            }
            const nextController = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
                metadata: encodePlainMachineStoredContent({ host: 'fixture', platform: 'linux', happyCliVersion: 'test',
                    homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
                dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey) } });
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
