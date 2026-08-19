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

    it('keeps the reader in place when a deactivating surface reports a scroll to the top', async () => {
        const scrollToOffset = vi.fn();
        const hook = await renderHook(
            (props: { surfaceActive: boolean }) => useSessionListScrollRetention({
                retentionKey: 'persisted-deactivating',
                scrollToOffset,
                surfaceActive: props.surfaceActive,
            }),
            { initialProps: { surfaceActive: true } },
        );

        await act(async () => {
            hook.getCurrent().handleLayout(layoutEvent(416));
            hook.getCurrent().handleScroll(scrollEvent(280, 416));
        });

        // Opening a session deactivates this surface. MEASURED on device: the native stack then
        // delivers exactly one scroll event for the list it is putting away, carrying either a
        // parked offset (-9999055) or a plain 0 - with a valid contentSize and layoutMeasurement in
        // both cases. It is indistinguishable by value from a real scroll to the top, so only the
        // surface state can tell them apart. Treating it as real is what loses the reader's place.
        await hook.rerender({ surfaceActive: false });
        await act(async () => {
            hook.getCurrent().handleScroll(scrollEvent(0, 416));
        });

        await hook.rerender({ surfaceActive: true });

        expect(scrollToOffset).toHaveBeenCalledWith({ offset: 280, animated: false });
    });

    it('does not restore when the reader had genuinely scrolled to the top before leaving', async () => {
        const scrollToOffset = vi.fn();
        const hook = await renderHook(
            (props: { surfaceActive: boolean }) => useSessionListScrollRetention({
                retentionKey: 'persisted-deactivating-top',
                scrollToOffset,
                surfaceActive: props.surfaceActive,
            }),
            { initialProps: { surfaceActive: true } },
        );

        await act(async () => {
            hook.getCurrent().handleLayout(layoutEvent(416));
            hook.getCurrent().handleScroll(scrollEvent(280, 416));
            hook.getCurrent().handleScroll(scrollEvent(0, 416));
        });

        await hook.rerender({ surfaceActive: false });
        await hook.rerender({ surfaceActive: true });

        expect(scrollToOffset).not.toHaveBeenCalled();
    });





    it('never repositions the reader once they have started scrolling again', async () => {
        const scrollToOffset = vi.fn();
        const hook = await renderHook(
            (props: { surfaceActive: boolean }) => useSessionListScrollRetention({
                retentionKey: 'persisted-user-takes-over',
                scrollToOffset,
                surfaceActive: props.surfaceActive,
            }),
            { initialProps: { surfaceActive: true } },
        );

        await act(async () => {
            hook.getCurrent().handleLayout(layoutEvent(416));
            hook.getCurrent().handleScroll(scrollEvent(280, 416));
            hook.getCurrent().handleLayout(layoutEvent(0));
        });

        // Back on the list, and the reader immediately starts scrolling. Reported from the device:
        // a restore landing mid-gesture yanks them to the old position, which is worse than the
        // stale position it was trying to fix. A scroll on a live surface means the reader has taken
        // control, so any pending restore is void from that moment on.
        await act(async () => {
            hook.getCurrent().handleScroll(scrollEvent(40, 416));
            hook.getCurrent().handleLayout(layoutEvent(416));
        });

        expect(scrollToOffset).not.toHaveBeenCalled();
    });
});
