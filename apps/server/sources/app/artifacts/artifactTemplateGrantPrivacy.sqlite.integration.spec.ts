import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    computeContentPublicKeyFingerprint, encodePlainArtifactStoredContent,
    sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { observePrismaReads } from '@/testkit/observePrismaReads';
import { listArtifactHeadersForCallerInTx, readArtifactRecipientCensusInTx } from './artifactAccessService';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';

describe('Template grant privacy through Artifact HTTP (real SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-template-grants-', initEncrypt: true, initAuth: true });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it.each(['plain', 'e2ee'] as const)('limits %s template inspection to self while retaining owner roster and recipient reads', async mode => {
        const account = () => db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
        const owner = await db.account.create({ data: { name: 'Template owner', encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
        const recipient = await account();
        const peer = await account();
        const team = await db.team.create({ data: { name: 'Private template audience' } });
        await db.teamMembership.createMany({ data: [recipient, peer].map(person => ({
            teamId: team.id, accountId: person.id, role: 'member' as const,
        })) });
        const dataKey = tweetnacl.randomBytes(32);
        const seal = (publicKey: Uint8Array) => new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey, recipientPublicKey: publicKey, randomBytes: tweetnacl.randomBytes,
        }));
        const header = mode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'bot_template.v1' }))
            : new TextEncoder().encode('encrypted template header');
        const body = mode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: 'released template' }))
            : new TextEncoder().encode('encrypted released template');
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            kind: deriveArtifactStoredKindV1({ kind: 'bot_template.v1' }), header, body,
            dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) : seal(owner.contentPublicKey!),
            headerVersion: 1, bodyVersion: 1 } });
        await db.artifactAccountGrant.createMany({ data: [recipient, peer].map(person => ({
            artifactId: artifact.id, accountId: person.id, accessLevel: 'admin' as const, createdByAccountId: owner.id,
        })) });
        await db.artifactTeamGrant.create({ data: { artifactId: artifact.id, teamId: team.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        if (mode === 'e2ee') await db.artifactKeyEnvelope.createMany({ data: [recipient, peer].map(person => ({
            artifactId: artifact.id, recipientAccountId: person.id, encryptedDataKey: seal(person.contentPublicKey!),
            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(person.contentPublicKey!),
        })) });

        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = (accountId: string) => ({ 'x-test-user-id': accountId,
                'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) });
            // Newer owned drafts and owned legacy records must not consume the
            // received page or make its coverage partial.
            await db.artifact.createMany({ data: Array.from({ length: 1000 }, (_, index) => ({
                id: crypto.randomUUID(), accountId: recipient.id, kind: index % 2 ? null : deriveArtifactStoredKindV1({ kind: 'bot_template.v1' }),
                header, body, dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) : seal(recipient.contentPublicKey!),
                headerVersion: 1, bodyVersion: 1, updatedAt: new Date(Date.now() + index + 1),
            })) });
            const receivedUrl = '/v1/artifacts?audience=received&kinds=%5B%22bot_template.v1%22%5D&limit=1';
            const received = await app.inject({ method: 'GET', url: receivedUrl, headers: headers(recipient.id) });
            expect(received.statusCode, received.body).toBe(200);
            expect(received.json()).toMatchObject({ items: [{ id: artifact.id, access: 'admin' }],
                hasUnclassified: false, coverage: { status: 'complete', unclassifiedCount: 0 } });
            expect(received.json().items).toHaveLength(1);
            expect(received.json().items[0]).not.toHaveProperty('body');
            expect(received.body).not.toContain(peer.id);
            const options = { actorAccountId: recipient.id, audience: 'received' as const,
                kinds: ['bot_template.v1'], limit: 1, cursor: null };
            const query = await inTx(async tx => {
                const observed = observePrismaReads(tx, ['artifact']);
                const rows = await listArtifactHeadersForCallerInTx(observed.tx, options);
                return { rows, transferred: observed.rows };
            });
            expect(query.rows.map(row => row.id)).toEqual([artifact.id]);
            expect(query.transferred.filter(row => row.model === 'artifact').map(row => row.count)).toEqual([1]);
            const grants = async (accountId: string) => {
                const result = await app.inject({ method: 'GET', url: `/v1/artifacts/${artifact.id}/access/grants`, headers: headers(accountId) });
                expect(result.statusCode, result.body).toBe(200);
                return result.json();
            };
            expect((await grants(owner.id)).grants).toHaveLength(3);
            expect((await grants(recipient.id)).grants).toMatchObject([{ principal: { kind: 'account', accountId: recipient.id } }]);
            expect((await grants(recipient.id)).grants).toHaveLength(1);
            const census = async (accountId: string) => {
                const result = await app.inject({ method: 'GET', url: `/v1/artifacts/${artifact.id}/access/recipients`, headers: headers(accountId) });
                expect(result.statusCode, result.body).toBe(200);
                return result.json();
            };
            expect((await census(owner.id)).recipients.map((row: { recipientAccountId: string }) => row.recipientAccountId).sort())
                .toEqual([owner.id, recipient.id, peer.id].sort());
            expect((await census(recipient.id)).recipients.map((row: { recipientAccountId: string }) => row.recipientAccountId)).toEqual([recipient.id]);
            const captured = await inTx(async tx => {
                const observed = observePrismaReads(tx, ['account', 'artifactKeyEnvelope']);
                const result = await readArtifactRecipientCensusInTx(observed.tx, { actorAccountId: recipient.id, artifactId: artifact.id });
                return { result, rows: observed.rows };
            });
            expect(captured.result.ok).toBe(true);
            expect([...new Set(captured.rows.filter(row => row.model === 'account').flatMap(row => row.ids))]).toEqual([recipient.id]);
            expect([...new Set(captured.rows.filter(row => row.model === 'artifactKeyEnvelope').flatMap(row => row.ids))])
                .toEqual(mode === 'e2ee' ? [recipient.id] : []);
            const exact = await app.inject({ method: 'GET', url: `/v1/artifacts/${artifact.id}`, headers: headers(recipient.id) });
            expect(exact.statusCode, exact.body).toBe(200);
            expect(exact.json()).toMatchObject({ body: privacyKit.encodeBase64(body), access: 'admin', ownerDisplayName: 'Template owner' });
            expect(exact.body).not.toContain(peer.id);
            const batch = await app.inject({ method: 'POST', url: '/v1/artifacts/read', headers: headers(recipient.id),
                payload: { artifactIds: [artifact.id] } });
            expect(batch.statusCode, batch.body).toBe(200);
            const item = batch.json().items[0];
            expect(item).toMatchObject({ ok: true, artifact: { body: privacyKit.encodeBase64(body), access: 'admin', ownerDisplayName: 'Template owner' } });
            expect(batch.body).not.toContain(peer.id);
            if (mode === 'e2ee') {
                expect(item.recipientCensus.recipients.map((row: { recipientAccountId: string }) => row.recipientAccountId)).toEqual([recipient.id]);
                expect(item.recipientCensus.callerDataEncryptionKey).toBe(exact.json().dataEncryptionKey);
            }
            await db.artifactAccountGrant.deleteMany({ where: { artifactId: artifact.id, accountId: recipient.id } });
            const teamReceived = await app.inject({ method: 'GET', url: receivedUrl, headers: headers(recipient.id) });
            expect(teamReceived.statusCode, teamReceived.body).toBe(200);
            expect(teamReceived.json()).toMatchObject({ items: [{ id: artifact.id, access: 'view' }] });
            expect((await grants(recipient.id)).grants).toEqual([]);
            const selfCensus = await census(recipient.id);
            expect(selfCensus.recipients.map((row: { recipientAccountId: string }) => row.recipientAccountId)).toEqual([recipient.id]);
            if (mode === 'e2ee') {
                const foreignEnvelope = await app.inject({ method: 'POST', url: `/v1/artifacts/${artifact.id}/access/key-envelopes`,
                    headers: headers(recipient.id), payload: { artifactId: artifact.id,
                        expectedDataEncryptionKey: selfCensus.dataEncryptionKey,
                        recipientKeyEnvelopes: [{ recipientAccountId: peer.id,
                            encryptedDataKey: privacyKit.encodeBase64(seal(peer.contentPublicKey!)),
                            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(peer.contentPublicKey!),
                        }] } });
                expect(foreignEnvelope.statusCode, foreignEnvelope.body).toBe(403);
                expect(foreignEnvelope.body).not.toContain(peer.id);
                const committed = await app.inject({ method: 'POST', url: `/v1/artifacts/${artifact.id}/access/key-envelopes`,
                    headers: headers(recipient.id), payload: { artifactId: artifact.id,
                        expectedDataEncryptionKey: selfCensus.dataEncryptionKey,
                        recipientKeyEnvelopes: [{ recipientAccountId: recipient.id,
                            encryptedDataKey: privacyKit.encodeBase64(seal(recipient.contentPublicKey!)),
                            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(recipient.contentPublicKey!),
                        }] } });
                expect(committed.statusCode).toBe(200);
                expect(committed.json()).toEqual({ appliedRecipientAccountIds: [recipient.id], skippedRecipientAccountIds: [] });
                const view = await app.inject({ method: 'GET', url: `/v1/artifacts/${artifact.id}`, headers: headers(recipient.id) });
                expect(view.statusCode).toBe(200);
                expect(view.json().access).toBe('view');
            }
        });
    });
});
