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

describe('fetchAndApplyFeed retry semantics', () => {
    afterEach(() => {
        runtimeFetchSpy.mockReset();
        vi.resetModules();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('throws and performs only a single HTTP attempt when retry mode is none', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);

        upsertAndActivateServer({ serverUrl: 'https://server.example.test', scope: 'tab' });
        runtimeFetchSpy.mockResolvedValue(new Response('nope', { status: 500 }));

        const { fetchAndApplyFeed } = await import('./syncFeed');

        const credentials: AuthCredentials = {
            token: buildTokenWithSub('server-test'),
            secret: encodeBase64(new Uint8Array(32).fill(1), 'base64url'),
        };

        const promise = fetchAndApplyFeed({
            credentials,
            getFeedItems: () => [],
            getFeedHead: () => null,
            assumeUsers: async () => {},
            getUsers: () => ({}),
            applyFeedItems: vi.fn(),
            log: { log: vi.fn() },
        });

        const assertion = expect(promise).rejects.toThrow();
        await vi.runAllTimersAsync();
        await assertion;

        expect(runtimeFetchSpy).toHaveBeenCalledTimes(1);
    });

    it('drops fetched feed items when the captured sync scope is stale before apply', async () => {
        upsertAndActivateServer({ serverUrl: 'https://server.example.test', scope: 'tab' });
        runtimeFetchSpy.mockImplementation(async () => new Response(JSON.stringify({
                items: [
                    {
                        id: 'feed-a',
                        body: { kind: 'text', text: 'hello' },
                        cursor: 'c_1',
                        createdAt: 1,
                        repeatKey: null,
                    },
                ],
                hasMore: false,
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

        const { fetchAndApplyFeed } = await import('./syncFeed');

        const credentials: AuthCredentials = {
            token: buildTokenWithSub('server-test'),
            secret: encodeBase64(new Uint8Array(32).fill(1), 'base64url'),
        };
        const applyFeedItems = vi.fn();

        await fetchAndApplyFeed({
            credentials,
            getFeedItems: () => [],
            getFeedHead: () => null,
            assumeUsers: async () => {},
            getUsers: () => ({}),
            applyFeedItems,
            shouldContinue: () => false,
            log: { log: vi.fn() },
        } as Parameters<typeof fetchAndApplyFeed>[0] & { shouldContinue: () => boolean });

        expect(applyFeedItems).not.toHaveBeenCalled();
    });
});
