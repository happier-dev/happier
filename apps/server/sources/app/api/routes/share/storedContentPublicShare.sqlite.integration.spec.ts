import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as privacyKit from "privacy-kit";
import { createHash } from "node:crypto";
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, ARTIFACT_HTML_BUNDLE_MIME_V1, encodePlainArtifactStoredContent, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION, buildAccountStoredContentCompatibilityHttpHeadersV1 } from "@happier-dev/protocol";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { sealPublicShareDataKeyV1, openPublicShareDataKeyV1, sealSessionDataKeyBundleV0, openSessionDataKeyBundleV0 } from "@happier-dev/protocol";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { publicShareRoutes } from "./publicShareRoutes";
import { registerSessionListingRoutes } from "../session/registerSessionListingRoutes";
import { registerSessionPatchRoute } from "../session/registerSessionPatchRoute";
import { updateSessionMetadataTupleWithRetry } from "@happier-dev/cli-common/sessionMetadata";
import { createPlainSessionOwnerMetadataEnvelopeV1 } from "@happier-dev/protocol";
import { createAccountScopedCryptoMaterialSnapshotV1, sealSessionOwnerMetadataEnvelopeV1, openSessionOwnerMetadataEnvelopeV1 } from "@happier-dev/protocol";
import tweetnacl from "tweetnacl";
import { resolveStoredContentPublicShareOrigin } from "@/app/share/storedContentPublicShareOrigin";
import { artifactsRoutes } from '../artifacts/artifactsRoutes';
import { frameSessionDataKeyBundleV0, sealAesGcmPayloadWebCrypto } from '@happier-dev/protocol';
import { loadPublicShareViewerContent } from './publicShareViewerClient';
import { writeSessionPublicShare } from '@/app/share/storedContentPublicShare';
import { readSessionAccessAuthenticationFromRequest } from '@/app/session/access/sessionAccessAuthentication';

describe("stored-content public share owner (real SQLite)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-stored-public-share-", initEncrypt: true, initFiles: true, env: {
            HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: "preview.example.test",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: "1",
        } });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it('rejects token-only Session publication at both the route and canonical owner without isolation', async () => {
        const owner = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{"v":1}', metadataLayoutVersion: 1,
            ownerMetadata: JSON.stringify({ t: 'encrypted', c: 'oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==' }) } });
        const previous = process.env.HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN;
        delete process.env.HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN;
        try {
            await withAuthenticatedTestApp(publicShareRoutes, async app => {
                const response = await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/public-share`,
                    headers: { 'x-test-user-id': owner.id, ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
                    payload: { token: 'new-legacy-publication' } });
                expect(response.statusCode, response.body).toBe(400);
            });
            const legacyInput = { userId: owner.id, sessionId: session.id,
                authentication: readSessionAccessAuthenticationFromRequest({ authAuthority: 'present_user' }),
                supportsCurrentProtocol: true, token: 'new-legacy-publication' };
            expect(await writeSessionPublicShare(legacyInput)).toEqual({ type: 'error', error: 'lookupId required' });
            expect(await db.publicSessionShare.count({ where: { sessionId: session.id } })).toBe(0);
        } finally {
            if (previous === undefined) delete process.env.HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN;
            else process.env.HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN = previous;
        }
    });

    it.each(['session', 'stored-content'] as const)('publishes a fragment Session link through the %s route without old-component negotiation and requires isolation', async route => {
        const owner = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{"v":1}', metadataLayoutVersion: 1,
            ownerMetadata: JSON.stringify({ t: 'encrypted', c: 'oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==' }) } });
        const lookupId = crypto.randomUUID();
        const payload = { lookupId, keyDerivation: 'fragment_v1', ...(route === 'stored-content' ? { subject: { kind: 'session', id: session.id } } : {}) };
        const url = route === 'session' ? `/v1/sessions/${session.id}/public-share` : '/v1/public-shares';
        await withAuthenticatedTestApp(publicShareRoutes, async app => {
            const previous = process.env.HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN;
            delete process.env.HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN;
            try {
                const blocked = await app.inject({ method: 'POST', url, headers: { 'x-test-user-id': owner.id }, payload });
                expect(blocked.statusCode, blocked.body).toBe(503);
                expect(blocked.json()).toEqual({ error: 'public_share_isolation_unavailable' });
                expect(await db.publicSessionShare.count({ where: { sessionId: session.id } })).toBe(0);
            } finally {
                if (previous === undefined) delete process.env.HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN;
                else process.env.HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN = previous;
            }
            const created = await app.inject({ method: 'POST', url, headers: { 'x-test-user-id': owner.id }, payload });
            expect(created.statusCode, created.body).toBe(200);
            const stored = await db.publicSessionShare.findUniqueOrThrow({ where: { sessionId: session.id } });
            expect(stored.keyDerivation).toBe('fragment_v1');
            expect(Buffer.from(stored.tokenHash)).toEqual(createHash('sha256').update(lookupId).digest());
            expect(created.json().isolatedOrigin).toBe(resolveStoredContentPublicShareOrigin(stored.id));
        });
    });

    it('keeps legacy Session settings and revocation available while rotation requires fragment publication', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{"v":1}', metadataLayoutVersion: 1,
            ownerMetadata: JSON.stringify(createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, workspace: {} })) } });
        const token = 'retained-' + crypto.randomUUID();
        const share = await db.publicSessionShare.create({ data: { sessionId: session.id, createdByUserId: owner.id,
            tokenHash: createHash('sha256').update(token).digest(), useCount: 4 } });
        const headers = { 'x-test-user-id': owner.id };
        const url = `/v1/sessions/${session.id}/public-share`;
        const previous = process.env.HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN;
        delete process.env.HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN;
        try {
            await withAuthenticatedTestApp(publicShareRoutes, async app => {
                const settings = await app.inject({ method: 'POST', url, headers, payload: { isConsentRequired: true, maxUses: 8 } });
                expect(settings.statusCode, settings.body).toBe(200);
                expect(await db.publicSessionShare.findUniqueOrThrow({ where: { id: share.id } })).toMatchObject({
                    keyDerivation: 'legacy_token_v1', tokenHash: share.tokenHash, useCount: 4, maxUses: 8, isConsentRequired: true,
                });
                const refused = await app.inject({ method: 'POST', url, headers, payload: { token: 'replacement-token' } });
                expect(refused.statusCode, refused.body).toBe(400);
                const lookupId = crypto.randomUUID();
                const rotation = { lookupId, keyDerivation: 'fragment_v1', maxUses: 8 };
                const blocked = await app.inject({ method: 'POST', url, headers, payload: rotation });
                expect(blocked.statusCode, blocked.body).toBe(503);
                expect(await db.publicSessionShare.findUniqueOrThrow({ where: { id: share.id } })).toMatchObject({ tokenHash: share.tokenHash, useCount: 4 });
                process.env.HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN = previous;
                const rotated = await app.inject({ method: 'POST', url, headers, payload: rotation });
                expect(rotated.statusCode, rotated.body).toBe(200);
                const rotatedRow = await db.publicSessionShare.findUniqueOrThrow({ where: { id: share.id } });
                expect(rotatedRow).toMatchObject({ keyDerivation: 'fragment_v1', useCount: 0 });
                expect(Buffer.from(rotatedRow.tokenHash)).toEqual(createHash('sha256').update(lookupId).digest());
                expect((await app.inject({ method: 'GET', url: `/v1/public-share/${token}` })).statusCode).toBe(404);
                delete process.env.HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN;
                expect((await app.inject({ method: 'DELETE', url, headers })).statusCode).toBe(200);
                expect(await db.publicSessionShare.findUnique({ where: { id: share.id } })).toBeNull();
            });
        } finally {
            if (previous === undefined) delete process.env.HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN;
            else process.env.HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN = previous;
        }
    });

    it.each(['widget-area-layout.v1', 'home-hub-layout.v1', 'approval_request.v1'])('refuses Plain Account public publication of %s without writing a share', async kind => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            headerVersion: 1, bodyVersion: 1, header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: '{}' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        await withAuthenticatedTestApp(publicShareRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v1/public-shares', headers: { 'x-test-user-id': owner.id },
                payload: { subject: { kind: 'artifact', id: artifact.id }, lookupId: crypto.randomUUID(), keyDerivation: 'fragment_v1' } });
            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({ error: 'artifact_kind_not_shareable' });
            expect(await db.publicSessionShare.count({ where: { artifactId: artifact.id } })).toBe(0);
        });
    });

    it('returns a private per-Artifact shell URL through ordinary access without creating a share', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            headerVersion: 1, bodyVersion: 1, header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'html', title: 'Private HTML' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: '<h1>Private bytes</h1>' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const response = await app.inject({ method: 'GET', url: `/v1/artifacts/${artifact.id}/html-preview`, headers: { 'x-test-user-id': owner.id } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({ url: `${resolveStoredContentPublicShareOrigin(artifact.id)}/a/${artifact.id}` });
            expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${artifact.id}/html-preview`, headers: { 'x-test-user-id': stranger.id } })).statusCode).toBe(404);
            expect(await db.publicSessionShare.count({ where: { artifactId: artifact.id } })).toBe(0);
            const host = new URL(response.json().url).host;
            expect((await app.inject({ method: 'GET', url: `/a/${artifact.id}`, headers: { host } })).statusCode).toBe(200);
            expect((await app.inject({ method: 'GET', url: `/a/${artifact.id}`, headers: { host: 'home.example.test' } })).statusCode).toBe(404);
            expect((await app.inject({ method: 'GET', url: `/a/${artifact.id}`, headers: { host, cookie: 'account=secret' } })).statusCode).toBe(404);
            const previous = process.env.HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN;
            delete process.env.HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN;
            try { expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${artifact.id}/html-preview`, headers: { 'x-test-user-id': owner.id } })).json()).toEqual({ error: 'artifact_html_isolation_unavailable' }); }
            finally { process.env.HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN = previous; }
        });
    });

    it('publishes real retained bundle bytes through share admission, not an independent asset store', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const id = crypto.randomUUID();
        const blobId = crypto.randomUUID();
        const bytes = Buffer.from(JSON.stringify({ v: 1, entrypoint: 'index.html', files: {
            'index.html': { mime: 'text/html', contentBase64: Buffer.from('<h1>Retained bundle</h1>').toString('base64') },
        } }));
        const reference = { blobId, mime: ARTIFACT_HTML_BUNDLE_MIME_V1, sizeBytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex') };
        await withAuthenticatedTestApp(app => { publicShareRoutes(app); artifactsRoutes(app); }, async app => {
            const headers = { 'x-test-user-id': owner.id };
            const created = await app.inject({ method: 'POST', url: '/v1/artifacts/content/binary', headers, payload: {
                id, header: encodePlainArtifactStoredContent({ kind: 'html', title: 'Bundle' }),
                body: encodePlainArtifactStoredContent({ body: reference }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                blob: { blobId, content: { t: 'plain', v: bytes.toString('base64') } },
            } });
            expect(created.statusCode, created.body).toBe(200);
            const lookupId = crypto.randomUUID();
            const shared = await app.inject({ method: 'POST', url: '/v1/public-shares', headers,
                payload: { subject: { kind: 'artifact', id }, lookupId, keyDerivation: 'fragment_v1' } });
            expect(shared.statusCode, shared.body).toBe(200);
            const readHeaders = { host: new URL(shared.json().isolatedOrigin).host };
            const read = await app.inject({ method: 'GET', url: `/v1/public-shares/${lookupId}/content`, headers: readHeaders });
            expect(read.statusCode, read.body).toBe(200);
            expect(read.json().content.blob).toEqual({ blobId, content: { t: 'plain', v: bytes.toString('base64') } });
            expect((await app.inject({ method: 'GET', url: `/v1/public-shares/${lookupId}/content`, headers: { ...readHeaders, cookie: 'account=secret' } })).statusCode).toBe(403);
            await app.inject({ method: 'DELETE', url: `/v1/public-shares/${shared.json().publicShare.id}`, headers });
            expect((await app.inject({ method: 'GET', url: `/v1/public-shares/${lookupId}/content`, headers: readHeaders })).statusCode).toBe(404);
        });
    });

    it.each(['plain', 'e2ee'] as const)('opens %s binary publications through consent and revocation while private blobs stay authorized', async mode => {
        const owner = await db.account.create({ data: { ...(mode === 'e2ee' ? createSignedAccountContentBinding() : {}), encryptionMode: mode } });
        const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
        const key = new Uint8Array(32).fill(21);
        const secret = 'A'.repeat(43);
        const encode = async (value: unknown) => mode === 'plain' ? encodePlainArtifactStoredContent(value) : privacyKit.encodeBase64(new Uint8Array(await sealSessionDataKeyBundleV0(value, key)));
        await withAuthenticatedTestApp(app => { publicShareRoutes(app); artifactsRoutes(app); }, async app => {
            for (const [kind, mime] of [['image', 'image/png'], ['pdf', 'application/pdf'], ['file', 'application/octet-stream']] as const) {
                const id = crypto.randomUUID();
                const blobId = crypto.randomUUID();
                const bytes = new Uint8Array([0, 128, 255, 13, 10]);
                const reference = { blobId, mime, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
                const blob = { blobId, content: mode === 'plain' ? { t: 'plain', v: privacyKit.encodeBase64(bytes) } : { t: 'encrypted', c: privacyKit.encodeBase64(new Uint8Array(frameSessionDataKeyBundleV0(await sealAesGcmPayloadWebCrypto(bytes, key)))) } };
                const headers = { 'x-test-user-id': owner.id };
                const created = await app.inject({ method: 'POST', url: '/v1/artifacts/content/binary', headers, payload: {
                    id, header: await encode({ kind, title: 'Shared file' }), body: await encode({ body: reference }),
                    dataEncryptionKey: mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : privacyKit.encodeBase64(new Uint8Array([31])), blob,
                } });
                expect(created.statusCode, created.body).toBe(200);
                const lookupId = crypto.randomUUID();
                const share = await app.inject({ method: 'POST', url: '/v1/public-shares', headers, payload: {
                    subject: { kind: 'artifact', id }, lookupId, keyDerivation: 'fragment_v1', isConsentRequired: true,
                    ...(mode === 'e2ee' ? { encryptedDataKey: sealPublicShareDataKeyV1({ dataKey: key, secret, randomBytes: length => new Uint8Array(length).fill(4) }) } : {}),
                } });
                expect(share.statusCode, share.body).toBe(200);
                const location = { origin: share.json().isolatedOrigin, pathname: `/s/${lookupId}`, hash: `#k=${secret}` };
                const fetch: typeof globalThis.fetch = async (url, init) => {
                    expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
                    expect(String(url)).not.toContain(secret);
                    const request = new URL(String(url));
                    const response = await app.inject({ method: 'GET', url: request.pathname + request.search, headers: { host: request.host } });
                    return new Response(response.body, { status: response.statusCode });
                };
                expect(await loadPublicShareViewerContent({ location, fetch })).toEqual({ status: 'consent_required' });
                expect((await db.publicSessionShare.findUniqueOrThrow({ where: { id: share.json().publicShare.id } })).useCount).toBe(0);
                expect(await loadPublicShareViewerContent({ location, fetch, consent: true })).toMatchObject({ status: 'ready', binary: { bytes, mime } });
                expect(await db.publicShareAccessLog.count({ where: { publicShareId: share.json().publicShare.id } })).toBe(1);
                expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${id}/blobs/${blobId}`, headers: { 'x-test-user-id': stranger.id } })).statusCode).toBe(404);
                await app.inject({ method: 'DELETE', url: `/v1/public-shares/${share.json().publicShare.id}`, headers });
                expect(await loadPublicShareViewerContent({ location, fetch, consent: true })).toEqual({ status: 'unavailable' });
            }
        });
    });

    it("publishes an ordinary plain Artifact through the canonical owner, with consent, use admission, audit and immediate revoke", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const stranger = await db.account.create({ data: { encryptionMode: "plain" } });
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            headerVersion: 1, bodyVersion: 1, header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ title: "Public document" })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: "Public text" })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        const lookupId = crypto.randomUUID();
        const headers = { "x-test-user-id": owner.id };
        await withAuthenticatedTestApp(publicShareRoutes, async app => {
            const create = await app.inject({ method: "POST", url: "/v1/public-shares", headers,
                payload: { subject: { kind: "artifact", id: artifact.id }, lookupId, keyDerivation: "fragment_v1", maxUses: 1, isConsentRequired: true } });
            expect(create.statusCode, create.body).toBe(200);
            const share = create.json().publicShare;
            expect(share.subject).toEqual({ kind: "artifact", id: artifact.id });
            expect((await app.inject({ method: "GET", url: `/v1/public-shares?subjectKind=artifact&subjectId=${artifact.id}`, headers: { "x-test-user-id": stranger.id } })).statusCode).toBe(403);
            const origin = create.json().isolatedOrigin;
            expect(origin).toBe(resolveStoredContentPublicShareOrigin(artifact.id));
            const readHeaders = { host: new URL(origin).host };
            expect((await app.inject({ method: "GET", url: `/v1/public-shares/${lookupId}/content`, headers: readHeaders })).json()).toMatchObject({ requiresConsent: true });
            expect((await app.inject({ method: "GET", url: `/v1/public-shares/${lookupId}/content?consent=true`, headers: readHeaders })).json()).toMatchObject({ encryptionMode: "plain", encryptedDataKey: null, content: { kind: "artifact", body: encodePlainArtifactStoredContent({ body: "Public text" }) } });
            expect((await app.inject({ method: "GET", url: `/v1/public-shares/${lookupId}/content?consent=true`, headers: readHeaders })).statusCode).toBe(404);
            const logs = await app.inject({ method: "GET", url: `/v1/public-shares/${share.id}/access-log`, headers });
            expect(logs.json().accessLog).toHaveLength(1);
            expect((await app.inject({ method: "DELETE", url: `/v1/public-shares/${share.id}`, headers })).statusCode).toBe(200);
            expect((await app.inject({ method: "GET", url: `/v1/public-shares/${lookupId}/content?consent=true`, headers: readHeaders })).statusCode).toBe(404);
        });
    });

    it("preserves path-token Session rows after privacy upgrade and refuses ordinary publication of plugin assets", async () => {
        const owner = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain", metadata: '{"v":1}', metadataLayoutVersion: 1, ownerMetadata: JSON.stringify({ t: "encrypted", c: "oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==" }) } });
        const token = crypto.randomUUID();
        await db.publicSessionShare.create({ data: { sessionId: session.id, createdByUserId: owner.id, tokenHash: createHash("sha256").update(token).digest() } });
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id, header: new Uint8Array([1]), body: new Uint8Array([2]), dataEncryptionKey: new Uint8Array([3]) } });
        await db.accountPluginRelease.create({ data: { accountId: owner.id, pluginId: "com.test.public", version: "1.0.0", archiveDigestSha256: "0".repeat(64), normalizedManifest: {}, collectionContracts: {}, uiSlots: [], packageAssetArtifactId: artifact.id } });
        await withAuthenticatedTestApp(publicShareRoutes, async app => {
            expect((await app.inject({ method: "GET", url: `/v1/public-share/${token}`, headers: buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) })).statusCode).toBe(200);
            const response = await app.inject({ method: "POST", url: "/v1/public-shares", headers: { "x-test-user-id": owner.id }, payload: { subject: { kind: "artifact", id: artifact.id }, lookupId: crypto.randomUUID(), keyDerivation: "fragment_v1" } });
            expect(response.statusCode).toBe(403);
        });
    });

    it("denies unavailable content while keeping the static viewer usable after revocation", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id, headerVersion: 1, bodyVersion: 1,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ title: "Shell" })), body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: "Text" })), dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        await withAuthenticatedTestApp(publicShareRoutes, async app => {
            const lookupId = crypto.randomUUID();
            const headers = { "x-test-user-id": owner.id };
            const created = await app.inject({ method: "POST", url: "/v1/public-shares", headers, payload: { subject: { kind: "artifact", id: artifact.id }, lookupId, keyDerivation: "fragment_v1" } });
            expect(created.statusCode, created.body).toBe(200);
            const host = new URL(created.json().isolatedOrigin).host;
            for (const url of [`/s/${lookupId}`, `/s/${lookupId}/viewer.js`]) {
                expect((await app.inject({ method: 'GET', url, headers: { host, cookie: 'account=secret' } })).statusCode).toBe(404);
                expect((await app.inject({ method: 'GET', url, headers: { host, authorization: 'Bearer secret' } })).statusCode).toBe(404);
            }
            expect((await app.inject({ method: "GET", url: `/s/${lookupId}`, headers: { host: "home.example.test" } })).statusCode).toBe(404);
            expect((await app.inject({ method: "GET", url: `/v1/public-shares/${lookupId}/content`, headers: { host: "home.example.test" } })).statusCode).toBe(404);
            const shell = await app.inject({ method: "GET", url: `/s/${lookupId}`, headers: { host } });
            expect(shell.statusCode, shell.body).toBe(200);
            expect(shell.headers["content-security-policy"]).toContain("connect-src 'self'");
            expect(shell.headers["set-cookie"]).toBeUndefined();
            expect((await app.inject({ method: "GET", url: `/s/${lookupId}/viewer.js`, headers: { host } })).headers["content-type"]).toContain("application/javascript");
            await db.account.update({ where: { id: owner.id }, data: { encryptionMode: "e2ee" } });
            const mismatched = await app.inject({ method: "GET", url: `/v1/public-shares/${lookupId}/content`, headers: { host } });
            expect(mismatched.statusCode, mismatched.body).toBe(404);
            expect((await db.publicSessionShare.findUniqueOrThrow({ where: { id: created.json().publicShare.id } })).useCount).toBe(0);
            expect(await db.publicShareAccessLog.count({ where: { publicShareId: created.json().publicShare.id } })).toBe(0);
            await db.account.update({ where: { id: owner.id }, data: { encryptionMode: "plain" } });
            await db.artifact.update({ where: { id: artifact.id }, data: { deletedAt: new Date() } });
            expect((await app.inject({ method: "GET", url: `/v1/public-shares/${lookupId}/content`, headers: { host } })).statusCode).toBe(404);
            expect((await app.inject({ method: "GET", url: `/s/${lookupId}`, headers: { host } })).statusCode).toBe(404);
            expect((await app.inject({ method: "GET", url: `/s/${lookupId}/viewer.js`, headers: { host } })).statusCode).toBe(200);
            expect((await app.inject({ method: "POST", url: "/v1/public-shares", headers,
                payload: { subject: { kind: "artifact", id: artifact.id }, lookupId: crypto.randomUUID(), keyDerivation: "fragment_v1" } })).statusCode).toBe(403);
            expect((await db.publicSessionShare.findUniqueOrThrow({ where: { id: created.json().publicShare.id } })).useCount).toBe(0);
            await db.artifact.update({ where: { id: artifact.id }, data: { deletedAt: null } });
            await app.inject({ method: "DELETE", url: `/v1/public-shares/${created.json().publicShare.id}`, headers });
            const revoked = await app.inject({ method: "GET", url: `/s/${lookupId}`, headers: { host } });
            expect(revoked.statusCode).toBe(404);
            expect(revoked.body).toBe(shell.body);
            expect(revoked.headers["content-type"]).toContain("text/html");
            expect((await app.inject({ method: "GET", url: `/s/${lookupId}/viewer.js`, headers: { host } })).statusCode).toBe(200);
        });
    });

    it.each(["artifact", "session"] as const)("cannot unwrap an E2EE %s with server-observed lookup/hash; the fragment secret alone opens canonical ciphertext", async kind => {
        const owner = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        const key = new Uint8Array(32).fill(17);
        const lookupId = "lookup-" + crypto.randomUUID();
        const secret = "secret-" + crypto.randomUUID();
        const sealed = new Uint8Array(await sealSessionDataKeyBundleV0({ v: 1, title: "Private document", body: "Private text" }, key));
        const encryptedDataKey = sealPublicShareDataKeyV1({ dataKey: key, secret, randomBytes: length => new Uint8Array(length).fill(23) });
        const storedOwner = JSON.stringify({ t: "encrypted", c: "oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==" });
        const subject = kind === "artifact"
            ? await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id, headerVersion: 1, bodyVersion: 1, header: sealed, body: sealed, dataEncryptionKey: new Uint8Array([31]) } })
            : await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "e2ee", metadata: privacyKit.encodeBase64(sealed), metadataLayoutVersion: 1, ownerMetadata: storedOwner } });
        const headers = { "x-test-user-id": owner.id, ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
        if (kind === "session") {
            for (const seq of [1, 2]) await db.sessionMessage.create({ data: { sessionId: subject.id, seq, content: { t: "encrypted", c: privacyKit.encodeBase64(sealed) } } });
            // Canonical reader accepts the released retained bare-ciphertext
            // and ciphertext-object shapes without imposing a current floor.
            await db.$executeRawUnsafe('UPDATE "SessionMessage" SET "content"=? WHERE "sessionId"=? AND "seq"=1', JSON.stringify(privacyKit.encodeBase64(sealed)), subject.id);
            await db.$executeRawUnsafe('UPDATE "SessionMessage" SET "content"=? WHERE "sessionId"=? AND "seq"=2', JSON.stringify({ ciphertext: privacyKit.encodeBase64(sealed) }), subject.id);
        }
        await withAuthenticatedTestApp(publicShareRoutes, async app => {
            const created = await app.inject({ method: "POST", url: "/v1/public-shares", headers, payload: { subject: { kind, id: subject.id }, lookupId, encryptedDataKey, keyDerivation: "fragment_v1", maxUses: 1 } });
            expect(created.statusCode, created.body).toBe(200);
            const stored = await db.publicSessionShare.findUniqueOrThrow({ where: { id: created.json().publicShare.id } });
            expect(Buffer.from(stored.tokenHash).toString("hex")).toBe(createHash("sha256").update(lookupId).digest("hex"));
            expect(JSON.stringify(stored)).not.toContain(secret);
            const envelope = Buffer.from(stored.encryptedDataKey!).toString("base64");
            expect(openPublicShareDataKeyV1({ encryptedDataKey: envelope, secret: lookupId })).toBeNull();
            expect(openPublicShareDataKeyV1({ encryptedDataKey: envelope, secret: Buffer.from(stored.tokenHash).toString("hex") })).toBeNull();
            const readHeaders = { host: new URL(created.json().isolatedOrigin).host };
            const read = await app.inject({ method: "GET", url: `/v1/public-shares/${lookupId}/content?limit=1`, headers: readHeaders });
            expect(read.statusCode, read.body).toBe(200);
            const value = read.json();
            const openedKey = openPublicShareDataKeyV1({ encryptedDataKey: value.encryptedDataKey, secret });
            expect(openedKey).toEqual(key);
            const ciphertext = kind === "artifact" ? value.content.body : value.content.metadata;
            expect(await openSessionDataKeyBundleV0(privacyKit.decodeBase64(ciphertext), openedKey!)).toMatchObject({ status: "authenticated", value: { body: "Private text" } });
            expect((await app.inject({ method: "GET", url: `/v1/public-share/${lookupId}`, headers })).statusCode).toBe(404);
            if (kind === "session") {
                expect(value.content.hasMore).toBe(true);
                const url = `/v1/public-shares/${lookupId}/content?beforeSeq=${value.content.nextBeforeSeq}&limit=1`;
                expect((await app.inject({ method: "GET", url, headers: readHeaders })).statusCode).toBe(404);
                const page = await app.inject({ method: "GET", url, headers: { ...readHeaders, "x-public-share-messages-access-token": value.messagesAccessToken } });
                expect(page.statusCode, page.body).toBe(200);
                expect(page.json().content.messages.map((message: { seq: number }) => message.seq)).toEqual([1]);
                expect((await db.publicSessionShare.findUniqueOrThrow({ where: { id: stored.id } })).useCount).toBe(1);
                expect(await db.publicShareAccessLog.count({ where: { publicShareId: stored.id } })).toBe(1);
            }
        });
    });

    it("enforces the configured shared public visitor rate limit", async () => {
        const previous = { ...process.env };
        process.env.HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_CHECKER = "fixed_window";
        process.env.HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_MAX_REQUESTS = "1";
        process.env.HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_WINDOW_MS = "60000";
        try {
            const owner = await db.account.create({ data: { encryptionMode: "plain" } });
            const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id, headerVersion: 1, bodyVersion: 1,
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ title: "Limited" })), body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: "Text" })), dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
            await withAuthenticatedTestApp(publicShareRoutes, async app => {
                const lookupId = crypto.randomUUID();
                const created = await app.inject({ method: "POST", url: "/v1/public-shares", headers: { "x-test-user-id": owner.id }, payload: { subject: { kind: "artifact", id: artifact.id }, lookupId, keyDerivation: "fragment_v1" } });
                expect(created.statusCode, created.body).toBe(200);
                const headers = { host: new URL(created.json().isolatedOrigin).host };
                expect((await app.inject({ method: "GET", url: `/v1/public-shares/${lookupId}/content`, headers })).statusCode).toBe(200);
                expect((await app.inject({ method: "GET", url: `/v1/public-shares/${lookupId}/content`, headers })).statusCode).toBe(429);
                expect((await app.inject({ method: "GET", url: `/s/${lookupId}`, headers })).statusCode).toBe(429);
                expect((await app.inject({ method: "GET", url: `/s/${lookupId}/viewer.js`, headers })).statusCode).toBe(200);
                expect((await db.publicSessionShare.findUniqueOrThrow({ where: { id: created.json().publicShare.id } })).useCount).toBe(1);
            });
        } finally {
            for (const name of ["HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_CHECKER", "HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_MAX_REQUESTS", "HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_WINDOW_MS"]) {
                if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
            }
        }
    });


    it("upgrades predecessor layout-zero E2EE metadata while preserving the provenance-pinned legacy token and DEK envelope", async () => {
        // Preview asset358465308/source86d1385864dd528b864a8ba72e4c3201f67aece3.
        // ../0.2 publicShareEncryption.ts: Happy Public Share/v1 SecretBox
        // payload {v:0,keyB64}; this retained vector is not a fragment envelope.
        const token = "released-preview-public-share-vector";
        const envelope = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHMJ6ZwXvlgV+Ew6Jtlspr/Sg/SEHyrn8lcqu7Euram/O2gprQ7e4Fe1w3nB1i3RVUrT1cj9PUi4jF5+isG5G/WnzMt54qn3pC0aKPXk8e2w==";
        const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
        const machineKey = new Uint8Array(32).fill(19);
        const contentPublicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
        const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: "e2ee", material: { type: "dataKey", machineKey }, dataKeyPublicKey: contentPublicKey });
        const owner = await db.account.create({ data: { ...createSignedAccountContentBinding(contentPublicKey), encryptionMode: "e2ee" } });
        const metadata = { path: "/encrypted/owner/private", host: "owner-host", name: "Retained encrypted session" };
        const encryptPayload = async (value: unknown) => privacyKit.encodeBase64(new Uint8Array(await sealSessionDataKeyBundleV0(value, key)));
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "e2ee", metadata: await encryptPayload(metadata) } });
        const share = await db.publicSessionShare.create({ data: { sessionId: session.id, createdByUserId: owner.id, tokenHash: createHash("sha256").update(token).digest(), encryptedDataKey: privacyKit.decodeBase64(envelope) } });
        await withAuthenticatedTestApp(app => { publicShareRoutes(app); registerSessionListingRoutes(app); registerSessionPatchRoute(app); }, async app => {
            const headers = buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION);
            const blocked = await app.inject({ method: "GET", url: `/v1/public-share/${token}`, headers });
            expect(blocked.statusCode, blocked.body).toBe(409);
            expect(blocked.json()).toMatchObject({ code: "metadata_privacy_upgrade_required" });
            expect((await db.publicSessionShare.findUniqueOrThrow({ where: { id: share.id } })).useCount).toBe(0);
            expect(await db.publicShareAccessLog.count({ where: { publicShareId: share.id } })).toBe(0);
            await updateSessionMetadataTupleWithRetry({
                initialSnapshot: { mode: "legacy_owner", metadataLayoutVersion: 0, metadataVersion: session.metadataVersion,
                    metadataCiphertext: session.metadata, ownerMetadata: null, agentStateVersion: session.agentStateVersion,
                    agentStateCiphertext: null, value: { metadata, agentState: null } },
                mutation: { kind: "ownerMigration" },
                ownerMigrationCurrentness: { expectedAccountEncryptionMode: "e2ee", expectedAccountContentPublicKeyFingerprint: material.contentPublicKeyFingerprint },
                crypto: { encryptPayload, encodeOwnerMetadata: ownerMetadata => sealSessionOwnerMetadataEnvelopeV1({ material: material.material, ownerMetadata, randomBytes: length => new Uint8Array(length).fill(7) }) },
                commit: async patch => {
                    const result = await app.inject({ method: "PATCH", url: `/v2/sessions/${session.id}`, headers: { ...headers, "x-test-user-id": owner.id }, payload: patch });
                    expect(result.statusCode, result.body).toBe(200);
                    const body = result.json();
                    return { result: "success" as const, metadataVersion: body.sharedMetadata.version, agentStateVersion: body.agentState.version };
                },
                refreshAfterConflict: async () => { throw new Error("Unexpected migration conflict"); },
            });
            const ownerHeaders = { "x-test-user-id": owner.id };
            const settingsReplay = await app.inject({ method: "POST", url: `/v1/sessions/${session.id}/public-share`,
                headers: ownerHeaders, payload: { encryptedDataKey: envelope } });
            expect(settingsReplay.statusCode, settingsReplay.body).toBe(200);
            const replacementEnvelope = sealPublicShareDataKeyV1({ dataKey: key, secret: "new-fragment-secret",
                randomBytes: length => new Uint8Array(length).fill(8) });
            const keyOnlyRotation = await app.inject({ method: "POST", url: `/v1/sessions/${session.id}/public-share`,
                headers: ownerHeaders, payload: { encryptedDataKey: replacementEnvelope } });
            expect(keyOnlyRotation.statusCode, keyOnlyRotation.body).toBe(400);
            expect(keyOnlyRotation.json()).toEqual({ error: "lookupId required" });
            const response = await app.inject({ method: "GET", url: `/v1/public-share/${token}`, headers });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().session.metadataLayoutVersion).toBe(1);
            expect(response.json().encryptedDataKey).toBe(envelope);
            const retainedKey = openPublicShareDataKeyV1({ encryptedDataKey: response.json().encryptedDataKey, secret: token });
            expect(retainedKey).toEqual(key);
            const openedShared = await openSessionDataKeyBundleV0(privacyKit.decodeBase64(response.json().session.metadata), retainedKey!);
            expect(openedShared.status).toBe("authenticated");
            expect(JSON.stringify(openedShared)).not.toContain(metadata.path);
            expect(JSON.stringify(openedShared)).not.toContain(metadata.host);
            const upgraded = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            expect(openSessionOwnerMetadataEnvelopeV1({ accountMode: "e2ee", envelope: JSON.parse(upgraded.ownerMetadata!), material: material.material })).toMatchObject({ ok: true, ownerMetadata: { workspace: { path: metadata.path, host: metadata.host } } });
            expect((await db.publicSessionShare.findUniqueOrThrow({ where: { id: share.id } })).tokenHash).toEqual(share.tokenHash);
        });
    });

    it("returns the typed privacy-upgrade state for a retained modern publication without consuming a visit", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain", metadata: '{"path":"/modern/owner/private"}' } });
        const lookupId = crypto.randomUUID();
        const share = await db.publicSessionShare.create({ data: { sessionId: session.id, createdByUserId: owner.id, tokenHash: createHash("sha256").update(lookupId).digest(), keyDerivation: "fragment_v1", maxUses: 1 } });
        await withAuthenticatedTestApp(publicShareRoutes, async app => {
            const pending = await app.inject({ method: "GET", url: `/v1/public-shares/${lookupId}/content`, headers: { host: new URL(resolveStoredContentPublicShareOrigin(share.id)!).host } });
            expect(pending.statusCode, pending.body).toBe(409);
            expect(pending.json()).toMatchObject({ code: "metadata_privacy_upgrade_required" });
            expect(pending.body).not.toContain("/modern/owner/private");
            expect((await db.publicSessionShare.findUniqueOrThrow({ where: { id: share.id } })).useCount).toBe(0);
            expect(await db.publicShareAccessLog.count({ where: { publicShareId: share.id } })).toBe(0);
        });
    });

    it("discovers an archived predecessor public link on the owner's first visit and retains its token through the canonical privacy upgrade", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const metadata = { path: "/owner/private", host: "owner-host", name: "Predecessor session" };
        // ../0.2 388915739e64655b454e0bee8198833a54e6eabc has flat metadata,
        // no ownerMetadata/layout marker and SHA256(path token) publication.
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain", metadata: JSON.stringify(metadata), archivedAt: new Date() } });
        const token = crypto.randomUUID();
        const share = await db.publicSessionShare.create({ data: { sessionId: session.id, createdByUserId: owner.id, tokenHash: createHash("sha256").update(token).digest() } });
        const unshared = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain", metadata: JSON.stringify(metadata) } });
        const stranger = await db.account.create({ data: { encryptionMode: "plain" } });
        const direct = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain", metadata: JSON.stringify(metadata), archivedAt: new Date() } });
        await db.sessionShare.create({ data: { sessionId: direct.id, sharedByUserId: owner.id, sharedWithUserId: stranger.id } });
        const headers = { "x-test-user-id": owner.id, ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
        await withAuthenticatedTestApp(app => { publicShareRoutes(app); registerSessionListingRoutes(app); registerSessionPatchRoute(app); }, async app => {
            const response = await app.inject({ method: "GET", url: `/v1/public-share/${token}`, headers });
            expect(response.statusCode).toBe(409);
            expect(response.body).not.toContain("/owner/private");
            expect(response.json()).toMatchObject({ code: "metadata_privacy_upgrade_required" });
            expect((await db.publicSessionShare.findUniqueOrThrow({ where: { id: share.id } })).useCount).toBe(0);
            const discovery = await app.inject({ method: "GET", url: "/v2/sessions/metadata-upgrades", headers });
            expect(discovery.statusCode, discovery.body).toBe(200);
            expect(discovery.json().sessionIds).toContain(session.id);
            expect(discovery.json().sessionIds).toContain(direct.id);
            expect(Object.keys(discovery.json())).toEqual(["sessionIds"]);
            expect(discovery.json().sessionIds).not.toContain(unshared.id);
            expect((await app.inject({ method: "GET", url: "/v2/sessions/metadata-upgrades", headers: { "x-test-user-id": stranger.id } })).json()).toEqual({ sessionIds: [] });
            expect((await app.inject({ method: "GET", url: "/v2/sessions/metadata-upgrades" })).statusCode).toBe(401);
            expect((await app.inject({ method: "GET", url: "/v2/sessions/metadata-upgrades", headers: { ...headers, "x-test-auth-token-kind": "api_token" } })).statusCode).toBe(403);
            await updateSessionMetadataTupleWithRetry({
                initialSnapshot: { mode: "legacy_owner", metadataLayoutVersion: 0, metadataVersion: session.metadataVersion,
                    metadataCiphertext: session.metadata, ownerMetadata: null, agentStateVersion: session.agentStateVersion,
                    agentStateCiphertext: null, value: { metadata, agentState: null } },
                mutation: { kind: "ownerMigration" },
                ownerMigrationCurrentness: { expectedAccountEncryptionMode: "plain", expectedAccountContentPublicKeyFingerprint: null },
                crypto: { encryptPayload: async value => JSON.stringify(value), encodeOwnerMetadata: createPlainSessionOwnerMetadataEnvelopeV1 },
                commit: async patch => {
                    const result = await app.inject({ method: "PATCH", url: `/v2/sessions/${session.id}`, headers, payload: patch });
                    expect(result.statusCode, result.body).toBe(200);
                    const body = result.json();
                    return { result: "success" as const, metadataVersion: body.sharedMetadata.version, agentStateVersion: body.agentState.version };
                },
                refreshAfterConflict: async () => { throw new Error("Unexpected migration conflict"); },
            });
            const reopened = await app.inject({ method: "GET", url: `/v1/public-share/${token}`, headers });
            expect(reopened.statusCode, reopened.body).toBe(200);
            expect(reopened.json().session.metadataLayoutVersion).toBe(1);
            expect(reopened.body).not.toContain("/owner/private");
            expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).ownerMetadata).toContain("/owner/private");
            expect((await db.publicSessionShare.findUniqueOrThrow({ where: { id: share.id } })).tokenHash).toEqual(share.tokenHash);
            expect((await app.inject({ method: "GET", url: "/v2/sessions/metadata-upgrades", headers })).json().sessionIds).not.toContain(session.id);
        });
    });


    it("rejects retained Session message mode mismatches before public disclosure or use/audit mutation on both read adapters", async () => {
        const owner = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        const key = new Uint8Array(32).fill(9);
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "e2ee", metadata: privacyKit.encodeBase64(new Uint8Array(await sealSessionDataKeyBundleV0({ v: 1 }, key))), metadataLayoutVersion: 1,
            ownerMetadata: JSON.stringify({ t: "encrypted", c: "oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==" }) } });
        await db.sessionMessage.create({ data: { sessionId: session.id, seq: 1, content: { t: "plain", v: { text: "Retained inconsistent plaintext" } } } });
        const lookupId = crypto.randomUUID();
        const encryptedDataKey = sealPublicShareDataKeyV1({ dataKey: key, secret: "local-fragment-secret", randomBytes: size => new Uint8Array(size).fill(5) });
        await withAuthenticatedTestApp(publicShareRoutes, async app => {
            const headers = { "x-test-user-id": owner.id, ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
            const created = await app.inject({ method: "POST", url: "/v1/public-shares", headers, payload: { subject: { kind: "session", id: session.id }, lookupId, encryptedDataKey, keyDerivation: "fragment_v1" } });
            expect(created.statusCode, created.body).toBe(200);
            const response = await app.inject({ method: "GET", url: `/v1/public-shares/${lookupId}/content`, headers: { host: new URL(created.json().isolatedOrigin).host } });
            expect(response.statusCode, response.body).toBe(404);
            expect(response.body).not.toContain("Retained inconsistent plaintext");
            const shareId = created.json().publicShare.id;
            expect((await db.publicSessionShare.findUniqueOrThrow({ where: { id: shareId } })).useCount).toBe(0);
            expect(await db.publicShareAccessLog.count({ where: { publicShareId: shareId } })).toBe(0);
            // Same retained row through the historical route shape must share
            // the canonical projection guard, rather than becoming a bypass.
            await db.publicSessionShare.update({ where: { id: shareId }, data: { keyDerivation: "legacy_token_v1" } });
            const legacy = await app.inject({ method: "GET", url: `/v1/public-share/${lookupId}/messages`, headers });
            expect(legacy.statusCode, legacy.body).toBe(404);
            expect(legacy.body).not.toContain("Retained inconsistent plaintext");
        });
    });


    it("treats derivation transitions as rotations for the canonical primary-Team policy even when lookup hashes are unchanged", async () => {
        const owner = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        const team = await db.team.create({ data: { name: "No external rotations", externalSharingPolicy: "disabled" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), primaryTeamId: team.id, encryptionMode: "plain", metadata: '{"v":1}', metadataLayoutVersion: 1,
            ownerMetadata: JSON.stringify({ t: "encrypted", c: "oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==" }) } });
        const lookupId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 60_000);
        const share = await db.publicSessionShare.create({ data: { sessionId: session.id, createdByUserId: owner.id, tokenHash: createHash("sha256").update(lookupId).digest(), keyDerivation: "legacy_token_v1", maxUses: 1, useCount: 1, expiresAt } });
        await withAuthenticatedTestApp(publicShareRoutes, async app => {
            const response = await app.inject({ method: "POST", url: `/v1/sessions/${session.id}/public-share`,
                headers: { "x-test-user-id": owner.id, ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
                payload: { lookupId, keyDerivation: "fragment_v1", maxUses: 1, expiresAt: expiresAt.getTime() } });
            expect(response.statusCode, response.body).toBe(403);
            expect(response.json()).toEqual({ error: "session_access_external_sharing_disabled" });
            expect(await db.publicSessionShare.findUniqueOrThrow({ where: { id: share.id } })).toMatchObject({ keyDerivation: "legacy_token_v1", useCount: 1 });
        });
    });

});
