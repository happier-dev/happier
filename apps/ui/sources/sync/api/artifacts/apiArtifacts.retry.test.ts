import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeFetchSpy = vi.hoisted(() => vi.fn());

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchSpy(...args),
}));

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';

import { encodeBase64 } from '@/encryption/base64';
import { encodeUTF8 } from '@/encryption/text';

function buildTokenWithSub(sub: string): string {
    const payload = encodeBase64(encodeUTF8(JSON.stringify({ sub })), 'base64');
    return `hdr.${payload}.sig`;
}

describe('apiArtifacts retry modes', () => {
    afterEach(() => {
        runtimeFetchSpy.mockReset();
        vi.resetModules();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('does not retry when retry mode is none', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);

        await upsertAndActivateServer({ serverUrl: 'https://server.example.test', scope: 'tab' });
        runtimeFetchSpy.mockImplementation(async (url: unknown) => {
            const href = String(url ?? '');
            if (href.endsWith('/health')) return new Response('{}', { status: 200 });
            if (href.includes('/v1/auth/ping')) return new Response('{}', { status: 200 });
            if (href.includes('/v1/artifacts')) return new Response('nope', { status: 500 });
            throw new Error(`Unexpected runtimeFetch URL: ${href}`);
        });

        const { fetchArtifacts } = await import('./apiArtifacts');

        const credentials: AuthCredentials = {
            token: buildTokenWithSub('server-test'),
            secret: encodeBase64(new Uint8Array(32).fill(1), 'base64url'),
        };

        const promise = (
            fetchArtifacts as unknown as (credentials: AuthCredentials, opts?: { retry?: string }) => Promise<unknown>
        )(credentials, { retry: 'none' });

        const assertion = expect(promise).rejects.toThrow();
        await vi.runAllTimersAsync();
        await assertion;

        const artifactCalls = runtimeFetchSpy.mock.calls.filter(([callUrl]) => String(callUrl ?? '').includes('/v1/artifacts'));
        expect(artifactCalls).toHaveLength(1);
    });

    it('reads a complete revision inventory through the captured request and rejects an incomplete response', async () => {
        const { fetchArtifactRevisions } = await import('./apiArtifacts');
        const revision = { bodyVersion: 2, body: 'retained-body', createdAt: 100, sizeBytes: 42 };
        const request = vi.fn(async () => new Response(JSON.stringify({ revisions: [revision], retentionCount: 10 })));
        await expect(fetchArtifactRevisions({ token: 'captured-token' }, 'artifact-id', { request }))
            .resolves.toEqual({ revisions: [revision], retentionCount: 10 });
        request.mockResolvedValueOnce(new Response(JSON.stringify({ retentionCount: 10 })));
        await expect(fetchArtifactRevisions({ token: 'captured-token' }, 'artifact-id', { request })).rejects.toThrow();
    });

    it.each([401, 403])('marks denied detail reads (%s) as unavailable content while preserving the HTTP failure', async (status) => {
        const { fetchArtifact } = await import('./apiArtifacts');
        const request = vi.fn(async () => Response.json({ error: 'Access denied' }, { status }));
        await expect(fetchArtifact({ token: 'captured-token' }, 'document', { request, retry: 'none' }))
            .rejects.toMatchObject({ name: 'HappyError', status, canTryAgain: false, code: 'content_unavailable' });
    });

    it.each([
        { encryptionMode: 'plain', dataEncryptionKey: 'encrypted-envelope' },
        { encryptionMode: 'e2ee', dataEncryptionKey: 'plain' },
    ])('rejects owner Account-mode $encryptionMode content-marker disagreement before opening content', async ({ encryptionMode, dataEncryptionKey }) => {
        const { fetchArtifact } = await import('./apiArtifacts');
        const { ARTIFACT_PLAIN_DATA_KEY_MARKER } = await import('@happier-dev/protocol');
        const request = vi.fn(async () => Response.json({ id: 'document', ownerAccountId: 'owner', access: 'owner',
            encryptionMode, dataEncryptionKey: dataEncryptionKey === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : dataEncryptionKey,
            header: 'stored-header', headerVersion: 1, body: 'stored-body', bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }));
        await expect(fetchArtifact({ token: 'captured-token' }, 'document', { request, retry: 'none' }))
            .rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
    });
});
