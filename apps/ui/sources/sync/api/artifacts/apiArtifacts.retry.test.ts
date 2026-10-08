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
    afterEach(async () => {
        const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await resetServerReachabilitySupervisors();
        const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
        await stopAllEndpointSupervisorsForTests();
        runtimeFetchSpy.mockReset();
        vi.resetModules();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('does not retry when retry mode is none', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);

        await upsertAndActivateServer({ serverUrl: 'https://server.example.test', scope: 'device' });
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
        const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
        const request = createServerFetchAtEndpoint({ endpointUrl: 'https://captured.example.test', credentials: { token: 'captured-token' } });
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ revisions: [revision], retentionCount: 10 })));
        await expect(fetchArtifactRevisions({ token: 'captured-token' }, 'artifact-id', { request }))
            .resolves.toEqual({ revisions: [revision], retentionCount: 10 });
        runtimeFetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ retentionCount: 10 })));
        await expect(fetchArtifactRevisions({ token: 'captured-token' }, 'artifact-id', { request })).rejects.toThrow();
    });

    it.each([
        { encryptionMode: 'plain', dataEncryptionKey: 'encrypted-envelope' },
        { encryptionMode: 'e2ee', dataEncryptionKey: 'plain' },
    ])('rejects owner Account-mode $encryptionMode content-marker disagreement before opening content', async ({ encryptionMode, dataEncryptionKey }) => {
        const { fetchArtifact } = await import('./apiArtifacts');
        const { ARTIFACT_PLAIN_DATA_KEY_MARKER } = await import('@happier-dev/protocol');
        const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
        const request = createServerFetchAtEndpoint({ endpointUrl: 'https://captured.example.test', credentials: { token: 'captured-token' } });
        runtimeFetchSpy.mockImplementation(async () => Response.json({ id: 'document', ownerAccountId: 'owner', access: 'owner',
            encryptionMode, dataEncryptionKey: dataEncryptionKey === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : dataEncryptionKey,
            header: 'stored-header', headerVersion: 1, body: 'stored-body', bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }));
        await expect(fetchArtifact({ token: 'captured-token' }, 'document', { request, retry: 'none' }))
            .rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
    });
});
