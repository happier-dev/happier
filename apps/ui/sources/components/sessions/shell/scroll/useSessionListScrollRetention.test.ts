import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import {
    releaseSessionListScrollRetention,
    resetSessionListScrollRetentionForTests,
    useSessionListScrollRetention,
} from './useSessionListScrollRetention';

afterEach(() => resetSessionListScrollRetentionForTests());

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
    it('keeps subscribed scroll callbacks stable and reads the current surface activity', async () => {
        const scrollToOffset = vi.fn();
        const hook = await renderHook(
            (props: { surfaceActive: boolean }) => useSessionListScrollRetention({
                retentionKey: 'stable-surface-lifecycle',
                scrollToOffset,
                surfaceActive: props.surfaceActive,
            }),
            { initialProps: { surfaceActive: true } },
        );
        const handlers = hook.getCurrent();
        await act(async () => {
            handlers.handleLayout(layoutEvent(416));
            handlers.handleScroll(scrollEvent(280, 416));
        });
        await hook.rerender({ surfaceActive: false });
        expect(hook.getCurrent()).toBe(handlers);
        await act(async () => {
            // Native may already hold this callback when the surface deactivates.
            handlers.handleScroll(scrollEvent(0, 416));
            handlers.handleLayout(layoutEvent(0));
        });
        await hook.rerender({ surfaceActive: true });
        await act(async () => {
            handlers.handleLayout(layoutEvent(416));
        });
        expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 280, animated: false });
        await hook.unmount();
    });


    it('releases only the removed route retention entry', async () => {
        const firstScrollToOffset = vi.fn();
        const secondScrollToOffset = vi.fn();
        const first = await renderHook(() => useSessionListScrollRetention({
            retentionKey: 'route-a',
            scrollToOffset: firstScrollToOffset,
        }));
        const second = await renderHook(() => useSessionListScrollRetention({
            retentionKey: 'route-b',
            scrollToOffset: secondScrollToOffset,
        }));

        await act(async () => {
            first.getCurrent().handleLayout(layoutEvent(416));
            first.getCurrent().handleScroll(scrollEvent(140, 416));
            second.getCurrent().handleLayout(layoutEvent(416));
            second.getCurrent().handleScroll(scrollEvent(280, 416));
        });
        await first.unmount();
        await second.unmount();

        expect(releaseSessionListScrollRetention('route-a')).toBe(true);
        const removed = await renderHook(() => useSessionListScrollRetention({
            retentionKey: 'route-a',
            scrollToOffset: firstScrollToOffset,
        }));
        const retained = await renderHook(() => useSessionListScrollRetention({
            retentionKey: 'route-b',
            scrollToOffset: secondScrollToOffset,
        }));
        await act(async () => {
            removed.getCurrent().handleLayout(layoutEvent(416));
            retained.getCurrent().handleLayout(layoutEvent(416));
        });
        expect(firstScrollToOffset).not.toHaveBeenCalled();
        expect(secondScrollToOffset).toHaveBeenCalledWith({ offset: 280, animated: false });
        await removed.unmount();
        await retained.unmount();
    });
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

    it('keeps the first visible qualified session at its measured viewport offset across membership replacement', async () => {
        const scrollToOffset = vi.fn();
        const scrollToIndex = vi.fn();
        const measureNodeViewportOffset = vi.fn(async () => -12);
        const hook = await renderHook(
            (props: { nodeIds: readonly string[] }) => useSessionListScrollRetention({
                retentionKey: 'membership-survives',
                scrollToOffset,
                scrollToIndex,
                nodeIds: props.nodeIds,
                measureNodeViewportOffset,
            }),
            { initialProps: { nodeIds: ['header:today', 'session:home:s1', 'session:home:s2'] } },
        );

        await act(async () => {
            hook.getCurrent().handleViewableItemsChanged({
                viewableItems: [
                    { item: { id: 'header:today' }, index: 0, isViewable: true },
                    { item: { id: 'session:home:s1' }, index: 1, isViewable: true },
                    { item: { id: 'session:home:s2' }, index: 2, isViewable: true },
                ],
            });
        });

        await hook.rerender({ nodeIds: ['header:filtered', 'session:home:s2', 'session:home:s1'] });

        expect(scrollToIndex).toHaveBeenCalledWith({
            index: 2,
            animated: false,
            viewOffset: -12,
            viewPosition: 0,
        });
        expect(scrollToOffset).not.toHaveBeenCalled();
    });

    it('keeps the viewport still when a reorder leaves its visible anchor in place', async () => {
        const scrollToOffset = vi.fn();
        const scrollToIndex = vi.fn();
        const hook = await renderHook(
            (props: { nodeIds: readonly string[] }) => useSessionListScrollRetention({
                retentionKey: 'reorder-below-visible-anchor',
                scrollToOffset,
                scrollToIndex,
                nodeIds: props.nodeIds,
                measureNodeViewportOffset: async () => 26,
            }),
            { initialProps: { nodeIds: ['header:project', 'session:home:a', 'session:home:b', 'session:home:c'] } },
        );

        await act(async () => {
            hook.getCurrent().handleLayout(layoutEvent(416));
            hook.getCurrent().handleScroll(scrollEvent(0, 416));
            hook.getCurrent().handleViewableItemsChanged({
                viewableItems: [
                    { item: { id: 'session:home:a' }, index: 1, isViewable: true },
                    { item: { id: 'session:home:b' }, index: 2, isViewable: true },
                    { item: { id: 'session:home:c' }, index: 3, isViewable: true },
                ],
            });
        });

        await hook.rerender({ nodeIds: ['header:project', 'session:home:a', 'session:home:c', 'session:home:b'] });

        expect(scrollToIndex).not.toHaveBeenCalled();
        expect(scrollToOffset).not.toHaveBeenCalled();
        // A same-index anchor still needs restoration when the preceding content changes.
        await hook.rerender({ nodeIds: ['header:filtered', 'session:home:a', 'session:home:c', 'session:home:b'] });
        expect(scrollToIndex).toHaveBeenCalledWith({ index: 1, animated: false, viewOffset: 26, viewPosition: 0 });
        await hook.unmount();
    });

    it('returns to the list start when the visible qualified session does not survive replacement', async () => {
        const scrollToOffset = vi.fn();
        const hook = await renderHook(
            (props: { nodeIds: readonly string[] }) => useSessionListScrollRetention({
                retentionKey: 'membership-removed',
                scrollToOffset,
                scrollToIndex: vi.fn(),
                nodeIds: props.nodeIds,
                measureNodeViewportOffset: vi.fn(async () => 0),
            }),
            { initialProps: { nodeIds: ['session:home:s1', 'session:home:s2'] } },
        );

        await act(async () => {
            hook.getCurrent().handleViewableItemsChanged({
                viewableItems: [
                    { item: { id: 'session:home:s1' }, index: 0, isViewable: true },
                ],
            });
        });
        await hook.rerender({ nodeIds: ['session:home:s2'] });

        expect(scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false });
    });

    it('cancels a pending membership restore when the reader starts scrolling', async () => {
        let resolveMeasurement: ((value: number) => void) | undefined;
        const scrollToIndex = vi.fn();
        const hook = await renderHook(
            (props: { nodeIds: readonly string[] }) => useSessionListScrollRetention({
                retentionKey: 'membership-user-takes-over',
                scrollToOffset: vi.fn(),
                scrollToIndex,
                nodeIds: props.nodeIds,
                measureNodeViewportOffset: () => new Promise<number>((resolve) => {
                    resolveMeasurement = resolve;
                }),
            }),
            { initialProps: { nodeIds: ['session:home:s1', 'session:home:s2'] } },
        );

        await act(async () => {
            hook.getCurrent().handleViewableItemsChanged({
                viewableItems: [
                    { item: { id: 'session:home:s1' }, index: 0, isViewable: true },
                ],
            });
        });
        await hook.rerender({ nodeIds: ['session:home:s2', 'session:home:s1'] });
        await act(async () => {
            hook.getCurrent().handleScrollInteractionStart();
            resolveMeasurement?.(-8);
        });

        expect(scrollToIndex).not.toHaveBeenCalled();
    });

    it('does not restore an anchor captured for a previous retention context', async () => {
        let resolveMeasurement: ((value: number) => void) | undefined;
        const scrollToIndex = vi.fn();
        const hook = await renderHook(
            (props: { retentionKey: string; nodeIds: readonly string[] }) => useSessionListScrollRetention({
                retentionKey: props.retentionKey,
                scrollToOffset: vi.fn(),
                scrollToIndex,
                nodeIds: props.nodeIds,
                measureNodeViewportOffset: () => new Promise<number>((resolve) => {
                    resolveMeasurement = resolve;
                }),
            }),
            { initialProps: { retentionKey: 'context-a', nodeIds: ['session:home:s1', 'session:home:s2'] } },
        );

        await act(async () => {
            hook.getCurrent().handleViewableItemsChanged({
                viewableItems: [{ item: { id: 'session:home:s1' }, index: 0, isViewable: true }],
            });
        });
        await hook.rerender({
            retentionKey: 'context-a',
            nodeIds: ['session:home:s2', 'session:home:s1'],
        });
        await hook.rerender({
            retentionKey: 'context-b',
            nodeIds: ['session:home:s2', 'session:home:s1'],
        });
        await act(async () => {
            resolveMeasurement?.(-8);
        });

        expect(scrollToIndex).not.toHaveBeenCalled();
    });
});
