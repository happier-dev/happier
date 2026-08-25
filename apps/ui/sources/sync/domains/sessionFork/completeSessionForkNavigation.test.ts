import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireLocalSessionVisibleForRouteMock = vi.hoisted(() => vi.fn());
const patchSessionMetadataWithRetryMock = vi.hoisted(() => vi.fn());
const writeExistingSessionDraftMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/localSessionRouteReadiness', () => ({
    requireLocalSessionVisibleForRoute: (params: unknown) => requireLocalSessionVisibleForRouteMock(params),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        patchSessionMetadataWithRetry: (...args: unknown[]) =>
            patchSessionMetadataWithRetryMock(...args),
    },
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    getActiveServerAccountScope: () => ({ serverId: 'server-a', accountId: 'account-a' }),
}));

vi.mock('@/sync/ops/sessionDrafts/sessionDraftRepository', () => ({
    writeExistingSessionDraft: (input: unknown) => writeExistingSessionDraftMock(input),
}));

describe('completeSessionForkNavigation', () => {
    beforeEach(() => {
        requireLocalSessionVisibleForRouteMock.mockReset();
        patchSessionMetadataWithRetryMock.mockReset();
        writeExistingSessionDraftMock.mockReset();
        requireLocalSessionVisibleForRouteMock.mockResolvedValue(undefined);
        patchSessionMetadataWithRetryMock.mockResolvedValue(undefined);
    });

    it('proves the expected child before restoring its draft, navigating, and persisting prompt metadata', async () => {
        const events: string[] = [];
        writeExistingSessionDraftMock.mockImplementation(() => {
            events.push('draft');
        });
        requireLocalSessionVisibleForRouteMock.mockImplementation(async () => {
            events.push('hydrate');
        });
        const navigate = vi.fn(async () => {
            events.push('navigate');
        });
        let writtenMetadata: unknown = null;
        patchSessionMetadataWithRetryMock.mockImplementation(async (
            _sessionId: string,
            update: (metadata: object) => unknown,
        ) => {
            events.push('persist');
            writtenMetadata = update({});
        });
        const { completeSessionForkNavigation } = await import('./completeSessionForkNavigation');

        await completeSessionForkNavigation({
            childSessionId: 'child',
            parentSessionId: 'parent',
            serverId: 'server-a',
            navigate,
            restoredDraftText: '  retry this  ',
            sourceMessageId: 'm1',
            writeForkInitialPrompt: true,
        });

        expect(writeExistingSessionDraftMock).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'child',
            patch: { text: '  retry this  ' },
        }));
        expect(requireLocalSessionVisibleForRouteMock).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'child',
            serverId: 'server-a',
            isLocalSessionReady: expect.any(Function),
        }));
        expect(navigate).toHaveBeenCalledWith('child', { serverId: 'server-a' });
        expect(patchSessionMetadataWithRetryMock).toHaveBeenCalledWith(
            'child',
            expect.any(Function),
            { serverId: 'server-a' },
        );
        expect(writtenMetadata).toEqual(expect.objectContaining({
            forkInitialPromptV1: expect.objectContaining({
                text: '  retry this  ',
                sourceMessageId: 'm1',
            }),
        }));
        expect(events).toEqual(['hydrate', 'draft', 'navigate', 'persist']);
    });

    it('does not write a restored draft, navigate, or persist prompt metadata for a wrong child', async () => {
        requireLocalSessionVisibleForRouteMock.mockRejectedValueOnce(new Error('child unavailable'));
        const navigate = vi.fn();
        const { completeSessionForkNavigation } = await import('./completeSessionForkNavigation');

        await expect(completeSessionForkNavigation({
            childSessionId: 'child',
            parentSessionId: 'parent',
            serverId: 'server-a',
            navigate,
            restoredDraftText: 'retry this',
            writeForkInitialPrompt: true,
        })).rejects.toThrow('child unavailable');

        expect(writeExistingSessionDraftMock).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
        expect(patchSessionMetadataWithRetryMock).not.toHaveBeenCalled();
    });

    it('propagates required metadata persistence failure after navigation', async () => {
        patchSessionMetadataWithRetryMock.mockRejectedValueOnce(new Error('metadata write failed'));
        writeExistingSessionDraftMock.mockImplementationOnce(() => {
            throw new Error('local draft unavailable');
        });
        const navigate = vi.fn(async () => undefined);
        const { completeSessionForkNavigation } = await import('./completeSessionForkNavigation');

        await expect(completeSessionForkNavigation({
            childSessionId: 'child',
            parentSessionId: 'parent',
            serverId: 'server-a',
            navigate,
            restoredDraftText: 'retry this',
            writeForkInitialPrompt: true,
        })).rejects.toThrow('metadata write failed');

        expect(requireLocalSessionVisibleForRouteMock).toHaveBeenCalledTimes(1);
        expect(navigate).toHaveBeenCalledWith('child', { serverId: 'server-a' });
    });
});
