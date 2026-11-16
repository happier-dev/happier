import { describe, expect, it } from 'vitest';
import { getThemeProfileContrastAnalysis, getThemeProfileContrastWarnings, resolveThemeProfileEditorTarget } from './themeProfileEditorModel';
import { getThemeProfileTokenDefinition } from '@/theme/profiles/themeProfileTokenRegistry';
import type { ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';

describe('theme profile contrast warnings', () => {
    it('measures translucent foreground over its actual surface instead of treating its RGB as opaque', () => {
        const profile: ThemeProfileV1 = {
            schemaVersion: 1, id: 'alpha', name: 'Alpha', createdAt: '', updatedAt: '',
            base: { light: 'light', dark: 'dark' },
            overrides: { light: { 'text.primary': 'rgba(0, 0, 0, 0.2)', 'background.canvas': '#ffffff' }, dark: {} },
        };
        const token = getThemeProfileTokenDefinition('text.primary')!;
        expect(getThemeProfileContrastWarnings(profile, 'light', token)).toContain('background.canvas');
        const analysis = getThemeProfileContrastAnalysis(profile, 'light', token);
        expect(analysis.fix).not.toBeNull();
        const fixed: ThemeProfileV1 = { ...profile, overrides: { ...profile.overrides,
            light: { ...profile.overrides.light, 'text.primary': analysis.fix! } } };
        expect(getThemeProfileContrastWarnings(fixed, 'light', token)).toEqual([]);
        expect(profile.overrides.light['text.primary']).toBe('rgba(0, 0, 0, 0.2)');
        const opaque: ThemeProfileV1 = { ...profile, overrides: { ...profile.overrides,
            light: { ...profile.overrides.light, 'text.primary': '#000000' } } };
        expect(getThemeProfileContrastWarnings(opaque, 'light', token)).not.toContain('background.canvas');
    });

    it('measures translucent surfaces over the theme canvas', () => {
        const profile: ThemeProfileV1 = {
            schemaVersion: 1, id: 'alpha', name: 'Alpha', createdAt: '', updatedAt: '',
            base: { light: 'light', dark: 'dark' },
            overrides: { light: { 'background.canvas': '#ffffff',
                'control.button.primary.foreground': '#000000',
                'control.button.primary.background': 'rgba(0, 0, 0, 0.05)' }, dark: {} },
        };
        const token = getThemeProfileTokenDefinition('control.button.primary.foreground')!;
        expect(getThemeProfileContrastWarnings(profile, 'light', token)).not.toContain('control.button.primary.background');
    });

    it('offers one fix across contrasting surfaces when each nearest single-surface fix fails another pair', () => {
        const profile: ThemeProfileV1 = {
            schemaVersion: 1, id: 'mixed', name: 'Mixed', createdAt: '', updatedAt: '',
            base: { light: 'light', dark: 'dark' },
            overrides: { light: { 'text.primary': '#bbbbbb', 'background.canvas': '#757575', 'surface.base': '#ffffff' }, dark: {} },
        };
        const token = getThemeProfileTokenDefinition('text.primary')!;
        const analysis = getThemeProfileContrastAnalysis(profile, 'light', token);
        expect(analysis.fix).not.toBeNull();
        const fixed: ThemeProfileV1 = { ...profile, overrides: { ...profile.overrides,
            light: { ...profile.overrides.light, 'text.primary': analysis.fix! } } };
        expect(getThemeProfileContrastWarnings(fixed, 'light', token)).toEqual([]);
    });
});

describe('theme profile editor identity', () => {
    it('follows a captured legacy origin after account fetch remaps the displayed id', () => {
        expect(resolveThemeProfileEditorTarget({ routeId: 'ocean', capturedLegacyProfileId: 'ocean',
            legacyProfileIds: { ocean_2: 'ocean' } })).toBe('ocean_2');
    });
    it('keeps an expired legacy origin separate from an account row at the old route', () => {
        expect(resolveThemeProfileEditorTarget({ routeId: 'ocean', capturedLegacyProfileId: 'ocean',
            legacyProfileIds: {} })).toBeNull();
        expect(resolveThemeProfileEditorTarget({ routeId: 'ocean', legacyProfileIds: {} })).toBe('ocean');
    });
});
