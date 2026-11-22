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
    projectDeploymentPreparationAdmissionV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import {
    computeExternalActionRequestEnvelopeDigestV1,
    encodeExternalActionResolvedTargetV1,
    signExternalActionMachineRequestV1,
} from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
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

describe('signed Template Apply to a Team Project Source', () => {
    const serverId = `srv_${'b'.repeat(32)}`;
    const actionId = DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1;
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;

    beforeAll(async () => {
        harness = await createDatabaseIntegrationHarness({ tempDirPrefix: 'happier-template-team-artifact-',
            initAuth: true, initEncrypt: true, env: { HAPPIER_SERVER_IDENTITY_ID: serverId } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it.each([
        { encryptionMode: 'plain', kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1 },
        { encryptionMode: 'e2ee', kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1 },
    ] as const)('publishes and shares $encryptionMode deployment content as the Machine owner', async ({ encryptionMode, kind }) => {
        const account = await db.account.create({ data: { encryptionMode,
            ...(encryptionMode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
        const member = await db.account.create({ data: { encryptionMode, ...createSignedAccountContentBinding() } });
        const sourceTeam = await db.team.create({ data: { name: 'Project Source Team' } });
        const otherTeam = await db.team.create({ data: { name: 'Other Team' } });
        const teamOwner = { kind: 'team' as const, teamId: sourceTeam.id };
        await db.teamMembership.createMany({ data: [
            { teamId: sourceTeam.id, accountId: account.id, role: 'owner' },
            { teamId: sourceTeam.id, accountId: member.id, role: 'member' },
            { teamId: otherTeam.id, accountId: account.id, role: 'owner' },
        ] });
        const key = nacl.sign.keyPair();
        const machineId = randomUUID();
        const installationId = randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: account.id, installationId,
            installationPublicKey: new Uint8Array(key.publicKey),
            metadata: encodePlainMachineStoredContent({ host: 'Template carrier', platform: 'linux',
                happyCliVersion: 'test', homeDir: '/tmp', happyHomeDir: '/tmp/happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: sourceTeam.id, accessLevel: 'admin',
            createdByAccountId: account.id }), accessLevel: 'admin', machineId } });
        const source = await inTx(tx => createProjectSourceInTx(tx, account.id, { serverId, requestKey: randomUUID(),
            name: 'Team Template destination', owner: teamOwner }));
        if (!source.ok) throw new Error(source.error);
        const target = { kind: 'machine' as const, machineId };
        const mint = async (mode: 'apply' | 'preview') => {
            const requestId = randomUUID();
            const input = { mode, serverId, machineId, projectSourceId: source.source.id,
                templateRef: { sourceId: 'apps', itemId: 'web', version: '1',
                    ref: { kind: 'content' as const, digest: `sha256:${'c'.repeat(64)}` } },
                environment: { kind: 'create' as const, name: 'Template app', requestKey: randomUUID(),
                    protection: 'nonProduction' as const, purpose: 'standard' as const, deployerMode: 'managers' as const,
                    controllerMachineId: machineId },
                target: { kind: 'new' as const, installationId },
                destination: { kind: 'stored' as const }, bindings: [],
            };
            const envelope = { v: 1 as const, requestId, target, input };
            const authorization = await auth.mintExternalActionExecutionAuthorization({
                serverIdentityId: serverId, accountId: account.id, authentication: { kind: 'account', tokenEpoch: 0 },
                actionId, requestId, target, machineId, installationId, custodianAccountId: account.id,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(actionId, input),
            }, { input });
            return { authorization, requestId };
        };
        const apply = await mint('apply');
        const preview = await mint('preview');
        const artifactId = randomUUID();
        const dataKey = nacl.randomBytes(32);
        const wrapKey = (recipientPublicKey: Uint8Array) => privacyKit.encodeBase64(sealEncryptedDataKeyEnvelopeV1({
            dataKey, recipientPublicKey, randomBytes: nacl.randomBytes,
        }));
        const create = ArtifactJsonCreateHttpInputV1Schema.parse({
            id: artifactId, kind,
            header: encryptionMode === 'plain' ? encodePlainArtifactStoredContent({ kind: kind.slice('v1:other:'.length), title: '' })
                : privacyKit.encodeBase64(nacl.randomBytes(48)),
            body: encryptionMode === 'plain' ? encodePlainArtifactStoredContent({ body: '{}' }) : privacyKit.encodeBase64(nacl.randomBytes(48)),
            dataEncryptionKey: encryptionMode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : wrapKey(account.contentPublicKey!),
        });

        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const request = (method: 'GET' | 'POST' | 'PUT', path: string, body?: object, authContext = apply) => {
                const { authorization, requestId } = authContext;
                return app.inject({ method, url: path, ...(body === undefined ? {} : { payload: body }),
                    headers: { ...currentAccountStoredContentCompatibilityHeaders,
                        [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                        [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                        [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                        [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                            authorizationToken: authorization.token, effectActionId: actionId, target,
                            requestId, installationId, method, path, body, privateKey: key.secretKey,
                        }),
                    },
                });
            };
            const createResponse = await request('POST', '/v1/artifacts', create);
            expect(createResponse.statusCode, 'signed Template Apply creates requester-owned content').toBe(200);
            expect(await db.artifact.findUnique({ where: { id: artifactId }, select: { accountId: true, kind: true } }))
                .toEqual({ accountId: account.id, kind });
            const accessPath = (id: string, step: string) => `/v1/artifacts/${id}/access/${step}`;
            const grant = { artifactId, principal: teamOwner, accessLevel: 'admin' };
            const grantResponse = await request('PUT', accessPath(artifactId, 'grants'), grant);
            expect(grantResponse.statusCode, 'signed Team-owner admin grant').toBe(200);
            expect(await db.artifactGrant.findMany({ where: { artifactId }, select: { teamId: true, accessLevel: true } }))
                .toEqual([{ teamId: sourceTeam.id, accessLevel: 'admin' }]);

            const otherAccountArtifact = randomUUID();
            const otherKindArtifact = randomUUID();
            const storedBytes = { header: privacyKit.decodeBase64(create.header), body: privacyKit.decodeBase64(create.body),
                dataEncryptionKey: privacyKit.decodeBase64(create.dataEncryptionKey) };
            await db.artifact.createMany({ data: [
                { ...storedBytes, id: otherAccountArtifact, accountId: member.id, kind },
                { ...storedBytes, id: otherKindArtifact, accountId: account.id, kind: 'v1:other:note.v1' },
            ] });
            for (const [reason, denied, authorization] of [
                ['another Team', { ...grant, principal: { kind: 'team', teamId: otherTeam.id } }, apply],
                ['another access level', { ...grant, accessLevel: 'view' }, apply],
                ['another Account’s Artifact', { ...grant, artifactId: otherAccountArtifact }, apply],
                ['a non-deployment Artifact kind', { ...grant, artifactId: otherKindArtifact }, apply],
                ['a preview binding', grant, preview],
            ] as const) {
                expect((await request('PUT', accessPath(denied.artifactId, 'grants'), denied, authorization)).statusCode, reason).toBe(401);
            }

            if (encryptionMode === 'e2ee') {
                expect((await request('GET', `/v1/artifacts/${artifactId}`)).statusCode, 'signed Artifact read before key preparation').toBe(200);
                const census = await request('GET', accessPath(artifactId, 'recipients'));
                expect(census.statusCode, 'signed Team-owner recipient census').toBe(200);
                expect(ArtifactAccessRecipientCensusResponseV1Schema.parse(census.json()).recipients)
                    .toContainEqual(expect.objectContaining({ recipientAccountId: member.id }));
                const envelope = { artifactId, expectedDataEncryptionKey: create.dataEncryptionKey,
                    recipientKeyEnvelopes: [{ recipientAccountId: member.id, encryptedDataKey: wrapKey(member.contentPublicKey!),
                        recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(member.contentPublicKey!) }] };
                const response = await request('POST', accessPath(artifactId, 'key-envelopes'), envelope);
                expect(response.statusCode, 'signed Team-owner key envelope commit').toBe(200);
                expect(response.json()).toEqual({ appliedRecipientAccountIds: [member.id], skippedRecipientAccountIds: [] });
                for (const [id, authorization] of [[otherAccountArtifact, apply], [otherKindArtifact, apply], [artifactId, preview]] as const) {
                    expect((await request('POST', accessPath(id, 'key-envelopes'), { ...envelope, artifactId: id }, authorization)).statusCode)
                        .toBe(401);
                }
            }
        }, { authentication: 'real' });
    });
});
