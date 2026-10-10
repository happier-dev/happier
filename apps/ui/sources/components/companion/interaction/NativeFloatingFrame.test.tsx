import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { TestGestureChain } from '@/dev/testkit/mocks/gestureHandler';

// Only the native measurement/animation boundary is replaced; frame, pan and portal stay real.
const measurements = vi.hoisted(() => ({ pageX: 40, pageY: 50, width: 200, height: 165 }));
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return { ...createReanimatedModuleMock(), measure: () => measurements };
});

import { FloatingFrame, type FrameRect } from '@happier-dev/plugin-ui/presentation';
import {
    createRetainedPresentationSlotsStore,
    RetainedPresentationSlotBinder,
    RetainedPresentationSlotsProvider,
} from '@/components/ui/presentation/retainedPresentationSlots';
import { NativeFloatingFrame } from './NativeFloatingFrame';

beforeEach(() => { measurements.pageX = 40; measurements.pageY = 50; });

describe('native FloatingFrame binding', () => {
    it('moves the retained picture on shared values and publishes only the obstacle-aware settle', async () => {
        const store = createRetainedPresentationSlotsStore();
        const onSettle = vi.fn();
        let mounts = 0;
        let renders = 0;
        function Picture() {
            React.useEffect(() => { mounts += 1; }, []);
            return <View testID="native-picture" />;
        }
        function Harness() {
            renders += 1;
            const [rect, setRect] = React.useState<FrameRect>({ x: 40, y: 50, width: 200, height: 165 });
            return <RetainedPresentationSlotsProvider store={store}>
                <FloatingFrame mode="floating" rect={rect} availableRect={{ x: 10, y: 20, width: 800, height: 600 }}
                    avoidRects={[{ x: 610, y: 455, width: 200, height: 165 }]}
                    aspectRatio={1.6} minWidth={180} moveInput="surface" nativeBinding={NativeFloatingFrame}
                    reducedMotion controls={<View />} accessibilityLabel="Viewer"
                    onModeChange={vi.fn()} onRectChange={(next, change) => { onSettle(next, change); setRect(next); }}>
                    <RetainedPresentationSlotBinder slotId="native-frame" enabled inputPassthrough
                        windowGeometry={{ x: rect.x, y: rect.y + 40, width: 200, height: 125 }}>
                        <Picture />
                    </RetainedPresentationSlotBinder>
                </FloatingFrame>
            </RetainedPresentationSlotsProvider>;
        }
        const screen = await renderScreen(<Harness />);
        const gesture = screen.findByType('GestureDetector').props.gesture as TestGestureChain;
        const motion = store.getPortalSnapshot()[0].nativeMotion!;
        const initialRenders = renders;
        await act(async () => {
            gesture.__handlers.onTouchesDown({ allTouches: [{ absoluteX: 140, absoluteY: 130 }] }, { fail: vi.fn() });
            gesture.__handlers.onBegin({ absoluteX: 140, absoluteY: 130 });
            gesture.__handlers.onUpdate({ translationX: 100, translationY: 80 });
        });
        expect([motion.x.value, motion.y.value]).toEqual([140, 130]);
        expect(store.getPortalSnapshot()[0].geometry).toMatchObject({ x: 40, y: 90 });
        expect(renders).toBe(initialRenders);
        expect(onSettle).not.toHaveBeenCalled();
        await act(async () => {
            gesture.__handlers.onEnd({ translationX: 610, translationY: 450, velocityX: 0, velocityY: 0 }, true);
            gesture.__handlers.onFinalize({}, true);
        });
        expect(onSettle).toHaveBeenCalledWith({ x: 610, y: 290, width: 200, height: 165 }, { kind: 'settle' });
        expect(store.getPortalSnapshot()[0].nativeMotion?.x).toBe(motion.x);
        expect(store.getPortalSnapshot()[0].geometry).toMatchObject({ x: 610, y: 330 });
        expect(mounts).toBe(1);
        await screen.unmount();
    });

    it('fails chrome admission before recognition and leaves control-mode input alone', async () => {
        const onRectChange = vi.fn();
        const renderFrame = (moveInput: 'surface' | 'chrome', footer = false) => <FloatingFrame
            mode="floating" rect={{ x: 40, y: 50, width: 200, height: footer ? 217 : 165 }}
            availableRect={{ x: 0, y: 0, width: 800, height: 600 }} aspectRatio={1.6}
            moveInput={moveInput} nativeBinding={NativeFloatingFrame} controls={<View />} footer={footer ? <View /> : undefined}
            accessibilityLabel="Viewer" onRectChange={onRectChange} onModeChange={vi.fn()}><View /></FloatingFrame>;
        const screen = await renderScreen(renderFrame('surface'));
        const gesture = screen.findByType('GestureDetector').props.gesture as TestGestureChain;
        const fail = vi.fn();
        await act(async () => {
            gesture.__handlers.onTouchesDown({ allTouches: [{ absoluteX: 100, absoluteY: 60 }] }, { fail });
        });
        expect(fail).toHaveBeenCalledOnce();
        await screen.update(renderFrame('surface', true));
        await act(async () => {
            const footerGesture = screen.findByType('GestureDetector').props.gesture as TestGestureChain;
            // The grip belongs to the body's bottom, not the frame's bottom below its footer.
            footerGesture.__handlers.onTouchesDown({ allTouches: [{ absoluteX: 50, absoluteY: 205 }] }, { fail });
        });
        expect(fail).toHaveBeenCalledTimes(2);
        await screen.update(renderFrame('chrome'));
        expect((screen.findByType('GestureDetector').props.gesture as TestGestureChain).__config.enabled).toBe(false);
        expect(onRectChange).not.toHaveBeenCalled();
        await screen.unmount();
    });
});
