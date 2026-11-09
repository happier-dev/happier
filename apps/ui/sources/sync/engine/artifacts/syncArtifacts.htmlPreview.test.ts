import { describe, expect, it, vi } from 'vitest';
import { ARTIFACT_UPLOAD_PATH_V1, decodeArtifactUploadMetadataV1 } from '@happier-dev/transfers';
import { ARTIFACT_HTML_BUNDLE_MIME_V1} from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent} from '@happier-dev/protocol/storage/artifactStoredContent';
import { type ArtifactBlobReferenceV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import type { Artifact, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { Encryption } from '@/sync/encryption/encryption';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { hashArtifactBinaryContent, sealArtifactBinaryContent } from '@/sync/domains/artifacts/artifactBinaryContent';
import { encodeBase64 } from '@/encryption/base64';
import { createArtifactWithHeaderViaApi, updateArtifactWithHeaderViaApi, fetchArtifactForViewFromApi, fetchArtifactWithBodyFromApi,
    fetchArtifactBodyRevisionsFromApi, type ArtifactDataKeyCache } from './syncArtifacts';
import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';

const artifactId = '29c6d6dd-8a45-4b30-a362-acdc5c700247';
const blobId = 'f3d86e48-5552-4b66-af88-709c083bd134';
const html = '<!doctype html><h1>Private HTML</h1><script>document.title="Executed"</script>';

function detailBatch(artifact: Artifact) {
    return { items: [{ artifactId: artifact.id, ok: true, artifact: { ...artifact, publicAudience: 'none' },
        recipientCensus: artifact.encryptionMode === 'e2ee' ? { artifactId: artifact.id,
            ownerAccountId: artifact.ownerAccountId, access: artifact.access, encryptionMode: 'e2ee',
            dataEncryptionKey: artifact.dataEncryptionKey, callerDataEncryptionKey: artifact.dataEncryptionKey,
            recipients: [] } : null }] };
}

describe('Artifact HTML private preview', () => {
    it.each(['plain', 'e2ee'] as const)('retains %s approval replay custody while refusing generic Document and history reads', async mode => {
        const encryption = mode === 'e2ee' ? await Encryption.create(new Uint8Array(32).fill(12)) : null;
        const dataKey = new Uint8Array(32).fill(9);
        const codec = new ArtifactEncryption(dataKey);
        const envelope = encryption ? encodeBase64(await encryption.encryptEncryptionKey(dataKey)) : ARTIFACT_PLAIN_DATA_KEY_MARKER;
        const body = JSON.stringify({ executionOriginV1: { externalActionExecutionAuthorization: { v: 1 } } });
        for (const kind of ['approval_request.v1', 'target_action_approval.v1', 'execution_run_host_action_approval.v1']) {
            const header = { kind, title: 'Review request', excerpt: body };
            const stored: Artifact = { id: artifactId, ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
                dataEncryptionKey: envelope, header: mode === 'plain' ? encodePlainArtifactStoredContent(header) : await codec.encryptHeader(header),
                body: mode === 'plain' ? encodePlainArtifactStoredContent({ body }) : await codec.encryptBody({ body }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
            const request = async (path: string) => {
                if (path === '/v1/artifacts/read') return Response.json(detailBatch(stored));
                if (path === `/v1/artifacts/${artifactId}`) return Response.json(stored);
                if (path.endsWith('/recipients')) return Response.json({ artifactId, ownerAccountId: 'owner', access: 'owner',
                    encryptionMode: mode, dataEncryptionKey: envelope, callerDataEncryptionKey: envelope, recipients: [] });
                if (path.endsWith('/revisions')) return Response.json({ revisions: [{ bodyVersion: 1,
                    body: stored.body, createdAt: 1, sizeBytes: 1 }], retentionCount: 10 });
                throw new Error('Unexpected approval transport request');
            };
            const artifactDataKeys: ArtifactDataKeyCache = new Map(mode === 'e2ee' ? [[artifactId, { envelope, dataKey }]] : []);
            const params = { artifactId, credentials: { token: 'fixture-auth' }, request, encryption, artifactDataKeys };
            // Project only the outcome, so even a failing confidentiality test cannot dump custody.
            const outcome = (result: Promise<unknown>) => result.then(() => ({ code: 'returned_content' }),
                (error: unknown) => ({ code: error && typeof error === 'object' ? Reflect.get(error, 'code') : null }));
            expect(await outcome(fetchArtifactForViewFromApi(params)))
                .toEqual({ code: 'artifact_kind_internal' });
            expect(await outcome(fetchArtifactBodyRevisionsFromApi(params))).toEqual({ code: 'artifact_kind_internal' });
            const privateRead = await fetchArtifactWithBodyFromApi(params);
            expect(privateRead?.body).toBe(body);
        }
    });
    it('opens a saved text-bundle with its stored MIME and effective network policy', async () => {
        const bundle = { ...artifactHtmlBundleFromBodyV1(html), requestedCapabilities: { networkOrigins: ['https://api.example.com'] } };
        const artifact: Artifact = { id: artifactId, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind: 'html', title: 'HTML', mime: ARTIFACT_HTML_BUNDLE_MIME_V1 }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(bundle) }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const request = async (path: string) => Response.json(path === '/v1/artifacts/read' ? detailBatch(artifact) : artifact);
        const view = await fetchArtifactForViewFromApi({ artifactId, credentials: { token: 'captured-token' }, request,
            encryption: null, artifactDataKeys: new Map() });
        expect(view?.htmlPreview?.bundle).toEqual(bundle);
    });
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
            expect(init?.method ?? 'GET').toBe(path === '/v1/artifacts/read' ? 'POST' : 'GET');
            if (path === '/v1/artifacts/read') return Response.json(detailBatch(artifact));
            if (path === `/v1/artifacts/${artifactId}`) return Response.json(artifact);
            if (path.endsWith('/recipients')) return Response.json({ artifactId, ownerAccountId: 'owner', access: 'owner',
                encryptionMode: mode, dataEncryptionKey: artifact.dataEncryptionKey,
                callerDataEncryptionKey: artifact.dataEncryptionKey, recipients: [] });
            if (path === `/v1/artifacts/${artifactId}/blobs/${blobId}`) return Response.json({ blobId, content });
            // A private local frame must not depend on Home preview DNS/TLS.
            if (path === `/v1/artifacts/${artifactId}/html-preview`) return Response.json({ error: 'artifact_html_isolation_unavailable' }, { status: 503 });
            throw new Error(`Unexpected HTTP path ${path}`);
        };
        const headerOpens = vi.spyOn(ArtifactEncryption.prototype, 'decryptHeaderRaw');
        const bodyOpens = vi.spyOn(ArtifactEncryption.prototype, 'decryptBody');
        const params = { artifactId, credentials: { token: 'captured-token' }, request, encryption, artifactDataKeys };
        const view = await fetchArtifactForViewFromApi(params);
        const result = view?.htmlPreview;
        if (!result) throw new Error('Missing opened HTML preview');
        console.info('HTML Artifact composed read measurement', { mode,
            heads: paths.filter(path => path === `/v1/artifacts/${artifactId}`).length,
            preparations: paths.filter(path => path.endsWith('/recipients')).length,
            headerOpens: headerOpens.mock.calls.length, bodyOpens: bodyOpens.mock.calls.length });
        expect(paths.filter(path => path === '/v1/artifacts/read')).toHaveLength(mode === 'e2ee' ? 1 : 0);
        expect(paths.filter(path => path === `/v1/artifacts/${artifactId}`)).toHaveLength(mode === 'e2ee' ? 0 : 1);
        expect(paths.filter(path => path.endsWith('/recipients'))).toHaveLength(0);
        expect(headerOpens).toHaveBeenCalledTimes(mode === 'e2ee' ? 1 : 0);
        expect(bodyOpens).toHaveBeenCalledTimes(mode === 'e2ee' ? 1 : 0);
        headerOpens.mockRestore();
        bodyOpens.mockRestore();
        expect(paths.filter(path => path.endsWith('/html-preview'))).toHaveLength(0);
        expect(result.bundle).toMatchObject({ v: 1, entrypoint: 'index.html', files: { 'index.html': { mime: 'text/html',
            contentBase64: Buffer.from(bytes).toString('base64') } } });
        expect(paths.some(path => path.includes('public'))).toBe(false);
        if (mode === 'plain') expect(artifactDataKeys.size).toBe(0);
    });
});
