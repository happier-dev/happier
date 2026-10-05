import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';

const mocks = vi.hoisted(() => ({
    serverFetch: vi.fn(),
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: mocks.serverFetch,
}));

import { createArtifact, updateArtifact, deleteArtifact, fetchArtifact, fetchArtifacts, fetchArtifactBlob } from './apiArtifacts';

const authority = { ownerAccountId: 'account-a', access: 'owner', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER };

describe('Artifact HTTP authority projection', () => {
    beforeEach(() => {
        mocks.serverFetch.mockReset();
    });

    it('refuses unsupported binary writes without falling back to older text-only endpoints', async () => {
        const attempted: string[] = [];
        mocks.serverFetch.mockImplementation(async (path: string) => {
            attempted.push(path);
            return path.endsWith('/content/binary') || path === '/v1/artifacts/content/upload'
                ? new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })
                : new Response(JSON.stringify({ id: 'artifact', ...authority, success: true }));
        });
        const blob = { blobId: '00000000-0000-4000-8000-000000000001', content: { t: 'plain' as const, v: 'AA==' } };
        await expect(createArtifact({ token: 't' }, { id: '00000000-0000-4000-8000-000000000002', header: 'header', body: 'body', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, blob },
            { retry: 'none' })).rejects.toMatchObject({ status: 404 });
        await expect(updateArtifact({ token: 't' }, 'artifact', { body: 'body', expectedBodyVersion: 1, blob: { blobId: blob.blobId } },
            { retry: 'none' })).rejects.toMatchObject({ status: 404 });
        await expect(updateArtifact({ token: 't' }, 'artifact', { body: 'text-body', expectedBodyVersion: 1, blob: null },
            { retry: 'none' })).rejects.toMatchObject({ status: 404 });
        expect(attempted).toEqual(['/v1/artifacts/content/upload', '/v1/artifacts/artifact/content/binary', '/v1/artifacts/artifact/content/binary']);
        await expect(createArtifact({ token: 't' }, { id: 'text', header: 'header', body: 'body', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER },
            { retry: 'none' })).resolves.toMatchObject({ id: 'artifact' });
        expect(attempted.at(-1)).toBe('/v1/artifacts');
    });

    it('opens only the requested explicit-mode private blob response and refuses substitutions', async () => {
        const blobId = '00000000-0000-4000-8000-000000000001';
        const content = { t: 'plain', v: 'AP+A' };
        mocks.serverFetch.mockResolvedValueOnce(new Response(JSON.stringify({ blobId, content }), { status: 200 }));
        await expect(fetchArtifactBlob({ token: 'token' }, 'private', blobId, 'plain')).resolves.toEqual({ blobId, content });
        for (const response of [
            { blobId, content: { t: 'encrypted', c: 'AP+A' } },
            { blobId: '00000000-0000-4000-8000-000000000002', content },
            { blobId, content: { t: 'plain', v: 'not base64' } },
        ]) {
            mocks.serverFetch.mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 200 }));
            await expect(fetchArtifactBlob({ token: 'token' }, 'private', blobId, 'plain')).rejects.toMatchObject({ code: expect.stringMatching(/^artifact_/) });
        }
    });

    it('selects only the captured owner for an Account migration, not received document grants', async () => {
        mocks.serverFetch.mockResolvedValueOnce(new Response(JSON.stringify([
            { id: 'owned', ...authority },
            { id: 'received', ...authority, ownerAccountId: 'account-b', access: 'admin' },
        ]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        const rows = await fetchArtifacts({ token: 'token' }, { retry: 'none', ownerAccountId: 'account-a' });
        expect(rows.map(row => row.id)).toEqual(['owned']);
    });

    it.each([{}, { ownerAccountId: 'account-a', access: 'owner' }, { ...authority, access: 'invalid' }])(
        'refuses incomplete or invalid current Artifact authority before returning read/list content', async (projection) => {
            const row = { id: 'private', header: 'private-header', ...projection };
            mocks.serverFetch.mockResolvedValueOnce(new Response(JSON.stringify(row), { status: 200 }));
            await expect(fetchArtifact({ token: 'token' }, 'private', { retry: 'none' }))
                .rejects.toMatchObject({ code: 'artifact_content_unavailable' });
            mocks.serverFetch.mockResolvedValueOnce(new Response(JSON.stringify([row]), { status: 200 }));
            await expect(fetchArtifacts({ token: 'token' }, { retry: 'none' }))
                .rejects.toMatchObject({ code: 'artifact_content_unavailable' });
        });

    it('deletes by id without reading stored content or requiring current protocol support', async () => {
        mocks.serverFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

        await expect(deleteArtifact(
            { token: 'token-only' },
            'artifact-plain',
            { retry: 'none' },
        )).resolves.toBeUndefined();

        expect(mocks.serverFetch).toHaveBeenCalledTimes(1);
        expect(mocks.serverFetch).toHaveBeenCalledWith(
            '/v1/artifacts/artifact-plain',
            expect.objectContaining({
                method: 'DELETE',
                headers: expect.objectContaining({
                    Authorization: 'Bearer token-only',
                }),
            }),
            expect.objectContaining({ includeAuth: false }),
        );
    });

});
