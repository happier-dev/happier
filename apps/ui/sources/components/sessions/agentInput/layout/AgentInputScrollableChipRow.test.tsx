import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('AgentInputScrollableChipRow', () => {
    it('does not reapply the mounted web offset when fade state rerenders the row', async () => {
        vi.resetModules();
        vi.clearAllMocks();

        const scrollNode = {
            clientHeight: 32,
            clientWidth: 100,
            scrollHeight: 32,
            scrollLeft: 0,
            scrollTop: 0,
            scrollWidth: 300,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        };
        vi.doMock('react-native', async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            type TestScrollViewProps = { children?: React.ReactNode; [key: string]: unknown };
            const ScrollView = React.forwardRef<{ getScrollableNode: () => typeof scrollNode }, TestScrollViewProps>((props, ref) => {
                React.useImperativeHandle(ref, () => ({ getScrollableNode: () => scrollNode }), []);
                return React.createElement('ScrollView', props, props.children as React.ReactNode);
            });
            return createReactNativeWebMock({ ScrollView });
        });
        vi.doMock('@/components/ui/scroll/ScrollEdgeFades', () => ({
            ScrollEdgeFades: () => null,
        }));
        vi.doMock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({
            ScrollEdgeIndicators: () => null,
        }));

        let nextFrameId = 0;
        const frames = new Map<number, FrameRequestCallback>();
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            nextFrameId += 1;
            frames.set(nextFrameId, callback);
            return nextFrameId;
        });
        vi.stubGlobal('cancelAnimationFrame', (frameId: number) => {
            frames.delete(frameId);
        });

        const flushFrames = async () => {
            await act(async () => {
                while (frames.size > 0) {
                    const callbacks = [...frames.values()];
                    frames.clear();
                    for (const callback of callbacks) callback(0);
                }
            });
        };

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            const { AgentInputScrollableChipRow } = await import('./AgentInputScrollableChipRow');
            const scrollOffsetRef = { current: 0 };
            await act(async () => {
                tree = renderer.create(
                    <AgentInputScrollableChipRow
                        fadeColor="black"
                        indicatorColor="white"
                        scrollOffsetRef={scrollOffsetRef}
                    >
                        <React.Fragment />
                    </AgentInputScrollableChipRow>,
                );
            });
            await flushFrames();
            if (!tree) throw new Error('Expected the scroll row to render');

            const scrollView = tree.root.findByType('ScrollView' as never);
            await act(async () => {
                scrollView.props.onWheel({ nativeEvent: { deltaX: 0, deltaY: 40 } });
            });
            expect(scrollNode.scrollLeft).toBe(40);
            expect(scrollOffsetRef.current).toBe(40);

            await flushFrames();
            expect(scrollNode.scrollLeft).toBe(40);
            expect(scrollOffsetRef.current).toBe(40);
        } finally {
            if (tree) {
                act(() => tree?.unmount());
            }
            vi.unstubAllGlobals();
        }
    });
});
