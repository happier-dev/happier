import { describe, expect, it } from 'vitest';
import { t } from '@/text';

import type { ThemePresetSourceOption } from './themeProfilePresetOptions';
import { buildThemePresetSourceOptions, getThemePresetSourceReferenceId, readThemePresetSourceReferenceId, resolveCustomThemeSourceLabel, resolveThemePresetSourcePreferredMode, themeProfileDraftMatchesPresetSource } from './themeProfilePresetOptions';
import type { ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import type { ThemeLibraryEntry } from '@happier-dev/protocol/account/settings/themeProfiles';

const profile = (overrides: ThemeProfileV1['overrides']): ThemeProfileV1 => ({
    schemaVersion: 1,
    id: 'theme_order',
    name: 'Order',
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
    base: { light: 'light', dark: 'dark' },
    overrides,
});

const source = (sourceProfile: ThemeProfileV1): ThemePresetSourceOption => ({
    id: sourceProfile.id,
    kind: 'custom',
    title: sourceProfile.name,
    subtitle: 'Custom theme',
    profile: sourceProfile,
    preferredMode: 'light',
    reference: { kind: 'artifact', id: sourceProfile.id },
});

describe('themeProfilePresetOptions', () => {
    it('labels a built-in source without presenting it as an authored theme', () => {
        expect(resolveCustomThemeSourceLabel({ kind: 'built-in', presetId: 'premiumDark' }, {
            sourceYours: 'Authored', sourceStore: 'Store', sourcePlugin: 'Plugin',
        })).toBe(t('settingsAppearance.themeProfiles.builtInTheme'));
    });
    it('round-trips tagged route references and reads released Artifact routes', () => {
        const references = [
            { kind: 'artifact', id: 'theme-header' },
            { kind: 'plugin', pluginId: 'first.theme', contributionId: 'night' },
            { kind: 'plugin', pluginId: 'second.theme', contributionId: 'night' },
        ] as const;
        for (const reference of references) expect(readThemePresetSourceReferenceId(getThemePresetSourceReferenceId(reference))).toEqual(reference);
        expect(readThemePresetSourceReferenceId('theme-header')).toEqual(references[0]);
        expect(readThemePresetSourceReferenceId('premiumDark')).toEqual({ kind: 'built-in', presetId: 'premiumDark' });
        expect(readThemePresetSourceReferenceId('["plugin","missing"]')).toBeNull();
    });
    it('projects header entries as selectable references without inventing profile bodies', () => {
        const entry: ThemeLibraryEntry = { id: 'theme-header', reference: { kind: 'artifact', id: 'theme-header' }, name: 'Header theme',
            mode: 'dark', source: { kind: 'yours' }, editable: true, deletable: true,
            compatibility: { status: 'supported', unsupportedPaths: [] },
            miniature: { mode: 'dark', canvas: '#111111', raised: '#222222', text: '#ffffff', mutedText: '#aaaaaa', accent: '#123456', border: '#333333', radius: 'soft' } };
        const plugin = (pluginId: string): ThemeLibraryEntry => ({ ...entry,
            reference: { kind: 'plugin', pluginId, contributionId: 'night' },
            source: { kind: 'plugin', pluginId, contributionId: 'night' }, editable: false, deletable: false });
        const store: ThemeLibraryEntry = { ...entry, id: 'store-theme', reference: { kind: 'artifact', id: 'store-theme' },
            source: { kind: 'store', contributionId: 'night', provenance: { sourceId: 'openvsx', itemId: 'publisher.palette',
                format: 'git', sourceUrl: 'https://open-vsx.org', ref: { kind: 'version', version: '1.0' }, importedAt: 1 } } };
        const custom = buildThemePresetSourceOptions([entry, store, plugin('first.theme'), plugin('second.theme')]).filter(candidate => candidate.kind === 'custom');
        expect(new Set(custom.map(candidate => candidate.id)).size).toBe(4);
        expect(custom.map(candidate => candidate.subtitle)).toEqual([
            t('settingsAppearance.themeProfiles.sourceYours'), t('settingsAppearance.themeProfiles.sourceStore'),
            t('settingsAppearance.themeProfiles.sourcePlugin'), t('settingsAppearance.themeProfiles.sourcePlugin'),
        ]);
        const option = custom.find(candidate => candidate.reference === entry.reference);
        expect(option).toMatchObject({ title: entry.name, reference: entry.reference, miniature: entry.miniature, preferredMode: 'dark' });
        expect(option?.profile).toBeNull();
    });
    it('matches preset values independent of override key insertion order', () => {
        const draft = profile({
            light: { 'text.primary': '#111111', 'background.canvas': '#FFFFFF' },
            dark: { 'surface.base': '#222222', 'text.primary': '#EEEEEE' },
        });
        const preset = source(profile({
            light: { 'background.canvas': '#FFFFFF', 'text.primary': '#111111' },
            dark: { 'text.primary': '#EEEEEE', 'surface.base': '#222222' },
        }));

        expect(themeProfileDraftMatchesPresetSource(draft, preset)).toBe(true);
    });

    it('infers custom theme mode from the side that actually contains profile colors', () => {
        expect(resolveThemePresetSourcePreferredMode(profile({
            light: {},
            dark: { 'background.canvas': '#08080A' },
        }))).toBe('dark');
        expect(resolveThemePresetSourcePreferredMode(profile({
            light: { 'background.canvas': '#FFFFFF' },
            dark: {},
        }))).toBe('light');
    });

    it('uses built-in preset metadata for curated theme modes', () => {
        const options = buildThemePresetSourceOptions([]);

        expect(options.find((option) => option.id === 'premiumDark')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'pitchDark')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'sunsetDark')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'tokyoNight')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'nightDark')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'classicDark')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'graphiteDark')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'catppuccinMocha')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'catppuccinMacchiato')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'catppuccinFrappe')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'oneDarkPro')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'monokaiPro')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'githubDark')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'darkModern')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'premiumLight')?.preferredMode).toBe('light');
        expect(options.find((option) => option.id === 'paperLight')?.preferredMode).toBe('light');
        expect(options.find((option) => option.id === 'catppuccinLatte')?.preferredMode).toBe('light');
        expect(options.find((option) => option.id === 'githubLight')?.preferredMode).toBe('light');
    });
});
