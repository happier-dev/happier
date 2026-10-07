import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as privacyKit from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, decodePlainArtifactStoredContent, sealSessionDataKeyBundleV0,
    sealEncryptedDataKeyEnvelopeV1, sealPublicShareDataKeyV1, openSessionDataKeyBundleV0, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    type AccountEncryptionMigrateArtifactsDirective } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { migrateArtifactAccountEncryptionInTx, matchArtifactAccountEncryptionMigrationPostStateInTx } from './artifactWriteService';
import { readArtifactAccountEncryptionMigrationInventoryInTx } from './artifactAccountEncryptionMigrationInventory';
import { storePlainArtifactDbBytes } from './artifactStoredContent';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { publicShareRoutes } from '@/app/api/routes/share/publicShareRoutes';
import { eventRouter } from '@/app/events/eventRouter';

describe('Artifact private provenance (real SQLite and HTTP)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-artifact-provenance-', initEncrypt: true, initFiles: true, env: {
            HAPPIER_PUBLIC_SERVER_URL: 'https://home.example.test',
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: 'preview.example.test',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: '1',
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST: 'server_sealed',
        } });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });
    afterEach(() => vi.restoreAllMocks());

    it('reads additive persisted provenance through inventory and conversion without accepting it as new content', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const id = crypto.randomUUID();
        const metadata = (bodyVersion: number) => ({ v: 1, artifactId: id, bodyVersion,
            provenance: { savedBy: { kind: 'person', accountId: owner.id } } });
        const additive = encodePlainArtifactStoredContent({ ...metadata(1), future: true,
            provenance: { ...metadata(1).provenance, future: true } });
        const header = encodePlainArtifactStoredContent({ title: 'Stored transition' });
        const body = encodePlainArtifactStoredContent({ body: 'Stored body' });
        const key = privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER);
        const sealed = (value: string) => storePlainArtifactDbBytes({ accountId: owner.id, artifactId: id,
            field: 'provenance', content: privacyKit.decodeBase64(value) })!;
        await db.artifact.create({ data: { id, accountId: owner.id, header: privacyKit.decodeBase64(header),
            body: privacyKit.decodeBase64(body), dataEncryptionKey: key, provenance: sealed(additive),
            headerVersion: 1, bodyVersion: 1 } });
        const inventory = await inTx(tx => readArtifactAccountEncryptionMigrationInventoryInTx({ tx, accountId: owner.id, limit: 10 }));
        expect(inventory?.items).toMatchObject([{ id, provenance: additive, bodyVersion: 1 }]);
        const item = { artifactId: id, expectedHeaderVersion: 1, expectedBodyVersion: 1,
            expectedDataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, expectedProvenance: additive,
            expectedProvenanceDataEncryptionKey: null, header, body, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            provenance: encodePlainArtifactStoredContent(metadata(2)), provenanceDataEncryptionKey: null,
            revisions: [], recipientKeyEnvelopes: [], blobs: [] };
        const directive = { action: 'migrate', items: [item] } satisfies AccountEncryptionMigrateArtifactsDirective;
        const invalidDirective = { ...directive, items: [{ ...item,
            provenance: encodePlainArtifactStoredContent({ ...metadata(2), future: true }) }] };
        expect(await inTx(tx => migrateArtifactAccountEncryptionInTx({ tx, accountId: owner.id,
            fromMode: 'plain', toMode: 'plain', directive: invalidDirective }))).toEqual({ status: 'invalid_content' });
        expect((await db.artifact.findUniqueOrThrow({ where: { id } })).bodyVersion).toBe(1);
        expect(await inTx(tx => migrateArtifactAccountEncryptionInTx({ tx, accountId: owner.id,
            fromMode: 'plain', toMode: 'plain', directive }))).toEqual({ status: 'applied' });
        expect(await inTx(tx => matchArtifactAccountEncryptionMigrationPostStateInTx({ tx, accountId: owner.id,
            toMode: 'plain', directive }))).toEqual({ status: 'matched' });
        const persisted = encodePlainArtifactStoredContent({ ...metadata(2), future: true });
        await db.artifact.update({ where: { id }, data: { provenance: sealed(persisted) } });
        expect(await inTx(tx => matchArtifactAccountEncryptionMigrationPostStateInTx({ tx, accountId: owner.id,
            toMode: 'plain', directive }))).toEqual({ status: 'mismatch' });
        expect(await inTx(tx => matchArtifactAccountEncryptionMigrationPostStateInTx({ tx, accountId: owner.id,
            toMode: 'plain', directive: { ...directive, items: [{ ...item, provenance: persisted }] } }))).toEqual({ status: 'matched' });
    });

    it('converts private head and retained metadata with independent transition keys and exact replay matching', async () => {
        const binding = createSignedAccountContentBinding();
        const owner = await db.account.create({ data: { encryptionMode: 'plain', ...binding } });
        const id = crypto.randomUUID();
        const metadata = (bodyVersion: number) => ({ v: 1, artifactId: id, bodyVersion, provenance: { savedBy: { kind: 'person', accountId: owner.id } } });
        const plainHeader = encodePlainArtifactStoredContent({ title: 'Transition' });
        const plainBody1 = encodePlainArtifactStoredContent({ body: 'First' });
        const plainBody2 = encodePlainArtifactStoredContent({ body: 'Second' });
        const plainPrivate1 = encodePlainArtifactStoredContent(metadata(1));
        const plainPrivate2 = encodePlainArtifactStoredContent(metadata(2));
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id };
            expect((await app.inject({ method: 'POST', url: '/v1/artifacts', headers, payload: {
                id, header: plainHeader, body: plainBody1, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, provenance: plainPrivate1,
            } })).statusCode).toBe(200);
            expect((await app.inject({ method: 'POST', url: `/v1/artifacts/${id}`, headers, payload: {
                expectedBodyVersion: 1, body: plainBody2, provenance: plainPrivate2,
            } })).statusCode).toBe(200);
        });
        const contentKey = tweetnacl.randomBytes(32);
        const privateKey = tweetnacl.randomBytes(32);
        const wrap = (key: Uint8Array) => privacyKit.encodeBase64(new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey: key, recipientPublicKey: binding.contentPublicKey, randomBytes: tweetnacl.randomBytes,
        })));
        const encode = async (value: unknown, key: Uint8Array) => privacyKit.encodeBase64(new Uint8Array(await sealSessionDataKeyBundleV0(value, key)));
        const item = { artifactId: id, expectedHeaderVersion: 1, expectedBodyVersion: 2, expectedDataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            expectedProvenance: plainPrivate2, expectedProvenanceDataEncryptionKey: null,
            header: await encode({ title: 'Transition' }, contentKey), body: await encode({ body: 'Second' }, contentKey),
            dataEncryptionKey: wrap(contentKey), provenance: await encode(metadata(3), privateKey), provenanceDataEncryptionKey: wrap(privateKey),
            revisions: [{ bodyVersion: 1, expectedBody: plainBody1, body: await encode({ body: 'First' }, contentKey),
                expectedProvenance: plainPrivate1, provenance: await encode(metadata(1), privateKey) }], recipientKeyEnvelopes: [], blobs: [] };
        const directive = { action: 'migrate', items: [item] } satisfies AccountEncryptionMigrateArtifactsDirective;
        expect(await inTx(async tx => {
            const result = await migrateArtifactAccountEncryptionInTx({ tx, accountId: owner.id, fromMode: 'plain', toMode: 'e2ee', directive });
            if (result.status === 'applied') await tx.account.update({ where: { id: owner.id }, data: { encryptionMode: 'e2ee' } });
            return result;
        })).toEqual({ status: 'applied' });
        expect(await inTx(tx => matchArtifactAccountEncryptionMigrationPostStateInTx({ tx, accountId: owner.id, toMode: 'e2ee', directive }))).toEqual({ status: 'matched' });
        const converted = await db.artifact.findUniqueOrThrow({ where: { id } });
        expect(privacyKit.encodeBase64(new Uint8Array(converted.provenance!))).toBe(item.provenance);
        expect(privacyKit.encodeBase64(new Uint8Array(converted.provenanceDataEncryptionKey!))).toBe(item.provenanceDataEncryptionKey);
        await db.artifactRevision.update({ where: { artifactId_bodyVersion: { artifactId: id, bodyVersion: 1 } }, data: { provenance: privacyKit.decodeBase64(item.provenance) } });
        expect(await inTx(tx => matchArtifactAccountEncryptionMigrationPostStateInTx({ tx, accountId: owner.id, toMode: 'e2ee', directive }))).toEqual({ status: 'mismatch' });
    });

    it('initializes a legacy E2EE private key once under the existing body CAS', async () => {
        // Socket delivery is the network boundary; CAS, access and event production stay real.
        const events = vi.spyOn(eventRouter, 'emitUpdate').mockImplementation(() => {});
        const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
        const editor = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
        const contentKey = tweetnacl.randomBytes(32);
        const privateKey = tweetnacl.randomBytes(32);
        const wrap = (key: Uint8Array, recipientPublicKey: Uint8Array) => privacyKit.encodeBase64(new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey: key, recipientPublicKey, randomBytes: tweetnacl.randomBytes,
        })));
        const encode = async (value: unknown, key: Uint8Array) => privacyKit.encodeBase64(new Uint8Array(await sealSessionDataKeyBundleV0(value, key)));
        const id = crypto.randomUUID();
        const headers = (accountId: string) => ({ 'x-test-user-id': accountId });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            expect((await app.inject({ method: 'POST', url: '/v1/artifacts', headers: headers(owner.id), payload: {
                id, header: await encode({ title: 'Legacy' }, contentKey), body: await encode({ body: 'Legacy' }, contentKey),
                dataEncryptionKey: wrap(contentKey, owner.contentPublicKey!),
            } })).statusCode).toBe(200);
            await db.artifactAccountGrant.create({ data: { artifactId: id, accountId: editor.id, accessLevel: 'edit', createdByAccountId: owner.id } });
            const census = (await app.inject({ method: 'GET', url: `/v1/artifacts/${id}/access/recipients`, headers: headers(owner.id) })).json();
            const ownerWrap = wrap(privateKey, owner.contentPublicKey!);
            expect((await app.inject({ method: 'POST', url: `/v1/artifacts/${id}/access/key-envelopes`, headers: headers(owner.id), payload: {
                artifactId: id, expectedDataEncryptionKey: census.dataEncryptionKey,
                recipientKeyEnvelopes: [{ recipientAccountId: editor.id, recipientContentPublicKeyFingerprint: census.recipients.find((r: { recipientAccountId: string }) => r.recipientAccountId === editor.id).contentPublicKeyFingerprint,
                    encryptedDataKey: wrap(contentKey, editor.contentPublicKey!) }],
            } })).statusCode).toBe(200);
            const metadata = await encode({ v: 1, artifactId: id, bodyVersion: 2, provenance: { savedBy: { kind: 'agent', accountId: editor.id, sessionId: 'agent-session' } } }, privateKey);
            const payload = { expectedBodyVersion: 1, body: await encode({ body: 'Agent save' }, contentKey), provenance: metadata, provenanceDataEncryptionKey: ownerWrap };
            const updated = await app.inject({ method: 'POST', url: `/v1/artifacts/${id}`, headers: headers(editor.id), payload });
            expect(updated.statusCode, updated.body).toBe(200);
            const persistedHead = await db.artifact.findUniqueOrThrow({ where: { id } });
            const persistedHistory = await db.artifactRevision.findMany({ where: { artifactId: id } });
            const expectedBytes = persistedHead.header.byteLength + persistedHead.body.byteLength + (persistedHead.provenance?.byteLength ?? 0)
                + persistedHistory.reduce((sum, revision) => sum + revision.body.byteLength + (revision.provenance?.byteLength ?? 0), 0);
            const usage = await app.inject({ method: 'GET', url: '/v1/artifacts/storage/usage', headers: headers(owner.id) });
            expect(usage.json()).toMatchObject({ usedBytes: expectedBytes });
            expect(updated.json()).toMatchObject({ success: true, bodyVersion: 2 });
            const ownerEvent = events.mock.calls.map(([event]) => event).find(event =>
                event.userId === owner.id && event.payload.body.t === 'update-artifact');
            expect(ownerEvent?.payload.body).toMatchObject({ provenance: metadata, provenanceDataEncryptionKey: ownerWrap });
            const editorEvent = events.mock.calls.map(([event]) => event).find(event =>
                event.userId === editor.id && event.payload.body.t === 'update-artifact');
            expect(editorEvent?.payload.body).toMatchObject({ provenance: null, provenanceDataEncryptionKey: null });
            const replay = await app.inject({ method: 'POST', url: `/v1/artifacts/${id}`, headers: headers(editor.id), payload });
            expect(replay.json()).toMatchObject({ success: false, error: 'version-mismatch' });
            expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${id}`, headers: headers(owner.id) })).json()).toMatchObject({ provenance: metadata, provenanceDataEncryptionKey: ownerWrap });
            expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${id}`, headers: headers(editor.id) })).json()).toMatchObject({ provenance: null, provenanceDataEncryptionKey: null });
            expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${id}/revisions`, headers: headers(owner.id) })).json().revisions).toMatchObject([{ bodyVersion: 1, provenance: null }]);
            const editorPrivateWrap = wrap(privateKey, editor.contentPublicKey!);
            expect((await app.inject({ method: 'POST', url: `/v1/artifacts/${id}/access/key-envelopes`, headers: headers(owner.id), payload: {
                artifactId: id, expectedDataEncryptionKey: census.dataEncryptionKey, expectedProvenanceDataEncryptionKey: ownerWrap,
                recipientKeyEnvelopes: [{ recipientAccountId: editor.id,
                    recipientContentPublicKeyFingerprint: census.recipients.find((r: { recipientAccountId: string }) => r.recipientAccountId === editor.id).contentPublicKeyFingerprint,
                    encryptedDataKey: wrap(contentKey, editor.contentPublicKey!), encryptedProvenanceDataKey: editorPrivateWrap }],
            } })).statusCode).toBe(200);
            const nextMetadata = await encode({ v: 1, artifactId: id, bodyVersion: 3,
                provenance: { savedBy: { kind: 'agent', accountId: editor.id, sessionId: 'agent-session' } } }, privateKey);
            const nextPayload = { expectedBodyVersion: 2, body: await encode({ body: 'Another agent save' }, contentKey), provenance: nextMetadata };
            // A grant wrap is not the Artifact owner's persisted wrap.
            expect((await app.inject({ method: 'POST', url: `/v1/artifacts/${id}`, headers: headers(editor.id),
                payload: { ...nextPayload, provenanceDataEncryptionKey: editorPrivateWrap } })).statusCode).toBe(400);
            events.mockClear();
            expect((await app.inject({ method: 'POST', url: `/v1/artifacts/${id}`, headers: headers(editor.id), payload: nextPayload })).statusCode).toBe(200);
            for (const account of [owner, editor]) {
                const emitted = events.mock.calls.map(([event]) => event).find(event =>
                    event.userId === account.id && event.payload.body.t === 'update-artifact');
                expect(emitted?.payload.body).toMatchObject({ provenance: nextMetadata,
                    provenanceDataEncryptionKey: account.id === owner.id ? ownerWrap : editorPrivateWrap });
            }
        });
    });

    it.each(['plain', 'e2ee'] as const)('keeps %s head/history attribution private to owner and grant recipients', async mode => {
        const events = vi.spyOn(eventRouter, 'emitUpdate').mockImplementation(() => {});
        const owner = await db.account.create({ data: { encryptionMode: mode, ...(mode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
        const recipient = await db.account.create({ data: { encryptionMode: mode, ...(mode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
        const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
        const id = crypto.randomUUID();
        const contentKey = tweetnacl.randomBytes(32);
        const privateKey = tweetnacl.randomBytes(32);
        const encode = async (value: unknown, key: Uint8Array) => mode === 'plain' ? encodePlainArtifactStoredContent(value)
            : privacyKit.encodeBase64(new Uint8Array(await sealSessionDataKeyBundleV0(value, key)));
        const wrap = (key: Uint8Array, recipientPublicKey: Uint8Array) => privacyKit.encodeBase64(new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey: key, recipientPublicKey, randomBytes: tweetnacl.randomBytes,
        })));
        const ownerPrivateWrap = mode === 'e2ee' ? wrap(privateKey, owner.contentPublicKey!) : undefined;
        const provenance = (bodyVersion: number, restoredFromBodyVersion?: number) => ({ v: 1, artifactId: id, bodyVersion,
            provenance: { savedBy: { kind: 'person', accountId: owner.id }, ...(restoredFromBodyVersion ? { restoredFromBodyVersion } : {}) } });
        const private1 = await encode(provenance(1), privateKey);
        const private2 = await encode(provenance(2), privateKey);
        const headers = (accountId: string) => ({ 'x-test-user-id': accountId,
            'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) });
        await withAuthenticatedTestApp(app => { artifactsRoutes(app); publicShareRoutes(app); }, async app => {
            const created = await app.inject({ method: 'POST', url: '/v1/artifacts', headers: headers(owner.id), payload: {
                id, header: await encode({ kind: 'text', title: 'Public text' }, contentKey), body: await encode({ body: 'First' }, contentKey),
                dataEncryptionKey: mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : wrap(contentKey, owner.contentPublicKey!),
                provenance: private1, ...(ownerPrivateWrap ? { provenanceDataEncryptionKey: ownerPrivateWrap } : {}),
            } });
            expect(created.statusCode, created.body).toBe(200);
            expect(created.json()).toMatchObject({ provenance: private1, provenanceDataEncryptionKey: ownerPrivateWrap ?? null });
            const createdEvent = events.mock.calls.map(([event]) => event).find(event =>
                event.userId === owner.id && event.payload.body.t === 'new-artifact');
            expect(createdEvent?.payload.body).toMatchObject({ provenance: private1, provenanceDataEncryptionKey: ownerPrivateWrap ?? null });
            const refused = await app.inject({ method: 'POST', url: `/v1/artifacts/${id}`, headers: headers(owner.id), payload: {
                body: await encode({ body: 'Refused' }, contentKey), expectedBodyVersion: 1,
                provenance: mode === 'plain' ? await encode(provenance(99), privateKey) : private2,
                provenanceDataEncryptionKey: mode === 'plain' ? wrap(privateKey, tweetnacl.box.keyPair().publicKey) : wrap(tweetnacl.randomBytes(32), owner.contentPublicKey!),
            } });
            expect(refused.statusCode, refused.body).toBe(400);
            expect(await db.artifactRevision.count({ where: { artifactId: id } })).toBe(0);
            if (mode === 'plain') {
                const substituted = await app.inject({ method: 'POST', url: `/v1/artifacts/${id}`, headers: headers(owner.id), payload: {
                    body: await encode({ body: 'Wrong revision' }, contentKey), expectedBodyVersion: 1,
                    provenance: await encode(provenance(99), privateKey),
                } });
                expect(substituted.statusCode, substituted.body).toBe(400);
            }
            await db.artifactAccountGrant.create({ data: { artifactId: id, accountId: recipient.id, accessLevel: 'view', createdByAccountId: owner.id } });
            let recipientPrivateWrap: string | undefined;
            if (mode === 'e2ee') {
                const census = await app.inject({ method: 'GET', url: `/v1/artifacts/${id}/access/recipients`, headers: headers(owner.id) });
                const fingerprint = census.json().recipients.find((row: { recipientAccountId: string }) => row.recipientAccountId === recipient.id).contentPublicKeyFingerprint;
                recipientPrivateWrap = wrap(privateKey, recipient.contentPublicKey!);
                const stale = await app.inject({ method: 'POST', url: `/v1/artifacts/${id}/access/key-envelopes`, headers: headers(owner.id), payload: {
                    artifactId: id, expectedDataEncryptionKey: created.json().dataEncryptionKey,
                    recipientKeyEnvelopes: [{ recipientAccountId: recipient.id, recipientContentPublicKeyFingerprint: fingerprint,
                        encryptedDataKey: wrap(contentKey, recipient.contentPublicKey!), encryptedProvenanceDataKey: recipientPrivateWrap }],
                } });
                expect(stale.statusCode, stale.body).toBe(409);
                expect(stale.json()).toEqual({ error: 'artifact_data_key_changed' });
                const committed = await app.inject({ method: 'POST', url: `/v1/artifacts/${id}/access/key-envelopes`, headers: headers(owner.id), payload: {
                    artifactId: id, expectedDataEncryptionKey: created.json().dataEncryptionKey, expectedProvenanceDataEncryptionKey: ownerPrivateWrap,
                    recipientKeyEnvelopes: [{ recipientAccountId: recipient.id, recipientContentPublicKeyFingerprint: fingerprint,
                        encryptedDataKey: wrap(contentKey, recipient.contentPublicKey!), encryptedProvenanceDataKey: recipientPrivateWrap }],
                } });
                expect(committed.statusCode, committed.body).toBe(200);
            }
            const updated = await app.inject({ method: 'POST', url: `/v1/artifacts/${id}`, headers: headers(owner.id), payload: {
                body: await encode({ body: 'Second' }, contentKey), expectedBodyVersion: 1, provenance: private2,
            } });
            expect(updated.statusCode, updated.body).toBe(200);
            for (const account of [owner, recipient]) {
                const updatedEvent = events.mock.calls.map(([event]) => event).find(event =>
                    event.userId === account.id && event.payload.body.t === 'update-artifact');
                expect(updatedEvent?.payload.body).toMatchObject({ provenance: private2, provenanceDataEncryptionKey: mode === 'plain' ? null
                    : account.id === owner.id ? ownerPrivateWrap : recipientPrivateWrap });
            }
            for (const account of [owner, recipient]) {
                const head = await app.inject({ method: 'GET', url: `/v1/artifacts/${id}`, headers: headers(account.id) });
                expect(head.statusCode, head.body).toBe(200);
                expect(head.json()).toMatchObject({ provenance: private2, provenanceDataEncryptionKey: mode === 'plain' ? null
                    : account.id === owner.id ? ownerPrivateWrap : recipientPrivateWrap });
                const fullList = await app.inject({ method: 'GET', url: '/v1/artifacts?includeBody=true', headers: headers(account.id) });
                expect(fullList.statusCode, fullList.body).toBe(200);
                expect(fullList.json()).toContainEqual(expect.objectContaining({ id, provenance: private2,
                    provenanceDataEncryptionKey: head.json().provenanceDataEncryptionKey }));
                const headerList = await app.inject({ method: 'GET', url: '/v1/artifacts', headers: headers(account.id) });
                expect(headerList.statusCode, headerList.body).toBe(200);
                const headerRow = headerList.json().find((row: { id: string }) => row.id === id);
                expect(headerRow).toMatchObject({ bodyVersion: 2, provenance: private2,
                    provenanceDataEncryptionKey: head.json().provenanceDataEncryptionKey });
                expect(headerRow).not.toHaveProperty('body');
                const history = await app.inject({ method: 'GET', url: `/v1/artifacts/${id}/revisions`, headers: headers(account.id) });
                expect(history.statusCode, history.body).toBe(200);
                expect(history.json().revisions).toMatchObject([{ bodyVersion: 1, provenance: private1 }]);
            }
            expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${id}`, headers: headers(stranger.id) })).statusCode).toBe(404);
            const stored = await db.artifact.findUniqueOrThrow({ where: { id } });
            if (mode === 'plain') expect(new TextDecoder().decode(stored.provenance!)).not.toContain(owner.id);
            if (mode === 'e2ee') expect(await openSessionDataKeyBundleV0(privacyKit.decodeBase64(private2), contentKey)).toEqual({ status: 'authentication_failed' });
            const lookupId = crypto.randomUUID();
            const shared = await app.inject({ method: 'POST', url: '/v1/public-shares', headers: headers(owner.id), payload: {
                subject: { kind: 'artifact', id }, lookupId, keyDerivation: 'fragment_v1',
                ...(mode === 'e2ee' ? { encryptedDataKey: sealPublicShareDataKeyV1({ dataKey: contentKey, secret: 'A'.repeat(43), randomBytes: tweetnacl.randomBytes }) } : {}),
            } });
            expect(shared.statusCode, shared.body).toBe(200);
            for (const accountId of [undefined, stranger.id]) {
                const publicRead = await app.inject({ method: 'GET', url: `/v1/public-shares/${lookupId}/content`, headers: {
                    host: new URL(shared.json().isolatedOrigin).host, ...(accountId ? headers(accountId) : {}),
                } });
                expect(publicRead.statusCode, publicRead.body).toBe(200);
                const publicBody = publicRead.json().content.body;
                if (mode === 'plain') expect(decodePlainArtifactStoredContent(publicBody)).toEqual({ body: 'Second' });
                else expect(await openSessionDataKeyBundleV0(privacyKit.decodeBase64(publicBody), contentKey))
                    .toEqual({ status: 'authenticated', value: { body: 'Second' } });
                expect(publicRead.body).not.toContain('provenance');
                expect(publicRead.body).not.toContain(owner.id);
                expect(publicRead.body).not.toContain(private2);
                if (ownerPrivateWrap) expect(publicRead.body).not.toContain(ownerPrivateWrap);
            }
            const restoredPrivate = await encode(provenance(3, 1), privateKey);
            const restored = await app.inject({ method: 'POST', url: `/v1/artifacts/${id}/revisions/1/restore`, headers: headers(owner.id), payload: {
                header: created.json().header, expectedHeaderVersion: 1, expectedBodyVersion: 2, provenance: restoredPrivate,
            } });
            expect(restored.statusCode, restored.body).toBe(200);
            for (const account of [owner, recipient]) {
                const restoredEvent = events.mock.calls.map(([event]) => event).find(event => event.userId === account.id
                    && event.payload.body.t === 'update-artifact' && event.payload.body.body?.version === 3);
                expect(restoredEvent?.payload.body).toMatchObject({ provenance: restoredPrivate, provenanceDataEncryptionKey: mode === 'plain' ? null
                    : account.id === owner.id ? ownerPrivateWrap : recipientPrivateWrap });
            }
            expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${id}`, headers: headers(owner.id) })).json()).toMatchObject({
                provenance: restoredPrivate, bodyVersion: 3,
            });
            if (mode === 'e2ee') {
                const rebound = createSignedAccountContentBinding();
                await db.account.update({ where: { id: recipient.id }, data: rebound });
                const census = (await app.inject({ method: 'GET', url: `/v1/artifacts/${id}/access/recipients`, headers: headers(owner.id) })).json();
                const replacement = { recipientAccountId: recipient.id, recipientContentPublicKeyFingerprint: census.recipients.find((r: { recipientAccountId: string }) => r.recipientAccountId === recipient.id).contentPublicKeyFingerprint,
                    encryptedDataKey: wrap(contentKey, rebound.contentPublicKey) };
                expect((await app.inject({ method: 'POST', url: `/v1/artifacts/${id}/access/key-envelopes`, headers: headers(owner.id), payload: {
                    artifactId: id, expectedDataEncryptionKey: created.json().dataEncryptionKey, recipientKeyEnvelopes: [replacement],
                } })).statusCode).toBe(200);
                expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${id}`, headers: headers(recipient.id) })).json()).toMatchObject({ provenance: null, provenanceDataEncryptionKey: null });
                const repaired = { ...replacement, encryptedProvenanceDataKey: wrap(privateKey, rebound.contentPublicKey) };
                expect((await app.inject({ method: 'POST', url: `/v1/artifacts/${id}/access/key-envelopes`, headers: headers(owner.id), payload: {
                    artifactId: id, expectedDataEncryptionKey: created.json().dataEncryptionKey, expectedProvenanceDataEncryptionKey: ownerPrivateWrap,
                    recipientKeyEnvelopes: [repaired],
                } })).statusCode).toBe(200);
                // Content-only preparation for the same binding preserves repaired private custody.
                expect((await app.inject({ method: 'POST', url: `/v1/artifacts/${id}/access/key-envelopes`, headers: headers(owner.id), payload: {
                    artifactId: id, expectedDataEncryptionKey: created.json().dataEncryptionKey, recipientKeyEnvelopes: [replacement],
                } })).statusCode).toBe(200);
                expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${id}`, headers: headers(recipient.id) })).json()).toMatchObject({ provenance: restoredPrivate, provenanceDataEncryptionKey: repaired.encryptedProvenanceDataKey });
            }
            expect((await app.inject({ method: 'POST', url: `/v1/artifacts/${id}`, headers: headers(owner.id), payload: {
                body: await encode({ body: 'Legacy untracked save' }, contentKey), expectedBodyVersion: 3,
            } })).statusCode).toBe(200);
            expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${id}`, headers: headers(owner.id) })).json()).toMatchObject({ provenance: null });
        });
    });
});
