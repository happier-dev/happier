import { teamResourceGrantFixture } from '@/testkit/resourceGrant.testkit';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import nacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, DeploymentPendingDeployV1Schema,
    DeploymentReceiptResultV1Schema, DeploymentEnvironmentGetResultV1Schema, sealSessionDataKeyBundleV0,
    sealEncryptedDataKeyEnvelopeV1, openSessionDataKeyBundleV0, computeDeploymentTransitionRequestDigestV1,
    computeContentPublicKeyFingerprint, type DeploymentTransitionInputV1, type DeploymentDeployAdmissionInputV1 } from '@happier-dev/protocol';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { computeMachineOwnerEnvelopeFingerprintV1 } from '@happier-dev/protocol/machines/machineOwnerEnvelopeFingerprintV1';
import { sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { ExternalActionExecutionAuthorizationV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1,
    EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { signExternalActionMachineRequestV1, encodeExternalActionResolvedTargetV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { createDeploymentEnvironmentV1, createDeploymentV1 } from '@happier-dev/deployments/testing/v1';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createAuthenticatedTestApp, withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { auth } from '@/app/auth/auth';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { commitMachineRecipientKeyEnvelopesInTx, resolveMachineAdmission } from '@/app/machines/machineAccess';

// Hop-local server admission test; the sole cross-component composed journey stays with S0.
describe('protected deployment pending storage', () => {
    const serverId = `srv_${'d'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-deployment-pending-', initEncrypt: true, initAuth: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: serverId, AUTH_REQUIRED_LOGIN_PROVIDERS: '',
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it.each([
        { mode: 'plain', team: false }, { mode: 'e2ee', team: false }, { mode: 'e2ee', team: true },
    ] as const)('retains and atomically takes the latest $mode pending intent (Team=$team)', async ({ mode, team: shared }) => {
        const accountKey = nacl.box.keyPair();
        const contentKey = nacl.randomBytes(32);
        const owner = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(accountKey.publicKey) : {}) } });
        const team = shared ? await db.team.create({ data: { name: 'Pending Team' } }) : null;
        const receiptOwner = team ? await db.account.create({ data: { encryptionMode: 'plain' } }) : owner;
        const replayKey = nacl.box.keyPair();
        const replayActor = team ? await db.account.create({ data: { encryptionMode: 'e2ee',
            ...createSignedAccountContentBinding(replayKey.publicKey) } }) : null;
        if (team) {
            await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: receiptOwner.id, role: 'member' } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: replayActor!.id, role: 'admin' } });
        }
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Pending project', audience: [],
            ...(team ? { owner: { kind: 'team' as const, teamId: team.id } } : {}),
            repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'acme/pending', cloneUrl: 'https://github.com/acme/pending.git' }, protocol: 'https' },
        }));
        if (!source.ok) throw new Error(source.error);
        const machineId = crypto.randomUUID();
        const installationId = crypto.randomUUID();
        const installationKey = nacl.sign.keyPair();
        const machineContentKey = nacl.randomBytes(32);
        const machineMetadata = { host: 'pending-controller', platform: 'linux', happyCliVersion: 'test',
            homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' };
        const machine = await db.machine.create({ data: { id: machineId, accountId: owner.id,
            metadata: mode === 'plain' ? encodePlainMachineStoredContent(machineMetadata)
                : privacyKit.encodeBase64(new Uint8Array(await sealSessionDataKeyBundleV0(machineMetadata, machineContentKey))),
            dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)
                : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: machineContentKey,
                    recipientPublicKey: accountKey.publicKey, randomBytes: nacl.randomBytes })), installationId,
            installationPublicKey: new Uint8Array(installationKey.publicKey) } });
        if (team) await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'view', createdByAccountId: owner.id }), machineId } });
        if (replayActor) {
            const ownerEnvelope = machine.dataEncryptionKey;
            if (!ownerEnvelope) throw new Error('Expected encrypted Machine owner envelope');
            // Team View already grants Use. Deliver the distinct Machine key
            // through its real owner; Artifact envelopes do not admit this root.
            const delivered = await inTx(tx => commitMachineRecipientKeyEnvelopesInTx(tx, {
                actorAccountId: owner.id, machineId,
                expectedMachineOwnerEnvelopeFingerprint: computeMachineOwnerEnvelopeFingerprintV1(ownerEnvelope),
                expectedMetadataVersion: machine.metadataVersion, expectedDaemonStateVersion: machine.daemonStateVersion,
                expectedCallerDataEncryptionKey: privacyKit.encodeBase64(ownerEnvelope),
                recipientKeyEnvelopes: [{ recipientAccountId: replayActor.id,
                    recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(replayKey.publicKey),
                    encryptedDataKey: privacyKit.encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: machineContentKey,
                        recipientPublicKey: replayKey.publicKey, randomBytes: nacl.randomBytes })) }],
            }));
            expect(delivered).toEqual({ appliedRecipientAccountIds: [replayActor.id], skippedRecipientAccountIds: [] });
            expect(await resolveMachineAdmission({ actorAccountId: replayActor.id, machineId, requiredRole: 'use' }))
                .toMatchObject({ kind: 'admitted', actorAccountId: replayActor.id, role: 'use', encryptionMode: 'e2ee' });
        }
        const content = async (kind: string, body: unknown) => {
            if (mode === 'e2ee' && (!team || kind !== 'deployment-receipt.v1')) {
                const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
                    kind: `v1:other:${kind}`, headerVersion: 1, bodyVersion: 1,
                    header: new Uint8Array(await sealSessionDataKeyBundleV0({ kind, title: 'Private deployment intent' }, contentKey)),
                    body: new Uint8Array(await sealSessionDataKeyBundleV0({ body: JSON.stringify(body) }, contentKey)),
                    dataEncryptionKey: new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: contentKey,
                        recipientPublicKey: accountKey.publicKey, randomBytes: nacl.randomBytes })) } });
                if (team) await db.artifactGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'admin', createdByAccountId: owner.id }), artifactId: artifact.id } });
                if (replayActor) await db.artifactKeyEnvelope.create({ data: { artifactId: artifact.id,
                    recipientAccountId: replayActor.id, recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(replayKey.publicKey),
                    encryptedDataKey: new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: contentKey,
                        recipientPublicKey: replayKey.publicKey, randomBytes: nacl.randomBytes })) } });
                return { contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
            }
            const created = await createArtifact({ actorUserId: team ? receiptOwner.id : owner.id, artifactId: crypto.randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Private deployment intent' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(body) })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!created.ok) throw new Error(created.error);
            if (team) await db.artifactGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'admin', createdByAccountId: receiptOwner.id }), artifactId: created.artifact.id } });
            return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const environment = createDeploymentEnvironmentV1();
        if (environment.content.t !== 'plain') throw new Error('Expected the public plain Environment fixture');
        const environmentContent = await content('deployment-environment.v1', environment.content.v);
        const admittedApp = createAuthenticatedTestApp({ authentication: 'real' });
        registerExternalActionRoutes(admittedApp, { dispatch: async () => ({ kind: 'placement_error', code: 'target_unavailable' }) });
        registerDeploymentRoutes(admittedApp);
        onTestFinished(() => admittedApp.close());
        await admittedApp.ready();
        const accountToken = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        type RequestSigner = Readonly<{ accountId: string; tokenEpoch: number; token: string; machineKey: Uint8Array; machineId?: string;
            installation?: Readonly<{ id: string; privateKey: Uint8Array }> }>;
        const signedRequest = async (actionId: 'action.operations.cancel' | 'deployments.deploy', input: unknown, path: string, body: unknown,
            signer: RequestSigner = { accountId: owner.id, tokenEpoch: owner.tokenEpoch, token: accountToken, machineKey: accountKey.secretKey }) => {
            const requestId = crypto.randomUUID();
            const signingMachineId = signer.machineId ?? machineId;
            const target = { kind: 'machine' as const, machineId: signingMachineId };
            const envelope = mode === 'plain' ? { v: 1, requestId, target, input }
                : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, input, material: { type: 'dataKey', machineKey: signer.machineKey }, randomBytes: nacl.randomBytes,
                    binding: { serverIdentityId: serverId, accountId: signer.accountId, actionId, requestId, target,
                        authentication: { kind: 'account', tokenEpoch: signer.tokenEpoch } } });
            const minted = await admittedApp.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${signer.token}` }, payload: { v: 1, machineId: signingMachineId, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            return admittedApp.inject({ method: 'POST', url: path, payload: body, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                    effectActionId: actionId, target: root.binding.target, installationId: signer.installation?.id ?? installationId, requestId: root.binding.requestId,
                    method: 'POST', path, body, privateKey: signer.installation?.privateKey ?? installationKey.secretKey }),
            } });
        };
        const signedCancel = (body: Readonly<{ serverId: string; environmentId: string; expectedRevision: number;
            actionOperationId: string; pendingDeploy: ReturnType<typeof DeploymentPendingDeployV1Schema.parse> }>) => signedRequest(
                'action.operations.cancel', { serverId, machineId, operationId: body.actionOperationId },
                `/v1/deployments/environments/${body.environmentId}/pending/cancel`, body);
        const signedColdCancel = (operationId: string, signer?: RequestSigner) => signedRequest('action.operations.cancel',
            { serverId, machineId, operationId }, '/v1/deployments/pending/cancel', { serverId, machineId, operationId }, signer);
        const signedDeploy = (body: DeploymentDeployAdmissionInputV1, signer?: RequestSigner) => {
            const { actionOperationId: _actionOperationId, ...reviewedInput } = body;
            return signedRequest('deployments.deploy', reviewedInput, `/v1/deployments/environments/${body.environmentId}/deploy`, body, signer);
        };
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id };
            // Operation IDs are scoped to a Machine, not globally reserved.
            // Insert another real Environment first so its same-ID pending
            // admission cannot shadow the cancellation Address below.
            const collision = mode === 'plain' ? await (async () => {
                const key = nacl.sign.keyPair();
                const controller = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
                    metadata: machine.metadata, dataEncryptionKey: machine.dataEncryptionKey,
                    installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(key.publicKey) } });
                const environment = await app.inject({ method: 'POST', url: '/v1/deployments/environments', headers, payload: {
                    serverId, projectSourceId: source.source.id, requestKey: crypto.randomUUID(),
                    protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                    controllerMachineId: controller.id, buildMachineId: controller.id, ...environmentContent,
                } });
                expect(environment.statusCode, environment.body).toBe(200);
                const linked = await app.inject({ method: 'POST',
                    url: `/v1/deployments/environments/${environment.json().environmentId}/targets`, headers, payload: {
                        serverId, environmentId: environment.json().environmentId, expectedRevision: environment.json().revision,
                        requestKey: crypto.randomUUID(), targetId: 'own-server', role: 'runtime',
                        machines: [{ machineId: controller.id, installationId: controller.installationId }],
                        ...await content('deployment-target-link.v1', {}),
                    } });
                expect(linked.statusCode, linked.body).toBe(200);
                return { controller, key, environmentId: environment.json().environmentId as string,
                    link: linked.json() as { revision: number; targetLinkId: string; targetLinkRevision: number } };
            })() : undefined;
            const created = await app.inject({ method: 'POST', url: '/v1/deployments/environments', headers, payload: {
                serverId, projectSourceId: source.source.id, requestKey: crypto.randomUUID(),
                protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                controllerMachineId: machineId, buildMachineId: machineId, ...environmentContent,
            } });
            expect(created.statusCode, created.body).toBe(200);
            const environmentId: string = created.json().environmentId;
            const base = `/v1/deployments/environments/${environmentId}`;
            const linked = await app.inject({ method: 'POST', url: `${base}/targets`, headers, payload: {
                serverId, environmentId, expectedRevision: created.json().revision, requestKey: crypto.randomUUID(),
                targetId: 'own-server', role: 'runtime', machines: [{ machineId, installationId }],
                ...await content('deployment-target-link.v1', {}),
            } });
            expect(linked.statusCode, linked.body).toBe(200);
            const receipt = createDeploymentV1();
            if (receipt.content.t !== 'plain' || receipt.content.v.sourceIntent.kind !== 'repository') {
                throw new Error('Expected the public repository receipt fixture');
            }
            const intentContent = { ...receipt.content.v, machines: [machineId], buildMachineId: machineId,
                sourceIntent: { ...receipt.content.v.sourceIntent, projectSourceId: source.source.id }, machineResults: [] };
            const input = { serverId, environmentId, expectedRevision: linked.json().revision,
                targetLinkId: linked.json().targetLinkId, expectedTargetLinkRevision: linked.json().targetLinkRevision,
                requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(),
                ...await content('deployment-receipt.v1', intentContent) };
            // Native stage/settle consumes the actual admitted controller and
            // builder capture produced by this signed reservation. Historical
            // unsigned reservation compatibility has its separate persistence tests.
            const active = await signedDeploy(input);
            expect(active.statusCode, active.body).toBe(200);
            const history = await db.deployment.create({ data: { environmentId, targetLinkId: input.targetLinkId,
                operation: 'deploy', state: 'succeeded', requestKey: crypto.randomUUID(), requestedByAccountId: owner.id,
                actionOperationId: crypto.randomUUID(), contentArtifactId: input.contentArtifactId,
                contentHeaderVersion: input.contentHeaderVersion, contentBodyVersion: input.contentBodyVersion } });
            const busyReceipt = await app.inject({ method: 'GET',
                url: `${base}/deployments?serverId=${serverId}&inProgressOnly=true`, headers });
            expect(busyReceipt.statusCode, busyReceipt.body).toBe(200);
            expect(busyReceipt.json()).toMatchObject({ ok: true,
                items: [{ id: active.json().deploymentId, state: 'queued' }], nextCursor: null });
            expect(busyReceipt.json().items).toHaveLength(1);
            await db.deployment.delete({ where: { id: history.id } });
            const preparePending = async (sha: string, revision: number, linkRevision = input.expectedTargetLinkRevision) => {
                const sourceIntent = { ...intentContent.sourceIntent, sha };
                const requestKey = crypto.randomUUID();
                const actionOperationId = crypto.randomUUID();
                const pendingIntent = { sourceIntent, requestKey, targetLinkId: input.targetLinkId, actionOperationId };
                return { ...input, expectedRevision: revision, expectedTargetLinkRevision: linkRevision,
                    requestKey, actionOperationId, whenBusy: 'supersede' as const,
                    ...await content('deployment-receipt.v1', { ...intentContent, sourceIntent }),
                    pendingDeploy: DeploymentPendingDeployV1Schema.parse(mode === 'plain' ? { t: 'plain', v: pendingIntent }
                        : { t: 'encrypted', c: privacyKit.encodeBase64(new Uint8Array(await sealSessionDataKeyBundleV0(pendingIntent, contentKey))) }) };
            };
            const next = await preparePending('b'.repeat(40), active.json().revision);
            const ordinaryBusy = await app.inject({ method: 'POST', url: `${base}/deploy`, headers,
                payload: { ...input, requestKey: crypto.randomUUID(), expectedRevision: active.json().revision } });
            expect(ordinaryBusy.statusCode, ordinaryBusy.body).toBe(409);
            const missingIntent = await app.inject({ method: 'POST', url: `${base}/deploy`, headers,
                payload: { ...next, pendingDeploy: undefined } });
            expect(missingIntent.statusCode, missingIntent.body).toBe(400);
            const pending = await signedDeploy(next);
            // The admitted intent must be retained without admitting a second effecting receipt.
            expect(pending.statusCode, pending.body).toBe(200);
            expect(DeploymentReceiptResultV1Schema.parse(pending.json())).toMatchObject({ ok: true, environmentId,
                kind: 'pending', actionOperationId: next.actionOperationId });
            expect(await db.deployment.count({ where: { environmentId, state: { in: ['queued', 'running'] } } })).toBe(1);
            const read = async () => {
                const response = await app.inject({ method: 'GET', url: `${base}?serverId=${serverId}`, headers });
                expect(response.statusCode, response.body).toBe(200);
                return DeploymentEnvironmentGetResultV1Schema.parse(response.json());
            };
            const reconnected = await read();
            expect(reconnected).toMatchObject({ ok: true, pendingDeploy: next.pendingDeploy });
            // Admission correspondence survives loss of the daemon's in-memory
            // operation without persisting requester credentials or private input.
            const admission = { requesterAccountId: owner.id, serverId, requestKey: next.requestKey,
                actionOperationId: next.actionOperationId, controller: { machineId, installationId },
                environmentRevision: pending.json().revision };
            expect(reconnected).toMatchObject({ pendingAdmission: admission });
            const storedPending = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environmentId },
                select: { pendingDeployContent: true } });
            expect(storedPending.pendingDeployContent).toEqual({ pendingDeploy: next.pendingDeploy, admission });
            if (next.pendingDeploy.t === 'plain') {
                expect(next.pendingDeploy.v).not.toHaveProperty('expectedLinkRevision');
                // Retained development data still opens through the same reader;
                // the new strict mutation below never receives this retired key.
                await db.deploymentEnvironment.update({ where: { id: environmentId }, data: { pendingDeployContent: {
                    pendingDeploy: { t: 'plain', v: { ...next.pendingDeploy.v,
                        expectedLinkRevision: input.expectedTargetLinkRevision } }, admission,
                } } });
                expect(await read()).toMatchObject({ pendingDeploy: next.pendingDeploy, pendingAdmission: admission });
            }
            expect(await db.deployment.count({ where: { environmentId } })).toBe(1);
            if (next.pendingDeploy.t === 'encrypted') expect(await openSessionDataKeyBundleV0(
                privacyKit.decodeBase64(next.pendingDeploy.c), contentKey)).toMatchObject({ status: 'authenticated',
                    value: { sourceIntent: { sha: 'b'.repeat(40) }, actionOperationId: next.actionOperationId } });
            expect(JSON.stringify(reconnected.ok && reconnected.environment)).not.toContain('sourceIntent');
            let writes = 0;
            const beforeReplay = await db.accountChange.findMany({ where: { accountId: owner.id }, orderBy: { entityId: 'asc' } });
            const stop = observeSqliteRequests({ before: request => {
                if (['DeploymentEnvironment', 'Deployment', 'AccountChange'].includes(request.model ?? '')
                    && ['create', 'update', 'updateMany', 'upsert'].includes(request.action)) writes++;
            } });
            try {
                const replay = await signedDeploy(next);
                expect(replay.statusCode, replay.body).toBe(200);
                expect(replay.json()).toEqual(pending.json());
                expect(await read()).toMatchObject({ pendingAdmission: admission });
                if (replayActor) {
                    const replayToken = await auth.createToken(replayActor.id, undefined, { kind: 'account', authority: 'present_user' });
                    const sharedReplay = await signedDeploy(next, { accountId: replayActor.id,
                        tokenEpoch: replayActor.tokenEpoch, token: replayToken, machineKey: replayKey.secretKey });
                    expect(sharedReplay.statusCode, sharedReplay.body).toBe(403);
                    expect(sharedReplay.json()).toEqual({ ok: false, error: 'deployment_access_denied' });
                    expect(await read()).toMatchObject({ pendingAdmission: admission, pendingDeploy: next.pendingDeploy });
                }
                expect(writes, 'duplicate pending requests do no record or publication work').toBe(0);
                expect(await db.accountChange.findMany({ where: { accountId: owner.id }, orderBy: { entityId: 'asc' } })).toEqual(beforeReplay);
            } finally { stop(); }
            let latest = await preparePending('c'.repeat(40), pending.json().revision);
            const wrongEnvelope = mode === 'plain' ? { t: 'encrypted', c: 'opaque' } : { t: 'plain', v: {
                sourceIntent: { ...intentContent.sourceIntent, sha: 'c'.repeat(40) }, requestKey: latest.requestKey,
                actionOperationId: latest.actionOperationId, targetLinkId: input.targetLinkId } };
            const wrongMode = await app.inject({ method: 'POST', url: `${base}/deploy`, headers,
                payload: { ...latest, pendingDeploy: wrongEnvelope } });
            expect(wrongMode.json()).toEqual({ ok: false, error: 'deployment_content_unavailable' });
            const stale = await app.inject({ method: 'POST', url: `${base}/deploy`, headers,
                payload: { ...latest, expectedRevision: active.json().revision } });
            expect(stale.statusCode).toBe(409);
            if (latest.pendingDeploy.t === 'plain') {
                const mismatchedReview = await app.inject({ method: 'POST', url: `${base}/deploy`, headers,
                    payload: { ...latest, pendingDeploy: { t: 'plain', v: { ...latest.pendingDeploy.v,
                        expectedLinkRevision: latest.expectedTargetLinkRevision + 1 } } } });
                expect(mismatchedReview.statusCode, mismatchedReview.body).toBe(400);
            }
            let replaced = await signedDeploy(latest);
            expect(replaced.statusCode, replaced.body).toBe(200);
            const oldReplay = await app.inject({ method: 'POST', url: `${base}/deploy`, headers, payload: next });
            expect(oldReplay.statusCode).toBe(409);
            expect(await read()).toMatchObject({ ok: true, pendingDeploy: latest.pendingDeploy });
            const cancelPending = { serverId, environmentId, expectedRevision: replaced.json().revision,
                actionOperationId: latest.actionOperationId, pendingDeploy: latest.pendingDeploy };
            const unsignedCancel = await app.inject({ method: 'POST', url: `${base}/pending/cancel`, headers,
                payload: { ...cancelPending, actionOperationId: mode === 'plain' ? latest.actionOperationId : 'unopened-operation' } });
            expect(unsignedCancel.statusCode, unsignedCancel.body).toBe(403);
            expect(unsignedCancel.json()).toEqual({ ok: false, error: 'deployment_access_denied' });
            expect(await read()).toMatchObject({ ok: true, pendingDeploy: latest.pendingDeploy });
            const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
            const deniedCancel = await app.inject({ method: 'POST', url: `${base}/pending/cancel`,
                headers: { 'x-test-user-id': outsider.id }, payload: cancelPending });
            expect(deniedCancel.statusCode, deniedCancel.body).toBe(403);
            expect(deniedCancel.json()).toEqual({ ok: false, error: 'deployment_access_denied' });
            const coldAddress = { serverId, machineId, operationId: latest.actionOperationId };
            const unsignedColdCancel = await app.inject({ method: 'POST', url: '/v1/deployments/pending/cancel',
                headers, payload: coldAddress });
            expect(unsignedColdCancel.statusCode, unsignedColdCancel.body).toBe(403);
            expect(unsignedColdCancel.json()).toEqual({ ok: false, error: 'deployment_access_denied' });
            const { actionOperationId: _pendingOperation, ...reviewedDeploy } = latest;
            const wrongPurpose = await signedRequest('deployments.deploy', reviewedDeploy,
                '/v1/deployments/pending/cancel', coldAddress);
            expect(wrongPurpose.statusCode, wrongPurpose.body).toBe(401);
            expect(wrongPurpose.json()).toEqual({ error: 'invalid_token', authorizationRefusal: 'verification_purpose' });
            for (const malformedAddress of [{ ...coldAddress, operationId: null }, { ...coldAddress, extra: true },
                { ...coldAddress, serverId: `srv_${'e'.repeat(32)}` }]) {
                const malformedColdCancel = await signedRequest('action.operations.cancel', coldAddress,
                    '/v1/deployments/pending/cancel', malformedAddress);
                expect(malformedColdCancel.statusCode, malformedColdCancel.body).toBe(401);
                expect(malformedColdCancel.json()).toMatchObject({ error: 'invalid_token' });
            }
            expect(await read()).toMatchObject({ pendingDeploy: latest.pendingDeploy });
            const missingColdCancel = await signedColdCancel(crypto.randomUUID());
            expect(missingColdCancel.statusCode, missingColdCancel.body).toBe(200);
            expect(missingColdCancel.json()).toEqual({ kind: 'not_found' });
            if (replayActor) {
                const replayToken = await auth.createToken(replayActor.id, undefined, { kind: 'account', authority: 'present_user' });
                const foreignColdCancel = await signedColdCancel(latest.actionOperationId, { accountId: replayActor.id,
                    tokenEpoch: replayActor.tokenEpoch, token: replayToken, machineKey: replayKey.secretKey });
                expect(foreignColdCancel.statusCode, foreignColdCancel.body).toBe(200);
                expect(foreignColdCancel.json()).toEqual({ kind: 'not_found' });
                expect(await read()).toMatchObject({ pendingAdmission: { requesterAccountId: owner.id }, pendingDeploy: latest.pendingDeploy });
            }
            // A new installation on the same Machine receives fresh roots, but
            // cannot cancel an intent admitted to its predecessor installation.
            const reinstalledKey = nacl.sign.keyPair();
            const reinstalledId = crypto.randomUUID();
            await db.machine.update({ where: { id: machineId }, data: { installationId: reinstalledId,
                installationPublicKey: new Uint8Array(reinstalledKey.publicKey) } });
            try {
                const wrongInstallation = await signedColdCancel(latest.actionOperationId, {
                    accountId: owner.id, tokenEpoch: owner.tokenEpoch, token: accountToken, machineKey: accountKey.secretKey,
                    installation: { id: reinstalledId, privateKey: reinstalledKey.secretKey },
                });
                expect(wrongInstallation.statusCode, wrongInstallation.body).toBe(200);
                expect(wrongInstallation.json()).toEqual({ kind: 'not_found' });
                expect(await read()).toMatchObject({ pendingDeploy: latest.pendingDeploy });
            } finally {
                await db.machine.update({ where: { id: machineId }, data: { installationId,
                    installationPublicKey: new Uint8Array(installationKey.publicKey) } });
            }
            const staleCancel = await signedCancel({ ...cancelPending, expectedRevision: cancelPending.expectedRevision - 1 });
            expect(staleCancel.json()).toEqual({ ok: false, error: 'deployment_conflict' });
            const changedCancel = await signedCancel({ ...cancelPending, pendingDeploy: next.pendingDeploy });
            expect(changedCancel.json()).toEqual({ ok: false, error: 'deployment_conflict' });
            expect(await read()).toMatchObject({ ok: true, pendingDeploy: latest.pendingDeploy });
            const cancelledPending = await signedCancel(cancelPending);
            expect(cancelledPending.statusCode, cancelledPending.body).toBe(200);
            expect(await read()).not.toHaveProperty('pendingDeploy');
            expect(await db.deployment.count({ where: { environmentId } })).toBe(1);
            latest = await preparePending('c'.repeat(40), cancelledPending.json().revision);
            replaced = await signedDeploy(latest);
            expect(replaced.statusCode, replaced.body).toBe(200);
            const oldCancel = await signedCancel({ ...cancelPending, expectedRevision: replaced.json().revision });
            expect(oldCancel.json()).toEqual({ ok: false, error: 'deployment_conflict' });
            expect((await signedColdCancel(cancelPending.actionOperationId)).json()).toEqual({ kind: 'not_found' });
            expect(await read()).toMatchObject({ ok: true, pendingDeploy: latest.pendingDeploy });
            // Controller changes place future work without moving the retained
            // intent. Its original captured installation still owns cancellation.
            const replacementController = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
                metadata: machine.metadata, dataEncryptionKey: machine.dataEncryptionKey,
                installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(nacl.sign.keyPair().publicKey) } });
            if (team) await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'view', createdByAccountId: owner.id }), machineId: replacementController.id } });
            const transferred = await app.inject({ method: 'POST', url: `${base}/controller`, headers, payload: {
                serverId, environmentId, expectedRevision: replaced.json().revision, controllerMachineId: replacementController.id,
            } });
            expect(transferred.statusCode, transferred.body).toBe(200);
            if (collision) {
                const signer = { accountId: owner.id, tokenEpoch: owner.tokenEpoch, token: accountToken,
                    machineKey: accountKey.secretKey, machineId: collision.controller.id,
                    installation: { id: collision.controller.installationId!, privateKey: collision.key.secretKey } };
                const collisionIntent = { ...intentContent, machines: [collision.controller.id], buildMachineId: collision.controller.id };
                const collisionInput = { serverId, environmentId: collision.environmentId,
                    expectedRevision: collision.link.revision, targetLinkId: collision.link.targetLinkId,
                    expectedTargetLinkRevision: collision.link.targetLinkRevision, requestKey: crypto.randomUUID(),
                    actionOperationId: crypto.randomUUID(), ...await content('deployment-receipt.v1', collisionIntent) };
                const activeCollision = await signedDeploy(collisionInput, signer);
                expect(activeCollision.statusCode, activeCollision.body).toBe(200);
                const requestKey = crypto.randomUUID();
                const pendingCollision = await signedDeploy({ ...collisionInput, expectedRevision: activeCollision.json().revision,
                    requestKey, actionOperationId: latest.actionOperationId, whenBusy: 'supersede',
                    pendingDeploy: { t: 'plain', v: { sourceIntent: collisionIntent.sourceIntent, requestKey,
                        targetLinkId: collisionInput.targetLinkId, actionOperationId: latest.actionOperationId } },
                }, signer);
                expect(pendingCollision.statusCode, pendingCollision.body).toBe(200);
            }
            let coldCandidates = 0;
            const stopColdObservation = observeSqliteRequests({ after: (request, result) => {
                if (request.model === 'DeploymentEnvironment' && request.action === 'findFirst' && result !== null) coldCandidates++;
            } });
            try {
                const coldCancelled = await signedColdCancel(latest.actionOperationId);
                expect(coldCancelled.statusCode, coldCancelled.body).toBe(200);
                expect(coldCancelled.json()).toEqual({ kind: 'requested' });
                expect(coldCandidates, 'cold lookup materializes only the matching admission').toBe(1);
            } finally { stopColdObservation(); }
            const afterColdCancel = await read();
            expect(afterColdCancel).not.toHaveProperty('pendingDeploy');
            expect(afterColdCancel).not.toHaveProperty('pendingAdmission');
            if (collision) expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: collision.environmentId },
                select: { pendingDeployContent: true } })).toMatchObject({ pendingDeployContent: {
                    admission: { actionOperationId: latest.actionOperationId, controller: { machineId: collision.controller.id } },
                } });
            expect(await db.deployment.count({ where: { environmentId } })).toBe(1);
            expect(afterColdCancel.ok).toBe(true);
            if (!afterColdCancel.ok) throw new Error(afterColdCancel.error);
            const returned = await app.inject({ method: 'POST', url: `${base}/controller`, headers, payload: {
                serverId, environmentId, expectedRevision: afterColdCancel.environment.revision, controllerMachineId: machineId,
            } });
            expect(returned.statusCode, returned.body).toBe(200);
            latest = await preparePending('c'.repeat(40), returned.json().revision);
            replaced = await signedDeploy(latest);
            expect(replaced.statusCode, replaced.body).toBe(200);
            const settleBody: Omit<DeploymentTransitionInputV1, 'proof'> = { serverId, environmentId,
                deploymentId: active.json().deploymentId, expectedRevision: active.json().deploymentRevision,
                actionOperationId: input.actionOperationId, machineId, installationId, kind: 'settle', state: 'succeeded',
                expectedTargetLinkRevision: input.expectedTargetLinkRevision };
            const sign = (body: Omit<DeploymentTransitionInputV1, 'proof'>) => signMachineInstallationProof({
                payload: { version: 1, machineId, installationId, accountId: owner.id,
                    deploymentTransition: { serverId, environmentId, deploymentId: body.deploymentId,
                        expectedRevision: body.expectedRevision, actionOperationId: input.actionOperationId,
                        requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) } }, privateKey: installationKey.secretKey });
            if (mode === 'plain') {
                const runningBody: Omit<DeploymentTransitionInputV1, 'proof'> = { serverId, environmentId,
                    deploymentId: active.json().deploymentId, expectedRevision: active.json().deploymentRevision,
                    actionOperationId: input.actionOperationId, machineId, installationId, kind: 'stage', state: 'running' };
                const running = await app.inject({ method: 'POST', url: `${base}/deployments/${active.json().deploymentId}/transitions`,
                    headers, payload: { ...runningBody, proof: sign(runningBody) } });
                expect(running.statusCode, running.body).toBe(200);
                settleBody.expectedRevision = running.json().deploymentRevision;
            }
            const settled = await app.inject({ method: 'POST',
                url: `${base}/deployments/${active.json().deploymentId}/transitions`, headers, payload: {
                    ...(mode === 'plain' ? { ...settleBody, proof: sign(settleBody) } : { serverId, environmentId,
                        deploymentId: active.json().deploymentId, expectedReceiptRevision: active.json().deploymentRevision, kind: 'cancel' }),
                } });
            expect(settled.statusCode, settled.body).toBe(200);
            const ready = await read();
            expect(ready).toMatchObject({ ok: true, pendingDeploy: latest.pendingDeploy });
            if (!ready.ok) throw new Error(ready.error);
            const currentLinkRevision = ready.targetLinks.find(link => link.id === input.targetLinkId)!.revision;
            if (mode === 'plain') expect(currentLinkRevision).toBe(input.expectedTargetLinkRevision + 1);
            // The retained definition is exact; current native review may
            // produce a fresh transport Artifact before ordinary re-admission.
            const currentSourceIntent = { ...intentContent.sourceIntent, sha: 'c'.repeat(40) };
            const freshCandidate = await content('deployment-receipt.v1', { ...intentContent, sourceIntent: currentSourceIntent });
            let retainedIntent: unknown = latest.pendingDeploy.t === 'plain' ? latest.pendingDeploy.v : undefined;
            if (latest.pendingDeploy.t === 'encrypted') {
                const openedIntent = await openSessionDataKeyBundleV0(privacyKit.decodeBase64(latest.pendingDeploy.c), contentKey);
                if (openedIntent.status !== 'authenticated') throw new Error('Expected the retained pending fixture to authenticate');
                retainedIntent = openedIntent.value;
            }
            expect(retainedIntent).toMatchObject({ sourceIntent: currentSourceIntent });
            const retainedPlain = DeploymentPendingDeployV1Schema.parse({ t: 'plain', v: retainedIntent });
            if (retainedPlain.t !== 'plain') throw new Error('Expected an opened pending fixture');
            if (latest.pendingDeploy.t === 'encrypted') {
                const wrongOuterOperation = await app.inject({ method: 'POST', url: `${base}/deploy`, headers,
                    payload: { ...latest, expectedRevision: replaced.json().revision, expectedTargetLinkRevision: currentLinkRevision,
                        actionOperationId: crypto.randomUUID() } });
                expect(wrongOuterOperation.json()).toEqual({ ok: false, error: 'deployment_conflict' });
                expect(await read()).toMatchObject({ ok: true, pendingDeploy: latest.pendingDeploy });
            }
            for (const changedIntent of [
                { ...retainedPlain.v, actionOperationId: crypto.randomUUID() },
                { ...retainedPlain.v, sourceIntent: { ...currentSourceIntent, sha: 'e'.repeat(40) } },
            ]) {
                const changedEnvelope = mode === 'plain' ? { t: 'plain', v: changedIntent }
                    : { t: 'encrypted', c: privacyKit.encodeBase64(new Uint8Array(await sealSessionDataKeyBundleV0(changedIntent, contentKey))) };
                const changedClaim = await app.inject({ method: 'POST', url: `${base}/deploy`, headers,
                    payload: { ...latest, expectedRevision: replaced.json().revision, expectedTargetLinkRevision: currentLinkRevision,
                        actionOperationId: changedIntent.actionOperationId, pendingDeploy: changedEnvelope } });
                expect(changedClaim.json()).toEqual({ ok: false, error: 'deployment_conflict' });
            }
            expect(freshCandidate.contentArtifactId).not.toBe(latest.contentArtifactId);
            const claimInput = { ...latest, ...freshCandidate, expectedRevision: replaced.json().revision,
                expectedTargetLinkRevision: currentLinkRevision };
            const countBeforeUnsignedClaim = await db.deployment.count({ where: { environmentId } });
            const unsignedClaim = await app.inject({ method: 'POST', url: `${base}/deploy`, headers, payload: claimInput });
            expect(unsignedClaim.statusCode, unsignedClaim.body).toBe(403);
            expect(unsignedClaim.json()).toEqual({ ok: false, error: 'deployment_access_denied' });
            expect(await read()).toMatchObject({ ok: true, pendingDeploy: latest.pendingDeploy });
            expect(await db.deployment.count({ where: { environmentId } })).toBe(countBeforeUnsignedClaim);
            const claimed = await signedDeploy(claimInput);
            expect(claimed.statusCode, claimed.body).toBe(200);
            expect(DeploymentReceiptResultV1Schema.parse(claimed.json())).toMatchObject({ ok: true, state: 'queued',
                deploymentRevision: 1 });
            const afterClaim = await read();
            expect(afterClaim).not.toHaveProperty('pendingDeploy');
            expect(await db.deployment.count({ where: { environmentId, state: { in: ['queued', 'running'] } } })).toBe(1);
            const claimedReplay = await signedDeploy(claimInput);
            expect(claimedReplay.json()).toEqual(claimed.json());
            const wrongClaimArtifact = await signedDeploy({ ...claimInput,
                ...await content('deployment-receipt.v1', { ...intentContent, sourceIntent: currentSourceIntent }) });
            expect(wrongClaimArtifact.json()).toEqual({ ok: false, error: 'deployment_conflict' });
            const finalIntent = await preparePending('d'.repeat(40), claimed.json().revision, currentLinkRevision);
            const finalPending = await app.inject({ method: 'POST', url: `${base}/deploy`, headers, payload: finalIntent });
            expect(finalPending.statusCode, finalPending.body).toBe(200);
            const dataLink = await app.inject({ method: 'POST', url: `${base}/targets`, headers, payload: {
                serverId, environmentId, expectedRevision: finalPending.json().revision, requestKey: crypto.randomUUID(),
                source: { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'database' } },
                targetId: 'example.deploy/database', targetKind: 'database', role: 'data', machines: [],
                ...await content('deployment-target-link.v1', {}),
            } });
            expect(dataLink.statusCode, dataLink.body).toBe(200);
            expect(await read()).toMatchObject({ ok: true, pendingDeploy: finalIntent.pendingDeploy });
            const stopCurrent = await app.inject({ method: 'POST',
                url: `${base}/deployments/${claimed.json().deploymentId}/transitions`, headers, payload: {
                    serverId, environmentId, deploymentId: claimed.json().deploymentId,
                    expectedReceiptRevision: claimed.json().deploymentRevision, kind: 'cancel',
                } });
            expect(stopCurrent.statusCode, stopCurrent.body).toBe(200);
            const replacement = await app.inject({ method: 'POST', url: `${base}/targets`, headers, payload: {
                serverId, environmentId, expectedRevision: dataLink.json().revision, requestKey: crypto.randomUUID(),
                replacesLinkId: input.targetLinkId, expectedTargetLinkRevision: currentLinkRevision,
                targetId: 'own-server', role: 'runtime', machines: [{ machineId, installationId }],
                ...await content('deployment-target-link.v1', {}),
            } });
            expect(replacement.statusCode, replacement.body).toBe(200);
            expect(await read()).not.toHaveProperty('pendingDeploy');
            const changes = await db.accountChange.findMany({ where: { accountId: owner.id } });
            expect(JSON.stringify(changes)).not.toContain('sourceIntent');
            expect(JSON.stringify(changes)).not.toContain('d'.repeat(40));
            await db.deploymentEnvironment.update({ where: { id: environmentId },
                data: { pendingDeployContent: { t: 'plain', v: { unexpected: 'invalid retained content' } } } });
            const corrupt = await app.inject({ method: 'GET', url: `${base}?serverId=${serverId}`, headers });
            expect(corrupt.statusCode, corrupt.body).toBe(409);
            expect(corrupt.json()).toEqual({ ok: false, error: 'deployment_content_unavailable' });
        });
    });
});
