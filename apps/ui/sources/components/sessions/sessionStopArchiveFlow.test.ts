import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import { createPartialStorageModuleMock } from '@/dev/testkit/mocks/storage';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';

const applySessionListRenderablePatchesSpy = vi.fn();
const modalConfirmSpy = vi.fn(async () => true);

vi.mock('@/sync/domains/state/storage', async (importOriginal) =>
    createPartialStorageModuleMock(importOriginal, {
        storage: {
            getState: () => ({
                applySessionListRenderablePatches: applySessionListRenderablePatchesSpy,
            }),
        },
    }),
);

vi.mock('@/modal', () => createModalModuleMock({
    spies: {
        confirm: modalConfirmSpy,
    },
}).module);

vi.mock('@/text', () => createTextModuleMock({
    translate: (key: string) => key,
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

    it('clears the visibility override when the user chooses to keep the session', async () => {
        modalConfirmSpy.mockResolvedValueOnce(false);

        const stopSpy = vi.fn(async () => ({ success: true }));
        const archiveSpy = vi.fn(async () => ({ success: true }));

        const { stopSessionAndMaybeArchive } = await import('./sessionStopArchiveFlow');

        await stopSessionAndMaybeArchive({
            sessionId: 'session_3',
            hideInactiveSessions: true,
            isPinned: false,
            stopSession: stopSpy,
            archiveSession: archiveSpy,
            stopErrorMessage: 'stop failed',
            archiveErrorMessage: 'archive failed',
        });

        expect(applySessionListRenderablePatchesSpy).toHaveBeenNthCalledWith(1, [
            {
                sessionId: 'session_3',
                patch: { keepVisibleWhenInactive: true },
            },
        ]);
        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(modalConfirmSpy).toHaveBeenCalledTimes(1);
        expect(archiveSpy).not.toHaveBeenCalled();
        expect(applySessionListRenderablePatchesSpy).toHaveBeenNthCalledWith(2, [
            {
                sessionId: 'session_3',
                patch: { keepVisibleWhenInactive: false },
            },
        ]);
    });
});
