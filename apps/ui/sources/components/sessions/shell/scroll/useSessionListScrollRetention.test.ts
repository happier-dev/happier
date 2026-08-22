import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { useSessionListScrollRetention } from './useSessionListScrollRetention';

function layoutEvent(height: number) {
    return {
        nativeEvent: {
            layout: {
                height,
            },
        },
    };
}

function scrollEvent(offsetY: number, viewportHeight: number, contentHeight = 1200) {
    return {
        nativeEvent: {
            contentOffset: { y: offsetY },
            contentSize: { height: contentHeight },
            layoutMeasurement: { height: viewportHeight },
        },
    };
}

describe('useSessionListScrollRetention', () => {
    it('restores the last visible scroll offset when a zero-height retained list becomes visible again', async () => {
        const scrollToOffset = vi.fn();
        const hook = await renderHook(() => useSessionListScrollRetention({
            retentionKey: 'persisted',
            scrollToOffset,
        }));

        await act(async () => {
            hook.getCurrent().handleLayout(layoutEvent(416));
            hook.getCurrent().handleScroll(scrollEvent(280, 416));
            hook.getCurrent().handleLayout(layoutEvent(0));
            hook.getCurrent().handleScroll(scrollEvent(0, 0));
            hook.getCurrent().handleLayout(layoutEvent(416));
        });

        expect(scrollToOffset).toHaveBeenCalledWith({ offset: 280, animated: false });
    });

    it('does not restore after the user intentionally scrolls to the top while visible', async () => {
        const scrollToOffset = vi.fn();
        const hook = await renderHook(() => useSessionListScrollRetention({
            retentionKey: 'persisted-top',
            scrollToOffset,
        }));

        await act(async () => {
            hook.getCurrent().handleLayout(layoutEvent(416));
            hook.getCurrent().handleScroll(scrollEvent(280, 416));
            hook.getCurrent().handleScroll(scrollEvent(0, 416));
            hook.getCurrent().handleLayout(layoutEvent(0));
            hook.getCurrent().handleLayout(layoutEvent(416));
        });

        expect(scrollToOffset).not.toHaveBeenCalled();
    });

    it('restores the last visible scroll offset after route-level unmount and remount', async () => {
        const initialScrollToOffset = vi.fn();
        const initialHook = await renderHook(() => useSessionListScrollRetention({
            retentionKey: 'persisted-route-roundtrip',
            scrollToOffset: initialScrollToOffset,
        }));

        await act(async () => {
            initialHook.getCurrent().handleLayout(layoutEvent(416));
            initialHook.getCurrent().handleScroll(scrollEvent(280, 416));
        });

        await initialHook.unmount();

        const remountScrollToOffset = vi.fn();
        const remountedHook = await renderHook(() => useSessionListScrollRetention({
            retentionKey: 'persisted-route-roundtrip',
            scrollToOffset: remountScrollToOffset,
        }));

        await act(async () => {
            remountedHook.getCurrent().handleLayout(layoutEvent(416));
        });

        expect(remountScrollToOffset).toHaveBeenCalledWith({ offset: 280, animated: false });
    });

    it('ignores native refresh bounce offsets instead of clearing the retained scroll position', async () => {
        const scrollToOffset = vi.fn();
        const hook = await renderHook(() => useSessionListScrollRetention({
            retentionKey: 'persisted-refresh-bounce',
            scrollToOffset,
        }));

        await act(async () => {
            hook.getCurrent().handleLayout(layoutEvent(416));
            hook.getCurrent().handleScroll(scrollEvent(280, 416));
            hook.getCurrent().handleScroll(scrollEvent(-1_998_407, 416));
            hook.getCurrent().handleLayout(layoutEvent(0));
            hook.getCurrent().handleLayout(layoutEvent(416));
        });

        expect(scrollToOffset).toHaveBeenCalledWith({ offset: 280, animated: false });
    });

    it('ignores out-of-range native scroll offsets instead of poisoning the retained scroll position', async () => {
        const scrollToOffset = vi.fn();
        const hook = await renderHook(() => useSessionListScrollRetention({
            retentionKey: 'persisted-out-of-range',
            scrollToOffset,
        }));

        await act(async () => {
            hook.getCurrent().handleLayout(layoutEvent(416));
            hook.getCurrent().handleScroll(scrollEvent(280, 416, 1200));
            hook.getCurrent().handleScroll(scrollEvent(1_999_543, 416, 1200));
            hook.getCurrent().handleLayout(layoutEvent(0));
            hook.getCurrent().handleLayout(layoutEvent(416));
        });

        expect(scrollToOffset).toHaveBeenCalledWith({ offset: 280, animated: false });
    });

    it('does not record scroll from an inactive surface as the reader position', async () => {
        const scrollToOffset = vi.fn();
        const hook = await renderHook(
            (props: { surfaceActive: boolean }) => useSessionListScrollRetention({
                retentionKey: 'persisted-inactive-scroll',
                scrollToOffset,
                surfaceActive: props.surfaceActive,
            }),
            { initialProps: { surfaceActive: true } },
        );

        await act(async () => {
            hook.getCurrent().handleLayout(layoutEvent(416));
            hook.getCurrent().handleScroll(scrollEvent(280, 416));
        });

        // MEASURED in remote-dev: deactivating the screen moves the native scroll view and reports it
        // as an ordinary scroll (`y: 0`, or a parked `-9999055`). Recording it would replace the
        // reader's place with the platform's, so the surface state is what rejects it.
        await hook.rerender({ surfaceActive: false });
        await act(async () => {
            hook.getCurrent().handleScroll(scrollEvent(0, 416));
        });

        await hook.rerender({ surfaceActive: true });
        await act(async () => {
            hook.getCurrent().handleLayout(layoutEvent(0));
            hook.getCurrent().handleLayout(layoutEvent(416));
        });

        expect(scrollToOffset).toHaveBeenCalledWith({ offset: 280, animated: false });
    });

    it('never repositions the reader once they have started scrolling again', async () => {
        const scrollToOffset = vi.fn();
        const hook = await renderHook(() => useSessionListScrollRetention({
            retentionKey: 'persisted-user-takes-over',
            scrollToOffset,
        }));

        await act(async () => {
            hook.getCurrent().handleLayout(layoutEvent(416));
            hook.getCurrent().handleScroll(scrollEvent(280, 416));
            hook.getCurrent().handleLayout(layoutEvent(0));
        });

        // Reported in remote-dev: a restore landing mid-gesture yanks the reader back to the old
        // position, which is worse than the stale position it was trying to fix. A scroll on a live
        // surface means the reader has taken control.
        await act(async () => {
            hook.getCurrent().handleScroll(scrollEvent(40, 416));
            hook.getCurrent().handleLayout(layoutEvent(416));
        });

        expect(scrollToOffset).not.toHaveBeenCalled();
    });
});
