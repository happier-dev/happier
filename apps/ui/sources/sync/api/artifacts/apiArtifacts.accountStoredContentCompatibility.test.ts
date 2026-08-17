import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getServerFeaturesSnapshot: vi.fn(),
    serverFetch: vi.fn(),
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: mocks.getServerFeaturesSnapshot,
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: mocks.serverFetch,
}));

import { deleteArtifact } from './apiArtifacts';

describe('deleteArtifact stored-content compatibility', () => {
    beforeEach(() => {
        mocks.getServerFeaturesSnapshot.mockReset();
        mocks.serverFetch.mockReset();
    });

    it('deletes by id without reading stored content or requiring current protocol support', async () => {
        mocks.serverFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
        mocks.getServerFeaturesSnapshot.mockResolvedValue({
            status: 'ready',
            features: {
                capabilities: {
                    encryption: {
                        storagePolicy: 'optional',
                    },
                },
            },
        });

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
            { includeAuth: false },
        );
        expect(mocks.getServerFeaturesSnapshot).not.toHaveBeenCalled();
    });

    it('preserves legacy E2EE Artifact deletion without requiring the marker capability', async () => {
        mocks.serverFetch
            .mockResolvedValueOnce(new Response(JSON.stringify({
                id: 'artifact-e2ee',
                header: 'encrypted-header',
                headerVersion: 1,
                body: 'encrypted-body',
                bodyVersion: 1,
                dataEncryptionKey: 'released-encrypted-data-key',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }))
            .mockResolvedValueOnce(new Response(null, { status: 204 }));

        await expect(deleteArtifact(
            { token: 'released-keyed-client', secret: 'real-e2ee-material' },
            'artifact-e2ee',
            { retry: 'none' },
        )).resolves.toBeUndefined();

        expect(mocks.getServerFeaturesSnapshot).not.toHaveBeenCalled();
        expect(
            mocks.serverFetch.mock.calls.filter(([, init]) =>
                (init as RequestInit | undefined)?.method === 'DELETE'),
        ).toHaveLength(1);
    });
});
