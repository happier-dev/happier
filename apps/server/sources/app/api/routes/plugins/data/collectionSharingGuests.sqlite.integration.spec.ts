import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from 'privacy-kit';
import {
    ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
    PluginManifestV2Schema,
    sealPluginCollectionPrivatePayloadV1,
    signAccountContentKeyBindingV1,
} from '@happier-dev/protocol';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { PLUGIN_COLLECTION_SHARING_HTTP_PATHS_V1 as paths } from '@happier-dev/protocol/plugins/data/collectionSharingV1';
import { createPluginAvailabilityOperations } from '@/app/plugins/availability/operations';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { db } from '@/storage/db';
import { createAccountTokenForTests, createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { pluginDataRoutes } from './pluginDataRoutes';

const manifest = PluginManifestV2Schema.parse({
    schemaVersion: 2,
    id: 'example.guest-sharing',
    version: '1.0.0',
    displayName: 'Guest sharing fixture',
    engines: { happier: '^1.0.0' },
    runtime: { apiVersion: 1 },
    contributes: { accountCollections: [{
        id: 'tasks', schemaVersion: 1, rowIdField: 'id',
        schema: { type: 'object', properties: {
            id: { type: 'string', maxLength: 256 },
            title: { type: 'string', maxLength: 256 },
            privateNote: { type: 'string', maxLength: 256 },
        }, required: ['id', 'title', 'privateNote'], additionalProperties: false },
        serverReadable: ['title'], indexes: [],
    }] },
});

async function createAccount(mode: 'plain' | 'e2ee') {
    const signing = tweetnacl.sign.keyPair();
    const content = tweetnacl.box.keyPair();
    const account = await db.account.create({ data: {
        encryptionMode: mode,
        ...(mode === 'plain' ? { publicKey: null } : {
            publicKey: Buffer.from(signing.publicKey).toString('hex'),
            contentPublicKey: new Uint8Array(content.publicKey),
            contentPublicKeySig: new Uint8Array(signAccountContentKeyBindingV1({
                accountSigningSecretKey: signing.secretKey, contentPublicKey: content.publicKey,
            })),
        }),
    } });
    const token = await createAccountTokenForTests(account.id, { kind: 'account', authority: 'present_user' });
    return { id: account.id, content, headers: {
        authorization: `Bearer ${token}`,
        'x-happier-account-stored-content-protocol': String(ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION),
    } };
}

describe('Collection sharing Team guests through authenticated routes', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-collection-team-guests-', initAuth: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 120_000);

    afterAll(async () => { await harness?.close(); });

    for (const mode of ['plain', 'e2ee'] as const) {
        it.each([
            { role: 'guest', audience: 'team', allowed: false },
            { role: 'guest', audience: 'group', allowed: true },
            { role: 'member', audience: 'team', allowed: true },
        ] as const)(`${mode}: $role with a $audience grant has the intended read, edit and key access`, async ({ role, audience, allowed }) => {
            const owner = await createAccount(mode);
            const recipient = await createAccount(mode);
            const team = await db.team.create({ data: { name: 'Collection sharing Team' } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
            const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role } });
            const group = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel('Editors') } });
            await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id,
                teamMembershipId: membership.id, nativeContribution: true } });
            await createPluginAvailabilityOperations().claimCollectionWriters({ accountId: owner.id, input: { manifest } });
            const contract = await db.pluginCollectionContract.findFirstOrThrow({
                where: { pluginId: manifest.id, collectionId: 'tasks' },
            });
            const ref = { pluginId: manifest.id, collectionId: 'tasks', schemaVersion: contract.schemaVersion,
                contractDigest: contract.contractDigest };
            const address = { ownerAccountId: owner.id, pluginId: ref.pluginId, collectionId: ref.collectionId, rowId: randomUUID() };
            const principal = audience === 'team' ? { kind: 'team', teamId: team.id }
                : { kind: 'group', teamId: team.id, groupId: group.id };
            const privatePayload = { privateNote: 'Owner private note' };
            const material = { type: 'legacy' as const, secret: randomBytes(32) };
            const dataKey = randomBytes(32);
            const content = mode === 'plain' ? { t: 'plain' as const, v: privatePayload }
                : { t: 'encrypted' as const, c: sealPluginCollectionPrivatePayloadV1({ material, payload: privatePayload, randomBytes }) };
            const resourceContent = mode === 'plain' ? content : { t: 'encrypted' as const, k: 'collection' as const,
                c: sealPluginCollectionPrivatePayloadV1({ material: { type: 'dataKey', machineKey: dataKey },
                    payload: privatePayload, randomBytes }) };
            const wrap = (account: typeof owner) => ({ recipientAccountId: account.id,
                encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey,
                    recipientPublicKey: account.content.publicKey, randomBytes })),
                recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(account.content.publicKey) });
            const ownerWrap = wrap(owner), recipientWrap = wrap(recipient);
            const app = createAuthenticatedTestApp({ authentication: 'real' });
            pluginDataRoutes(app);
            await app.ready();
            try {
                const post = (account: typeof owner, url: string, payload: unknown) => app.inject({
                    method: 'POST', url, headers: account.headers, payload,
                });
                const created = await post(owner, '/v1/plugins/data/mutate', { pluginId: ref.pluginId, collectionId: ref.collectionId,
                    writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest }, operations: [{
                        kind: 'put', rowId: address.rowId, expectedRevision: 'absent', expectedAbsenceEpoch: 0,
                        content, projection: { title: 'Original' },
                    }] });
                expect(created.statusCode, JSON.stringify(created.json())).toBe(200);
                const granted = await post(owner, paths.setGrant, { ...address, principal, accessLevel: 'edit', expectedRevision: 1,
                    ...(mode === 'e2ee' ? { promotion: { expectedRevision: 1, content: resourceContent,
                        ownerKeyEnvelope: ownerWrap, recipientKeyEnvelopes: [recipientWrap] } } : {}),
                });
                expect(granted.statusCode, JSON.stringify(granted.json())).toBe(200);
                const revision = mode === 'e2ee' ? 2 : 1;
                const stored = await db.pluginCollectionRow.findFirstOrThrow({ where: { accountId: owner.id, rowId: address.rowId } });
                if (mode === 'e2ee') {
                    // A well-framed wrap with a genuine recipient binding must still require a grant.
                    expect.soft(await db.pluginCollectionKeyEnvelope.count({ where: {
                        rowDbId: stored.id, recipientAccountId: recipient.id,
                    } })).toBe(allowed ? 1 : 0);
                    const committed = await post(owner, paths.commitKeys, { ...address,
                        expectedDataEncryptionKey: ownerWrap.encryptedDataKey, recipientKeyEnvelopes: [recipientWrap] });
                    expect(committed.statusCode).toBe(200);
                    expect.soft(committed.json()).toEqual({ appliedRecipientAccountIds: allowed ? [recipient.id] : [],
                        skippedRecipientAccountIds: allowed ? [] : [recipient.id] });
                    expect.soft(await db.pluginCollectionKeyEnvelope.count({ where: {
                        rowDbId: stored.id, recipientAccountId: recipient.id,
                    } })).toBe(allowed ? 1 : 0);
                }
                const read = await post(recipient, paths.get, { ...address, readerContext: ref });
                expect.soft(read.statusCode).toBe(allowed ? 200 : 404);
                if (allowed) expect(read.json()).toMatchObject({ access: 'edit', row: { revision, projection: { title: 'Original' } } });
                else expect.soft(read.json().error).toBe('collection_unavailable');
                const listing = await post(recipient, paths.sharedWithMe, { pluginId: ref.pluginId,
                    collectionId: ref.collectionId, readerContext: ref });
                expect(listing.statusCode).toBe(200);
                expect.soft(listing.json().resources).toHaveLength(allowed ? 1 : 0);
                const edit = await post(recipient, paths.put, { ...address, writerContext: ref, expectedRevision: revision,
                    content: resourceContent, projection: { title: 'Recipient edit' } });
                expect.soft(edit.statusCode).toBe(allowed ? 200 : 404);
                if (allowed) expect(edit.json()).toMatchObject({ access: 'edit', row: { revision: revision + 1,
                    projection: { title: 'Recipient edit' } } });
                else expect.soft(edit.json().error).toBe('collection_unavailable');
                const after = await db.pluginCollectionRow.findUniqueOrThrow({ where: { id: stored.id },
                    include: { projections: true } });
                expect.soft(after.revision).toBe(allowed ? revision + 1 : revision);
                expect.soft(after.projections.find(field => field.fieldId === 'title')?.typedEncodedValue)
                    .toBe(JSON.stringify(allowed ? 'Recipient edit' : 'Original'));
            } finally { await app.close(); }
        });
    }
});
