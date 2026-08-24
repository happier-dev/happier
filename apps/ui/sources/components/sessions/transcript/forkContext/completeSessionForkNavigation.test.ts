import { beforeEach, describe, expect, it, vi } from 'vitest';

const ensureSessionVisibleForMessageRouteMock = vi.hoisted(() => vi.fn());
const requireLocalSessionVisibleForRouteMock = vi.hoisted(() => vi.fn());
const patchSessionMetadataWithRetryMock = vi.hoisted(() => vi.fn());
const writeExistingSessionDraftMock = vi.hoisted(() => vi.fn());
const flushSessionDraftMock = vi.hoisted(() => vi.fn(async () => ({ status: 'clean' as const })));
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

vi.mock('@/sync/ops/sessionDrafts/sessionDraftRepository', () => ({
    writeExistingSessionDraft: writeExistingSessionDraftMock,
    flushSessionDraft: flushSessionDraftMock,
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
        writeExistingSessionDraftMock.mockReset();
        flushSessionDraftMock.mockClear();

        const storageModule = await import('@/sync/domains/state/storage');
        storageRef.current = (storageModule as any).createForkCompletionTestStore({
            sessions: {
                child: {
                    id: 'child',
                    metadata: {},
                },
            },
            profileScope: { serverId: 'server-a', accountId: 'account-a' },
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
        writeExistingSessionDraftMock.mockImplementation(({ sessionId }: { sessionId: string }) => {
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
        expect(writeExistingSessionDraftMock).toHaveBeenCalledWith({
            scope: { serverId: 'server-b', accountId: 'account-a' },
            sessionId: 'child',
            patch: { text: 'retry this' },
            materializationIntent: 'seeded',
        });
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

        expect(writeExistingSessionDraftMock).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
        expect(patchSessionMetadataWithRetryMock).not.toHaveBeenCalled();
    });
});
