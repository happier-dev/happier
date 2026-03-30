import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeFetchSpy = vi.hoisted(() => vi.fn());

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchSpy(...args),
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { encodeBase64 } from '@/encryption/base64';
import { encodeUTF8 } from '@/encryption/text';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';

function buildTokenWithSub(sub: string): string {
    const payload = encodeBase64(encodeUTF8(JSON.stringify({ sub })), 'base64');
    return `hdr.${payload}.sig`;
}

describe('getFriendsList retry semantics', () => {
    afterEach(() => {
        runtimeFetchSpy.mockReset();
        vi.resetModules();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('performs only a single /v1/friends attempt when retry mode is none', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);

        upsertAndActivateServer({ serverUrl: 'https://server.example.test', scope: 'tab' });

        runtimeFetchSpy.mockImplementation(async (input: unknown) => {
            const url = String(input ?? '');
            if (url.endsWith('/v1/version') || url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (url.endsWith('/v1/friends')) {
                return new Response('nope', { status: 429 });
            }
            return new Response('nope', { status: 404 });
        });

        const { getFriendsList } = await import('./apiFriends');

        const credentials: AuthCredentials = {
            token: buildTokenWithSub('server-test'),
            secret: encodeBase64(new Uint8Array(32).fill(1), 'base64url'),
        };

        const promise = getFriendsList(credentials, { retry: 'none' });
        const assertion = expect(promise).rejects.toThrow();
        await vi.runAllTimersAsync();
        await assertion;

        const friendCalls = runtimeFetchSpy.mock.calls.filter((call) => String(call[0]).endsWith('/v1/friends')).length;
        expect(friendCalls).toBe(1);
    });
});
