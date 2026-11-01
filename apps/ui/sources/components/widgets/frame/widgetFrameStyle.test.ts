import { describe, expect, it } from 'vitest';

import { resolveWidgetFrameStyle, resolveWidgetFrameStyleToggle } from './widgetFrameStyle';

describe('resolveWidgetFrameStyle', () => {
    it('uses the surface default from Appearance when the widget has no override', () => {
        expect(resolveWidgetFrameStyle({ placement: 'board', surfaceDefault: 'plain', override: null })).toBe('plain');
        expect(resolveWidgetFrameStyle({ placement: 'companion', surfaceDefault: 'card' })).toBe('card');
    });

    it('falls back to the placement defaults (Home and Board card, Companion plain) when nothing is set', () => {
        expect(resolveWidgetFrameStyle({ placement: 'home' })).toBe('card');
        expect(resolveWidgetFrameStyle({ placement: 'board' })).toBe('card');
        expect(resolveWidgetFrameStyle({ placement: 'companion' })).toBe('plain');
    });
});

describe('resolveWidgetFrameStyleToggle (the ⋯ menu entries)', () => {
    it('offers the opposite of what the widget shows, and no reset while it follows the surface', () => {
        expect(resolveWidgetFrameStyleToggle({ placement: 'board', surfaceDefault: 'card', override: null })).toEqual({
            effective: 'card',
            toggleTo: 'plain',
            canReset: false,
        });
    });

    it('offers to return to the surface default once overridden', () => {
        expect(resolveWidgetFrameStyleToggle({ placement: 'board', surfaceDefault: 'card', override: 'plain' })).toEqual({
            effective: 'plain',
            toggleTo: 'card',
            canReset: true,
        });
    });
});
