import { beforeEach, describe, expect, it, vi } from 'vitest';

const waitForForkChildHydrationMock = vi.hoisted(() => vi.fn());
const patchSessionMetadataWithRetryMock = vi.hoisted(() => vi.fn());
const updateSessionDraftMock = vi.hoisted(() => vi.fn());

vi.mock('./waitForForkChildHydration', () => ({
    waitForForkChildHydration: (params: unknown) => waitForForkChildHydrationMock(params),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        patchSessionMetadataWithRetry: (...args: unknown[]) =>
            patchSessionMetadataWithRetryMock(...args),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({
            updateSessionDraft: (...args: unknown[]) => updateSessionDraftMock(...args),
        }),
    },
}));

describe('completeSessionForkNavigation', () => {
    beforeEach(() => {
        waitForForkChildHydrationMock.mockReset();
        patchSessionMetadataWithRetryMock.mockReset();
        updateSessionDraftMock.mockReset();
        waitForForkChildHydrationMock.mockResolvedValue(undefined);
        patchSessionMetadataWithRetryMock.mockResolvedValue(undefined);
    });

    it('preserves the restored draft and completes hydration, navigation, and metadata persistence in order', async () => {
        const events: string[] = [];
        updateSessionDraftMock.mockImplementation(() => {
            events.push('draft');
        });
        waitForForkChildHydrationMock.mockImplementation(async () => {
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

        expect(updateSessionDraftMock).toHaveBeenCalledWith('child', '  retry this  ');
        expect(waitForForkChildHydrationMock).toHaveBeenCalledWith({
            childSessionId: 'child',
            parentSessionId: 'parent',
            serverId: 'server-a',
        });
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
        expect(events).toEqual(['draft', 'hydrate', 'navigate', 'persist']);
    });

    it('does not navigate when required fork hydration fails', async () => {
        waitForForkChildHydrationMock.mockRejectedValueOnce(new Error('child unavailable'));
        const navigate = vi.fn();
        const { completeSessionForkNavigation } = await import('./completeSessionForkNavigation');

        await expect(completeSessionForkNavigation({
            childSessionId: 'child',
            parentSessionId: 'parent',
            serverId: 'server-a',
            navigate,
        })).rejects.toThrow('child unavailable');

        expect(navigate).not.toHaveBeenCalled();
        expect(patchSessionMetadataWithRetryMock).not.toHaveBeenCalled();
    });

    it('propagates required metadata persistence failure after navigation', async () => {
        patchSessionMetadataWithRetryMock.mockRejectedValueOnce(new Error('metadata write failed'));
        updateSessionDraftMock.mockImplementationOnce(() => {
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

        expect(waitForForkChildHydrationMock).toHaveBeenCalledTimes(1);
        expect(navigate).toHaveBeenCalledWith('child', { serverId: 'server-a' });
    });
});
