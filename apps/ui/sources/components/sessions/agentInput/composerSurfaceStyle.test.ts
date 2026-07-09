import { describe, expect, it } from 'vitest';

import { isGlassComposerSurface } from './composerSurfaceStyle';

describe('isGlassComposerSurface', () => {
    it('enables the glass surface when glass is selected', () => {
        expect(isGlassComposerSurface({ setting: 'glass' })).toBe(true);
    });

    it('stays on the default surface for standard or unset', () => {
        expect(isGlassComposerSurface({ setting: 'standard' })).toBe(false);
        expect(isGlassComposerSurface({ setting: undefined })).toBe(false);
    });
});
