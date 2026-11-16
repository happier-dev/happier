import { describe, expect, it } from 'vitest';
import * as themes from './themeProfiles.js';
import { ACCOUNT_SETTING_DEFINITIONS, AccountSettingsSchema } from './accountSettings.js';

const profile = (id: string) => ({
    schemaVersion: 1, id, name: 'Ocean', createdAt: '2026-05-12', updatedAt: '2026-05-12',
    base: { light: 'light', dark: 'dark' }, overrides: { light: { 'surface.base': '#123456' }, dark: {} },
});

describe('Account theme profile library', () => {
    it('defaults missing libraries without dropping other settings', () => {
        expect(AccountSettingsSchema.parse({}).themeProfiles).toEqual([]);
    });
    it('rejects reserved base and built-in profile identities at mutation admission', () => {
        for (const id of ['light', 'new', 'premiumDark']) {
            expect(ACCOUNT_SETTING_DEFINITIONS.themeProfiles.parseMutationValue([profile(id)]).success).toBe(false);
        }
    });
    it('migrates aliases without losing newer valid tokens or overriding canonical values', () => {
        const source = { ...profile('theme_ocean'), overrides: { light: { 'groupped.background': '#111111', 'background.canvas': '#222222', 'future.token': '#abcdef' }, dark: {} } };
        expect(AccountSettingsSchema.parse({ themeProfiles: [source] }).themeProfiles[0]?.overrides.light).toEqual({ 'background.canvas': '#222222', 'future.token': '#abcdef' });
    });
    it('rejects malformed colors and closed mutation fields', () => {
        for (const source of [
            { ...profile('theme_ocean'), unknown: true },
            { ...profile('theme_ocean'), overrides: { light: { 'surface.base': 'url(bad)' }, dark: {} } },
        ]) expect(ACCOUNT_SETTING_DEFINITIONS.themeProfiles.parseMutationValue([source]).success).toBe(false);
    });
    it('rejects control characters before name normalization', () => {
        expect(ACCOUNT_SETTING_DEFINITIONS.themeProfiles.parseMutationValue([{ ...profile('theme_name'), name: '\nOcean' }]).success).toBe(false);
    });
    it('retains opaque tokens that match Object prototype property names', () => {
        const source = { ...profile('theme_token'), overrides: { light: { constructor: '#abcdef' }, dark: {} } };
        expect(AccountSettingsSchema.parse({ themeProfiles: [source] }).themeProfiles[0]?.overrides.light).toEqual({ constructor: '#abcdef' });
    });
    it('recovers valid stored siblings while refusing malformed library mutations', () => {
        const valid = profile('theme_valid');
        const library = [valid, { id: 'malformed' }, valid];
        expect(AccountSettingsSchema.parse({ themeProfiles: library }).themeProfiles).toEqual([valid]);
        expect(ACCOUNT_SETTING_DEFINITIONS.themeProfiles.parseMutationValue(library).success).toBe(false);
    });
    it('owns and retains libraries beyond the local creation limit', () => {
        const profiles = Array.from({ length: 51 }, (_, index) => profile(`theme_${index}`));
        expect(AccountSettingsSchema.parse({ themeProfiles: profiles }).themeProfiles).toEqual(profiles);
        expect(ACCOUNT_SETTING_DEFINITIONS).toHaveProperty('themeProfiles');
    });
});


describe('portable theme presentation', () => {
    it('admits seeds, style, CSS and pinned Store provenance', () => {
        const source = { ...profile('theme_portable'), seeds: { canvas: '#112233', accent: '#abcdef' },
            style: { radius: 'round', fontFamily: 'Inter' }, css: '[data-surface="card"] { opacity: .9 }',
            source: { kind: 'store', contributionId: 'night', provenance: { sourceId: 'openvsx', itemId: 'publisher.palette', format: 'git', sourceUrl: 'https://open-vsx.org', ref: { kind: 'version', version: '1.0' }, importedAt: 1 } },
            requiresAppVersion: '0.4.0' };
        expect(themes.ThemeProfileV1Schema.safeParse(source).success).toBe(true);
        expect(themes.ThemeProfileLibraryStoredSchema.parse([source])).toEqual([source]);
    });
});


describe('theme document retention', () => {
    it('resets known presentation while retaining future children and preserving omitted partial edits', () => {
        const parsed = themes.parseThemeProfileDocument({ ...profile('reset_theme'), schemaVersion: 2,
            seeds: { canvas: '#112233', accent: '#abcdef', futureTone: '#fedcba' },
            style: { radius: 'round', fontFamily: 'Inter', futureInset: true }, css: '.card{}', futureTone: 'warm' });
        if (!parsed.ok) throw new Error('reset source rejected');
        const partial = themes.mergeThemeProfileDocumentEdit(parsed.document, { name: 'Renamed' });
        expect(partial.raw.seeds).toEqual(parsed.document.raw.seeds);
        const reset = themes.mergeThemeProfileDocumentEdit(parsed.document, { name: 'Reset', overrides: { light: {}, dark: {} } },
            { removeKnownFields: ['seeds', 'style', 'css'] });
        expect(reset.profile).not.toHaveProperty('seeds');
        expect(reset.profile).not.toHaveProperty('style');
        expect(reset.profile).not.toHaveProperty('css');
        expect(reset.raw).toMatchObject({ schemaVersion: 2, name: 'Reset', seeds: { futureTone: '#fedcba' },
            style: { futureInset: true }, futureTone: 'warm' });
        expect(reset.raw).not.toHaveProperty('css');
        expect(reset.raw.seeds).not.toHaveProperty('canvas');
        expect(reset.raw.style).not.toHaveProperty('radius');
        expect(themes.parseThemeProfileDocument({ ...profile('invalid_reset'), seeds: { accent: '#abcdef', futureTone: true } }).ok).toBe(false);
        expect(themes.parseThemeProfileDocument({ ...profile('invalid_reset'), style: { radius: 4, futureInset: true } }).ok).toBe(false);
    });

    it('preserves future raw presentation through a known edit and recovers supported stored siblings', () => {
        const raw = { ...profile('future_theme'), style: { radius: 'round', futureGlow: { amount: 2 } }, futurePresentation: { blur: true } };
        const result = themes.parseThemeProfileDocument(raw);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('document rejected');
        expect(result.document.compatibility).toMatchObject({ status: 'partial', unsupportedPaths: ['style.futureGlow', 'futurePresentation'] });
        const edited = themes.mergeThemeProfileDocumentEdit(result.document, { name: 'Renamed', style: { radius: 'sharp' } });
        expect(edited.raw).toMatchObject({ name: 'Renamed', style: { radius: 'sharp', futureGlow: { amount: 2 } }, futurePresentation: { blur: true } });
        expect(themes.ThemeProfileLibraryStoredSchema.parse([raw, profile('sibling')])[0])
            .toMatchObject({ id: 'future_theme', style: { radius: 'round' } });
        const newer = themes.parseThemeProfileDocument({ ...raw, schemaVersion: 2 });
        const pending = themes.parseThemeProfileDocument({ ...profile('future_theme'),
            style: { radius: 'round', futureInset: true }, futureTone: '#abcdef' });
        if (!newer.ok || !pending.ok) throw new Error('retained source rejected');
        const inherited = themes.mergeThemeProfileDocumentEdit(newer.document, { ...pending.document.profile, name: 'Latest' },
            { retainedPresentation: pending.document });
        expect(inherited.raw).toMatchObject({ schemaVersion: 2, name: 'Latest',
            style: { radius: 'round', futureGlow: { amount: 2 }, futureInset: true },
            futurePresentation: { blur: true }, futureTone: '#abcdef' });
    });
    it('rejects malformed known fields and source authority while partially projecting future versions', () => {
        for (const change of [{ id: 'new' }, { seeds: { canvas: 'url(external)', accent: '#abcdef' } }, { source: { kind: 'yours', pluginId: 'other' } }]) {
            expect(themes.parseThemeProfileDocument({ ...profile('valid_theme'), ...change }).ok).toBe(false);
        }
        const future = themes.parseThemeProfileDocument({ ...profile('future_theme'), schemaVersion: 2, css: '.card{}' });
        expect(future.ok).toBe(true);
        if (!future.ok) throw new Error('future presentation rejected');
        expect(future.document.raw.schemaVersion).toBe(2);
        expect(future.document.profile.schemaVersion).toBe(1);
        expect(future.document.compatibility.unsupportedPaths).toContain('schemaVersion');
    });
});


describe('theme references', () => {
    it('addresses plugin contributions independently from custom profile identities', () => {
        const reference = { kind: 'plugin', pluginId: 'org.example.palette', contributionId: 'night' };
        expect(themes.ThemeReferenceSchema.parse(reference)).toEqual(reference);
        expect(themes.ThemeProfileV1Schema.safeParse({ ...profile('valid_theme'), id: 'org.example.palette:night' }).success).toBe(false);
        expect(themes.ThemeReferenceSchema.safeParse({ ...reference, id: 'another-record' }).success).toBe(false);
    });
});
