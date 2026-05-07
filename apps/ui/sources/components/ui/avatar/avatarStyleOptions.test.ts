import { describe, expect, it } from 'vitest';

import { AVATAR_STYLE_IDS } from '@/sync/domains/settings/registry/account/avatarStyleSetting';
import {
    AVATAR_STYLE_OPTIONS,
    getMeshGradientVariantForAvatarStyle,
    getNextAvatarStyleId,
    normalizeAvatarStyleId,
} from './avatarStyleOptions';

describe('avatarStyleOptions', () => {
    it('defines one display option for every persisted avatar style id', () => {
        const optionIds = AVATAR_STYLE_OPTIONS.map((option) => option.id);

        expect(new Set(optionIds).size).toBe(optionIds.length);
        expect(optionIds).toEqual([...AVATAR_STYLE_IDS]);
    });

    it('normalizes unknown avatar styles to the legacy gradient fallback', () => {
        expect(normalizeAvatarStyleId('not-a-style')).toBe('gradient');
    });

    it('cycles through mesh gradient after brutalist, then layered raster gradients, then wraps to pixelated', () => {
        expect(getNextAvatarStyleId('brutalist')).toBe('meshGradient');
        expect(getNextAvatarStyleId('meshGradientSoftNoise')).toBe('photoGradient');
        expect(getNextAvatarStyleId('photoGradientMeshGrid')).toBe('pixelated');
    });

    it('surfaces mesh gradient variants as selectable style options', () => {
        const optionIds = AVATAR_STYLE_OPTIONS.map((option) => option.id);

        expect(optionIds).toContain('meshGradient');
        expect(optionIds).toContain('meshGradientOrganic');
        expect(optionIds).toContain('meshGradientRows');
        expect(optionIds).toContain('meshGradientColumns');
        expect(optionIds).toContain('meshGradientDiagonal');
        expect(optionIds).toContain('meshGradientOval');
        expect(optionIds).toContain('meshGradientWaves');
        expect(optionIds).toContain('meshGradientSoftNoise');
    });

    it('surfaces layered raster variants as selectable style options after SVG mesh styles', () => {
        const optionIds = AVATAR_STYLE_OPTIONS.map((option) => option.id);

        expect(optionIds).toEqual(expect.arrayContaining([
            'photoGradient',
            'photoGradientRows',
            'photoGradientColumns',
            'photoGradientDiagonal',
            'photoGradientWaves',
            'photoGradientOval',
            'photoGradientValueNoise',
            'photoGradientVoronoi',
            'photoGradientMeshGrid',
        ]));
        expect(optionIds.indexOf('meshGradientSoftNoise')).toBeLessThan(optionIds.indexOf('photoGradient'));
        expect(getNextAvatarStyleId('photoGradientColumns')).toBe('photoGradientDiagonal');
        expect(getNextAvatarStyleId('photoGradientDiagonal')).toBe('photoGradientWaves');
    });

    it('maps persisted mesh gradient style ids to renderer variants', () => {
        expect(getMeshGradientVariantForAvatarStyle('meshGradient')).toBe('auto');
        expect(getMeshGradientVariantForAvatarStyle('meshGradientRows')).toBe('rows');
        expect(getMeshGradientVariantForAvatarStyle('meshGradientColumns')).toBe('columns');
        expect(getMeshGradientVariantForAvatarStyle('meshGradientDiagonal')).toBe('diagonal');
        expect(getMeshGradientVariantForAvatarStyle('meshGradientOval')).toBe('oval');
        expect(getMeshGradientVariantForAvatarStyle('gradient')).toBeNull();
    });
});
