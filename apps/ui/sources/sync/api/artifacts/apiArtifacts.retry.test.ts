import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeFetchSpy = vi.hoisted(() => vi.fn());

vi.mock('@/utils/system/runtimeFetch', () => {
    // Named first so the getter's `this` is this object, not vi.mock's Partial<unknown> factory type.
    const mocked = {
        runtimeFetch: (...args: unknown[]) => runtimeFetchSpy(...args),
        get runtimeFetchManualResponse() { return this.runtimeFetch; },
    };
    return mocked;
});

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';

import { encodeBase64 } from '@/encryption/base64';
import { encodeUTF8 } from '@/encryption/text';
import { createDeferred } from '@/dev/testkit';
import type { ServerFetch } from '@/sync/http/client';

async function capturedArtifactRead(request: ServerFetch) {
    const { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } = await import('@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1');
    runtimeFetchSpy.mockImplementation(async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return Response.json({});
        if (url.pathname === '/v1/features') return Response.json({ features: {}, capabilities: { accountStoredContentCompatibility: {
            v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
        } } });
        return request(url.pathname + url.search, init);
    });
    const { createCapturedServerReadTransport } = await import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope');
    return createCapturedServerReadTransport({ serverId: 'artifact-retry-test',
        profile: { serverUrl: 'https://artifact-retry.test' }, credentials: { token: 'captured-token' } });
}

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

    it.each(['detail', 'inventory'] as const)('shares the existing automatic %s recovery cadence across borrowers', async (projection) => {
        vi.useFakeTimers();
        const { fetchArtifact, fetchArtifactListPage } = await import('./apiArtifacts');
        const { ARTIFACT_PLAIN_DATA_KEY_MARKER } = await import('@happier-dev/protocol/storage/artifactStoredContent');
        let attempts = 0;
        const request = async () => {
            attempts++;
            if (attempts === 1) return Response.json({ error: 'unavailable' }, { status: 503 });
            return Response.json(projection === 'inventory' ? [] : { id: 'document', ownerAccountId: 'owner', access: 'owner',
                encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, publicAudience: 'none' });
        };
        const readTransport = await capturedArtifactRead(request);
        const read = () => projection === 'detail'
            ? fetchArtifact({ token: 'captured-token' }, 'document', { readTransport })
            : fetchArtifactListPage({ token: 'captured-token' }, { readTransport });
        const pending = Promise.all([read(), read()]);
        await vi.runAllTimersAsync();
        expect(await pending).toHaveLength(2);
        expect(attempts).toBe(2);
    });

    it('shares pending opaque details without retaining them after settlement', async () => {
        const { fetchArtifact } = await import('./apiArtifacts');
        const { ARTIFACT_PLAIN_DATA_KEY_MARKER } = await import('@happier-dev/protocol/storage/artifactStoredContent');
        const release = createDeferred<void>();
        let attempts = 0;
        const request = async () => {
            attempts++;
            await release.promise;
            return Response.json({ id: 'document', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, publicAudience: 'none' });
        };
        const readTransport = await capturedArtifactRead(request);
        const first = fetchArtifact({ token: 'captured-token' }, 'document', { readTransport });
        const sibling = fetchArtifact({ token: 'captured-token' }, 'document', { readTransport });
        release.resolve();
        await expect(Promise.all([first, sibling])).resolves.toMatchObject([{ id: 'document' }, { id: 'document' }]);
        expect(attempts).toBe(1);
        await fetchArtifact({ token: 'captured-token' }, 'document', { readTransport });
        expect(attempts).toBe(2);
    });

    it('shares identical inventory pages and keeps opaque cursors distinct', async () => {
        const { fetchArtifactListPage } = await import('./apiArtifacts');
        const release = createDeferred<void>();
        const paths: string[] = [];
        const request = async (path: string) => {
            paths.push(path);
            await release.promise;
            return Response.json([]);
        };
        const readTransport = await capturedArtifactRead(request);
        const first = fetchArtifactListPage({ token: 'captured-token' }, { readTransport, cursor: 'first', limit: 100 });
        const sibling = fetchArtifactListPage({ token: 'captured-token' }, { readTransport, cursor: 'first', limit: 100 });
        const other = fetchArtifactListPage({ token: 'captured-token' }, { readTransport, cursor: 'other', limit: 100 });
        release.resolve();
        await Promise.all([first, sibling, other]);
        expect(paths.sort()).toEqual(['/v1/artifacts?limit=100&cursor=first', '/v1/artifacts?limit=100&cursor=other']);
    });

    it('issues no more HTTP after its final borrower leaves during automatic recovery', async () => {
        vi.useFakeTimers();
        const { fetchArtifact } = await import('./apiArtifacts');
        const failedAttempt = createDeferred<void>();
        let attempts = 0;
        const readTransport = await capturedArtifactRead(async () => {
            attempts++;
            failedAttempt.resolve();
            return Response.json({ error: 'unavailable' }, { status: 503 });
        });
        const controller = new AbortController();
        const pending = fetchArtifact({ token: 'captured-token' }, 'document', { readTransport, signal: controller.signal });
        const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await failedAttempt.promise;
        await vi.advanceTimersByTimeAsync(0);
        const timersBeforeCancel = vi.getTimerCount();
        controller.abort();
        await cancelled;
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(timersBeforeCancel - 1);
        await vi.runAllTimersAsync();
        expect(attempts).toBe(1);
    });

    it.each(['create', 'update'] as const)('cancels %s recovery without waiting for its retry delay', async operation => {
        vi.useFakeTimers();
        const { createArtifact, updateArtifact } = await import('./apiArtifacts');
        const failedAttempt = createDeferred<void>();
        let attempts = 0;
        const request: ServerFetch = async () => {
            attempts++;
            failedAttempt.resolve();
            return Response.json({ error: 'unavailable' }, { status: 503 });
        };
        const controller = new AbortController();
        const opts = { request, signal: controller.signal };
        const pending = operation === 'create'
            ? createArtifact({ token: 'captured-token' }, { id: 'document', header: 'header', body: 'body', dataEncryptionKey: 'key' }, opts)
            : updateArtifact({ token: 'captured-token' }, 'document', { header: 'header', expectedHeaderVersion: 1 }, opts);
        let settled = false;
        const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' }).then(() => { settled = true; });
        await failedAttempt.promise;
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(true);
        await cancelled;
        expect(attempts).toBe(1);
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
        const { ARTIFACT_PLAIN_DATA_KEY_MARKER} = await import('@happier-dev/protocol/storage/artifactStoredContent');
        const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
        const request = createServerFetchAtEndpoint({ endpointUrl: 'https://captured.example.test', credentials: { token: 'captured-token' } });
        runtimeFetchSpy.mockImplementation(async () => Response.json({ id: 'document', ownerAccountId: 'owner', access: 'owner',
            encryptionMode, dataEncryptionKey: dataEncryptionKey === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : dataEncryptionKey,
            header: 'stored-header', headerVersion: 1, body: 'stored-body', bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }));
        await expect(fetchArtifact({ token: 'captured-token' }, 'document', { request, retry: 'none' }))
            .rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
    });
});
