import { describe, expect, it } from 'vitest';
import { resolveInAppFirstFrame } from './inAppFirstFrame';

describe('the opening at the first usable layout', () => {
    it('runs only a renderer that has already painted and leaves desktop presentation to native', () => {
        expect(resolveInAppFirstFrame('in-app', 'ready', true)).toBe('play');
        expect(resolveInAppFirstFrame('in-app', 'ready', false)).toBe('still');
        expect(resolveInAppFirstFrame('in-app', null, true)).toBe('still');
        expect(resolveInAppFirstFrame('in-app', 'still', true)).toBe('still');
        expect(resolveInAppFirstFrame('reduced', 'ready', true)).toBe('still');
        expect(resolveInAppFirstFrame('overlay-eligible', 'ready', true)).toBe('still');
    });
});
