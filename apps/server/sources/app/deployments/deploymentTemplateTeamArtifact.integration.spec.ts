import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import nacl from 'tweetnacl';
import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    ArtifactAccessRecipientCensusResponseV1Schema,
    ArtifactJsonCreateHttpInputV1Schema,
    DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1,
    DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1,
    MACHINE_PLAIN_DATA_KEY_MARKER,
    computeContentPublicKeyFingerprint,
    encodePlainArtifactStoredContent,
    encodePlainMachineStoredContent,
    sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';
import {
    EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
    createDeploymentEnvironmentContentArtifactIdV1,
    projectDeploymentPreparationAdmissionV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import {
    computeExternalActionRequestEnvelopeDigestV1,
    encodeExternalActionResolvedTargetV1,
    signExternalActionMachineRequestV1,
} from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import {
    createDeploymentPreparationContentArtifactIdV1, type DeploymentPreparationContentSlotV1,
} from '@happier-dev/protocol/deployments/deploymentCandidatePublicationV1';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { currentAccountStoredContentCompatibilityHeaders } from '@/app/api/testkit/accountStoredContentCompatibility';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { auth } from '@/app/auth/auth';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';
import { teamResourceGrantFixture } from '@/testkit/resourceGrant.testkit';

describe('signed deployment preparation for a Team Project Source', () => {
    const serverId = `srv_${'b'.repeat(32)}`;
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;

    beforeAll(async () => {
        harness = await createDatabaseIntegrationHarness({ tempDirPrefix: 'happier-preparation-team-artifact-',
            initAuth: true, initEncrypt: true, env: { HAPPIER_SERVER_IDENTITY_ID: serverId } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    describe.each([DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1])('%s', actionId => {
        it.each(['plain', 'e2ee'] as const)('shares only this invocation’s %s Artifacts through a foreign Team Machine', async encryptionMode => {
            const account = await db.account.create({ data: { encryptionMode,
                ...(encryptionMode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
            const custodian = await db.account.create({ data: { encryptionMode, ...createSignedAccountContentBinding() } });
            const sourceTeam = await db.team.create({ data: { name: 'Project Source Team' } });
            const otherTeam = await db.team.create({ data: { name: 'Other Team' } });
            const teamOwner = { kind: 'team' as const, teamId: sourceTeam.id };
            await db.teamMembership.createMany({ data: [
                { teamId: sourceTeam.id, accountId: account.id, role: 'owner' },
                { teamId: sourceTeam.id, accountId: custodian.id, role: 'member' },
                { teamId: otherTeam.id, accountId: account.id, role: 'owner' },
            ] });
            const installationKey = nacl.sign.keyPair();
            const machineId = randomUUID();
            const installationId = randomUUID();
            await db.machine.create({ data: { id: machineId, accountId: custodian.id, installationId,
                installationPublicKey: new Uint8Array(installationKey.publicKey),
                metadata: encodePlainMachineStoredContent({ host: 'Team carrier', platform: 'linux',
                    happyCliVersion: 'test', homeDir: '/tmp', happyHomeDir: '/tmp/happier' }),
                dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
            await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: sourceTeam.id, accessLevel: 'admin',
                createdByAccountId: custodian.id }), accessLevel: 'admin', machineId } });
            const source = await inTx(tx => createProjectSourceInTx(tx, account.id, { serverId, requestKey: randomUUID(),
                name: 'Team destination', owner: teamOwner }));
            if (!source.ok) throw new Error(source.error);

            const wrapKey = (dataKey: Uint8Array, recipientPublicKey: Uint8Array) => privacyKit.encodeBase64(
                sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey, randomBytes: nacl.randomBytes }));
            const publication = (id: string, kind = DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1 as string) => {
                const dataKey = nacl.randomBytes(32);
                const body = ArtifactJsonCreateHttpInputV1Schema.parse({
                    id, kind,
                    header: encryptionMode === 'plain' ? encodePlainArtifactStoredContent({ kind: kind.slice('v1:other:'.length), title: '' })
                        : privacyKit.encodeBase64(nacl.randomBytes(48)),
                    body: encryptionMode === 'plain' ? encodePlainArtifactStoredContent({ body: '{}' }) : privacyKit.encodeBase64(nacl.randomBytes(48)),
                    dataEncryptionKey: encryptionMode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : wrapKey(dataKey, account.contentPublicKey!),
                });
                const storedBytes = { header: privacyKit.decodeBase64(body.header), body: privacyKit.decodeBase64(body.body),
                    dataEncryptionKey: privacyKit.decodeBase64(body.dataEncryptionKey) };
                return { body, dataKey, storedBytes };
            };
            const unrelated = publication(randomUUID());
            await db.artifact.create({ data: { ...unrelated.storedBytes, id: unrelated.body.id, accountId: account.id } });

            const slots: DeploymentPreparationContentSlotV1[] = ['environment', 'runtimeLink'];
            const createPreview = async () => {
                const content = await db.artifact.create({ data: { ...unrelated.storedBytes, kind: unrelated.body.kind, accountId: account.id,
                    id: randomUUID() } });
                const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id, createdByAccountId: account.id,
                    protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: machineId,
                    contentArtifactId: content.id, contentHeaderVersion: 1, contentBodyVersion: 1 } });
                const createLink = (role: 'runtime' | 'data') => db.deploymentTargetLink.create({ data: {
                    environmentId: environment.id, createdByAccountId: account.id, role, state: 'configured',
                    ...(role === 'runtime' ? { sourceKind: 'host', targetKind: 'ownServer', hostTargetId: 'own-server' }
                        : { sourceKind: 'plugin', targetKind: 'data', pluginId: 'data-plugin', contributionLocalId: 'data' }),
                    contentArtifactId: content.id, contentHeaderVersion: 1, contentBodyVersion: 1,
                } });
                const runtime = await createLink('runtime');
                const data = await createLink('data');
                await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: runtime.id } });
                slots.push({ templateDataTargetLinkId: data.id });
                return { templateEnvironmentId: environment.id, expectedTemplateRevision: environment.revision,
                    runtimeTargetLinkId: runtime.id, pullRequestId: 'preview-pr' };
            };
            const preview = actionId === DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1 ? await createPreview() : undefined;
            const target = { kind: 'machine' as const, machineId };
            const environment = { kind: 'create' as const, name: 'Team app', requestKey: randomUUID(), protection: 'nonProduction' as const,
                purpose: 'standard' as const, deployerMode: 'managers' as const, controllerMachineId: machineId };
            const mint = async (mode: 'apply' | 'preview', requestId: string = randomUUID()) => {
                const createInput = (selected: NonNullable<typeof preview>) => ({ mode, serverId, projectSourceId: source.source.id,
                    name: environment.name, requestKey: environment.requestKey, protection: environment.protection, purpose: 'preview' as const,
                    deployerMode: environment.deployerMode, controllerMachineId: machineId, preview: selected,
                    // A prepared Create can carry an existing candidate; that remains a read operand.
                    contentArtifactId: unrelated.body.id, contentHeaderVersion: 1, contentBodyVersion: 1 });
                const templateInput = () => ({ mode, serverId, machineId, projectSourceId: source.source.id,
                    templateRef: { sourceId: 'apps', itemId: 'web', version: '1',
                        ref: { kind: 'content' as const, digest: `sha256:${'c'.repeat(64)}` } },
                    environment, target: { kind: 'new' as const, installationId },
                    destination: { kind: 'stored' as const }, bindings: [] });
                const input = preview ? createInput(preview) : templateInput();
                const authorization = await auth.mintExternalActionExecutionAuthorization({
                    serverIdentityId: serverId, accountId: account.id, authentication: { kind: 'account', tokenEpoch: account.tokenEpoch },
                    actionId, requestId, target, machineId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId, target, input }),
                    deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(actionId, input),
                }, { input });
                expect(authorization.binding).toMatchObject({ accountId: account.id, custodianAccountId: custodian.id, installationId });
                return authorization;
            };
            const apply = await mint('apply');
            const another = await mint('apply');
            const replay = await mint('apply', apply.binding.requestId);
            const previewOnly = preview ? undefined : await mint('preview');

            await withAuthenticatedTestApp(artifactsRoutes, async app => {
                const request = (method: 'GET' | 'POST' | 'PUT', path: string, body?: object, authorization = apply) =>
                    app.inject({ method, url: path, ...(body === undefined ? {} : { payload: body }),
                        headers: { ...currentAccountStoredContentCompatibilityHeaders,
                            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                                authorizationToken: authorization.token, effectActionId: actionId, target,
                                requestId: authorization.binding.requestId, installationId, method, path, body, privateKey: installationKey.secretKey,
                            }),
                        },
                    });
                const accessPath = (id: string, step: string) => `/v1/artifacts/${id}/access/${step}`;
                const grant = async (artifactId: string, authorization = apply, principal = teamOwner, accessLevel = 'admin') =>
                    request('PUT', accessPath(artifactId, 'grants'), { artifactId, principal, accessLevel }, authorization);
                const envelope = (artifactId: string, created: ReturnType<typeof publication>, authorization = apply) => request(
                    'POST', accessPath(artifactId, 'key-envelopes'), { artifactId, expectedDataEncryptionKey: created.body.dataEncryptionKey,
                        recipientKeyEnvelopes: [{ recipientAccountId: custodian.id,
                            encryptedDataKey: wrapKey(created.dataKey, custodian.contentPublicKey!),
                            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(custodian.contentPublicKey!) }] },
                    authorization);

                expect((await grant(unrelated.body.id)).statusCode, 'unrelated requester-owned unkinded Artifact').toBe(401);
                if (encryptionMode === 'e2ee') expect((await envelope(unrelated.body.id, unrelated)).statusCode).toBe(401);
                expect(await db.artifactGrant.count({ where: { artifactId: unrelated.body.id } })).toBe(0);

                const publishedIds = new Set<string>();
                for (const slot of slots) {
                    const artifactId = createDeploymentPreparationContentArtifactIdV1(apply.binding, slot);
                    expect(createDeploymentPreparationContentArtifactIdV1(replay.binding, slot)).toBe(artifactId);
                    expect(publishedIds.has(artifactId)).toBe(false);
                    publishedIds.add(artifactId);
                    const kind = slot === 'environment' ? DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1 : DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1;
                    const created = publication(artifactId, kind);
                    expect((await request('POST', '/v1/artifacts', created.body)).statusCode, 'create this invocation’s Artifact').toBe(200);
                    expect((await request('POST', '/v1/artifacts', publication(artifactId, kind).body, replay)).statusCode, 'retry create').toBe(200);
                    expect((await grant(artifactId, replay)).statusCode, 'grant on this invocation’s Artifact').toBe(200);
                    expect((await grant(artifactId, another)).statusCode).toBe(401);
                    expect((await grant(artifactId, apply, { kind: 'team', teamId: otherTeam.id })).statusCode).toBe(401);
                    expect((await grant(artifactId, apply, teamOwner, 'view')).statusCode).toBe(401);
                    if (previewOnly) expect((await grant(artifactId, previewOnly)).statusCode).toBe(401);
                    expect(await db.artifactGrant.findMany({ where: { artifactId }, select: { teamId: true, accessLevel: true } }))
                        .toEqual([{ teamId: sourceTeam.id, accessLevel: 'admin' }]);

                    if (encryptionMode === 'e2ee') {
                        expect((await request('GET', `/v1/artifacts/${artifactId}`)).statusCode).toBe(200);
                        const census = await request('GET', accessPath(artifactId, 'recipients'));
                        expect(census.statusCode).toBe(200);
                        expect(ArtifactAccessRecipientCensusResponseV1Schema.parse(census.json()).recipients)
                            .toContainEqual(expect.objectContaining({ recipientAccountId: custodian.id }));
                        const response = await envelope(artifactId, created, replay);
                        expect(response.statusCode, 'key envelope on this invocation’s Artifact').toBe(200);
                        expect(response.json()).toEqual({ appliedRecipientAccountIds: [custodian.id], skippedRecipientAccountIds: [] });
                        expect((await envelope(artifactId, created, another)).statusCode).toBe(401);
                    }
                }

                const control = createDeploymentPreparationContentArtifactIdV1(another.binding, 'environment');
                const bytes = publication(control).storedBytes;
                await db.artifact.create({ data: { ...bytes, id: control, accountId: custodian.id, kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1 } });
                expect((await grant(control, another)).statusCode, 'another Account’s Artifact even at the exact ID').toBe(401);
                await db.artifact.update({ where: { id: control }, data: { accountId: account.id, kind: 'v1:other:note.v1' } });
                expect((await grant(control, another)).statusCode, 'non-deployment kind even at the exact ID').toBe(401);
            }, { authentication: 'real' });
        });
    });

    it.each(['plain', 'e2ee'] as const)('shares the %s Template bindings candidate of this invocation under its root', async encryptionMode => {
        const actionId = DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1;
        const account = await db.account.create({ data: { encryptionMode,
            ...(encryptionMode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
        const custodian = await db.account.create({ data: { encryptionMode, ...createSignedAccountContentBinding() } });
        const team = await db.team.create({ data: { name: 'Bindings Team' } });
        const teamOwner = { kind: 'team' as const, teamId: team.id };
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: account.id, role: 'owner' }, { teamId: team.id, accountId: custodian.id, role: 'member' },
        ] });
        const installationKey = nacl.sign.keyPair();
        const machineId = randomUUID();
        const installationId = randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: custodian.id, installationId,
            installationPublicKey: new Uint8Array(installationKey.publicKey),
            metadata: encodePlainMachineStoredContent({ host: 'Team carrier', platform: 'linux',
                happyCliVersion: 'test', homeDir: '/tmp', happyHomeDir: '/tmp/happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'admin',
            createdByAccountId: custodian.id }), accessLevel: 'admin', machineId } });
        const source = await inTx(tx => createProjectSourceInTx(tx, account.id, { serverId, requestKey: randomUUID(),
            name: 'Team bindings destination', owner: teamOwner }));
        if (!source.ok) throw new Error(source.error);
        const wrapKey = (dataKey: Uint8Array, recipientPublicKey: Uint8Array) => privacyKit.encodeBase64(
            sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey, randomBytes: nacl.randomBytes }));
        const publication = (id: string) => {
            const dataKey = nacl.randomBytes(32);
            const body = ArtifactJsonCreateHttpInputV1Schema.parse({ id, kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1,
                header: encryptionMode === 'plain' ? encodePlainArtifactStoredContent({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1.slice('v1:other:'.length), title: '' })
                    : privacyKit.encodeBase64(nacl.randomBytes(48)),
                body: encryptionMode === 'plain' ? encodePlainArtifactStoredContent({ body: '{}' }) : privacyKit.encodeBase64(nacl.randomBytes(48)),
                dataEncryptionKey: encryptionMode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : wrapKey(dataKey, account.contentPublicKey!) });
            return { body, dataKey, storedBytes: { header: privacyKit.decodeBase64(body.header), body: privacyKit.decodeBase64(body.body),
                dataEncryptionKey: privacyKit.decodeBase64(body.dataEncryptionKey) } };
        };
        const current = publication(randomUUID());
        const content = await db.artifact.create({ data: { ...current.storedBytes, id: current.body.id, accountId: account.id,
            kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1 } });
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id, createdByAccountId: account.id,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: machineId,
            contentArtifactId: content.id, contentHeaderVersion: 1, contentBodyVersion: 1 } });
        const unrelated = publication(randomUUID());
        await db.artifact.create({ data: { ...unrelated.storedBytes, id: unrelated.body.id, accountId: account.id } });
        const target = { kind: 'machine' as const, machineId };
        const mint = async () => {
            const requestId = randomUUID();
            const input = { mode: 'apply' as const, serverId, machineId, projectSourceId: source.source.id,
                templateRef: { sourceId: 'apps', itemId: 'web', version: '1', ref: { kind: 'content' as const, digest: `sha256:${'c'.repeat(64)}` } },
                environment: { kind: 'existing' as const, environmentId: environment.id, expectedRevision: environment.revision },
                target: { kind: 'new' as const, installationId }, destination: { kind: 'stored' as const }, bindings: [] };
            return auth.mintExternalActionExecutionAuthorization({
                serverIdentityId: serverId, accountId: account.id, authentication: { kind: 'account', tokenEpoch: account.tokenEpoch },
                actionId, requestId, target, machineId,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId, target, input }),
                deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(actionId, input),
            }, { input });
        };
        const apply = await mint();
        const another = await mint();
        const bindingsId = (authorization: typeof apply) => createDeploymentEnvironmentContentArtifactIdV1({ ...authorization.binding,
            actionId: DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, environmentId: environment.id });

        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            // The bindings child publishes its candidate and shares it under the root's signed carrier.
            const request = (method: 'GET' | 'POST' | 'PUT', path: string, body?: object, authorization = apply) =>
                app.inject({ method, url: path, ...(body === undefined ? {} : { payload: body }),
                    headers: { ...currentAccountStoredContentCompatibilityHeaders,
                        [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                        [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                        [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                        [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                            authorizationToken: authorization.token, effectActionId: actionId, target,
                            requestId: authorization.binding.requestId, installationId, method, path, body, privateKey: installationKey.secretKey,
                        }),
                    } });
            const grant = (artifactId: string, authorization = apply) => request('PUT', `/v1/artifacts/${artifactId}/access/grants`,
                { artifactId, principal: teamOwner, accessLevel: 'admin' }, authorization);
            expect((await grant(unrelated.body.id)).statusCode, 'unrelated requester-owned unkinded Artifact').toBe(401);
            const artifactId = bindingsId(apply);
            const created = publication(artifactId);
            expect((await request('POST', '/v1/artifacts', created.body)).statusCode).toBe(200);
            expect((await grant(artifactId)).statusCode, 'grant on this invocation’s bindings candidate').toBe(200);
            expect((await grant(artifactId, another)).statusCode, 'another invocation').toBe(401);
            expect(bindingsId(another)).not.toBe(artifactId);
            if (encryptionMode === 'e2ee') {
                const census = await request('GET', `/v1/artifacts/${artifactId}/access/recipients`);
                expect(census.statusCode, 'recipient census of this invocation’s bindings candidate').toBe(200);
                expect(ArtifactAccessRecipientCensusResponseV1Schema.parse(census.json()).recipients)
                    .toContainEqual(expect.objectContaining({ recipientAccountId: custodian.id }));
                const envelope = await request('POST', `/v1/artifacts/${artifactId}/access/key-envelopes`, { artifactId,
                    expectedDataEncryptionKey: created.body.dataEncryptionKey, recipientKeyEnvelopes: [{ recipientAccountId: custodian.id,
                        encryptedDataKey: wrapKey(created.dataKey, custodian.contentPublicKey!),
                        recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(custodian.contentPublicKey!) }] });
                expect(envelope.statusCode, 'key envelope on this invocation’s bindings candidate').toBe(200);
                expect((await request('GET', `/v1/artifacts/${unrelated.body.id}/access/recipients`)).statusCode).toBe(401);
            }
        }, { authentication: 'real' });
    });
});
