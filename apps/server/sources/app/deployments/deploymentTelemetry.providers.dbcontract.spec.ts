import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent,
    MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent,
    createPluginInstallationManifestPublisherSigningInputV1, PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
    stringifyPluginInstallationManifestCanonicalJsonV1, computeDeploymentTransitionRequestDigestV1 } from '@happier-dev/protocol';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionMachineRequestV1,
    encodeExternalActionResolvedTargetV1 } from '@happier-dev/protocol/actions';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { encodeReviewedActionChildHttpProofV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER, EXTERNAL_ACTION_REVIEWED_CHILD_HEADER,
    projectExternalActionDeploymentNativeEnvelopeAdmissionV1, createDeploymentEnvironmentContentArtifactIdV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { createDeploymentEnvironmentV1, createDeploymentTargetLinkV1,
    createDeploymentV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { db, getDbProviderFromEnv, initDbMysql, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { initEncrypt } from '@/modules/encrypt';
import { auth } from '@/app/auth/auth';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { currentAccountStoredContentCompatibilityHeaders } from '@/app/api/testkit/accountStoredContentCompatibility';

const provider = getDbProviderFromEnv(process.env, 'postgres');
describe.skipIf(provider !== 'postgres' && provider !== 'mysql')('deployment telemetry native storage and routing', () => {
    const serverId = `srv_${'e'.repeat(32)}`;
    const previousIdentity = process.env.HAPPIER_SERVER_IDENTITY_ID;
    const previousSecret = process.env.HANDY_MASTER_SECRET;
    beforeAll(async () => {
        const target = provider === 'mysql' ? process.env.HAPPIER_TEST_MYSQL_DATABASE_URL : process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID || !target || target !== process.env.DATABASE_URL) {
            throw new Error('Run with the disposable native DB-contract harness');
        }
        process.env.HAPPIER_SERVER_IDENTITY_ID = serverId;
        process.env.HANDY_MASTER_SECRET ??= 'deployment-telemetry-test-only';
        await initEncrypt();
        if (provider === 'mysql') await initDbMysql(); else initDbPostgres();
        await db.$connect();
        await auth.init();
    });
    afterAll(async () => {
        await db.$disconnect();
        if (previousIdentity === undefined) delete process.env.HAPPIER_SERVER_IDENTITY_ID;
        else process.env.HAPPIER_SERVER_IDENTITY_ID = previousIdentity;
        if (previousSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
        else process.env.HANDY_MASTER_SECRET = previousSecret;
    });

    async function fixture() {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const nextCustodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(custodian.id, owner.id);
        await makeShareEligibleForTest(nextCustodian.id, owner.id);
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: randomUUID(), name: 'Production telemetry', audience: [],
        }));
        if (!source.ok) throw new Error(source.error);
        const keys = nacl.sign.keyPair();
        const machine = (accountId: string) => db.machine.create({ data: { id: randomUUID(), accountId,
            active: true, metadata: encodePlainMachineStoredContent({ host: 'Telemetry', platform: 'linux',
                happyCliVersion: 'test', homeDir: '/home/telemetry', happyHomeDir: '/home/telemetry/.happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            installationId: randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey) } });
        const controller = await machine(owner.id);
        const oldCollector = await machine(custodian.id);
        const newCollector = await machine(nextCustodian.id);
        await db.machineGrant.createMany({ data: [oldCollector, newCollector].map(collector => ({
            machineId: collector.id, principalKind: 'account', accountId: owner.id, accessLevel: 'view', createdByAccountId: collector.accountId,
        })) });
        const definition = createDeploymentEnvironmentV1().content;
        if (definition.t !== 'plain') throw new Error('Expected plain fixture');
        const createPlainArtifact = (artifactId: string, kind: string, value: unknown) => createArtifact({ actorUserId: owner.id, artifactId,
            kind: `v1:other:${kind}`,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Telemetry' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(value) })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        const createContentArtifact = (artifactId: string, telemetry?: { metrics: boolean; appLlmCost: boolean; exceptions: boolean }) =>
            createPlainArtifact(artifactId, 'deployment-environment.v1', { ...definition.v, ...(telemetry ? { telemetry } : {}) });
        const createReference = async (kind: 'deployment-target-link.v1' | 'deployment-receipt.v1') => {
            const content = kind === 'deployment-target-link.v1' ? createDeploymentTargetLinkV1().content : createDeploymentV1().content;
            if (content.t !== 'plain') throw new Error('Expected plain fixture');
            const result = await createPlainArtifact(randomUUID(), kind, content.v);
            if (!result.ok) throw new Error(result.error);
            return { contentArtifactId: result.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const artifact = await createContentArtifact(randomUUID());
        if (!artifact.ok) throw new Error(artifact.error);
        const reference = { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: owner.id, controllerMachineId: controller.id, protection: 'nonProduction', purpose: 'standard',
            deployerMode: 'managers', referencedSavedSecretRevisions: [], ...reference } });
        return { owner, custodian, controller, oldCollector, newCollector, environment, reference, keys, createContentArtifact, createReference };
    }

    it('writes placement through one bindings CAS and publishes only actual changes to both collector Accounts', async () => {
        const f = await fixture();
        const ownerBearer = await auth.createToken(f.owner.id, undefined, { kind: 'account', authority: 'present_user' });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const write = (expectedRevision: number, telemetryMachineId: string | null) => app.inject({ method: 'POST',
                url: `/v1/deployments/environments/${f.environment.id}/bindings`, headers: { authorization: `Bearer ${ownerBearer}` },
                payload: { serverId, environmentId: f.environment.id, expectedRevision, ...f.reference,
                    referencedSavedSecretRevisions: [], grants: [], telemetryMachineId } });
            // G1: the Source can use another Account's collector without Manage on that Machine.
            const setup = await write(1, f.oldCollector.id);
            expect(setup.statusCode, setup.body).toBe(200);
            expect(setup.json()).toMatchObject({ ok: true, revision: 2 });
            expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } }))
                .toMatchObject({ telemetryMachineId: f.oldCollector.id, telemetryTokenHash: null });
            const read = await app.inject({ method: 'GET',
                url: `/v1/deployments/environments/${f.environment.id}?serverId=${serverId}`,
                headers: { ...currentAccountStoredContentCompatibilityHeaders, authorization: `Bearer ${ownerBearer}` } });
            expect(read.statusCode, read.body).toBe(200);
            expect(read.json()).toMatchObject({ ok: true, environment: { telemetryMachineId: f.oldCollector.id } });
            const changes = () => db.accountChange.findMany({ where: { accountId: { in: [f.oldCollector.accountId, f.newCollector.accountId] }, kind: 'machine',
                entityId: { in: [f.oldCollector.id, f.newCollector.id] } }, orderBy: { cursor: 'asc' } });
            const initial = await changes();
            expect(initial.map(change => change.entityId)).toEqual([f.oldCollector.id]);
            const references = await app.inject({ method: 'GET',
                url: `/v1/deployments/machine-references?homeId=${serverId}&machineId=${f.oldCollector.id}`,
                headers: { authorization: `Bearer ${ownerBearer}` } });
            expect(references.statusCode, references.body).toBe(200);
            expect(references.json().references).toContainEqual(expect.objectContaining({
                deploymentRoles: ['telemetry'],
            }));
            expect((await write(2, f.oldCollector.id)).json()).toMatchObject({ ok: true, revision: 2 });
            expect(await changes()).toEqual(initial);
            expect((await write(2, f.newCollector.id)).json()).toMatchObject({ ok: true, revision: 3 });
            const moved = await changes();
            expect(moved.map(change => change.entityId).sort()).toEqual([f.oldCollector.id, f.newCollector.id].sort());
            expect(moved.find(change => change.entityId === f.oldCollector.id)!.cursor).toBeGreaterThan(initial[0]!.cursor);
            await db.machineGrant.deleteMany({ where: { machineId: f.oldCollector.id } });
            const refused = await write(3, f.oldCollector.id);
            expect(refused.statusCode, refused.body).toBe(503);
            expect(refused.json()).toMatchObject({ ok: false, error: 'machine_unavailable', role: 'telemetry' });
            expect((await write(3, null)).json()).toMatchObject({ ok: true, revision: 4 });
            const disabled = await changes();
            expect(disabled.map(change => change.entityId).sort()).toEqual([f.oldCollector.id, f.newCollector.id].sort());
            expect(disabled.find(change => change.entityId === f.newCollector.id)!.cursor)
                .toBeGreaterThan(moved.find(change => change.entityId === f.newCollector.id)!.cursor);
        }, { authentication: 'real' });
    });

    it('spends explicit collector admission after withdrawal while refusing new direct and default selection', async () => {
        const f = await fixture();
        const actionId = 'deployments.environments.telemetry.set';
        const bindingAction = 'deployments.bindings.set';
        const target = { kind: 'machine' as const, machineId: f.controller.id };
        const original = { serverId, environmentId: f.environment.id, expectedRevision: 1 };
        const mint = async (explicit: boolean) => {
            const input = { ...original, ...(explicit ? { collector: { machineId: f.oldCollector.id } } : {}) };
            const requestId = randomUUID();
            const authentication = { kind: 'account' as const, tokenEpoch: f.owner.tokenEpoch };
            const envelope = { v: 1 as const, requestId, target, input };
            return auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId, accountId: f.owner.id,
                authentication, actionId, machineId: f.controller.id, target, requestId,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) },
                { input, deploymentNativeAdmission: projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope }) });
        };
        const explicit = await mint(true);
        const discoveredDefault = await mint(false);
        const reviewedChild = { actionId: bindingAction, role: 'telemetry.bindings',
            inputDigest: computeActionInputApprovalDigestV1(bindingAction,
                { ...original, set: [], remove: [], telemetryMachineId: f.oldCollector.id }) };
        const prepare = async (authorization: typeof explicit) => {
            const artifactId = createDeploymentEnvironmentContentArtifactIdV1({ ...authorization.binding,
                actionId: bindingAction, environmentId: f.environment.id });
            expect(await f.createContentArtifact(artifactId)).toMatchObject({ ok: true });
            const body = { ...original, contentArtifactId: artifactId, contentHeaderVersion: 1, contentBodyVersion: 1,
                referencedSavedSecretRevisions: [], grants: [], telemetryMachineId: f.oldCollector.id };
            const path = `/v1/deployments/environments/${f.environment.id}/bindings`;
            const headers = { ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: bindingAction,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(reviewedChild),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: authorization.token, effectActionId: bindingAction, target,
                    installationId: f.controller.installationId!, requestId: authorization.binding.requestId,
                    method: 'POST', path, body, reviewedChild, privateKey: f.keys.secretKey }) };
            return { path, body, headers };
        };
        const admitted = await prepare(explicit);
        const defaultSelection = await prepare(discoveredDefault);
        await db.machineGrant.deleteMany({ where: { machineId: f.oldCollector.id } });
        const bearer = await auth.createToken(f.owner.id, undefined, { kind: 'account', authority: 'present_user' });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const direct = await app.inject({ method: 'POST', url: admitted.path,
                headers: { authorization: `Bearer ${bearer}` }, payload: { ...admitted.body, ...f.reference } });
            expect(direct.statusCode, direct.body).toBe(503);
            const currentDefault = await app.inject({ method: 'POST', url: defaultSelection.path,
                headers: defaultSelection.headers, payload: defaultSelection.body });
            expect(currentDefault.statusCode, currentDefault.body).toBe(503);
            const spent = await app.inject({ method: 'POST', url: admitted.path, headers: admitted.headers, payload: admitted.body });
            expect(spent.statusCode, spent.body).toBe(200);
            expect(spent.json()).toMatchObject({ ok: true, revision: 2 });
        }, { authentication: 'real' });
    });

    it('returns only the authenticated Machine assignments and replaces the token only at signed deploy settlement', async () => {
        const f = await fixture();
        const ownerBearer = await auth.createToken(f.owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const collectorBearer = await auth.createToken(f.custodian.id, undefined, { kind: 'account', authority: 'present_user' });
        const nextCollectorBearer = await auth.createToken(f.newCollector.accountId, undefined, { kind: 'account', authority: 'present_user' });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            let reference = f.reference;
            let previousCapabilities: string | undefined;
            const write = async (expectedRevision: number, telemetryMachineId: string | null,
                telemetryCapabilities?: { metrics: boolean; appLlmCost: boolean; exceptions: boolean }) => {
                if (telemetryCapabilities && JSON.stringify(telemetryCapabilities) !== previousCapabilities) {
                    const artifact = await f.createContentArtifact(randomUUID(), telemetryCapabilities);
                    if (!artifact.ok) throw new Error(artifact.error);
                    reference = { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
                    previousCapabilities = JSON.stringify(telemetryCapabilities);
                }
                return app.inject({ method: 'POST',
                    url: `/v1/deployments/environments/${f.environment.id}/bindings`, headers: { authorization: `Bearer ${ownerBearer}` },
                    payload: { serverId, environmentId: f.environment.id, expectedRevision, ...reference,
                        referencedSavedSecretRevisions: [], grants: [], telemetryMachineId,
                        ...(telemetryCapabilities ? { telemetryCapabilities } : {}) } });
            };
            expect((await write(1, f.oldCollector.id)).statusCode).toBe(200);
            const assignments = async (machine = f.oldCollector,
                bearer = machine.id === f.oldCollector.id ? collectorBearer : nextCollectorBearer, signed = true,
                publisher = machine) => {
                const path = `/v1/deployments/machines/${machine.id}/telemetry-assignments`;
                const proof = { v: 1 as const, alg: 'ed25519-machine-installation-v1' as const,
                    machineId: publisher.id, installationId: publisher.installationId!, issuedAt: Date.now(), nonce: randomUUID(),
                    method: 'POST' as const, path, bodySha256Base64Url: createHash('sha256')
                        .update(stringifyPluginInstallationManifestCanonicalJsonV1({})).digest('base64url') };
                const signature = nacl.sign.detached(createPluginInstallationManifestPublisherSigningInputV1({ proof }), f.keys.secretKey);
                const header = encodeBase64(new TextEncoder().encode(JSON.stringify({ proof: { ...proof,
                    signatureBase64Url: encodeBase64(signature, 'base64url') } })), 'base64url');
                return app.inject({ method: 'POST', url: path, payload: {}, headers: { authorization: `Bearer ${bearer}`,
                    ...(signed ? { [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: header } : {}) } });
            };
            // G1: a real collector installation reads even though it cannot read the Environment's Source.
            expect((await assignments()).json()).toEqual({ ok: true,
                assignments: [{ environmentId: f.environment.id, tokenHash: null,
                    capabilities: { metrics: false, appLlmCost: false, exceptions: false } }] });
            const selected = { metrics: true, appLlmCost: false, exceptions: true };
            const changed = await write(2, f.oldCollector.id, selected);
            expect(changed.statusCode, changed.body).toBe(200);
            expect((await assignments()).json()).toEqual({ ok: true,
                assignments: [{ environmentId: f.environment.id, tokenHash: null, capabilities: selected }] });
            // D34: a Team-owned Project's Team travels with the assignment for the native issue writer's grants.
            await db.projectSource.update({ where: { id: f.environment.projectSourceId }, data: { owner: { kind: 'team', teamId: 'team-d34' } } });
            expect((await assignments()).json()).toEqual({ ok: true,
                assignments: [{ environmentId: f.environment.id, tokenHash: null, capabilities: selected, teamId: 'team-d34' }] });
            await db.projectSource.update({ where: { id: f.environment.projectSourceId }, data: { owner: { kind: 'account', accountId: f.owner.id } } });
            const mismatched = await app.inject({ method: 'POST',
                url: `/v1/deployments/environments/${f.environment.id}/bindings`, headers: { authorization: `Bearer ${ownerBearer}` },
                payload: { serverId, environmentId: f.environment.id, expectedRevision: 3, ...reference,
                    referencedSavedSecretRevisions: [], grants: [], telemetryMachineId: f.oldCollector.id,
                    telemetryCapabilities: { ...selected, metrics: false } } });
            expect(mismatched.statusCode, mismatched.body).toBe(409);
            expect((await assignments(f.newCollector)).json()).toEqual({ ok: true, assignments: [] });
            expect((await assignments(f.oldCollector, ownerBearer)).statusCode).toBe(403);
            expect((await assignments(f.oldCollector, collectorBearer, false)).statusCode).toBe(403);
            expect((await assignments(f.newCollector, collectorBearer, true, f.oldCollector)).statusCode).toBe(403);

            const link = await db.deploymentTargetLink.create({ data: { environmentId: f.environment.id,
                createdByAccountId: f.owner.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
                targetKind: 'ownServer', state: 'configured', ...await f.createReference('deployment-target-link.v1') } });
            await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: { runtimeTargetLinkId: link.id } });
            const receipt = await db.deployment.create({ data: { environmentId: f.environment.id, targetLinkId: link.id,
                requestedByAccountId: f.owner.id, requestKey: randomUUID(), actionOperationId: randomUUID(),
                operation: 'deploy', state: 'running', acceptedControllerMachineId: f.controller.id,
                acceptedControllerInstallationId: f.controller.installationId, ...await f.createReference('deployment-receipt.v1') } });
            const hash = createHash('sha256').update('delivered-test-token').digest('hex');
            const body = { kind: 'settle' as const, serverId, environmentId: f.environment.id, deploymentId: receipt.id,
                actionOperationId: receipt.actionOperationId, expectedRevision: 1, machineId: f.controller.id,
                installationId: f.controller.installationId!, state: 'succeeded' as const,
                expectedTargetLinkRevision: 1, telemetryMachineId: f.oldCollector.id, telemetryTokenHash: hash };
            const proof = signMachineInstallationProof({ payload: { version: 1, machineId: f.controller.id,
                installationId: f.controller.installationId!, accountId: f.owner.id, deploymentTransition: {
                    serverId, environmentId: f.environment.id, deploymentId: receipt.id, actionOperationId: receipt.actionOperationId,
                    expectedRevision: 1, requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) } },
                privateKey: f.keys.secretKey });
            const settle = await app.inject({ method: 'POST',
                url: `/v1/deployments/environments/${f.environment.id}/deployments/${receipt.id}/transitions`,
                headers: { authorization: `Bearer ${ownerBearer}` }, payload: { ...body, proof } });
            expect(settle.statusCode, settle.body).toBe(200);
            expect((await assignments()).json()).toEqual({ ok: true,
                assignments: [{ environmentId: f.environment.id, tokenHash: hash, capabilities: selected }] });
            const publication = await db.accountChange.findFirstOrThrow({ where: { accountId: f.custodian.id,
                kind: 'machine', entityId: f.oldCollector.id } });
            const replay = await app.inject({ method: 'POST',
                url: `/v1/deployments/environments/${f.environment.id}/deployments/${receipt.id}/transitions`,
                headers: { authorization: `Bearer ${ownerBearer}` }, payload: { ...body, proof } });
            expect(replay.statusCode, replay.body).toBe(200);
            expect(await db.accountChange.findFirstOrThrow({ where: { accountId: f.custodian.id,
                kind: 'machine', entityId: f.oldCollector.id } })).toEqual(publication);
            const failed = await db.deployment.create({ data: { environmentId: f.environment.id, targetLinkId: link.id,
                requestedByAccountId: f.owner.id, requestKey: randomUUID(), actionOperationId: randomUUID(),
                operation: 'deploy', state: 'running', acceptedControllerMachineId: f.controller.id,
                acceptedControllerInstallationId: f.controller.installationId, ...await f.createReference('deployment-receipt.v1') } });
            const { expectedTargetLinkRevision: _linkRevision, ...terminalBody } = body;
            const failedBody = { ...terminalBody, deploymentId: failed.id, actionOperationId: failed.actionOperationId,
                state: 'failed' as const, telemetryTokenHash: 'c'.repeat(64) };
            const failedProof = signMachineInstallationProof({ payload: { version: 1, machineId: f.controller.id,
                installationId: f.controller.installationId!, accountId: f.owner.id, deploymentTransition: {
                    serverId, environmentId: f.environment.id, deploymentId: failed.id, actionOperationId: failed.actionOperationId,
                    expectedRevision: 1, requestBodyDigest: computeDeploymentTransitionRequestDigestV1(failedBody) } },
                privateKey: f.keys.secretKey });
            expect((await app.inject({ method: 'POST',
                url: `/v1/deployments/environments/${f.environment.id}/deployments/${failed.id}/transitions`,
                headers: { authorization: `Bearer ${ownerBearer}` }, payload: { ...failedBody, proof: failedProof } })).statusCode).toBe(200);
            expect((await assignments()).json()).toEqual({ ok: true,
                assignments: [{ environmentId: f.environment.id, tokenHash: hash, capabilities: selected }] });
            expect(await db.accountChange.findFirstOrThrow({ where: { accountId: f.custodian.id,
                kind: 'machine', entityId: f.oldCollector.id } })).toEqual(publication);
            const disabled = { ...selected, metrics: false };
            const disabledWrite = await write(3, f.oldCollector.id, disabled);
            expect(disabledWrite.statusCode, disabledWrite.body).toBe(200);
            expect((await assignments()).json()).toEqual({ ok: true,
                assignments: [{ environmentId: f.environment.id, tokenHash: hash, capabilities: disabled }] });
            const disabledPublication = await db.accountChange.findFirstOrThrow({ where: { accountId: f.custodian.id,
                kind: 'machine', entityId: f.oldCollector.id } });
            const unchanged = await write(4, f.oldCollector.id, disabled);
            expect(unchanged.json()).toMatchObject({ ok: true, revision: 4 });
            expect(await db.accountChange.findFirstOrThrow({ where: { accountId: f.custodian.id,
                kind: 'machine', entityId: f.oldCollector.id } })).toEqual(disabledPublication);
            expect((await write(4, f.newCollector.id)).statusCode).toBe(200);
            expect((await assignments()).json()).toEqual({ ok: true, assignments: [] });
            expect((await assignments(f.newCollector)).json()).toEqual({ ok: true,
                assignments: [{ environmentId: f.environment.id, tokenHash: null, capabilities: disabled }] });
            const late = await db.deployment.create({ data: { environmentId: f.environment.id, targetLinkId: link.id,
                requestedByAccountId: f.owner.id, requestKey: randomUUID(), actionOperationId: randomUUID(),
                operation: 'deploy', state: 'running', acceptedControllerMachineId: f.controller.id,
                acceptedControllerInstallationId: f.controller.installationId, ...await f.createReference('deployment-receipt.v1') } });
            const lateBody = { ...body, deploymentId: late.id, actionOperationId: late.actionOperationId,
                expectedTargetLinkRevision: 2, telemetryTokenHash: 'b'.repeat(64) };
            const lateProof = signMachineInstallationProof({ payload: { version: 1, machineId: f.controller.id,
                installationId: f.controller.installationId!, accountId: f.owner.id, deploymentTransition: {
                    serverId, environmentId: f.environment.id, deploymentId: late.id, actionOperationId: late.actionOperationId,
                    expectedRevision: 1, requestBodyDigest: computeDeploymentTransitionRequestDigestV1(lateBody) } },
                privateKey: f.keys.secretKey });
            const lateSettle = await app.inject({ method: 'POST',
                url: `/v1/deployments/environments/${f.environment.id}/deployments/${late.id}/transitions`,
                headers: { authorization: `Bearer ${ownerBearer}` }, payload: { ...lateBody, proof: lateProof } });
            expect(lateSettle.statusCode, lateSettle.body).toBe(200);
            expect((await assignments(f.newCollector)).json()).toEqual({ ok: true,
                assignments: [{ environmentId: f.environment.id, tokenHash: null, capabilities: disabled }] });
            const beforeRemoval = await db.accountChange.findFirstOrThrow({ where: { accountId: f.newCollector.accountId,
                kind: 'machine', entityId: f.newCollector.id } });
            const removed = await app.inject({ method: 'POST',
                url: `/v1/deployments/environments/${f.environment.id}/delete`,
                headers: { authorization: `Bearer ${ownerBearer}` }, payload: { serverId, environmentId: f.environment.id,
                    expectedRevision: 5, requestKey: randomUUID(), detachKeepRunning: true } });
            expect(removed.statusCode, removed.body).toBe(200);
            expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } }))
                .toMatchObject({ telemetryMachineId: null, telemetryTokenHash: null });
            expect((await assignments()).json()).toEqual({ ok: true, assignments: [] });
            expect((await assignments(f.newCollector)).json()).toEqual({ ok: true, assignments: [] });
            expect((await db.accountChange.findFirstOrThrow({ where: { accountId: f.newCollector.accountId,
                kind: 'machine', entityId: f.newCollector.id } })).cursor).toBeGreaterThan(beforeRemoval.cursor);
            expect((await db.accountChange.findFirstOrThrow({ where: { accountId: f.custodian.id,
                kind: 'machine', entityId: f.oldCollector.id } })).cursor).toBeGreaterThan(publication.cursor);
        }, { authentication: 'real' });
    });
});
