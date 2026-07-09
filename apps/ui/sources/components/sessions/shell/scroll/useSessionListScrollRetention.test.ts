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
});
