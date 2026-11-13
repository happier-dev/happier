import { describe, expect, it } from 'vitest';

import { resolveSessionLineageRowAppearance } from './resolveSessionLineageRowAppearance';

describe('resolveSessionLineageRowAppearance', () => {
    const presets = {
        parent: { density: 'detailed' as const, avatarStyle: 'gradient' as const },
        child: { density: 'narrow' as const, avatarStyle: 'pixelated' as const },
    };

    it('uses depth rather than disclosure ownership for parent and child presentation', () => {
        expect(resolveSessionLineageRowAppearance({
            enabled: true,
            nestingDepth: 0,
            hasChildren: true,
            baseDensity: 'cozy',
            presets,
        })).toEqual({ density: 'detailed', rowDensity: 'default', avatarStyle: 'gradient' });

        expect(resolveSessionLineageRowAppearance({
            enabled: true,
            nestingDepth: 2,
            hasChildren: true,
            baseDensity: 'cozy',
            presets,
        })).toEqual({ density: 'narrow', rowDensity: 'minimal', avatarStyle: 'pixelated' });
    });

    it('does not change standalone rows or any row while the feature is off', () => {
        expect(resolveSessionLineageRowAppearance({
            enabled: true,
            nestingDepth: 0,
            hasChildren: false,
            baseDensity: 'cozy',
            presets,
        })).toEqual({ density: 'cozy', rowDensity: 'compact', avatarStyle: null });

        expect(resolveSessionLineageRowAppearance({
            enabled: false,
            nestingDepth: 0,
            hasChildren: true,
            baseDensity: 'cozy',
            presets,
        })).toEqual({ density: 'cozy', rowDensity: 'compact', avatarStyle: null });
    });
});
