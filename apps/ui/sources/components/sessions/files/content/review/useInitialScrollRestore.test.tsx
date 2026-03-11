import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    deferOnWeb: (action: () => void) => setTimeout(action, 0),
}));

import { useInitialScrollRestore } from '@/components/sessions/files/content/review/useInitialScrollRestore';

function Harness(props: Readonly<{
    initial: number | null;
    scrollTopRef: React.MutableRefObject<number>;
    apply: ReturnType<typeof vi.fn>;
}>) {
    useInitialScrollRestore({
        initialScrollTop: props.initial,
        latestScrollTopRef: props.scrollTopRef,
        applyInitialScrollTop: props.apply,
        maxAttempts: 3,
    });
    return null;
}

describe('useInitialScrollRestore', () => {
    it('applies initial scroll when user has not scrolled', () => {
        vi.useFakeTimers();
        const scrollTopRef = { current: 0 };
        const apply = vi.fn(() => true);

        act(() => {
            renderer.create(React.createElement(Harness, { initial: 1200, scrollTopRef, apply }));
        });

        act(() => {
            vi.runAllTimers();
        });

        expect(apply).toHaveBeenCalledTimes(1);
        expect(apply).toHaveBeenCalledWith(1200);

        vi.useRealTimers();
    });

    it('does not apply initial scroll if user scrolls before restore fires', () => {
        vi.useFakeTimers();
        const scrollTopRef = { current: 0 };
        const apply = vi.fn(() => true);

        act(() => {
            renderer.create(React.createElement(Harness, { initial: 1200, scrollTopRef, apply }));
        });

        act(() => {
            scrollTopRef.current = 250;
        });

        act(() => {
            vi.runAllTimers();
        });

        expect(apply).toHaveBeenCalledTimes(0);

        vi.useRealTimers();
    });

    it('retries until apply succeeds or attempts exhausted', () => {
        vi.useFakeTimers();
        const scrollTopRef = { current: 0 };
        const apply = vi.fn()
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(true);

        function RetryHarness() {
            useInitialScrollRestore({
                initialScrollTop: 1200,
                latestScrollTopRef: scrollTopRef,
                applyInitialScrollTop: apply,
                maxAttempts: 3,
            });
            return null;
        }

        act(() => {
            renderer.create(React.createElement(RetryHarness));
        });

        act(() => {
            vi.runAllTimers();
        });

        expect(apply).toHaveBeenCalledTimes(3);
        expect(apply).toHaveBeenLastCalledWith(1200);

        vi.useRealTimers();
    });
});
