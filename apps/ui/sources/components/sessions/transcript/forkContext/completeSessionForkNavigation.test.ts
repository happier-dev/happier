import { beforeEach, describe, expect, it, vi } from 'vitest';

const ensureSessionVisibleForMessageRouteMock = vi.hoisted(() => vi.fn());
const patchSessionMetadataWithRetryMock = vi.hoisted(() => vi.fn());
const updateSessionDraftMock = vi.hoisted(() => vi.fn());
const storageRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSessionVisibleForMessageRoute: (...args: unknown[]) =>
            ensureSessionVisibleForMessageRouteMock(...args),
        patchSessionMetadataWithRetry: (...args: unknown[]) => patchSessionMetadataWithRetryMock(...args),
    },
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    return {
        storage: {
            getState: () => storageRef.current.getState(),
        },
        createForkCompletionTestStore: (state: object) => createStorageStoreMock(state as never),
    };
});

describe('completeSessionForkNavigation', () => {
    beforeEach(async () => {
        ensureSessionVisibleForMessageRouteMock.mockReset();
        patchSessionMetadataWithRetryMock.mockReset();
        updateSessionDraftMock.mockReset();

        const storageModule = await import('@/sync/domains/state/storage');
        storageRef.current = (storageModule as any).createForkCompletionTestStore({
            sessions: {
                child: {
                    id: 'child',
                    metadata: {},
                },
            },
            updateSessionDraft: (...args: unknown[]) => updateSessionDraftMock(...args),
        });
    });

    it('hydrates fork metadata before navigation and preserves restored draft metadata', async () => {
        const events: string[] = [];
        ensureSessionVisibleForMessageRouteMock.mockImplementation(async (sessionId: string) => {
            events.push(`hydrate:${sessionId}`);
            storageRef.current.getState().sessions.child.metadata = {
                forkV1: { v: 1, parentSessionId: 'parent' },
            };
            return true;
        });
        patchSessionMetadataWithRetryMock.mockImplementation(async (sessionId: string) => {
            events.push(`patch:${sessionId}`);
        });
        updateSessionDraftMock.mockImplementation((sessionId: string) => {
            events.push(`draft:${sessionId}`);
        });
        const navigate = vi.fn(async (sessionId: string) => {
            events.push(`navigate:${sessionId}`);
        });

        const { completeSessionForkNavigation } = await import('./completeSessionForkNavigation');

        await completeSessionForkNavigation({
            childSessionId: 'child',
            parentSessionId: 'parent',
            serverId: 'server-b',
            navigate,
            restoredDraftText: 'retry this',
            sourceMessageId: 'm1',
            writeForkInitialPrompt: true,
        });

        expect(ensureSessionVisibleForMessageRouteMock).toHaveBeenCalledWith('child', { forceRefresh: true, serverId: 'server-b' });
        expect(updateSessionDraftMock).toHaveBeenCalledWith('child', 'retry this');
        expect(navigate).toHaveBeenCalledWith('child', { serverId: 'server-b' });
        expect(patchSessionMetadataWithRetryMock).toHaveBeenCalledWith('child', expect.any(Function), { serverId: 'server-b' });
        expect(events).toEqual(['draft:child', 'hydrate:child', 'navigate:child', 'patch:child']);
    });

    it('continues waiting when route hydration succeeds before fork metadata lands', async () => {
        ensureSessionVisibleForMessageRouteMock.mockResolvedValue(true);

        setTimeout(() => {
            storageRef.current.getState().sessions.child.metadata = {
                forkV1: { v: 1, parentSessionId: 'parent' },
            };
        }, 5);

        const { waitForForkChildHydration } = await import('./waitForForkChildHydration');

        await expect(waitForForkChildHydration({
            childSessionId: 'child',
            parentSessionId: 'parent',
            timeoutMs: 100,
            pollIntervalMs: 1,
        })).resolves.toBeUndefined();

        expect(ensureSessionVisibleForMessageRouteMock).toHaveBeenCalledWith('child', { forceRefresh: true });
    });

    // The child id comes back from a fork RPC; the only local proof that the row
    // now in the store is THIS fork's child is its own recorded parent. Without
    // that comparison a stale or unrelated fork child satisfies the wait, and the
    // navigation — and the restored draft written after it — land on the wrong
    // Session.
    it('refuses a hydrated child that names a different parent', async () => {
        ensureSessionVisibleForMessageRouteMock.mockImplementation(async () => {
            storageRef.current.getState().sessions.child.metadata = {
                forkV1: { v: 1, parentSessionId: 'someone-else' },
            };
            return true;
        });

        const { waitForForkChildHydration } = await import('./waitForForkChildHydration');

        await expect(waitForForkChildHydration({
            childSessionId: 'child',
            parentSessionId: 'parent',
            timeoutMs: 20,
            pollIntervalMs: 1,
        })).rejects.toThrow();
    });

    it('refuses a child whose fork metadata never hydrates', async () => {
        ensureSessionVisibleForMessageRouteMock.mockResolvedValue(true);

        const { waitForForkChildHydration } = await import('./waitForForkChildHydration');

        await expect(waitForForkChildHydration({
            childSessionId: 'child',
            parentSessionId: 'parent',
            timeoutMs: 20,
            pollIntervalMs: 1,
        })).rejects.toThrow();
    });

    it('does not navigate or write the restored prompt when hydration is refused', async () => {
        ensureSessionVisibleForMessageRouteMock.mockImplementation(async () => {
            storageRef.current.getState().sessions.child.metadata = {
                forkV1: { v: 1, parentSessionId: 'someone-else' },
            };
            return true;
        });
        const navigate = vi.fn();

        const { completeSessionForkNavigation } = await import('./completeSessionForkNavigation');

        await expect(completeSessionForkNavigation({
            childSessionId: 'child',
            parentSessionId: 'parent',
            navigate,
            restoredDraftText: 'retry this',
            sourceMessageId: 'm1',
            writeForkInitialPrompt: true,
        })).rejects.toThrow();

        expect(navigate).not.toHaveBeenCalled();
        expect(patchSessionMetadataWithRetryMock).not.toHaveBeenCalled();
    });
});
