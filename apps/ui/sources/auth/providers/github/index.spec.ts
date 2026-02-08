import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/tokenStorage';

vi.mock('@/sync/serverConfig', () => ({
    getServerUrl: () => 'https://server.test',
}));

vi.mock('@/utils/time', () => ({
    backoff: async <T>(fn: () => Promise<T>) => await fn(),
}));

import { githubAuthProvider } from './index';

type MockFetchResponse = {
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
};

function jsonResponse(params: { ok: boolean; status: number; body: unknown }): MockFetchResponse {
    return {
        ok: params.ok,
        status: params.status,
        json: async () => params.body,
    };
}

const credentials: AuthCredentials = { token: 'token', secret: 'secret' };

function stubFetch(body: unknown) {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => {
        return jsonResponse({ ok: true, status: 200, body }) as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('githubAuthProvider', () => {
    it('exposes expected static provider metadata', () => {
        expect(githubAuthProvider.id).toBe('github');
        expect(githubAuthProvider.displayName).toBe('GitHub');
        expect(githubAuthProvider.badgeIconName).toBe('logo-github');
        expect(githubAuthProvider.supportsProfileBadge).toBe(true);
        expect(githubAuthProvider.connectButtonColor).toBe('#24292e');
    });

    it.each([
        { label: 'string payload', body: { success: 'yes' } },
        { label: 'numeric payload', body: { success: 1 } },
        { label: 'missing success field', body: {} },
    ])('finalizeConnect throws when response success is not true ($label)', async ({ body }) => {
        stubFetch(body);

        await expect(
            githubAuthProvider.finalizeConnect(credentials, { pending: 'pending-1', username: 'octocat' }),
        ).rejects.toThrow('Failed to finalize GitHub connection');
    });

    it('finalizeConnect resolves when response success is true', async () => {
        stubFetch({ success: true });

        await expect(
            githubAuthProvider.finalizeConnect(credentials, { pending: 'pending-1', username: 'octocat' }),
        ).resolves.toBeUndefined();
    });

    it.each([
        { label: 'string payload', body: { success: 'yes' } },
        { label: 'numeric payload', body: { success: 1 } },
        { label: 'missing success field', body: {} },
    ])('disconnect throws when response success is not true ($label)', async ({ body }) => {
        stubFetch(body);

        await expect(githubAuthProvider.disconnect(credentials)).rejects.toThrow(
            'Failed to disconnect GitHub account',
        );
    });

    it('disconnect resolves when response success is true', async () => {
        stubFetch({ success: true });

        await expect(githubAuthProvider.disconnect(credentials)).resolves.toBeUndefined();
    });
});
