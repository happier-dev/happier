import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MutableRefObject } from 'react';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                Platform: {
                    OS: 'web',
                    select: (value: any) => value?.default ?? null,
                },
            }
    );
});

import { useInitialScrollRestore } from '@/components/workspaces/scm/review/useInitialScrollRestore';
import { renderHook } from '@/dev/testkit';

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) =>
        globalThis.setTimeout(() => callback(Date.now()), 0)));
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => globalThis.clearTimeout(handle));
});

type InitialScrollRestoreHarnessProps = Readonly<{
    initial: number | null;
    latestScrollTopRef: MutableRefObject<number>;
    applyInitialScrollTop: (top: number) => boolean;
    ready?: boolean;
}>;

async function renderInitialScrollRestoreHarness(props: InitialScrollRestoreHarnessProps) {
    return renderHook(({ initial, latestScrollTopRef, applyInitialScrollTop, ready }: InitialScrollRestoreHarnessProps) => {
        return useInitialScrollRestore({
            initialScrollTop: initial,
            latestScrollTopRef,
            applyInitialScrollTop,
            ready,
        });
    }, {
        initialProps: props,
        flushOptions: { cycles: 0 },
    });
}

async function advanceRestoreTimers(times = 1): Promise<void> {
    await act(async () => {
        for (let index = 0; index < times; index += 1) {
            await vi.advanceTimersToNextTimerAsync();
        }
    });
}

describe('useInitialScrollRestore', () => {
    it('does not introduce web restoration frames or offset writes on native', async () => {
        const { Platform } = await import('react-native');
        Object.assign(Platform, { OS: 'ios' });
        try {
            const apply = vi.fn(() => true);
            const hook = await renderInitialScrollRestoreHarness({
                initial: 300, latestScrollTopRef: { current: 300 }, applyInitialScrollTop: apply, ready: true,
            });
            act(() => { hook.getCurrent().requestRestore(); });
            expect(globalThis.requestAnimationFrame).not.toHaveBeenCalled();
            expect(apply).not.toHaveBeenCalled();
            await hook.unmount();
        } finally {
            Object.assign(Platform, { OS: 'web' });
        }
    });

    it('waits for recycler readiness without losing reader movement before layout completes', async () => {
        const scrollTopRef = { current: 300 };
        const apply = vi.fn(() => true);
        const hook = await renderInitialScrollRestoreHarness({ initial: 300, latestScrollTopRef: scrollTopRef,
            applyInitialScrollTop: apply, ready: false });
        await act(async () => { await vi.runOnlyPendingTimersAsync(); });
        expect(apply).not.toHaveBeenCalled();
        scrollTopRef.current = 250;
        await hook.rerender({ initial: 300, latestScrollTopRef: scrollTopRef, applyInitialScrollTop: apply, ready: true });
        await advanceRestoreTimers();
        expect(apply).not.toHaveBeenCalled();
    });
    it('restores a saved position already retained by the scroll tracker on remount', async () => {
        const scrollTopRef = { current: 300 };
        const apply = vi.fn(() => true);

        await renderInitialScrollRestoreHarness({
            initial: 300,
            latestScrollTopRef: scrollTopRef,
            applyInitialScrollTop: apply,
        });

        await advanceRestoreTimers();

        expect(apply.mock.calls).toEqual([[300]]);
    });

    it('restores on mount without jumping again when the persisted seed follows a reader scroll', async () => {
        const scrollTopRef = { current: 0 };
        const apply = vi.fn(() => true);

        const hook = await renderInitialScrollRestoreHarness({
            initial: 1200,
            latestScrollTopRef: scrollTopRef,
            applyInitialScrollTop: apply,
        });

        await advanceRestoreTimers();

        expect(apply).toHaveBeenCalledTimes(1);
        expect(apply).toHaveBeenCalledWith(1200);

        act(() => { scrollTopRef.current = 1800; });
        await hook.rerender({ initial: 1800, latestScrollTopRef: scrollTopRef, applyInitialScrollTop: apply });
        await act(async () => { await vi.runOnlyPendingTimersAsync(); });

        expect(scrollTopRef.current).toBe(1800);
        expect(apply.mock.calls).toEqual([[1200]]);
    });

    it('does not apply initial scroll if user scrolls before restore fires', async () => {
        const scrollTopRef = { current: 0 };
        const apply = vi.fn(() => true);

        await renderInitialScrollRestoreHarness({
            initial: 1200,
            latestScrollTopRef: scrollTopRef,
            applyInitialScrollTop: apply,
        });

        act(() => {
            scrollTopRef.current = 250;
        });

        await advanceRestoreTimers();

        expect(apply).toHaveBeenCalledTimes(0);
    });

    it('does not restore after the reader returns to the top before the scheduled restore', async () => {
        const scrollTopRef = { current: 300 };
        const apply = vi.fn(() => true);
        await renderInitialScrollRestoreHarness({
            initial: 300,
            latestScrollTopRef: scrollTopRef,
            applyInitialScrollTop: apply,
        });

        act(() => { scrollTopRef.current = 0; });
        await advanceRestoreTimers();

        expect(apply).not.toHaveBeenCalled();
    });

    it('waits for real readiness events beyond twelve failed layouts without autonomous retry frames', async () => {
        const scrollTopRef = { current: 0 };
        let viewportReady = false;
        const apply = vi.fn(() => viewportReady);

        const hook = await renderInitialScrollRestoreHarness({
            initial: 1200,
            latestScrollTopRef: scrollTopRef,
            applyInitialScrollTop: apply,
        });

        await advanceRestoreTimers();
        expect(apply).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);

        for (let index = 0; index < 20; index += 1) {
            act(() => {
                hook.getCurrent().requestRestore();
                hook.getCurrent().requestRestore();
            });
            await advanceRestoreTimers();
            expect(vi.getTimerCount()).toBe(0);
        }
        expect(apply).toHaveBeenCalledTimes(21);
        viewportReady = true;
        act(() => { hook.getCurrent().requestRestore(); });
        await advanceRestoreTimers();
        expect(apply).toHaveBeenCalledTimes(22);
        expect(apply).toHaveBeenLastCalledWith(1200);
        expect(globalThis.requestAnimationFrame).toHaveBeenCalledTimes(22);

        act(() => { hook.getCurrent().requestRestore(); });
        expect(vi.getTimerCount()).toBe(0);
        expect(globalThis.requestAnimationFrame).toHaveBeenCalledTimes(22);
    });

    it('cancels scheduled and future readiness attempts on explicit navigation', async () => {
        const apply = vi.fn(() => true);
        const hook = await renderInitialScrollRestoreHarness({
            initial: 300,
            latestScrollTopRef: { current: 300 },
            applyInitialScrollTop: apply,
            ready: false,
        });
        expect(vi.getTimerCount()).toBe(0);
        await hook.rerender({ initial: 300, latestScrollTopRef: { current: 300 }, applyInitialScrollTop: apply, ready: true });
        act(() => { hook.getCurrent().cancelRestore(); });
        expect(vi.getTimerCount()).toBe(0);
        act(() => { hook.getCurrent().requestRestore(); });
        expect(vi.getTimerCount()).toBe(0);
        expect(apply).not.toHaveBeenCalled();
    });

    it('cancels pending restore timers on unmount', async () => {
        const scrollTopRef = { current: 0 };
        const apply = vi.fn(() => false);
        const hook = await renderInitialScrollRestoreHarness({
            initial: 1200,
            latestScrollTopRef: scrollTopRef,
            applyInitialScrollTop: apply,
        });

        expect(vi.getTimerCount()).toBeGreaterThan(0);

        await hook.unmount();

        expect(vi.getTimerCount()).toBe(0);
    });

    it('cancels a timeout fallback with its matching timer boundary even when frame cancellation exists', async () => {
        vi.stubGlobal('requestAnimationFrame', undefined);
        const cancelFrame = vi.fn();
        vi.stubGlobal('cancelAnimationFrame', cancelFrame);
        const apply = vi.fn(() => true);
        const hook = await renderInitialScrollRestoreHarness({
            initial: 300, latestScrollTopRef: { current: 300 }, applyInitialScrollTop: apply,
        });
        expect(vi.getTimerCount()).toBe(1);
        act(() => { hook.getCurrent().cancelRestore(); });
        expect(vi.getTimerCount()).toBe(0);
        expect(cancelFrame).not.toHaveBeenCalled();
        expect(apply).not.toHaveBeenCalled();
    });
});
