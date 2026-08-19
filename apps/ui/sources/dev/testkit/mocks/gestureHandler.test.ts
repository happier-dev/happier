import { describe, expect, it, vi } from 'vitest';

import * as gestureHandlerStub from '@/dev/reactNativeGestureHandlerStub';

import { createGestureHandlerMock, findGestureByKind, type TestGestureChain } from './gestureHandler';

describe('createGestureHandlerMock', () => {
    it('records composed gesture handlers for test drivers', () => {
        const module = createGestureHandlerMock();

        const pan = module.Gesture.Pan()
            .minDistance(4)
            .activateAfterLongPress(350)
            .cancelsTouchesInView(false)
            .onStart(vi.fn())
            .onUpdate(vi.fn())
            .onEnd(vi.fn());
        const longPress = module.Gesture.LongPress()
            .minDuration(350)
            .maxDistance(44)
            .shouldCancelWhenOutside(false)
            .onStart(vi.fn());
        const composed = module.Gesture.Simultaneous(longPress, pan);

        expect(composed.__kind).toBe('simultaneous');
        expect(composed.__gestures).toEqual([longPress, pan]);
        expect(findGestureByKind(composed, 'pan')).toBe(pan);
        expect(findGestureByKind(composed, 'longPress')).toBe(longPress);
        expect(pan.__config).toMatchObject({
            minDistance: 4,
            activateAfterLongPress: 350,
            cancelsTouchesInView: false,
        });
        expect(Object.keys(pan.__handlers)).toEqual(['onStart', 'onUpdate', 'onEnd']);
    });

    it('records the directional pan chain used by lateral swipe navigation', () => {
        const module = createGestureHandlerMock();
        const onEnd = vi.fn();

        const pan = module.Gesture.Pan()
            .enabled(true)
            .activeOffsetX([-12, 12])
            .failOffsetY([-8, 8])
            .hitSlop({ left: -24, right: -32 })
            .cancelsTouchesInView(true)
            .onEnd(onEnd);

        expect(pan.__config).toEqual({
            enabled: true,
            activeOffsetX: [-12, 12],
            failOffsetY: [-8, 8],
            hitSlop: { left: -24, right: -32 },
            cancelsTouchesInView: true,
        });

        pan.__handlers.onEnd?.({ translationX: 96, velocityX: 800 });
        expect(onEnd).toHaveBeenCalledWith({ translationX: 96, velocityX: 800 });
    });

    it('composes raced gestures so drivers can reach each branch', () => {
        const module = createGestureHandlerMock();

        const pan = module.Gesture.Pan();
        const longPress = module.Gesture.LongPress();
        const raced = module.Gesture.Race(longPress, pan);

        expect(raced.__kind).toBe('race');
        expect(findGestureByKind(raced, 'pan')).toBe(pan);
        expect(findGestureByKind(raced, 'longPress')).toBe(longPress);
    });

    it('reports every created gesture to a caller-supplied recorder', () => {
        const created: TestGestureChain[] = [];
        const module = createGestureHandlerMock({
            onGestureCreated: (gesture) => {
                created.push(gesture);
            },
        });

        const pan = module.Gesture.Pan();
        const longPress = module.Gesture.LongPress();
        const composed = module.Gesture.Simultaneous(longPress, pan);

        expect(created).toHaveLength(3);
        expect(created[0]).toBe(pan);
        expect(created[1]).toBe(longPress);
        expect(created[2]).toBe(composed);
    });
});

describe('reactNativeGestureHandlerStub', () => {
    it('records the same chain surface as the testkit mock', () => {
        const onEnd = vi.fn();

        const pan = gestureHandlerStub.Gesture.Pan()
            .enabled(true)
            .minDistance(4)
            .activeOffsetX([-12, 12])
            .activeOffsetY([-12, 12])
            .failOffsetX([-8, 8])
            .failOffsetY([-8, 8])
            .hitSlop({ left: -24, right: -32 })
            .cancelsTouchesInView(true)
            .shouldCancelWhenOutside(false)
            .activateAfterLongPress(350)
            .withTestId('lateral-session-swipe')
            .onBegin(vi.fn())
            .onStart(vi.fn())
            .onUpdate(vi.fn())
            .onEnd(onEnd)
            .onFinalize(vi.fn())
            .onTouchesDown(vi.fn())
            .onTouchesMove(vi.fn())
            .onTouchesUp(vi.fn())
            .onTouchesCancelled(vi.fn());

        expect(pan.__kind).toBe('pan');
        expect(pan.__config).toEqual({
            enabled: true,
            minDistance: 4,
            activeOffsetX: [-12, 12],
            activeOffsetY: [-12, 12],
            failOffsetX: [-8, 8],
            failOffsetY: [-8, 8],
            hitSlop: { left: -24, right: -32 },
            cancelsTouchesInView: true,
            shouldCancelWhenOutside: false,
            activateAfterLongPress: 350,
            testId: 'lateral-session-swipe',
        });

        pan.__handlers.onEnd?.({ translationX: -96 });
        expect(onEnd).toHaveBeenCalledWith({ translationX: -96 });
    });

    it('composes gestures with the shared kinds so drivers work under the global alias', () => {
        const pan = gestureHandlerStub.Gesture.Pan();
        const longPress = gestureHandlerStub.Gesture.LongPress();

        expect(findGestureByKind(gestureHandlerStub.Gesture.Simultaneous(longPress, pan), 'pan')).toBe(pan);
        expect(findGestureByKind(gestureHandlerStub.Gesture.Race(longPress, pan), 'longPress')).toBe(longPress);
    });

    it('keeps host-element component exports so tree queries stay stable', () => {
        expect(gestureHandlerStub.GestureDetector).toBe('GestureDetector');
        expect(gestureHandlerStub.ScrollView).toBe('GestureHandlerScrollView');
    });
});
