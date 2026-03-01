import { describe, expect, it } from 'vitest';

import { resolvePointerClientX } from './resolvePointerClientX';

describe('resolvePointerClientX', () => {
    it('prefers nativeEvent.clientX when available', () => {
        expect(resolvePointerClientX({ nativeEvent: { clientX: 123 } })).toBe(123);
    });

    it('falls back to event.clientX', () => {
        expect(resolvePointerClientX({ clientX: 45 })).toBe(45);
    });

    it('supports nativeEvent.pageX for React Native Web synthetic events', () => {
        expect(resolvePointerClientX({ nativeEvent: { pageX: 99 } })).toBe(99);
    });

    it('supports event.pageX', () => {
        expect(resolvePointerClientX({ pageX: 77 })).toBe(77);
    });

    it('supports touches[0].clientX', () => {
        expect(resolvePointerClientX({ touches: [{ clientX: 12 }] })).toBe(12);
    });

    it('supports touches[0].pageX', () => {
        expect(resolvePointerClientX({ touches: [{ pageX: 34 }] })).toBe(34);
    });

    it('returns null when no pointer coordinate is available', () => {
        expect(resolvePointerClientX({})).toBeNull();
    });
});
