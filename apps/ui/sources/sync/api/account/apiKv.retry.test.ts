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

describe('apiKv retry modes', () => {
    afterEach(() => {
        runtimeFetchSpy.mockReset();
        vi.resetModules();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('does not retry kvList when retry mode is none', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);

        upsertAndActivateServer({ serverUrl: 'https://server.example.test', scope: 'tab' });
        runtimeFetchSpy.mockImplementation(async (url: unknown) => {
            const href = String(url ?? '');
            if (href.includes('/v1/version')) return new Response('{}', { status: 200 });
            if (href.endsWith('/health')) return new Response('{}', { status: 200 });
            if (href.includes('/v1/auth/ping')) return new Response('{}', { status: 200 });
            if (href.includes('/v1/kv')) return new Response('nope', { status: 500 });
            throw new Error(`Unexpected runtimeFetch URL: ${href}`);
        });

        const { kvList } = await import('./apiKv');

        const credentials: AuthCredentials = {
            token: buildTokenWithSub('server-test'),
            secret: encodeBase64(new Uint8Array(32).fill(1), 'base64url'),
        };

        const promise = (kvList as unknown as (credentials: AuthCredentials, params: any) => Promise<unknown>)(
            credentials,
            { prefix: 'todo.', limit: 10, retry: 'none' },
        );

        const assertion = expect(promise).rejects.toThrow();
        await vi.runAllTimersAsync();
        await assertion;

        const listCalls = runtimeFetchSpy.mock.calls.filter(([callUrl]) => String(callUrl ?? '').includes('/v1/kv'));
        expect(listCalls).toHaveLength(1);
    });
});
