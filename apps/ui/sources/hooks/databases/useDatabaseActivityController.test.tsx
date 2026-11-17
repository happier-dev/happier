import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storage';
import { createDatabaseActivityController } from './activityController';
import { useDatabaseActivityController } from './useDatabaseActivityController';

const nativeState = vi.hoisted(async () => {
    const { createReactNativeAppStateEmitter } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeAppStateEmitter('active');
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ AppState: (await nativeState).appState });
});

describe('database Activity lifecycle consumer', () => {
    const initial = storage.getState();
    beforeEach(async () => {
        vi.useFakeTimers();
        (await nativeState).emit('active');
        storage.setState(initial, true);
    });
    afterEach(() => {
        standardCleanup();
        storage.setState(initial, true);
        vi.useRealTimers();
    });

    it('has no hidden, offline or closed reads and uses the Account cadence with manual recovery', async () => {
        // Resource read is the engine/network boundary; the real hook, settings, controller and scheduler run.
        const read = vi.fn(async () => ({ backends: 1 }));
        const controller = createDatabaseActivityController({ read });
        const hook = await renderHook((options: { presented: boolean; online: boolean }) =>
            useDatabaseActivityController(controller, options), { initialProps: { presented: false, online: true } });
        const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
        await advance(60_000);
        expect(read).not.toHaveBeenCalled();
        await hook.rerender({ presented: true, online: true });
        await advance(0);
        expect(read).toHaveBeenCalledTimes(1);
        await advance(60_000);
        expect(read).toHaveBeenCalledTimes(13);
        await hook.rerender({ presented: false, online: true });
        await advance(60_000);
        await hook.getCurrent().refresh();
        expect(read).toHaveBeenCalledTimes(13);
        expect(hook.getCurrent().value).toEqual({ backends: 1 });
        await hook.rerender({ presented: true, online: false });
        await advance(60_000);
        await hook.getCurrent().refresh();
        expect(read).toHaveBeenCalledTimes(13);
        await hook.rerender({ presented: true, online: true });
        await advance(0);
        expect(read).toHaveBeenCalledTimes(14);
        await act(async () => {
            const state = storage.getState();
            state.applySettings({ ...state.settings, databaseActivityAutoRefreshIntervalMs: 12000 }, state.settingsVersion + 1);
        });
        await advance(0);
        const changedIntervalStart = read.mock.calls.length;
        await advance(60_000);
        expect(read.mock.calls.length - changedIntervalStart).toBe(5);
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(read.mock.calls.length - changedIntervalStart).toBe(6);
        await act(async () => { (await nativeState).emit('background'); });
        const backgroundCount = read.mock.calls.length;
        await advance(60_000);
        await hook.getCurrent().refresh();
        expect(read).toHaveBeenCalledTimes(backgroundCount);
        await act(async () => { (await nativeState).emit('active'); });
        await advance(0);
        expect(read).toHaveBeenCalledTimes(backgroundCount + 1);
        await hook.unmount();
        const closedCount = read.mock.calls.length;
        await advance(60_000);
        expect(read).toHaveBeenCalledTimes(closedCount);
    });
});
