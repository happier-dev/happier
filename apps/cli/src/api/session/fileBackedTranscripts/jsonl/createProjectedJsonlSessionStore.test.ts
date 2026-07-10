import { beforeEach, describe, expect, it, vi } from 'vitest';

const followerStartSpy = vi.hoisted(() => vi.fn(async () => {}));
const followerStopSpy = vi.hoisted(() => vi.fn(async () => {}));
const followerConstructorSpy = vi.hoisted(() => vi.fn());

vi.mock('./createJsonlFollowController', () => ({
    createJsonlFollowController: (options: unknown) => {
        followerConstructorSpy(options);
        return {
            attach: async () => {
                await followerStartSpy();
            },
            detach: async () => {},
            drainNow: async () => {},
            dispose: async () => {
                await followerStopSpy();
            },
            getPolicy: () => ({}),
        };
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
                agentId: 'codex',
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

    it('retries follower startup after an initial cursor read fails', async () => {
        const resolveFile = vi.fn(async () => ({ filePath: '/tmp/session-2/projected.jsonl' }));
        const readAfter = vi
            .fn()
            .mockRejectedValueOnce(new Error('cursor read failed'))
            .mockResolvedValueOnce({
                items: [],
                nextCursor: 'cursor-2',
                truncated: false,
            });

        const { createProjectedJsonlSessionStore } = await import('./createProjectedJsonlSessionStore');
        const store = createProjectedJsonlSessionStore<string, null, undefined, { cursor: string; maxBytes: number; maxItems: number }, string | null>({
            key: {
                agentId: 'codex',
                source: { kind: 'codexHome', home: 'user' },
                remoteSessionId: 'session-2',
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

        await expect(store.setLifecycleState('hot_attached')).rejects.toThrow('cursor read failed');
        expect(followerStartSpy).not.toHaveBeenCalled();

        await store.setLifecycleState('hot_attached');

        expect(resolveFile).toHaveBeenCalledTimes(1);
        expect(readAfter).toHaveBeenCalledTimes(2);
        expect(followerStartSpy).toHaveBeenCalledTimes(1);

        await store.dispose();
    });
});
