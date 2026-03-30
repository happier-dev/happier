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

import { useInitialScrollRestore } from '@/components/sessions/files/content/review/useInitialScrollRestore';
import { renderHook } from '@/dev/testkit';

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});

beforeEach(() => {
    vi.useFakeTimers();
});

type InitialScrollRestoreHarnessProps = Readonly<{
    initial: number | null;
    latestScrollTopRef: MutableRefObject<number>;
    applyInitialScrollTop: (top: number) => boolean;
}>;

async function renderInitialScrollRestoreHarness(props: InitialScrollRestoreHarnessProps) {
    return renderHook(({ initial, latestScrollTopRef, applyInitialScrollTop }: InitialScrollRestoreHarnessProps) => {
        useInitialScrollRestore({
            initialScrollTop: initial,
            latestScrollTopRef,
            applyInitialScrollTop,
            maxAttempts: 3,
        });
        return null;
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
    it('applies initial scroll when user has not scrolled', async () => {
        const scrollTopRef = { current: 0 };
        const apply = vi.fn(() => true);

        await renderInitialScrollRestoreHarness({
            initial: 1200,
            latestScrollTopRef: scrollTopRef,
            applyInitialScrollTop: apply,
        });

        await advanceRestoreTimers();

        expect(apply).toHaveBeenCalledTimes(1);
        expect(apply).toHaveBeenCalledWith(1200);
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

    it('retries until apply succeeds or attempts exhausted', async () => {
        const scrollTopRef = { current: 0 };
        const apply = vi.fn()
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(true);

        await renderInitialScrollRestoreHarness({
            initial: 1200,
            latestScrollTopRef: scrollTopRef,
            applyInitialScrollTop: apply,
        });

        await advanceRestoreTimers(3);

        expect(apply).toHaveBeenCalledTimes(3);
        expect(apply).toHaveBeenLastCalledWith(1200);
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
});
