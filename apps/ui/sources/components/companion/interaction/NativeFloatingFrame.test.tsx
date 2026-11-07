import * as React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { TestGestureChain } from '@/dev/testkit/mocks/gestureHandler';

// Only the native measurement/animation boundary is replaced; frame, pan and portal stay real.
const measurements = vi.hoisted(() => ({ pageX: 40, pageY: 50, width: 200, height: 165 }));
const springTargets = vi.hoisted(() => [] as number[]);
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return { ...createReanimatedModuleMock(), withSpring: (target: number) => {
        springTargets.push(target);
        return target;
    }, measure: (ref: { current?: { testID?: string } }) =>
        ref.current?.testID === 'native-chrome-button'
            ? { pageX: 60, pageY: 50, width: 40, height: 32 } : measurements };
});

import { FloatingFrame, type FrameRect, type FloatingFrameMode } from '@happier-dev/plugin-ui/presentation';
import {
    createRetainedPresentationSlotsStore,
    RetainedPresentationFloatingLayerContext,
    RetainedPresentationSlotBinder,
    RetainedPresentationSlotsProvider,
    RetainedPresentationNativeMotionContext,
    useRetainedPresentationFloatingBody,
    type RetainedPresentationNativeMotion,
} from '@/components/ui/presentation/retainedPresentationSlots';
import { NativeFloatingFrame } from './NativeFloatingFrame';
import { CompanionNoDragRegion, CompanionNoDragRegionProvider } from './CompanionNoDragRegion';

beforeEach(() => { measurements.pageX = 40; measurements.pageY = 50; springTargets.length = 0; });

describe('native FloatingFrame binding', () => {
    it('settles a resize with the same movement spring, honoring reduced motion', async () => {
        const onRectChange = vi.fn();
        const frame = (reducedMotion: boolean) => <FloatingFrame
            mode="floating" rect={{ x: 100, y: 50, width: 200, height: 165 }}
            availableRect={{ x: 10, y: 20, width: 800, height: 600 }} aspectRatio={1.6}
            moveInput="chrome" nativeBinding={NativeFloatingFrame} controls={<View />} reducedMotion={reducedMotion}
            accessibilityLabel="Viewer" onRectChange={onRectChange} onModeChange={vi.fn()}><View /></FloatingFrame>;
        for (const reduced of [false, true]) {
            springTargets.length = 0;
            const screen = await renderScreen(frame(reduced));
            const gesture = screen.findAllByType('GestureDetector')[1].props.gesture as TestGestureChain;
            await act(async () => {
                gesture.__handlers.onBegin({ absoluteX: 110, absoluteY: 205 });
                gesture.__handlers.onUpdate({ translationX: -80, translationY: 0 });
                gesture.__handlers.onEnd({ translationX: -80, translationY: 0 }, true);
                gesture.__handlers.onFinalize({}, true);
            });
            expect(onRectChange).toHaveBeenLastCalledWith({ x: 20, y: 50, width: 280, height: 215 }, { kind: 'settle' });
            expect(springTargets).toEqual(reduced ? [] : [20, 50]);
            await screen.unmount();
        }
    });
    it('rejects a registered native chrome control before recognition while admitting its background', async () => {
        const screen = await renderScreen(<CompanionNoDragRegionProvider>
            <FloatingFrame mode="floating" rect={{ x: 40, y: 50, width: 200, height: 165 }}
                availableRect={{ x: 0, y: 0, width: 800, height: 600 }} aspectRatio={1.6}
                moveInput="chrome" nativeBinding={NativeFloatingFrame} accessibilityLabel="Viewer"
                controls={<CompanionNoDragRegion testID="native-chrome-button"><View /></CompanionNoDragRegion>}
                onRectChange={vi.fn()} onModeChange={vi.fn()}><View /></FloatingFrame>
        </CompanionNoDragRegionProvider>, {
            // OS view identities let Reanimated measure the actual registered control separately.
            createNodeMock: (element) => ({ testID: element.props.testID }),
        });
        await act(async () => {
            screen.findHostByTestId('native-chrome-button')!.props.onLayout({
                nativeEvent: { layout: { x: 20, y: 0, width: 40, height: 32 } },
            });
        });
        const gesture = screen.findAllByType('GestureDetector')[0].props.gesture as TestGestureChain;
        const controlFail = vi.fn();
        const backgroundFail = vi.fn();
        await act(async () => {
            gesture.__handlers.onTouchesDown({ allTouches: [{ absoluteX: 80, absoluteY: 60 }] }, { fail: controlFail });
            gesture.__handlers.onTouchesDown({ allTouches: [{ absoluteX: 150, absoluteY: 60 }] }, { fail: backgroundFail });
        });
        expect(controlFail).toHaveBeenCalledOnce();
        expect(backgroundFail).not.toHaveBeenCalled();
        await screen.unmount();
    });
    it('abandons an active resize on control takeover and restores the controlled size', async () => {
        const onRectChange = vi.fn();
        const motion: { current: RetainedPresentationNativeMotion | null } = { current: null };
        function Picture() {
            motion.current = React.useContext(RetainedPresentationNativeMotionContext);
            return <View />;
        }
        const frame = (moveInput: 'surface' | 'chrome') => <FloatingFrame
            mode="floating" rect={{ x: 40, y: 50, width: 200, height: 165 }}
            availableRect={{ x: 0, y: 0, width: 800, height: 600 }} aspectRatio={1.6}
            moveInput={moveInput} nativeBinding={NativeFloatingFrame} controls={<View />}
            accessibilityLabel="Viewer" onRectChange={onRectChange} onModeChange={vi.fn()}><Picture /></FloatingFrame>;
        const screen = await renderScreen(frame('surface'));
        const gesture = screen.findAllByType('GestureDetector')[1].props.gesture as TestGestureChain;
        await act(async () => {
            gesture.__handlers.onBegin({ absoluteX: 50, absoluteY: 205 });
            gesture.__handlers.onUpdate({ translationX: -30, translationY: 0 });
        });
        await screen.update(frame('chrome'));
        await act(async () => {
            gesture.__handlers.onEnd({ translationX: -30, translationY: 0 }, false);
            gesture.__handlers.onFinalize({}, false);
        });
        expect(onRectChange).not.toHaveBeenCalled();
        expect([motion.current!.width!.value, motion.current!.height!.value]).toEqual([200, 165]);
        await screen.unmount();
    });
    it('resizes a controlled retained body from its portal grip without remounting or publishing each frame', async () => {
        const store = createRetainedPresentationSlotsStore();
        const onRectChange = vi.fn();
        let mounts = 0;
        let renders = 0;
        function Picture() {
            React.useEffect(() => { mounts += 1; }, []);
            return <View testID="resize-picture" />;
        }
        function Harness() {
            renders += 1;
            const [rect, setRect] = React.useState<FrameRect>({ x: 40, y: 50, width: 200, height: 165 });
            return <RetainedPresentationSlotsProvider store={store}>
                <FloatingFrame mode="floating" rect={rect} availableRect={{ x: 0, y: 0, width: 800, height: 600 }}
                    aspectRatio={1.6} minWidth={180} moveInput="chrome" nativeBinding={NativeFloatingFrame}
                    reducedMotion controls={<View />} accessibilityLabel="Viewer" testID="resize-frame"
                    onModeChange={vi.fn()} onRectChange={(next, change) => { onRectChange(next, change); setRect(next); }}>
                    <RetainedPresentationSlotBinder slotId="resize-frame" enabled inputPassthrough={false}
                        windowGeometry={{ x: rect.x, y: rect.y + 40, width: rect.width, height: rect.height - 40 }}>
                        <Picture />
                    </RetainedPresentationSlotBinder>
                </FloatingFrame>
            </RetainedPresentationSlotsProvider>;
        }
        const screen = await renderScreen(<Harness />);
        const portal = screen.findByTestId('browser-presentation-portal-slot-resize-frame')!;
        const grip = portal.findByProps({ testID: 'resize-frame-grip' });
        expect(grip).toBeDefined();
        const gesture = portal.findByType('GestureDetector').props.gesture as TestGestureChain;
        const motion = store.getPortalSnapshot()[0].nativeMotion!;
        const initialRenders = renders;
        await act(async () => {
            gesture.__handlers.onTouchesDown({ allTouches: [{ absoluteX: 50, absoluteY: 205 }] }, { fail: vi.fn() });
            gesture.__handlers.onBegin({ absoluteX: 50, absoluteY: 205 });
            gesture.__handlers.onUpdate({ translationX: -30, translationY: 90 });
        });
        expect([motion.x.value, motion.width!.value]).toEqual([10, 230]);
        expect(motion.height!.value).toBe(183.75);
        expect(renders).toBe(initialRenders);
        expect(onRectChange).not.toHaveBeenCalled();
        await act(async () => {
            gesture.__handlers.onEnd({ translationX: -30, translationY: 90, velocityX: 900 }, true);
            gesture.__handlers.onFinalize({}, true);
        });
        expect(onRectChange).toHaveBeenLastCalledWith({ x: 10, y: 50, width: 230, height: 183.75 }, { kind: 'settle' });
        const nextGesture = screen.findByTestId('browser-presentation-portal-slot-resize-frame')!
            .findByType('GestureDetector').props.gesture as TestGestureChain;
        await act(async () => {
            nextGesture.__handlers.onBegin({ absoluteX: 20, absoluteY: 215 });
            nextGesture.__handlers.onUpdate({ translationX: 200, translationY: 0 });
            nextGesture.__handlers.onFinalize({ velocityX: -900 }, false);
        });
        expect(onRectChange).toHaveBeenLastCalledWith({ x: 60, y: 50, width: 180, height: 152.5 }, { kind: 'settle' });
        expect(mounts).toBe(1);
        await screen.unmount();
    });
    it('moves the retained picture on shared values and publishes only the clamped settle', async () => {
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
        const gesture = screen.findAllByType('GestureDetector')[0].props.gesture as TestGestureChain;
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
        expect(onSettle).toHaveBeenCalledWith({ x: 610, y: 455, width: 200, height: 165 }, { kind: 'settle' });
        expect(store.getPortalSnapshot()[0].nativeMotion?.x).toBe(motion.x);
        expect(store.getPortalSnapshot()[0].geometry).toMatchObject({ x: 610, y: 495 });
        expect(mounts).toBe(1);
        await screen.unmount();
    });

    it('moves a body bound in its own tree from a frame drawn in the root floating layer (plan 63 A1, native)', async () => {
        const store = createRetainedPresentationSlotsStore();
        const onSettle = vi.fn();
        let mounts = 0;
        let renders = 0;
        const SessionContext = React.createContext<string | null>(null);
        let pictureSession: string | null = null;
        function Picture(props: Readonly<{ session: string | null }>) {
            pictureSession = props.session;
            React.useEffect(() => { mounts += 1; }, []);
            return <View testID="layer-picture" />;
        }
        // The body's owner still reads its Session's providers: it was never moved out of that tree.
        function Source(props: Readonly<{ rect: FrameRect }>) {
            const session = React.useContext(SessionContext);
            const picture = React.useMemo(() => <Picture session={session} />, [session]);
            return <RetainedPresentationSlotBinder slotId="viewer" enabled inputPassthrough
                windowGeometry={{ x: props.rect.x, y: props.rect.y + 40, width: 200, height: 125 }}>
                {picture}
            </RetainedPresentationSlotBinder>;
        }
        function Session() {
            renders += 1;
            const layer = React.useContext(RetainedPresentationFloatingLayerContext);
            const floating = useRetainedPresentationFloatingBody();
            const [rect, setRect] = React.useState<FrameRect>({ x: 40, y: 50, width: 200, height: 165 });
            const frame = floating.frame(<FloatingFrame mode="floating" rect={rect}
                availableRect={{ x: 16, y: 16, width: 1408, height: 868 }} aspectRatio={1.6} minWidth={180}
                moveInput="surface" nativeBinding={NativeFloatingFrame} reducedMotion controls={<View />}
                accessibilityLabel="Viewer" onModeChange={vi.fn()}
                onRectChange={(next, change) => { onSettle(next, change); setRect(next); }}><View /></FloatingFrame>);
            return <>
                {layer ? layer.present(frame) : null}
                {floating.body(<Source rect={rect} />)}
            </>;
        }
        const screen = await renderScreen(<RetainedPresentationSlotsProvider store={store}>
            <SessionContext.Provider value="session-a"><Session /></SessionContext.Provider>
        </RetainedPresentationSlotsProvider>, {
            // The root layer and the portal stand over the whole 1440 x 900 window.
            createNodeMock: (element) => ({
                testID: element.props.testID,
                measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 1440, 900),
            }),
        });
        const layer = () => screen.findHostByTestId('retained-presentation-floating-layer')!;
        await act(async () => { layer().props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 1440, height: 900 } } }); });
        // The frame is drawn in the root layer; the body binds above it and reads its own Session.
        expect(layer().findAllByType(FloatingFrame)).toHaveLength(1);
        expect(pictureSession).toBe('session-a');
        const slot = screen.findByTestId('browser-presentation-portal-slot-viewer')!;
        const zIndex = (node: { props: { style?: unknown } }) => Number(StyleSheet.flatten(node.props.style as StyleProp<ViewStyle>)?.zIndex ?? 0);
        expect(zIndex(slot)).toBeGreaterThan(zIndex(layer()));
        const motion = store.getPortalSnapshot()[0].nativeMotion!;
        expect(motion).toBeTruthy();
        const gesture = layer().findAllByType('GestureDetector')[0].props.gesture as TestGestureChain;
        const initialRenders = renders;
        await act(async () => {
            gesture.__handlers.onTouchesDown({ allTouches: [{ absoluteX: 140, absoluteY: 130 }] }, { fail: vi.fn() });
            gesture.__handlers.onBegin({ absoluteX: 140, absoluteY: 130 });
            gesture.__handlers.onUpdate({ translationX: 900, translationY: 80 });
        });
        // The body follows the frame on the same shared values, past where a Session column would end.
        expect([motion.x.value, motion.y.value]).toEqual([940, 130]);
        expect(renders).toBe(initialRenders);
        await act(async () => {
            gesture.__handlers.onEnd({ translationX: 900, translationY: 80, velocityX: 0, velocityY: 0 }, true);
            gesture.__handlers.onFinalize({}, true);
        });
        expect(onSettle).toHaveBeenLastCalledWith({ x: 940, y: 130, width: 200, height: 165 }, { kind: 'settle' });
        expect(store.getPortalSnapshot()[0].geometry).toMatchObject({ x: 940, y: 170 });
        expect(mounts).toBe(1);
        await screen.unmount();
    });

    it('admits chrome in control mode while leaving remote body input alone', async () => {
        const onRectChange = vi.fn();
        const renderFrame = (moveInput: 'surface' | 'chrome', footer = false, mode: FloatingFrameMode = 'floating') => <FloatingFrame
            mode={mode} rect={{ x: 40, y: 50, width: 200, height: footer ? 217 : 165 }}
            availableRect={{ x: 0, y: 0, width: 800, height: 600 }} aspectRatio={1.6}
            moveInput={moveInput} nativeBinding={NativeFloatingFrame} controls={<View />} footer={footer ? <View /> : undefined}
            accessibilityLabel="Viewer" onRectChange={onRectChange} onModeChange={vi.fn()}><View /></FloatingFrame>;
        const screen = await renderScreen(renderFrame('surface'));
        const gesture = screen.findAllByType('GestureDetector')[0].props.gesture as TestGestureChain;
        const fail = vi.fn();
        await act(async () => {
            gesture.__handlers.onTouchesDown({ allTouches: [{ absoluteX: 100, absoluteY: 60 }] }, { fail });
        });
        expect(fail).not.toHaveBeenCalled();
        await screen.update(renderFrame('surface', true));
        await act(async () => {
            const footerGesture = screen.findAllByType('GestureDetector')[0].props.gesture as TestGestureChain;
            // The grip belongs to the body's bottom, not the frame's bottom below its footer.
            footerGesture.__handlers.onTouchesDown({ allTouches: [{ absoluteX: 50, absoluteY: 205 }] }, { fail });
        });
        expect(fail).toHaveBeenCalledOnce(); // Grip belongs to the separate resize binding.
        await screen.update(renderFrame('chrome'));
        const controlPan = screen.findAllByType('GestureDetector')[0].props.gesture as TestGestureChain;
        expect(controlPan.__config.enabled).toBe(true);
        await act(async () => {
            controlPan.__handlers.onTouchesDown({ allTouches: [{ absoluteX: 100, absoluteY: 130 }] }, { fail });
        });
        expect(fail).toHaveBeenCalledTimes(2);
        expect(onRectChange).not.toHaveBeenCalled();
        await act(async () => {
            controlPan.__handlers.onBegin({ absoluteX: 100, absoluteY: 60 });
            controlPan.__handlers.onUpdate({ translationX: 100, translationY: 80 });
            controlPan.__handlers.onEnd({ translationX: 100, translationY: 80 }, true);
            controlPan.__handlers.onFinalize({}, true);
        });
        // Plan 63 A1: a release rests where the person put it; nothing snaps it to a corner.
        expect(onRectChange).toHaveBeenLastCalledWith({ x: 140, y: 130, width: 200, height: 165 }, { kind: 'settle' });
        for (const mode of ['expanded', 'docked'] as const) {
            await screen.update(renderFrame('chrome', false, mode));
            expect((screen.findAllByType('GestureDetector')[0].props.gesture as TestGestureChain).__config.enabled).toBe(false);
        }
        await screen.unmount();
    });
});
