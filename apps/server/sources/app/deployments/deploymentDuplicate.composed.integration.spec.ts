import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent, DeploymentEnvironmentCreateResultV1Schema, DeploymentEnvironmentCreateStorageInputV1Schema,
    encodePlainArtifactStoredContent, sealEncryptedDataKeyEnvelopeV1, sealSessionDataKeyBundleV0 } from '@happier-dev/protocol';
import { DeploymentEnvironmentContentV1Schema, DeploymentTargetLinkContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { MachineSecretGrantV1Schema } from '@happier-dev/protocol/deployments/machineSecretGrantV1';
import { db } from '@/storage/db';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { inTx } from '@/storage/inTx';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { createDeploymentEnvironmentInTx } from './deploymentEnvironmentService';
import { syncEnvironmentSecretGrantsInTx } from './environmentSecretGrantRepository';

describe('Duplicate through the Environment create HTTP/storage boundary', () => {
    const serverId = `srv_${'a'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-deployment-duplicate-', initEncrypt: true, initAuth: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: serverId, AUTH_REQUIRED_LOGIN_PROVIDERS: '' } });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function fixture(mode: 'plain' | 'e2ee') {
        const keys = nacl.box.keyPair();
        const account = () => db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(keys.publicKey) : {}) } });
        const sourceOwner = await account();
        const actor = await account();
        await makeShareEligibleForTest(sourceOwner.id, actor.id);
        const source = await inTx(tx => createProjectSourceInTx(tx, sourceOwner.id, { serverId,
            requestKey: crypto.randomUUID(), name: 'Readable original',
            audience: [{ principal: { kind: 'account', accountId: actor.id }, level: 'view' }] }));
        const destination = await inTx(tx => createProjectSourceInTx(tx, actor.id, { serverId,
            requestKey: crypto.randomUUID(), name: 'Managed destination', audience: [] }));
        if (!source.ok || !destination.ok) throw new Error('Expected admitted Source fixtures');
        // Machine content matches the Account mode, as Machine admission requires.
        const machineContent = mode === 'plain' ? { metadata: encodePlainMachineStoredContent({ host: 'Duplicate', platform: 'linux',
            happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } : { metadata: '{}' };
        const sourceMachine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: sourceOwner.id,
            ...machineContent, installationId: crypto.randomUUID() } });
        const destinationMachine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: actor.id,
            ...machineContent, installationId: crypto.randomUUID() } });
        const artifactFor = async (accountId: string, name: string,
            kind: 'deployment-environment.v1' | 'deployment-target-link.v1' = 'deployment-environment.v1') => {
            const document = '{"services":{"app":{"image":"app:1"}}}';
            const content = kind === 'deployment-target-link.v1' ? DeploymentTargetLinkContentV1Schema.parse({})
                : DeploymentEnvironmentContentV1Schema.parse({ name, retainPreviousDeployments: 1, bindings: [],
                definition: { kind: 'stored', contentRevision: 1, document, profiles: [], services: ['app'],
                    composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}` } });
            const resourceKey = nacl.randomBytes(32);
            const seal = async (value: unknown) => mode === 'plain'
                ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(value))
                : new Uint8Array(await sealSessionDataKeyBundleV0(value, resourceKey));
            const result = await createArtifact({ actorUserId: accountId, artifactId: crypto.randomUUID(),
                kind: `v1:other:${kind}`,
                header: await seal({ kind, title: name }),
                body: await seal({ body: JSON.stringify(content) }),
                dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)
                    : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: resourceKey,
                        recipientPublicKey: keys.publicKey, randomBytes: nacl.randomBytes })) });
            if (!result.ok) throw new Error(result.error);
            return { contentArtifactId: result.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const originalContent = await artifactFor(sourceOwner.id, 'Original');
        const original = await inTx(tx => createDeploymentEnvironmentInTx(tx, sourceOwner.id, { serverId,
            projectSourceId: source.source.id, requestKey: crypto.randomUUID(), protection: 'production', purpose: 'standard',
            deployerMode: 'managers', controllerMachineId: sourceMachine.id, ...originalContent }));
        if (!original.ok) throw new Error(original.error);
        const prepared = await artifactFor(actor.id, 'Independent copy');
        const input = { serverId, projectSourceId: destination.source.id, requestKey: crypto.randomUUID(),
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: destinationMachine.id, ...prepared,
            copyIntentCommitment: createHash('sha256').update('reviewed-independent-copy-fixture').digest('base64url'),
            copyFrom: { environmentId: original.environmentId, expectedRevision: original.revision } };
        return { actor, sourceOwner, sourceMachine, source, destination, original, originalContent, input, artifactFor };
    }

    it.each(['plain', 'e2ee'] as const)('creates an independent %s Environment from a readable source and preserves acknowledged retry custody', async mode => {
        const f = await fixture(mode);
        // Persisted running/history facts are inputs to Duplicate, never copy instructions.
        const target = await db.deploymentTargetLink.create({ data: { environmentId: f.original.environmentId,
            createdByAccountId: f.actor.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'deployed', ...f.originalContent } });
        const receipt = await db.deployment.create({ data: { environmentId: f.original.environmentId, targetLinkId: target.id,
            operation: 'deploy', state: 'succeeded', requestedByAccountId: f.actor.id, requestKey: crypto.randomUUID(),
            actionOperationId: crypto.randomUUID(), approvalId: crypto.randomUUID(), ...f.originalContent } });
        await db.deploymentTargetLink.update({ where: { id: target.id }, data: { activeDeploymentId: receipt.id } });
        await db.deploymentEnvironment.update({ where: { id: f.original.environmentId }, data: { runtimeTargetLinkId: target.id } });
        await inTx(tx => syncEnvironmentSecretGrantsInTx(tx, { environmentId: f.original.environmentId,
            grants: [MachineSecretGrantV1Schema.parse({ v: 1, kind: 'environmentValues', environmentId: f.original.environmentId,
                machineId: f.sourceMachine.id, installationId: f.sourceMachine.installationId!,
                binding: { purpose: 'variable', phase: 'runtime', grantRef: crypto.randomUUID() },
                sealedContent: privacyKit.encodeBase64(nacl.randomBytes(48)) })] }));
        expect(await db.machineSecretGrant.count({ where: { environmentId: f.original.environmentId } })).toBe(1);
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const post = (payload: unknown) => app.inject({ method: 'POST', url: '/v1/deployments/environments',
                headers: { 'x-test-user-id': f.actor.id }, payload });
            const requests: { model?: string; action: string; args: unknown }[] = [];
            const stop = observeSqliteRequests({ before: request => {
                requests.push({ model: request.model, action: request.action, args: request.args });
            } });
            const response = await (async () => { try { return await post(f.input); } finally { stop(); } })();
            expect(response.statusCode).toBe(200);
            const created = DeploymentEnvironmentCreateResultV1Schema.parse(response.json());
            if (!created.ok) throw new Error(created.error);
            expect(created.environmentId).not.toBe(f.original.environmentId);
            expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: created.environmentId } })).toMatchObject({
                projectSourceId: f.destination.source.id, createdByAccountId: f.actor.id,
                contentArtifactId: f.input.contentArtifactId, controllerMachineId: f.input.controllerMachineId,
                protection: 'nonProduction', runtimeTargetLinkId: null, previewTemplateEnvironmentId: null,
                referencedSavedSecretRevisions: [], pendingDeployContent: null,
            });
            expect(await db.deploymentTargetLink.count({ where: { environmentId: created.environmentId } })).toBe(0);
            expect(await db.deployment.count({ where: { environmentId: created.environmentId } })).toBe(0);
            expect(await db.machineSecretGrant.count({ where: { environmentId: created.environmentId } })).toBe(0);
            // Admission reads one source header, and cannot open its unshared private Artifact.
            const sourceReads = requests.filter(request => request.model === 'DeploymentEnvironment'
                && request.action === 'findUnique' && JSON.stringify(request.args).includes(f.original.environmentId));
            expect(sourceReads).toHaveLength(1);
            expect(requests.filter(request => request.model === 'Artifact')
                .some(request => JSON.stringify(request.args).includes(f.originalContent.contentArtifactId))).toBe(false);
            await db.deploymentEnvironment.update({ where: { id: f.original.environmentId }, data: { revision: { increment: 1 } } });
            const retry = await post(f.input);
            expect(retry.statusCode).toBe(200);
            expect(retry.json()).toEqual({ ...created, replayed: true });
            expect((await post({ ...f.input, copyFrom: { ...f.input.copyFrom, expectedRevision: 2 } })).json())
                .toEqual({ ok: false, error: 'deployment_conflict' });
            const changedContent = await f.artifactFor(f.actor.id, 'Changed prepared copy');
            expect((await post({ ...f.input, ...changedContent,
                copyIntentCommitment: createHash('sha256').update('changed-prepared-copy-fixture').digest('base64url') })).json())
                .toEqual({ ok: false, error: 'deployment_conflict' });
            expect(await db.deploymentEnvironment.count({ where: { projectSourceId: f.destination.source.id } })).toBe(1);
            await db.projectSource.update({ where: { id: f.source.source.id }, data: { audience: [] } });
            expect((await post(f.input)).json()).toEqual({ ok: false, error: 'deployment_unavailable' });
            // A source revocation affects the next request, not the independent acknowledged destination.
            expect(await db.deploymentEnvironment.count({ where: { id: created.environmentId, deletedAt: null } })).toBe(1);
        });
    });

    it.each(['plain', 'e2ee'] as const)('replays the committed %s copy intent after fresh Artifact materialization and conflicts on changed commitment or source CAS', async mode => {
        const f = await fixture(mode);
        // The host owns this opaque commitment; this owner only binds its exact
        // value into the existing requestKey digest, without opening choices.
        const copyIntentCommitment = createHash('sha256').update('reviewed-copy-fixture').digest('base64url');
        const input = DeploymentEnvironmentCreateStorageInputV1Schema.parse({ ...f.input, copyIntentCommitment,
            firstTargetLink: { ...await f.artifactFor(f.actor.id, 'Runtime', 'deployment-target-link.v1'),
                machines: [{ machineId: f.input.controllerMachineId,
                    installationId: (await db.machine.findUniqueOrThrow({ where: { id: f.input.controllerMachineId } })).installationId }] } });
        const create = (prepared: typeof input) => inTx(tx => createDeploymentEnvironmentInTx(tx, f.actor.id, prepared));
        const created = await create(input);
        if (!created.ok) throw new Error(created.error);
        const rematerialized = { ...await f.artifactFor(f.actor.id, 'Independent copy'),
            firstTargetLink: { ...await f.artifactFor(f.actor.id, 'Runtime', 'deployment-target-link.v1'),
                machines: input.firstTargetLink?.machines ?? [] } };
        expect(rematerialized.contentArtifactId).not.toBe(input.contentArtifactId);
        // Already acknowledged work survives a later source revision, while a
        // new source CAS or reviewed configuration still changes the intent.
        await db.deploymentEnvironment.update({ where: { id: f.original.environmentId }, data: { revision: { increment: 1 } } });
        expect.soft(await create({ ...input, ...rematerialized })).toEqual({ ...created, replayed: true });
        expect(await create({ ...input, ...rematerialized,
            copyIntentCommitment: createHash('sha256').update('changed-reviewed-copy-fixture').digest('base64url') }))
            .toEqual({ ok: false, error: 'deployment_conflict' });
        expect(await create({ ...input, ...rematerialized,
            copyFrom: { environmentId: f.original.environmentId, expectedRevision: f.original.revision + 1 } }))
            .toEqual({ ok: false, error: 'deployment_conflict' });
        expect(await create({ ...input, ...rematerialized,
            firstTargetLink: { ...rematerialized.firstTargetLink, machines: [{
                machineId: f.input.controllerMachineId, installationId: crypto.randomUUID(),
            }] } })).toEqual({ ok: false, error: 'deployment_conflict' });
        expect(await db.deploymentEnvironment.count({ where: { projectSourceId: f.destination.source.id } })).toBe(1);
        expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: created.environmentId } }))
            .toMatchObject({ contentArtifactId: input.contentArtifactId });
    });

    it.each(['plain', 'e2ee'] as const)('refuses stale, inaccessible, deleted and unmanaged %s copy intents before destination mutation', async mode => {
        const f = await fixture(mode);
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const post = (payload: unknown) => app.inject({ method: 'POST', url: '/v1/deployments/environments',
                headers: { 'x-test-user-id': f.actor.id }, payload });
            expect((await post({ ...f.input, copyFrom: { ...f.input.copyFrom, expectedRevision: 2 } })).json())
                .toEqual({ ok: false, error: 'deployment_conflict' });
            expect((await post({ ...f.input, copyFrom: { environmentId: crypto.randomUUID(), expectedRevision: 1 } })).json())
                .toEqual({ ok: false, error: 'deployment_unavailable' });
            expect((await post({ ...f.input, projectSourceId: f.source.source.id })).json())
                .toEqual({ ok: false, error: 'deployment_access_denied' });
            expect((await post({ ...f.input, copyFrom: { ...f.input.copyFrom, choices: { secrets: [] } } })).json())
                .toEqual({ ok: false, error: 'deployment_invalid' });
            await db.projectSource.update({ where: { id: f.source.source.id }, data: { audience: [] } });
            expect((await post(f.input)).json()).toEqual({ ok: false, error: 'deployment_unavailable' });
            await db.projectSource.update({ where: { id: f.source.source.id }, data: {
                audience: [{ principal: { kind: 'account', accountId: f.actor.id }, level: 'view' }] } });
            await db.deploymentEnvironment.update({ where: { id: f.original.environmentId }, data: { deletedAt: new Date() } });
            expect((await post(f.input)).json()).toEqual({ ok: false, error: 'deployment_unavailable' });
            expect(await db.deploymentEnvironment.count({ where: { projectSourceId: f.destination.source.id } })).toBe(0);
            await db.deploymentEnvironment.update({ where: { id: f.original.environmentId }, data: { deletedAt: null } });
            const aliased = await app.inject({ method: 'POST', url: '/v1/deployments/environments',
                headers: { 'x-test-user-id': f.sourceOwner.id }, payload: { ...f.input, ...f.originalContent,
                    projectSourceId: f.source.source.id, controllerMachineId: f.sourceMachine.id,
                    requestKey: crypto.randomUUID() } });
            expect(aliased.json()).toEqual({ ok: false, error: 'deployment_conflict' });
            expect(await db.deploymentEnvironment.count({ where: { projectSourceId: f.source.source.id } })).toBe(1);
            // Failed attempts did not reserve a repeat key: this same intent can now succeed.
            expect((await post(f.input)).statusCode).toBe(200);
        });
    });
});
