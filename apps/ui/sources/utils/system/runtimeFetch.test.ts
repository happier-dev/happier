import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
});

describe('runtimeFetch', () => {
    it('defaults credentials to same-origin when omitted', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { runtimeFetch } = await import('./runtimeFetch');
        await runtimeFetch('https://api.example.test/v1/features');

        const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        expect(init?.credentials).toBe('same-origin');
    });

    it('preserves explicit credentials', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { runtimeFetch } = await import('./runtimeFetch');
        await runtimeFetch('https://api.example.test/v1/features', { credentials: 'omit' });

        const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        expect(init?.credentials).toBe('omit');
    });
});
