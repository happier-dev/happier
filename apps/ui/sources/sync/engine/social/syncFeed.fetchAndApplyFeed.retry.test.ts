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
import type { ServerFetch } from '@/sync/http/client';
import { FeedResponseSchema, type FeedItem } from '@/sync/domains/social/feedTypes';

function buildTokenWithSub(sub: string): string {
    const payload = encodeBase64(encodeUTF8(JSON.stringify({ sub })), 'base64');
    return `hdr.${payload}.sig`;
}

function buildFeedItems(count: number): FeedItem[] {
    return Array.from({ length: count }, (_, index) => {
        const counter = count - index;
        return {
            id: `feed-${counter}`,
            body: { kind: 'text', text: `Item ${counter}` },
            cursor: `0-${counter}`,
            counter,
            createdAt: counter,
            repeatKey: null,
        };
    });
}

function createFeedRequest(items: readonly FeedItem[]) {
    // HTTP boundary only. Mirrors app/feed/feedGet.ts: before => counter <,
    // after => counter >, descending order, and limit + 1 determines hasMore.
    // No shared server feed fixture exists; keep the API parser and sync owner real.
    return vi.fn<ServerFetch>(async (path) => {
        const { searchParams } = new URL(path, 'https://server.example.test');
        const before = searchParams.get('before');
        const after = searchParams.get('after');
        const limit = Number(searchParams.get('limit') ?? 100);
        const selected = items
            .filter(item => before !== null ? item.counter < Number(before.slice(2))
                : after !== null ? item.counter > Number(after.slice(2)) : true)
            .sort((left, right) => right.counter - left.counter)
            .slice(0, limit + 1);
        return Response.json(FeedResponseSchema.parse({
            items: selected.slice(0, limit),
            hasMore: selected.length > limit,
        }));
    });
}

describe('fetchAndApplyFeed pagination and retry semantics', () => {
    afterEach(() => {
        runtimeFetchSpy.mockReset();
        vi.resetModules();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it.each([0, 1, 101, 200])(
        'reads each initial feed page once and applies all %i items exactly once',
        async (count) => {
            const items = buildFeedItems(count);
            const request = createFeedRequest(items);
            const { fetchAndApplyFeed } = await import('./syncFeed');
            let applied: FeedItem[] = [];

            await fetchAndApplyFeed({
                credentials: { token: buildTokenWithSub('server-test'), secret: encodeBase64(new Uint8Array(32).fill(1), 'base64url') },
                getFeedItems: () => [],
                getFeedHead: () => null,
                assumeUsers: async () => {},
                getUsers: () => ({}),
                applyFeedItems: (next) => { applied = next; },
                request,
                log: { log: vi.fn() },
            });

            expect(applied).toEqual(items);
            expect(request).toHaveBeenCalledTimes(Math.max(1, Math.ceil(count / 100)));
        },
    );

    it.each([50, 150])('catches up %i newer items and stops at the known page', async (newCount) => {
        const items = buildFeedItems(101 + newCount);
        const existing = items.slice(newCount);
        const request = createFeedRequest(items);
        const { fetchAndApplyFeed } = await import('./syncFeed');
        let applied: FeedItem[] = [];

        await fetchAndApplyFeed({
            credentials: { token: buildTokenWithSub('server-test'), secret: encodeBase64(new Uint8Array(32).fill(1), 'base64url') },
            getFeedItems: () => existing,
            getFeedHead: () => existing[0].cursor,
            assumeUsers: async () => {},
            getUsers: () => ({}),
            applyFeedItems: (next) => { applied = next; },
            request,
            log: { log: vi.fn() },
        });

        expect(request.mock.calls[0]?.[0]).toBe('/v1/feed?limit=100&after=0-101');
        expect(applied.filter(item => item.counter > 101)).toEqual(items.slice(0, newCount));
        expect(new Set(applied.map(item => item.id)).size).toBe(applied.length);
        // A short head query settles immediately. A full page walks backwards once,
        // reaching known rows while the server still has older rows available.
        expect(request).toHaveBeenCalledTimes(newCount <= 100 ? 1 : 2);
        expect(applied).toEqual(items.slice(0, newCount <= 100 ? newCount : 200));
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
                    cursor: '0-1',
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
