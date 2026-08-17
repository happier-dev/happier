import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

const appStateEmitter = vi.hoisted(async () => {
    const { createReactNativeAppStateEmitter } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeAppStateEmitter('active');
});
const invalidateFromAutoRefresh = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { get OS() { return 'web'; } },
        AppState: (await appStateEmitter).appState,
    });
});

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => false,
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: { invalidateFromAutoRefresh },
}));

describe('useScmSessionAutoRefresh', () => {
    const globalWithDocument = globalThis as unknown as {
        document?: { visibilityState?: string };
    };
    const originalDocument = globalWithDocument.document;

    beforeEach(async () => {
        vi.useFakeTimers();
        (await appStateEmitter).emit('active');
        globalWithDocument.document = { visibilityState: 'visible' };
        invalidateFromAutoRefresh.mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
        globalWithDocument.document = originalDocument;
        standardCleanup();
    });

    it('refreshes on the configured cadence while the runtime is active', async () => {
        const { useScmSessionAutoRefresh } = await import('./useScmSessionAutoRefresh');

        await renderHook(() => useScmSessionAutoRefresh({ sessionId: 'session-1', intervalMs: 300_000 }));

        expect(invalidateFromAutoRefresh).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(300_000);
        expect(invalidateFromAutoRefresh).toHaveBeenCalledTimes(2);
    });

    it('does not make the machine run git while the app is backgrounded', async () => {
        const { useScmSessionAutoRefresh } = await import('./useScmSessionAutoRefresh');

        await renderHook(() => useScmSessionAutoRefresh({ sessionId: 'session-1', intervalMs: 300_000 }));
        invalidateFromAutoRefresh.mockClear();

        (await appStateEmitter).emit('background');
        await vi.advanceTimersByTimeAsync(300_000 * 3);

        expect(invalidateFromAutoRefresh).not.toHaveBeenCalled();
    });

    it('catches up once when the app returns to the foreground overdue', async () => {
        const { useScmSessionAutoRefresh } = await import('./useScmSessionAutoRefresh');

        await renderHook(() => useScmSessionAutoRefresh({ sessionId: 'session-1', intervalMs: 300_000 }));
        invalidateFromAutoRefresh.mockClear();

        (await appStateEmitter).emit('background');
        await vi.advanceTimersByTimeAsync(300_000 * 3);
        expect(invalidateFromAutoRefresh).not.toHaveBeenCalled();

        (await appStateEmitter).emit('active');

        expect(invalidateFromAutoRefresh).toHaveBeenCalledTimes(1);
        expect(invalidateFromAutoRefresh).toHaveBeenCalledWith('session-1');
    });
});
