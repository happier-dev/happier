import { beforeAll, afterAll, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import nacl from 'tweetnacl';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { encodeSensitiveContentForAtRestStorage } from '@/app/encryption/sensitiveContentAtRestStorage';
import { deriveAccountRecipientEnvelopeReadinessFromRow } from '@/app/encryption/accountRecipientEnvelopeReadiness';
import { readSavedSecretResourcesForAccountInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { SavedSecretResourceStoredContentV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent,
    encodePlainMachineStoredContent, sealEncryptedDataKeyEnvelopeV1, sealSessionDataKeyBundleV0,
    sealSavedSecretResourceStoredContentV1, formatSharedSavedSecretRefV1, captureDeploymentBindingSavedSecretRevisionsV1 } from '@happier-dev/protocol';
import { createDeploymentEnvironmentInTx } from './deploymentEnvironmentService';
import { linkDeploymentTargetInTx } from './deploymentTargetLinkService';
import { syncEnvironmentSecretGrantsInTx, readEnvironmentMachineSecretGrantsInTx } from './environmentSecretGrantRepository';

const serverId = `srv_${'7'.repeat(32)}`;
let harness: LightSqliteHarness;
beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-platform-bindings-',
    initEncrypt: true, initAuth: true, env: { HAPPIER_SERVER_IDENTITY_ID: serverId, AUTH_REQUIRED_LOGIN_PROVIDERS: '' } }); }, 180_000);
afterAll(async () => { if (harness) await harness.close(); });

it.each(['plain', 'e2ee'] as const)('commits %s platform bindings and exact same-Link provenance with one Environment CAS', async mode => {
    const keys = nacl.box.keyPair();
    const owner = await db.account.create({ data: { encryptionMode: mode,
        ...(mode === 'e2ee' ? createSignedAccountContentBinding(keys.publicKey) : {}) } });
    const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId,
        requestKey: crypto.randomUUID(), name: 'Platform site', audience: [], repository: {
            provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
            repository: { nameWithOwner: 'owner/site', cloneUrl: 'https://github.com/owner/site.git' }, protocol: 'https' } }));
    if (!source.ok) throw new Error(source.error);
    const machineKey = nacl.randomBytes(32);
    const machineMetadata = { host: 'Controller', platform: 'linux', happyCliVersion: 'test',
        homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' };
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
        active: true, installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(nacl.sign.keyPair().publicKey),
        metadata: mode === 'plain' ? encodePlainMachineStoredContent(machineMetadata)
            : privacyKit.encodeBase64(new Uint8Array(await sealSessionDataKeyBundleV0(machineMetadata, machineKey))),
        dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)
            : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: machineKey, recipientPublicKey: keys.publicKey, randomBytes: nacl.randomBytes })) } });
    const dataKey = nacl.randomBytes(32);
    const seal = async (content: unknown) => mode === 'plain'
        ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(content))
        : new Uint8Array(await sealSessionDataKeyBundleV0(content, dataKey));
    const artifact = async (kind: string, content: unknown) => {
        const created = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(), kind: `v1:other:${kind}`,
            header: await seal({ kind, title: 'Platform site' }), body: await seal({ body: JSON.stringify(content) }),
            dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)
                : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: keys.publicKey, randomBytes: nacl.randomBytes })) });
        if (!created.ok) throw new Error(created.error);
        return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
    };
    const initial = { name: 'Platform site', retainPreviousDeployments: 1, definition: { kind: 'repository', ref: 'main' }, bindings: [] };
    const environmentArtifact = await artifact('deployment-environment.v1', initial);
    const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, {
        serverId, projectSourceId: source.source.id, requestKey: crypto.randomUUID(), protection: 'nonProduction',
        purpose: 'standard', deployerMode: 'managers', controllerMachineId: machine.id,
        ...environmentArtifact }));
    if (!created.ok) throw new Error(created.error);
    const linkContent = { credentialPrincipal: { kind: 'account', accountId: owner.id, purpose: {
        consumer: { pluginId: 'happier.deploy.vercel', localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' },
        target: { kind: 'account', account: { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'selected' } } },
        providerIdentity: { providerAccountId: 'team_selected', providerResourceId: 'prj_selected', providerEnvironment: 'production' },
        providerEnvironment: { kind: 'production' } };
    const linkArtifact = await artifact('deployment-target-link.v1', linkContent);
    const linked = await inTx(tx => linkDeploymentTargetInTx(tx, owner.id, {
        serverId, environmentId: created.environmentId, expectedRevision: 1, requestKey: crypto.randomUUID(),
        role: 'runtime', targetId: 'happier.deploy.vercel:runtime', targetKind: 'vercel',
        source: { kind: 'plugin', contribution: { pluginId: 'happier.deploy.vercel', localId: 'runtime' } }, machines: [],
        ...linkArtifact }));
    if (!linked.ok) throw new Error(linked.error);
    const link = await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: linked.targetLinkId } });
    // Same-owner opaque custody must retain the exact unrelated registry seal.
    const resourceId = crypto.randomUUID();
    const resourceContent = { v: 1 as const, name: 'Registry', kind: 'password' as const, value: 'fixture-registry-token' };
    const resourceKey = nacl.randomBytes(32);
    await db.savedSecretResource.create({ data: { id: resourceId, ownerAccountId: owner.id,
        displayName: resourceContent.name, kind: resourceContent.kind, encryptionMode: mode,
        storedContent: encodeSensitiveContentForAtRestStorage({ contentMode: mode,
            keyPath: ['storage', 'saved_secret_resource', resourceId, 'v1'],
            contentSchema: SavedSecretResourceStoredContentV1Schema,
            content: sealSavedSecretResourceStoredContentV1(mode === 'plain'
                ? { resourceId, mode, content: resourceContent }
                : { resourceId, mode, content: resourceContent, resourceDataKey: resourceKey, randomBytes: nacl.randomBytes }) }) } });
    if (mode === 'e2ee') {
        const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(owner);
        if (readiness.status !== 'available') throw new Error('Fixture Account recipient is unavailable');
        await db.savedSecretResourceKeyEnvelope.create({ data: { resourceId, recipientAccountId: owner.id,
            recipientContentPublicKeyFingerprint: readiness.binding.contentPublicKeyFingerprint,
            encryptedDataKey: new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: resourceKey,
                recipientPublicKey: keys.publicKey, randomBytes: nacl.randomBytes })) } });
    }
    expect(await inTx(tx => readSavedSecretResourcesForAccountInTx(tx, owner.id, undefined, [resourceId])))
        .toMatchObject([{ revision: 1, materialStatus: 'ready', capabilities: { use: true } }]);
    const registry = { purpose: 'registry' as const, targetLinkId: link.id, access: 'pull' as const,
        registryOrigin: 'https://registry.example.test',
        source: { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: 1 } };
    const initialMixed = { ...initial, bindings: [registry] };
    const currentMixed = await artifact('deployment-environment.v1', initialMixed);
    const captures = captureDeploymentBindingSavedSecretRevisionsV1([registry]);
    await db.deploymentEnvironment.update({ where: { id: created.environmentId }, data: {
        ...currentMixed, buildMachineId: machine.id, referencedSavedSecretRevisions: captures } });
    const registryGrant = { v: 1 as const, kind: 'secret' as const, environmentId: created.environmentId,
        machineId: machine.id, installationId: machine.installationId!, resourceId, resourceRevision: 1,
        sealedContent: 'fixture-existing-registry-seal' };
    await inTx(tx => syncEnvironmentSecretGrantsInTx(tx, { environmentId: created.environmentId, grants: [registryGrant] }));
    const content = await artifact('deployment-environment.v1', { ...initialMixed, bindings: [registry,
        { purpose: 'variable', phase: 'build', name: 'MODE', source: { kind: 'value', value: 'release' } } ] });
    const linkCandidate = await artifact('deployment-target-link.v1', { ...linkContent,
        ownedVariables: [{ key: 'MODE', providerId: 'env_mode', desiredRevision: linked.revision + 1 }] });
    const input = { serverId, environmentId: created.environmentId, expectedRevision: linked.revision,
        ...content, referencedSavedSecretRevisions: captures, grants: [],
        targetLinkContent: { targetLinkId: link.id, expectedTargetLinkRevision: link.revision, ...linkCandidate } };
    await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
        const save = (payload: unknown) => app.inject({ method: 'POST',
            url: `/v1/deployments/environments/${created.environmentId}/bindings`, headers: { 'x-test-user-id': owner.id }, payload });
        // A valid existing build recipient must not make an old seal replaceable.
        for (const grants of [[{ ...registryGrant, sealedContent: 'changed-caller-seal' }],
            [{ ...registryGrant, installationId: crypto.randomUUID() }], [registryGrant, registryGrant]]) {
            const refused = await save({ ...input, ...currentMixed, grants });
            expect(refused.statusCode, refused.body).toBe(409);
            expect(await inTx(tx => readEnvironmentMachineSecretGrantsInTx(tx, { environmentId: created.environmentId }))).toEqual([registryGrant]);
        }
        // Public routing must retain the old purpose and exact registry relation.
        for (const requiredBindings of [undefined, [{ purpose: 'backupDestination' }],
            [{ purpose: 'registry', targetLinkId: crypto.randomUUID(), access: 'pull' }]]) {
            const refused = await save({ ...input, ...currentMixed, grants: [registryGrant],
                referencedSavedSecretRevisions: [{ resourceId, revision: 1,
                    ...(requiredBindings ? { requiredBindings } : {}) }] });
            expect(refused.statusCode, refused.body).toBe(409);
            expect(await inTx(tx => readEnvironmentMachineSecretGrantsInTx(tx, { environmentId: created.environmentId }))).toEqual([registryGrant]);
        }
        const stale = await save({ ...input, targetLinkContent: { ...input.targetLinkContent, expectedTargetLinkRevision: link.revision + 1 } });
        expect(stale.statusCode, stale.body).toBe(409);
        expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: created.environmentId } })).toMatchObject({ revision: linked.revision });
        const saved = await save(input);
        expect(saved.statusCode, saved.body).toBe(200);
        expect(saved.json()).toMatchObject({ ok: true, revision: linked.revision + 1 });
        expect(await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: link.id } })).toMatchObject({
            ...linkCandidate, id: link.id, revision: link.revision + 1, activeDeploymentId: link.activeDeploymentId,
            createdByAccountId: link.createdByAccountId });
        expect(await inTx(tx => readEnvironmentMachineSecretGrantsInTx(tx, { environmentId: created.environmentId }))).toEqual([registryGrant]);
        const repeated = await save(input);
        expect(repeated.statusCode, repeated.body).toBe(409);
    });
});
