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

describe('apiFriends retry modes', () => {
    afterEach(() => {
        runtimeFetchSpy.mockReset();
        vi.resetModules();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('does not retry getFriendsList when retry mode is none', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);

        upsertAndActivateServer({ serverUrl: 'https://server.example.test', scope: 'tab' });

        runtimeFetchSpy.mockImplementation(async (url: unknown) => {
            const href = String(url ?? '');
            if (href.includes('/v1/version')) return new Response('{}', { status: 200 });
            if (href.endsWith('/health')) return new Response('{}', { status: 200 });
            if (href.includes('/v1/auth/ping')) return new Response('{}', { status: 200 });
            if (href.includes('/v1/friends')) return new Response('nope', { status: 408 });
            throw new Error(`Unexpected runtimeFetch URL: ${href}`);
        });

        const { getFriendsList } = await import('./apiFriends');

        const credentials: AuthCredentials = {
            token: buildTokenWithSub('server-test'),
            secret: encodeBase64(new Uint8Array(32).fill(1), 'base64url'),
        };

        const promise = (
            getFriendsList as unknown as (credentials: AuthCredentials, opts?: { retry?: string }) => Promise<unknown>
        )(credentials, { retry: 'none' });

        const assertion = expect(promise).rejects.toThrow();
        await vi.runAllTimersAsync();
        await assertion;

        const friendCalls = runtimeFetchSpy.mock.calls.filter((call) => String(call[0]).includes('/v1/friends')).length;
        expect(friendCalls).toBe(1);
    });

    it('throws when getUserProfile receives an invalid server response (schema mismatch)', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);

        upsertAndActivateServer({ serverUrl: 'https://server.example.test', scope: 'tab' });

        runtimeFetchSpy.mockImplementation(async (url: unknown) => {
            const href = String(url ?? '');
            if (href.includes('/v1/version')) return new Response('{}', { status: 200 });
            if (href.endsWith('/health')) return new Response('{}', { status: 200 });
            if (href.includes('/v1/auth/ping')) return new Response('{}', { status: 200 });
            if (href.includes('/v1/user/user-1')) {
                return new Response(JSON.stringify({ nope: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            throw new Error(`Unexpected runtimeFetch URL: ${href}`);
        });

        const { getUserProfile } = await import('./apiFriends');

        const credentials: AuthCredentials = {
            token: buildTokenWithSub('server-test'),
            secret: encodeBase64(new Uint8Array(32).fill(1), 'base64url'),
        };

        const promise = getUserProfile(credentials, 'user-1', { retry: 'none' });
        const assertion = expect(promise).rejects.toThrow('Invalid user profile response');
        await vi.runAllTimersAsync();
        await assertion;
    });

    it('throws when getFriendsList receives an invalid server response (schema mismatch)', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);

        upsertAndActivateServer({ serverUrl: 'https://server.example.test', scope: 'tab' });

        runtimeFetchSpy.mockImplementation(async (url: unknown) => {
            const href = String(url ?? '');
            if (href.includes('/v1/version')) return new Response('{}', { status: 200 });
            if (href.endsWith('/health')) return new Response('{}', { status: 200 });
            if (href.includes('/v1/auth/ping')) return new Response('{}', { status: 200 });
            if (href.includes('/v1/friends')) {
                return new Response(JSON.stringify({ nope: true }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            throw new Error(`Unexpected runtimeFetch URL: ${href}`);
        });

        const { getFriendsList } = await import('./apiFriends');

        const credentials: AuthCredentials = {
            token: buildTokenWithSub('server-test'),
            secret: encodeBase64(new Uint8Array(32).fill(1), 'base64url'),
        };

        const promise = (
            getFriendsList as unknown as (credentials: AuthCredentials, opts?: { retry?: string }) => Promise<unknown>
        )(credentials, { retry: 'none' });

        const assertion = expect(promise).rejects.toThrow('Invalid friends list response');
        await vi.runAllTimersAsync();
        await assertion;
    });
});
