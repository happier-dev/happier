import { describe, expect, it } from 'vitest';
import { getThemeProfileContrastAnalysis, getThemeProfileContrastWarnings, resolveThemeProfileEditorDraft } from './themeProfileEditorModel';
import { getThemeProfileTokenDefinition } from '@/theme/profiles/themeProfileTokenRegistry';
import type { ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';

describe('theme profile contrast warnings', () => {
    it('warns when the editable accent seed is too close to the editable page seed', () => {
        const profile: ThemeProfileV1 = {
            schemaVersion: 1, id: 'seeds', name: 'Seeds', createdAt: '', updatedAt: '',
            base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} },
            seeds: { canvas: '#F4EFE6', accent: '#EBD9C6' },
        };

        const draft = resolveThemeProfileEditorDraft(profile, 'light');
        expect(draft.seeds.accent.warnings).toEqual(['seed.canvas']);
        expect(draft.seeds.accent.fix).not.toBeNull();
    });

    it('warns when an editable link colour is unreadable on the page', () => {
        const profile: ThemeProfileV1 = {
            schemaVersion: 1, id: 'link-warning', name: 'Link warning', createdAt: '', updatedAt: '',
            base: { light: 'light', dark: 'dark' },
            overrides: { light: { 'text.link': '#eeeeee', 'background.canvas': '#ffffff' }, dark: {} },
        };

        expect(getThemeProfileContrastWarnings(profile, 'light', getThemeProfileTokenDefinition('text.link')!)).toContain('background.canvas');
    });

    it('keeps the Default palette quiet in both modes', () => {
        const profile: ThemeProfileV1 = {
            schemaVersion: 1, id: 'default', name: 'Default', createdAt: '', updatedAt: '',
            base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} },
        };

        for (const mode of ['light', 'dark'] as const) {
            const draft = resolveThemeProfileEditorDraft(profile, mode);
            const warnings = Object.fromEntries(Object.entries(draft.tokens)
                .filter(([, token]) => token.contrast.warnings.length > 0)
                .map(([tokenId, token]) => [tokenId, token.contrast.warnings]));
            expect(warnings).toEqual({});
        }
    });

    it('resolves each changed draft mode once for all token values and contrast pairs', () => {
        let resolutions = 0;
        const profile: ThemeProfileV1 = {
            schemaVersion: 1, id: 'cost', name: 'Cost', createdAt: '', updatedAt: '',
            base: { light: 'light', dark: 'dark' },
            overrides: { light: { 'text.primary': '#eeeeee', 'background.canvas': '#ffffff' }, dark: {} },
            // Observe the real resolver's serialization, retaining real style application and colour logic.
            style: Object.assign({ radius: 'soft' as const }, { toJSON: () => {
                resolutions += 1;
                return { radius: 'soft' };
            } }),
        };
        const rows = resolveThemeProfileEditorDraft(profile, 'light').tokens;
        expect(rows['text.primary']?.value).toBe('#eeeeee');
        expect(rows['text.primary']?.contrast.warnings).toContain('background.canvas');
        expect(resolutions).toBe(1);
        const changed = { ...profile, overrides: { ...profile.overrides, light: {
            ...profile.overrides.light, 'text.primary': '#000000',
        } } };
        const next = resolveThemeProfileEditorDraft(changed, 'light');
        expect(next.tokens['text.primary']?.value).toBe('#000000');
        expect(next.tokens['text.primary']?.contrast.warnings).toEqual([]);
        expect(next.tokens['text.primary']?.changed).toBe(true);
        expect(resolutions).toBe(2);
        const dark = resolveThemeProfileEditorDraft(changed, 'dark');
        expect(dark.tokens['text.primary']?.changed).toBe(false);
        expect(dark.tokens['text.primary']?.value).not.toBe('#000000');
        expect(resolutions).toBe(3);
    });

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
