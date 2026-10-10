import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(async () => {
    vi.resetModules();
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    await upsertAndActivateServer({ serverUrl: 'https://selected.example.test' });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

async function capturedRequest() {
    const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
    return createServerFetchAtEndpoint({ endpointUrl: 'https://captured.example.test', credentials: { token: 'captured' } });
}

describe('Account KV captured request', () => {
    it('passes the exact read-only list cursor to the captured Home', async () => {
        const fetchBoundary = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ items: [] }));
        vi.stubGlobal('fetch', fetchBoundary);
        const request = await capturedRequest();
        const { kvList } = await import('./apiKv');
        await kvList({ token: 'captured' }, { request, retry: 'none', prefix: 'workspace:', limit: 1000, afterKey: 'workspace:tabs:v1' });
        const url = new URL(String(fetchBoundary.mock.calls[0]![0]));
        expect(url.origin).toBe('https://captured.example.test');
        expect(url.searchParams.get('afterKey')).toBe('workspace:tabs:v1');
    });
    it('uses the captured Account request for reads and CAS conflicts', async () => {
        const fetchBoundary = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(new Response(JSON.stringify({ key: 'workspace:tabs:v1', value: 'record', version: 2 })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ success: false, errors: [{
                key: 'workspace:tabs:v1', error: 'version-mismatch', value: 'remote', version: 3,
            }] }), { status: 409 }));
        vi.stubGlobal('fetch', fetchBoundary);
        const request = await capturedRequest();
        const { kvGet, kvMutate } = await import('./apiKv');
        await expect(kvGet({ token: 'captured' }, 'workspace:tabs:v1', { request, retry: 'none' }))
            .resolves.toEqual({ key: 'workspace:tabs:v1', value: 'record', version: 2 });
        await expect(kvMutate({ token: 'captured' }, [{ key: 'workspace:tabs:v1', value: 'local', version: 2 }], { request, retry: 'none' }))
            .resolves.toMatchObject({ success: false, errors: [{ value: 'remote', version: 3 }] });
        expect(fetchBoundary.mock.calls.every(([input]) => new URL(String(input)).origin === 'https://captured.example.test')).toBe(true);
        expect(fetchBoundary).toHaveBeenCalledTimes(2);
        for (const [, init] of fetchBoundary.mock.calls) {
            expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer captured');
        }
    });
});
