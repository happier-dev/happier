import { describe, expect, it } from 'vitest';

import { resolvePointerClientPoint } from './resolvePointerClientPoint.js';

describe('resolvePointerClientPoint', () => {
    it('prefers nativeEvent.clientX/clientY when available', () => {
        expect(resolvePointerClientPoint({
            nativeEvent: { clientX: 123, clientY: 456, pageX: 901, pageY: 902 },
            clientX: 11, clientY: 22, pageX: 33, pageY: 44,
        }))
            .toEqual({ x: 123, y: 456 });
    });

    it('falls back to event.clientX/clientY', () => {
        expect(resolvePointerClientPoint({
            clientX: 11, clientY: 22,
            nativeEvent: { pageX: 55, pageY: 66 }, pageX: 77, pageY: 88,
        }))
            .toEqual({ x: 11, y: 22 });
    });

    it('supports nativeEvent.pageX/pageY for React Native Web synthetic events', () => {
        expect(resolvePointerClientPoint({ nativeEvent: { pageX: 5, pageY: 7 } }))
            .toEqual({ x: 5, y: 7 });
    });

    it('falls back to event.pageX/pageY', () => {
        expect(resolvePointerClientPoint({ pageX: 77, pageY: 88 }))
            .toEqual({ x: 77, y: 88 });
    });

    it('supports touches[0].clientX/clientY', () => {
        expect(resolvePointerClientPoint({ touches: [{ clientX: 12, clientY: 34 }] }))
            .toEqual({ x: 12, y: 34 });
    });

    it('supports touches[0].pageX/pageY', () => {
        expect(resolvePointerClientPoint({ touches: [{ pageX: 34, pageY: 56 }] }))
            .toEqual({ x: 34, y: 56 });
    });

    it('returns null coordinates when no pointer coordinate is available', () => {
        expect(resolvePointerClientPoint({})).toEqual({ x: null, y: null });
    });
});


