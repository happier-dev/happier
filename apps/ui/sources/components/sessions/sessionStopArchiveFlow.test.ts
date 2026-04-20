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
        delete process.env.EXPO_PUBLIC_HAPPIER_SESSION_ARCHIVE_AFTER_STOP_RETRY_MS;
        delete process.env.EXPO_PUBLIC_HAPPIER_SESSION_ARCHIVE_AFTER_STOP_MAX_RETRIES;
    });

    it('stops without archiving when stop-only behavior is requested', async () => {
        const stopSpy = vi.fn(async () => ({ success: true }));
        const archiveSpy = vi.fn(async () => ({ success: true }));

        const { stopSessionAndMaybeArchive } = await import('./sessionStopArchiveFlow');

        await stopSessionAndMaybeArchive({
            sessionId: 'session_1',
            hideInactiveSessions: true,
            isPinned: false,
            archiveAfterStop: 'never',
            stopSession: stopSpy,
            archiveSession: archiveSpy,
            stopErrorMessage: 'stop failed',
            archiveErrorMessage: 'archive failed',
        });

        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(archiveSpy).not.toHaveBeenCalled();
        expect(applySessionListRenderablePatchesSpy).not.toHaveBeenCalled();
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
                archiveAfterStop: 'always',
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

    it('does not preserve visibility for stop-only sessions hidden by settings', async () => {
        const stopSpy = vi.fn(async () => ({ success: true }));
        const archiveSpy = vi.fn(async () => ({ success: true }));

        const { stopSessionAndMaybeArchive } = await import('./sessionStopArchiveFlow');

        await stopSessionAndMaybeArchive({
            sessionId: 'session_3',
            hideInactiveSessions: true,
            isPinned: false,
            archiveAfterStop: 'never',
            stopSession: stopSpy,
            archiveSession: archiveSpy,
            stopErrorMessage: 'stop failed',
            archiveErrorMessage: 'archive failed',
        });

        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(archiveSpy).not.toHaveBeenCalled();
        expect(applySessionListRenderablePatchesSpy).not.toHaveBeenCalled();
    });

    it('archives immediately after stopping when explicitly requested', async () => {
        const stopSpy = vi.fn(async () => ({ success: true }));
        const archiveSpy = vi.fn(async () => ({ success: true }));

        const { stopSessionAndMaybeArchive } = await import('./sessionStopArchiveFlow');

        await stopSessionAndMaybeArchive({
            sessionId: 'session_4',
            hideInactiveSessions: false,
            isPinned: false,
            archiveAfterStop: 'always',
            stopSession: stopSpy,
            archiveSession: archiveSpy,
            stopErrorMessage: 'stop failed',
            archiveErrorMessage: 'archive failed',
        });

        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(archiveSpy).toHaveBeenCalledTimes(1);
        expect(applySessionListRenderablePatchesSpy).toHaveBeenNthCalledWith(1, [
            {
                sessionId: 'session_4',
                patch: { keepVisibleWhenInactive: true },
            },
        ]);
        expect(applySessionListRenderablePatchesSpy).toHaveBeenNthCalledWith(2, [
            {
                sessionId: 'session_4',
                patch: { keepVisibleWhenInactive: false },
            },
        ]);
    });

    it('retries archive after stop when the first archive attempt still sees the session as active', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SESSION_ARCHIVE_AFTER_STOP_RETRY_MS = '0';
        process.env.EXPO_PUBLIC_HAPPIER_SESSION_ARCHIVE_AFTER_STOP_MAX_RETRIES = '2';

        const stopSpy = vi.fn(async () => ({ success: true }));
        const archiveSpy = vi.fn()
            .mockResolvedValueOnce({
                success: false,
                message: 'Cannot archive an active session',
                code: 'session_active' as const,
            })
            .mockResolvedValueOnce({ success: true });

        const { stopSessionAndMaybeArchive } = await import('./sessionStopArchiveFlow');

        await stopSessionAndMaybeArchive({
            sessionId: 'session_retry',
            hideInactiveSessions: false,
            isPinned: false,
            archiveAfterStop: 'always',
            stopSession: stopSpy,
            archiveSession: archiveSpy,
            stopErrorMessage: 'stop failed',
            archiveErrorMessage: 'archive failed',
        });

        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(archiveSpy).toHaveBeenCalledTimes(2);
        expect(applySessionListRenderablePatchesSpy).toHaveBeenNthCalledWith(1, [
            {
                sessionId: 'session_retry',
                patch: { keepVisibleWhenInactive: true },
            },
        ]);
        expect(applySessionListRenderablePatchesSpy).toHaveBeenNthCalledWith(2, [
            {
                sessionId: 'session_retry',
                patch: { keepVisibleWhenInactive: false },
            },
        ]);
    });

    it('clears the visibility override when archive fails after stopping', async () => {
        const stopSpy = vi.fn(async () => ({ success: true }));
        const archiveSpy = vi.fn(async () => ({ success: false, message: 'archive boom' }));

        const { stopSessionAndMaybeArchive } = await import('./sessionStopArchiveFlow');

        await expect(
            stopSessionAndMaybeArchive({
                sessionId: 'session_5',
                hideInactiveSessions: false,
                isPinned: false,
                archiveAfterStop: 'always',
                stopSession: stopSpy,
                archiveSession: archiveSpy,
                stopErrorMessage: 'stop failed',
                archiveErrorMessage: 'archive failed',
            }),
        ).rejects.toMatchObject({ message: 'archive boom' });

        expect(applySessionListRenderablePatchesSpy).toHaveBeenNthCalledWith(1, [
            {
                sessionId: 'session_5',
                patch: { keepVisibleWhenInactive: true },
            },
        ]);
        expect(applySessionListRenderablePatchesSpy).toHaveBeenNthCalledWith(2, [
            {
                sessionId: 'session_5',
                patch: { keepVisibleWhenInactive: false },
            },
        ]);
    });
});
