import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    computeContentPublicKeyFingerprint, encodePlainArtifactStoredContent, sealEncryptedDataKeyEnvelopeV1,
    sealPublicShareDataKeyV1, openPublicShareDataKeyV1, sealSessionDataKeyBundleV0 } from '@happier-dev/protocol';
import { projectBotTemplateArtifactHeaderV1, type BotTemplateArtifactV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { ArtifactHttpReadV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { ArtifactHeaderMetadataV1Schema, ArtifactSignedInLinkJoinReadV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { ArtifactBodyEnvelopeV1StoredSchema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { db } from '@/storage/db';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { publicShareRoutes } from './publicShareRoutes';
import { artifactsRoutes } from '../artifacts/artifactsRoutes';

describe('signed-in Artifact links through authenticated HTTP', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-template-links-', initEncrypt: true,
            env: { HAPPIER_PUBLIC_SERVER_URL: 'https://home.example.test', HAPPIER_WEBAPP_URL: 'https://home.example.test' } });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it.each(['plain', 'e2ee'] as const)('joins %s links only as self, isolates anonymous routes and separates link from grant revocation', async mode => {
        const account = (accountMode = mode) => db.account.create({ data: { encryptionMode: accountMode,
            ...(accountMode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
        const owner = await account();
        const recipient = await account();
        const peer = await account();
        const plainRecipient = await account('plain');
        const dataKey = tweetnacl.randomBytes(32);
        const wrap = (publicKey: Uint8Array) => privacyKit.encodeBase64(new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey, recipientPublicKey: publicKey, randomBytes: tweetnacl.randomBytes,
        })));
        const released: BotTemplateArtifactV1 = { v: 1, state: 'released', release: { v: 1, version: '1.0.0', releasedAtMs: 1,
            changelog: '', content: { v: 1, identity: { name: 'Garden', description: 'A reusable Bot', madeFromName: 'Garden' },
                instructions: { markdown: 'Help with plants' }, memoryRules: [], skills: [],
                needs: { software: [], connectedAccounts: [], mcpServers: [] } } } };
        const encode = async (value: unknown) => mode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(value))
            : new Uint8Array(await sealSessionDataKeyBundleV0(value, dataKey));
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            kind: deriveArtifactStoredKindV1({ kind: 'bot_template.v1' }), headerVersion: 1, bodyVersion: 1,
            header: await encode(projectBotTemplateArtifactHeaderV1(released)), body: await encode({ body: JSON.stringify(released) }),
            dataEncryptionKey: privacyKit.decodeBase64(mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : wrap(owner.contentPublicKey!)),
        } });
        const lookupId = crypto.randomUUID();
        const keyEnvelope = { recipientAccountId: recipient.id, encryptedDataKey: mode === 'e2ee' ? wrap(recipient.contentPublicKey!) : '',
            recipientContentPublicKeyFingerprint: mode === 'e2ee' ? computeContentPublicKeyFingerprint(recipient.contentPublicKey!) : '' };
        const headers = (accountId: string) => ({ 'x-test-user-id': accountId,
            'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) });
        await withAuthenticatedTestApp(app => { publicShareRoutes(app); artifactsRoutes(app); }, async app => {
            const create = { method: 'POST' as const, url: '/v1/artifact-signed-in-links', headers: headers(owner.id), payload: {
                artifactId: artifact.id, lookupId,
                ...(mode === 'e2ee' ? { encryptedDataKey: sealPublicShareDataKeyV1({ dataKey, secret: 'A'.repeat(43), randomBytes: tweetnacl.randomBytes }) } : {}),
            } };
            const created = await app.inject(create);
            expect(created.statusCode, created.body).toBe(200);
            expect(created.json()).toMatchObject({ publicShare: { id: artifact.id, audience: 'signed_in', subject: { kind: 'artifact', id: artifact.id } } });
            const originalLink = await db.artifactSignedInLink.findUniqueOrThrow({ where: { artifactId: artifact.id } });
            const preserved = await app.inject({ ...create, payload: { ...create.payload, lookupId: crypto.randomUUID(), preserveExisting: true,
                ...(mode === 'e2ee' ? { encryptedDataKey: sealPublicShareDataKeyV1({ dataKey, secret: 'B'.repeat(43), randomBytes: tweetnacl.randomBytes }) } : {}) } });
            expect(preserved.statusCode, preserved.body).toBe(200);
            expect(preserved.json()).toMatchObject({ created: false, publicShare: { id: artifact.id, audience: 'signed_in' } });
            expect(await db.artifactSignedInLink.findUniqueOrThrow({ where: { artifactId: artifact.id } })).toEqual(originalLink);
            const listed = await app.inject({ method: 'GET', url: `/v1/artifact-signed-in-links?artifactId=${artifact.id}`, headers: headers(owner.id) });
            expect(listed.json()).toMatchObject({ publicShares: [{ id: artifact.id, audience: 'signed_in' }] });
            expect((await app.inject({ method: 'GET', url: `/v1/artifact-signed-in-links?artifactId=${artifact.id}`, headers: headers(peer.id) })).statusCode).toBe(403);
            const exposed = await app.inject({ method: 'GET', url: `/v1/artifacts/${artifact.id}`, headers: headers(owner.id) });
            expect(exposed.statusCode, exposed.body).toBe(200);
            expect(exposed.json().publicAudience).toBe('retained');
            expect((await app.inject({ ...create, headers: headers(peer.id) })).statusCode).toBe(403);
            for (const url of [`/v1/public-shares/${lookupId}/content`, `/s/${lookupId}`, `/v1/public-shares/${lookupId}`]) {
                expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
            }
            const joinUrl = `/v1/artifact-signed-in-links/${lookupId}/join`;
            expect((await app.inject({ method: 'GET', url: joinUrl })).statusCode).toBe(401);
            const prepared = await app.inject({ method: 'GET', url: joinUrl, headers: headers(recipient.id) });
            expect(prepared.statusCode, prepared.body).toBe(200);
            expect(prepared.json()).toMatchObject({ artifactId: artifact.id, authorAccountId: owner.id, encryptionMode: mode });
            if (mode === 'e2ee') expect(openPublicShareDataKeyV1({ encryptedDataKey: prepared.json().encryptedDataKey, secret: 'A'.repeat(43) })).toEqual(dataKey);
            expect(prepared.body).not.toMatch(/provenance|revisions|grants|sourceSession/);
            if (mode === 'e2ee') {
                const refused = await app.inject({ method: 'POST', url: joinUrl, headers: headers(plainRecipient.id), payload: {} });
                expect(refused.statusCode, refused.body).toBe(409);
                expect(refused.json()).toMatchObject({ error: 'recipient_key_unavailable', reason: 'plain_account' });
                expect(await db.artifactAccountGrant.count({ where: { artifactId: artifact.id, accountId: plainRecipient.id } })).toBe(0);
                expect((await app.inject({ method: 'POST', url: joinUrl, headers: headers(peer.id), payload: { keyEnvelope } })).statusCode).toBe(403);
            }
            const joined = await app.inject({ method: 'POST', url: joinUrl, headers: headers(recipient.id), payload: mode === 'e2ee' ? { keyEnvelope } : {} });
            expect(joined.statusCode, joined.body).toBe(200);
            expect(joined.json()).toEqual({ artifactId: artifact.id, ownerAccountId: owner.id, access: 'view' });
            await db.artifactAccountGrant.update({ where: { artifactId_accountId: { artifactId: artifact.id, accountId: recipient.id } }, data: { accessLevel: 'edit' } });
            const rejoined = await app.inject({ method: 'POST', url: joinUrl, headers: headers(recipient.id), payload: mode === 'e2ee' ? { keyEnvelope } : {} });
            expect(rejoined.json()).toMatchObject({ access: 'edit' });
            expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${artifact.id}`, headers: headers(recipient.id) })).statusCode).toBe(200);
            expect((await app.inject({ method: 'DELETE', url: `/v1/artifact-signed-in-links/${artifact.id}`, headers: headers(owner.id) })).statusCode).toBe(200);
            expect((await app.inject({ method: 'POST', url: joinUrl, headers: headers(peer.id), payload: {} })).statusCode).toBe(404);
            expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${artifact.id}`, headers: headers(recipient.id) })).statusCode).toBe(200);
            expect((await app.inject({ method: 'DELETE', url: `/v1/artifacts/${artifact.id}/access/grants`, headers: headers(owner.id), payload: {
                artifactId: artifact.id, principal: { kind: 'account', accountId: recipient.id },
            } })).statusCode).toBe(200);
            expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${artifact.id}`, headers: headers(recipient.id) })).statusCode).toBe(404);
        });
    });
});
