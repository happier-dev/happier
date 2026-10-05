import { describe, expect, it } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { encodeBase64 } from '@/encryption/base64';
import { createArtifact } from './apiArtifacts';

describe('Artifact finite upload HTTP transport', () => {
    it('sends binary bytes in one request-bound carrier without the JSON body cutoff', async () => {
        const id = '00000000-0000-4000-8000-000000000001';
        const blobId = '00000000-0000-4000-8000-000000000002';
        const bytes = new Uint8Array(1_100_000).fill(128);
        let received: Uint8Array | undefined;
        let destination: unknown;
        const request = async (path: string, init?: RequestInit) => {
            if (path === '/v1/artifacts/content/upload') {
                expect(new Headers(init?.headers).get('content-type')).toBe('application/vnd.happier.artifact-upload-v1');
                const wire = new Uint8Array(await new Response(init?.body).arrayBuffer());
                const separator = wire.indexOf(10);
                destination = JSON.parse(new TextDecoder().decode(wire.subarray(0, separator)));
                received = wire.subarray(separator + 1);
                return Response.json({ id, ownerAccountId: 'account', access: 'owner',
                    encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER });
            }
            return Response.json({ error: 'request_too_large' }, { status: 413 });
        };
        await expect(createArtifact({ token: 'token' }, { id, header: 'header', body: 'body',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, blob: { blobId, content: { t: 'plain', v: encodeBase64(bytes) } } },
            { request, retry: 'none' })).resolves.toMatchObject({ id });
        expect(destination).toEqual({ kind: 'create', artifactId: id, blobId, t: 'plain', sizeBytes: bytes.length,
            header: 'header', body: 'body', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER });
        expect(received).toEqual(bytes);
    });

    it('binds binary upload cancellation to its single captured Home request', async () => {
        const controller = new AbortController();
        const id = '00000000-0000-4000-8000-000000000001';
        const blobId = '00000000-0000-4000-8000-000000000002';
        let canceled = false;
        const request = async (path: string, init?: RequestInit) => {
            if (path === '/v1/artifacts/content/upload') {
                expect(init?.signal).toBe(controller.signal);
                canceled = true;
                controller.abort();
                controller.signal.throwIfAborted();
            }
            return Response.json({ error: 'unsupported' }, { status: 404 });
        };
        await expect(createArtifact({ token: 'token' }, { id, header: 'header', body: 'body',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, blob: { blobId, content: { t: 'plain', v: 'AA==' } } },
            { request, retry: 'none', signal: controller.signal })).rejects.toThrow();
        expect(canceled).toBe(true);
    });
});
