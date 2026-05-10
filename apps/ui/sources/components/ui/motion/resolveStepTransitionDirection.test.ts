import { describe, expect, it } from 'vitest';

import { resolveStepTransitionDirection } from './resolveStepTransitionDirection';

describe('resolveStepTransitionDirection', () => {
    it('returns replace when there is no previous index', () => {
        expect(resolveStepTransitionDirection({ previousIndex: null, nextIndex: 0 })).toBe('replace');
        expect(resolveStepTransitionDirection({ previousIndex: null, nextIndex: 4 })).toBe('replace');
    });

    it('returns forward when next > previous', () => {
        expect(resolveStepTransitionDirection({ previousIndex: 0, nextIndex: 1 })).toBe('forward');
        expect(resolveStepTransitionDirection({ previousIndex: 3, nextIndex: 5 })).toBe('forward');
    });

    it('returns backward when next < previous', () => {
        expect(resolveStepTransitionDirection({ previousIndex: 2, nextIndex: 1 })).toBe('backward');
        expect(resolveStepTransitionDirection({ previousIndex: 5, nextIndex: 0 })).toBe('backward');
    });

    it('returns replace when next === previous', () => {
        expect(resolveStepTransitionDirection({ previousIndex: 2, nextIndex: 2 })).toBe('replace');
    });
});
