import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';

const applySessionListRenderablePatchesSpy = vi.fn();
const modalConfirmSpy = vi.fn(async () => true);

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({
            applySessionListRenderablePatches: applySessionListRenderablePatchesSpy,
        }),
    },
}));

vi.mock('@/modal', () => ({
    Modal: {
        confirm: modalConfirmSpy,
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('stopSessionAndMaybeArchive', () => {
    afterEach(() => {
        standardCleanup();
        applySessionListRenderablePatchesSpy.mockClear();
        modalConfirmSpy.mockClear();
    });

    it('keeps an inactive session visible until archive succeeds', async () => {
        const stopSpy = vi.fn(async () => ({ success: true }));
        const archiveSpy = vi.fn(async () => ({ success: true }));

        const { stopSessionAndMaybeArchive } = await import('./sessionStopArchiveFlow');

        await stopSessionAndMaybeArchive({
            sessionId: 'session_1',
            hideInactiveSessions: true,
            isPinned: false,
            stopSession: stopSpy,
            archiveSession: archiveSpy,
            stopErrorMessage: 'stop failed',
            archiveErrorMessage: 'archive failed',
        });

        expect(applySessionListRenderablePatchesSpy).toHaveBeenNthCalledWith(1, [
            {
                sessionId: 'session_1',
                patch: { keepVisibleWhenInactive: true },
            },
        ]);
        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(modalConfirmSpy).toHaveBeenCalledTimes(1);
        expect(archiveSpy).toHaveBeenCalledTimes(1);
        expect(applySessionListRenderablePatchesSpy).toHaveBeenNthCalledWith(2, [
            {
                sessionId: 'session_1',
                patch: { keepVisibleWhenInactive: false },
            },
        ]);
    });

    it('clears the visibility override when stopping fails', async () => {
        const stopSpy = vi.fn(async () => ({ success: false, message: 'boom' }));
        const archiveSpy = vi.fn(async () => ({ success: true }));

        const { stopSessionAndMaybeArchive } = await import('./sessionStopArchiveFlow');

        await expect(
            stopSessionAndMaybeArchive({
                sessionId: 'session_2',
                hideInactiveSessions: true,
                isPinned: false,
                stopSession: stopSpy,
                archiveSession: archiveSpy,
                stopErrorMessage: 'stop failed',
                archiveErrorMessage: 'archive failed',
            }),
        ).rejects.toMatchObject({ message: 'boom' });

        expect(applySessionListRenderablePatchesSpy).toHaveBeenNthCalledWith(1, [
            {
                sessionId: 'session_2',
                patch: { keepVisibleWhenInactive: true },
            },
        ]);
        expect(applySessionListRenderablePatchesSpy).toHaveBeenNthCalledWith(2, [
            {
                sessionId: 'session_2',
                patch: { keepVisibleWhenInactive: false },
            },
        ]);
        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(archiveSpy).not.toHaveBeenCalled();
    });
});
