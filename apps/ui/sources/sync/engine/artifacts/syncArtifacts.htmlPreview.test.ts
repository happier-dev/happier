import { describe, expect, it, vi } from 'vitest';
import { ARTIFACT_UPLOAD_PATH_V1, decodeArtifactUploadMetadataV1 } from '@happier-dev/transfers';
import { ARTIFACT_HTML_BUNDLE_MIME_V1, ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, type ArtifactBlobReferenceV1 } from '@happier-dev/protocol';
import type { Artifact, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { Encryption } from '@/sync/encryption/encryption';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { hashArtifactBinaryContent, sealArtifactBinaryContent } from '@/sync/domains/artifacts/artifactBinaryContent';
import { encodeBase64 } from '@/encryption/base64';
import { createArtifactWithHeaderViaApi, updateArtifactWithHeaderViaApi, fetchArtifactForViewFromApi, type ArtifactDataKeyCache } from './syncArtifacts';

const artifactId = '29c6d6dd-8a45-4b30-a362-acdc5c700247';
const blobId = 'f3d86e48-5552-4b66-af88-709c083bd134';
const html = '<!doctype html><h1>Private HTML</h1><script>document.title="Executed"</script>';

describe('Artifact HTML private preview', () => {
    it.each(['create', 'update'] as const)('rejects malformed HTML bundle bytes before a %s can commit', async (operation) => {
        let committed = false;
        const request = async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (init?.method === 'POST') {
                if (path !== ARTIFACT_UPLOAD_PATH_V1 || !(init.body instanceof ArrayBuffer)) throw new Error('Expected canonical Artifact upload frame');
                const frame = new Uint8Array(init.body);
                const write = decodeArtifactUploadMetadataV1(frame.subarray(0, frame.indexOf(10)));
                committed = true;
                if (operation === 'create') {
                    if (write.kind !== 'create') throw new Error('Expected create destination');
                    return Response.json({ id: write.artifactId, header: write.header, body: write.body, dataEncryptionKey: write.dataEncryptionKey,
                        ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
                        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
                }
                return Response.json({ success: true, headerVersion: 2, bodyVersion: 2 });
            }
            throw new Error(`Unexpected HTTP path ${path}`);
        };
        const common = { credentials: { token: 'captured-token' }, request, encryption: null, artifactDataKeys: new Map(),
            header: { kind: 'html' }, body: { bytes: new TextEncoder().encode('{"v":1,"entrypoint":"../private.html","files":{}}'), mime: ARTIFACT_HTML_BUNDLE_MIME_V1 } };
        const current: DecryptedArtifact = { id: artifactId, title: 'HTML', header: { kind: 'html', title: 'HTML' }, rawHeader: { kind: 'html', title: 'HTML' },
            body: html, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, storageMode: 'plain', isDecrypted: true };
        const outcome = await (operation === 'create'
            ? createArtifactWithHeaderViaApi({ ...common, addArtifact: () => {} })
            : updateArtifactWithHeaderViaApi({ ...common, artifactId, getArtifact: () => current, updateArtifact: () => {} }))
            .then(() => null, (error: unknown) => error);
        expect(committed).toBe(false);
        expect(outcome).toMatchObject({ code: 'artifact_html_content_invalid' });
    });
    it.each(['plain', 'e2ee'] as const)('opens %s stored bytes using captured authentication without creating a public share', async (mode) => {
        const encryption = mode === 'e2ee' ? await Encryption.create(new Uint8Array(32).fill(12)) : null;
        const dataKey = new Uint8Array(32).fill(9);
        const codec = new ArtifactEncryption(dataKey);
        const envelope = encryption ? encodeBase64(await encryption.encryptEncryptionKey(dataKey)) : ARTIFACT_PLAIN_DATA_KEY_MARKER;
        const bytes = new TextEncoder().encode(html);
        const reference: ArtifactBlobReferenceV1 = { blobId, mime: 'text/html', sizeBytes: bytes.length,
            sha256: hashArtifactBinaryContent(bytes) };
        // HTTP is substituted; header/body opening, recipient preparation and blob integrity remain real.
        const artifact: Artifact = { id: artifactId, ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
            dataEncryptionKey: envelope,
            header: mode === 'plain' ? encodePlainArtifactStoredContent({ kind: 'html', title: 'HTML' })
                : await codec.encryptHeader({ kind: 'html', title: 'HTML' }),
            body: mode === 'plain' ? encodePlainArtifactStoredContent({ body: html }) : await codec.encryptBody({ body: reference }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const content = await sealArtifactBinaryContent(bytes, mode, mode === 'e2ee' ? codec : null);
        const artifactDataKeys: ArtifactDataKeyCache = new Map(mode === 'e2ee' ? [[artifactId, { envelope, dataKey }]] : []);
        const paths: string[] = [];
        const request = async (path: string, init?: RequestInit) => {
            paths.push(path);
            expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer captured-token');
            expect(init?.method ?? 'GET').toBe('GET');
            if (path === `/v1/artifacts/${artifactId}`) return Response.json(artifact);
            if (path.endsWith('/recipients')) return Response.json({ artifactId, ownerAccountId: 'owner', access: 'owner',
                encryptionMode: mode, dataEncryptionKey: artifact.dataEncryptionKey,
                callerDataEncryptionKey: artifact.dataEncryptionKey, recipients: [] });
            if (path === `/v1/artifacts/${artifactId}/blobs/${blobId}`) return Response.json({ blobId, content });
            if (path === `/v1/artifacts/${artifactId}/html-preview`) return Response.json({ url: `https://${artifactId}.preview.test/a/${artifactId}` });
            throw new Error(`Unexpected HTTP path ${path}`);
        };
        const headerOpens = vi.spyOn(ArtifactEncryption.prototype, 'decryptHeaderRaw');
        const bodyOpens = vi.spyOn(ArtifactEncryption.prototype, 'decryptBody');
        const params = { artifactId, credentials: { token: 'captured-token' }, request, encryption, artifactDataKeys };
        const view = await fetchArtifactForViewFromApi({ ...params, includePdfPreview: true });
        const result = view?.htmlPreviewUrl;
        if (!result) throw new Error('Missing opened HTML preview');
        console.info('HTML Artifact composed read measurement', { mode,
            heads: paths.filter(path => path === `/v1/artifacts/${artifactId}`).length,
            preparations: paths.filter(path => path.endsWith('/recipients')).length,
            headerOpens: headerOpens.mock.calls.length, bodyOpens: bodyOpens.mock.calls.length });
        expect(paths.filter(path => path === `/v1/artifacts/${artifactId}`)).toHaveLength(1);
        expect(paths.filter(path => path.endsWith('/recipients'))).toHaveLength(mode === 'e2ee' ? 1 : 0);
        expect(headerOpens).toHaveBeenCalledTimes(mode === 'e2ee' ? 1 : 0);
        expect(bodyOpens).toHaveBeenCalledTimes(mode === 'e2ee' ? 1 : 0);
        headerOpens.mockRestore();
        bodyOpens.mockRestore();
        const url = new URL(result);
        expect(url.origin).toBe(`https://${artifactId}.preview.test`);
        expect(url.search).toBe('');
        const bundle: unknown = JSON.parse(Buffer.from(url.hash.slice(3), 'base64url').toString('utf8'));
        expect(bundle).toMatchObject({ v: 1, entrypoint: 'index.html', files: { 'index.html': { mime: 'text/html',
            contentBase64: Buffer.from(bytes).toString('base64') } } });
        expect(paths.some(path => path.includes('public'))).toBe(false);
        if (mode === 'plain') expect(artifactDataKeys.size).toBe(0);
    });
});
