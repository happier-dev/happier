import { describe, expect, it, vi } from 'vitest';

import { createGestureHandlerMock, findGestureByKind } from './gestureHandler';

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
});
