import { beforeEach, describe, expect, it, vi } from 'vitest';

const ensureSessionVisibleForMessageRouteMock = vi.hoisted(() => vi.fn());
const requireLocalSessionVisibleForRouteMock = vi.hoisted(() => vi.fn());
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

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession', () => ({
    requireLocalSessionVisibleForRoute: (params: unknown) => requireLocalSessionVisibleForRouteMock(params),
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
        requireLocalSessionVisibleForRouteMock.mockReset();
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
        requireLocalSessionVisibleForRouteMock.mockResolvedValue(undefined);
    });

    it('proves fork lineage before restoring its draft, navigating, and preserving prompt metadata', async () => {
        const events: string[] = [];
        requireLocalSessionVisibleForRouteMock.mockImplementation(async (params: any) => {
            events.push(`hydrate:${params.sessionId}`);
            storageRef.current.getState().sessions.child.metadata = {
                forkV1: { v: 1, parentSessionId: 'parent' },
            };
            expect(params.isLocalSessionReady(storageRef.current.getState().sessions.child)).toBe(true);
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

        expect(requireLocalSessionVisibleForRouteMock).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'child',
            serverId: 'server-b',
            isLocalSessionReady: expect.any(Function),
        }));
        expect(updateSessionDraftMock).toHaveBeenCalledWith('child', 'retry this');
        expect(navigate).toHaveBeenCalledWith('child', { serverId: 'server-b' });
        expect(patchSessionMetadataWithRetryMock).toHaveBeenCalledWith('child', expect.any(Function), { serverId: 'server-b' });
        expect(events).toEqual(['hydrate:child', 'draft:child', 'navigate:child', 'patch:child']);
    });

    it('does not write the restored draft, navigate, or persist prompt metadata for a wrong child', async () => {
        requireLocalSessionVisibleForRouteMock.mockImplementation(async (params: any) => {
            storageRef.current.getState().sessions.child.metadata = {
                forkV1: { v: 1, parentSessionId: 'someone-else' },
            };
            expect(params.isLocalSessionReady(storageRef.current.getState().sessions.child)).toBe(false);
            throw new Error('child unavailable');
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

        expect(updateSessionDraftMock).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
        expect(patchSessionMetadataWithRetryMock).not.toHaveBeenCalled();
    });
});
