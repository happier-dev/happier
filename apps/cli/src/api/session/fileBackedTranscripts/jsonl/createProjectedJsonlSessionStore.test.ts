import { beforeEach, describe, expect, it, vi } from 'vitest';

const followerStartSpy = vi.hoisted(() => vi.fn(async () => {}));
const followerStopSpy = vi.hoisted(() => vi.fn(async () => {}));
const followerConstructorSpy = vi.hoisted(() => vi.fn());

vi.mock('./followJsonlFile', () => ({
    JsonlFollower: class JsonlFollower {
        constructor(options: unknown) {
            followerConstructorSpy(options);
        }

        async start(): Promise<void> {
            await followerStartSpy();
        }

        async stop(): Promise<void> {
            await followerStopSpy();
        }
    },
}));

describe('createProjectedJsonlSessionStore', () => {
    beforeEach(() => {
        followerConstructorSpy.mockClear();
        followerStartSpy.mockClear();
        followerStopSpy.mockClear();
    });

    it('retries file resolution after an initial miss before starting the follower', async () => {
        const resolveFile = vi
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ filePath: '/tmp/session-1/projected.jsonl' });
        const readAfter = vi.fn(async () => ({
            items: [],
            nextCursor: 'cursor-1',
            truncated: false,
        }));

        const { createProjectedJsonlSessionStore } = await import('./createProjectedJsonlSessionStore');
        const store = createProjectedJsonlSessionStore<string, null, undefined, { cursor: string; maxBytes: number; maxItems: number }, string | null>({
            key: {
                providerId: 'codex',
                source: { kind: 'codexHome', home: 'user' },
                remoteSessionId: 'session-1',
            },
            operations: {
                resolveFile,
                pageOlder: vi.fn(async () => ({
                    items: [],
                    nextCursor: null,
                    hasMore: false,
                    tailCursor: null,
                    truncated: false,
                })),
                readAfter,
            },
        });

        await store.setLifecycleState('hot_attached');

        expect(resolveFile).toHaveBeenCalledTimes(1);
        expect(followerStartSpy).not.toHaveBeenCalled();

        const unsubscribe = store.subscribe(() => {});
        expect(resolveFile).toHaveBeenCalledTimes(2);
        await vi.waitFor(() => {
            expect(readAfter).toHaveBeenCalledTimes(1);
            expect(followerConstructorSpy).toHaveBeenCalledWith(expect.objectContaining({
                filePath: '/tmp/session-1/projected.jsonl',
                startAtEnd: false,
            }));
            expect(followerStartSpy).toHaveBeenCalledTimes(1);
        });

        unsubscribe();
        await store.dispose();
    });
});
