import { describe, expect, it } from 'vitest';

import { resolvePointerClientPoint } from './resolvePointerClientPoint';

describe('resolvePointerClientPoint', () => {
    it('prefers nativeEvent.clientX/clientY when available', () => {
        expect(resolvePointerClientPoint({ nativeEvent: { clientX: 123, clientY: 456 } }))
            .toEqual({ x: 123, y: 456 });
    });

    it('falls back to event.clientX/clientY', () => {
        expect(resolvePointerClientPoint({ clientX: 11, clientY: 22 }))
            .toEqual({ x: 11, y: 22 });
    });

    it('supports nativeEvent.pageX/pageY for React Native Web synthetic events', () => {
        expect(resolvePointerClientPoint({ nativeEvent: { pageX: 5, pageY: 7 } }))
            .toEqual({ x: 5, y: 7 });
    });

    it('supports touches[0].clientX/clientY', () => {
        expect(resolvePointerClientPoint({ touches: [{ clientX: 12, clientY: 34 }] }))
            .toEqual({ x: 12, y: 34 });
    });

    it('returns null coordinates when no pointer coordinate is available', () => {
        expect(resolvePointerClientPoint({})).toEqual({ x: null, y: null });
    });
});

