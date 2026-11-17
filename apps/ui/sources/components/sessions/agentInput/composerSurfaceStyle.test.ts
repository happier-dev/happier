import { describe, expect, it } from 'vitest';

import { isGlassComposerSurface, resolveComposerSurfacePaint, resolveComposerMaterialPaint } from './composerSurfaceStyle';
import { lightTheme } from '@/theme';

describe('isGlassComposerSurface', () => {
    it('does not claim the selected solid input is the final paint without mounted material facts', () => {
        expect(resolveComposerMaterialPaint({ theme: lightTheme, glass: false, embedded: false }).source)
            .toEqual({ kind: 'fixed' });
    });
    it('uses the editable input path while embedded and custom composer paint remain instance-owned', () => {
        expect(resolveComposerSurfacePaint({ theme: lightTheme, glass: false, embedded: false }))
            .toEqual({ color: lightTheme.colors.input.background, source: { kind: 'token', ref: 'control.input.background' } });
        expect(resolveComposerSurfacePaint({ theme: lightTheme, glass: false, embedded: true }).source).toEqual({ kind: 'fixed' });
        expect(resolveComposerSurfacePaint({ theme: lightTheme, glass: false, embedded: false, customBackground: '#123456' }).source)
            .toEqual({ kind: 'fixed' });
        const glassPaint = { color: lightTheme.colors.glass.composerSurface,
            source: { kind: 'derived' as const, from: ['surface.base'] as const } };
        expect(resolveComposerSurfacePaint({ theme: lightTheme, glass: true, embedded: false, glassPaint })).toEqual(glassPaint);
    });
    it('enables the glass surface when glass is selected', () => {
        expect(isGlassComposerSurface({ setting: 'glass' })).toBe(true);
    });

    it('stays on the default surface for standard or unset', () => {
        expect(isGlassComposerSurface({ setting: 'standard' })).toBe(false);
        expect(isGlassComposerSurface({ setting: undefined })).toBe(false);
    });
});
