import { describe, expect, it, vi } from 'vitest';
import * as themes from './themeProfiles.js';
import { AccountSettingsSchema } from './accountSettings.js';
import { applyAccountSettingMutationV1 } from './accountSettingMutationV1.js';

const profile = (id: string) => ({
    schemaVersion: 1, id, name: 'Ocean', createdAt: '2026-05-12', updatedAt: '2026-05-12',
    base: { light: 'light', dark: 'dark' }, overrides: { light: { 'surface.base': '#123456' }, dark: {} },
});

it('reuses the document and skips full admission for an unchanged edit', () => {
    const parsed = themes.parseThemeProfileDocument({ ...profile('stable_theme'), assetAppearance: 'dark',
        style: { radius: 'soft', futureGlow: true }, futurePresentation: { glow: true } });
    if (!parsed.ok) throw new Error('Invalid theme fixture');
    expect(themes.mergeThemeProfileDocumentEdit(parsed.document, {})).toBe(parsed.document);
    expect(themes.mergeThemeProfileDocumentEdit(parsed.document, { assetAppearance: 'dark' })).toBe(parsed.document);
    expect(themes.mergeThemeProfileDocumentEdit(parsed.document, { style: { radius: 'soft' } })).toBe(parsed.document);
});

it('still refuses a source change that would invalidate a reserved profile id', () => {
    const parsed = themes.parseThemeProfileDocument({ ...profile('premiumDark'), source: { kind: 'built-in', presetId: 'premiumDark' } });
    if (!parsed.ok) throw new Error('Invalid theme fixture');
    expect(() => themes.mergeThemeProfileDocumentEdit(parsed.document, { source: { kind: 'yours' } })).toThrow('invalid_known_envelope');
});

describe('Account theme profile library', () => {
    it('refuses library-body authoring through generic Account settings mutations', () => {
        expect(applyAccountSettingMutationV1({}, { operations: [{ op: 'set', key: 'themeProfiles', value: [profile('released_theme')] }] }))
            .toMatchObject({ status: 'invalid', reason: 'unknownKey' });
    });
    it('excludes released library bodies from effective Account preferences', () => {
        expect(AccountSettingsSchema.parse({ themeProfiles: [profile('released_theme')] })).not.toHaveProperty('themeProfiles');
    });
    it('rejects reserved base and built-in profile identities at mutation admission', () => {
        for (const id of ['light', 'new', 'premiumDark']) {
            expect(themes.ThemeProfileLibrarySchema.safeParse([profile(id)]).success).toBe(false);
        }
    });
    it('migrates aliases without losing newer valid tokens or overriding canonical values', () => {
        const source = { ...profile('theme_ocean'), overrides: { light: { 'groupped.background': '#111111', 'background.canvas': '#222222', 'future.token': '#abcdef' }, dark: {} } };
        expect(themes.ThemeProfileLibraryStoredSchema.parse([source])[0]?.overrides.light).toEqual({ 'background.canvas': '#222222', 'future.token': '#abcdef' });
    });
    it('retains valid override collections beyond the former 300-token cutoff', () => {
        const overrides = Object.fromEntries(Array.from({ length: 301 }, (_, index) => [`future.token${index}`, '#abcdef']));
        const source = { ...profile('theme_many_tokens'), overrides: { light: overrides, dark: {} } };
        expect(themes.ThemeProfileV1Schema.parse(source).overrides.light).toEqual(overrides);
        expect(themes.ThemeProfileLibraryStoredSchema.parse([source])[0]?.overrides.light).toEqual(overrides);
    });
    it('rejects malformed colors and closed mutation fields', () => {
        for (const source of [
            { ...profile('theme_ocean'), unknown: true },
            { ...profile('theme_ocean'), overrides: { light: { 'surface.base': 'url(bad)' }, dark: {} } },
        ]) expect(themes.ThemeProfileLibrarySchema.safeParse([source]).success).toBe(false);
    });
    it('rejects control characters before name normalization', () => {
        expect(themes.ThemeProfileLibrarySchema.safeParse([{ ...profile('theme_name'), name: '\nOcean' }]).success).toBe(false);
    });
    it('retains opaque tokens that match Object prototype property names', () => {
        const source = { ...profile('theme_token'), overrides: { light: { constructor: '#abcdef' }, dark: {} } };
        expect(themes.ThemeProfileLibraryStoredSchema.parse([source])[0]?.overrides.light).toEqual({ constructor: '#abcdef' });
    });
    it('recovers valid stored siblings while refusing malformed library mutations', () => {
        const valid = profile('theme_valid');
        const library = [valid, { id: 'malformed' }, valid];
        expect(themes.ThemeProfileLibraryStoredSchema.parse(library)).toEqual([valid]);
        expect(themes.ThemeProfileLibrarySchema.safeParse(library).success).toBe(false);
    });
    it('owns and retains libraries beyond the local creation limit', () => {
        const profiles = Array.from({ length: 51 }, (_, index) => profile(`theme_${index}`));
        expect(themes.ThemeProfileLibraryStoredSchema.parse(profiles)).toEqual(profiles);
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
    it('reports unknown override ids while preserving them through edits and alias migration', () => {
        const raw = { ...profile('future_tokens'), overrides: {
            light: { 'groupped.background': '#112233', 'future.token': '#aabbcc', constructor: '#abcdef' },
            dark: { 'text.primary': '#eeeeee', 'future.darkToken': '#445566' },
        } };
        const parsed = themes.parseThemeProfileDocument(raw);
        if (!parsed.ok) throw new Error('Valid newer token document rejected');
        expect(parsed.document.compatibility).toEqual({ status: 'partial', unsupportedPaths: [
            'overrides.light.constructor', 'overrides.light.future.token', 'overrides.dark.future.darkToken',
        ] });
        expect(parsed.document.raw).toEqual(raw);
        expect(parsed.document.profile.overrides.light).toEqual({
            'background.canvas': '#112233', 'future.token': '#aabbcc', constructor: '#abcdef',
        });
        const edited = themes.mergeThemeProfileDocumentEdit(parsed.document, { name: 'Renamed' });
        expect(edited.raw.overrides).toEqual(raw.overrides);
        expect(edited.compatibility).toEqual(parsed.document.compatibility);
        const supported = themes.parseThemeProfileDocument(profile('supported_tokens'));
        expect(supported).toMatchObject({ ok: true, document: { compatibility: { status: 'supported', unsupportedPaths: [] } } });
    });

    it('resets known presentation while retaining future children and preserving omitted partial edits', () => {
        const parsed = themes.parseThemeProfileDocument({ ...profile('reset_theme'), schemaVersion: 2,
            seeds: { canvas: '#112233', accent: '#abcdef', futureTone: '#fedcba' },
            style: { radius: 'round', fontFamily: 'Inter', futureInset: true }, css: '.card{}', futureTone: 'warm' });
        if (!parsed.ok) throw new Error('reset source rejected');
        const partial = themes.mergeThemeProfileDocumentEdit(parsed.document, { name: 'Renamed' });
        expect(partial.raw.seeds).toEqual(parsed.document.raw.seeds);
        const admission = vi.spyOn(themes.ThemeProfileV1Schema, 'safeParse');
        const reset = themes.mergeThemeProfileDocumentEdit(parsed.document, { name: 'Reset', overrides: { light: {}, dark: {} } },
            { removeKnownFields: ['seeds', 'style', 'css'] });
        const admissions = admission.mock.calls.length;
        admission.mockRestore();
        expect(admissions).toBe(1);
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
    it('admits a complete editor draft once while retaining future presentation', () => {
        const parsed = themes.parseThemeProfileDocument({ ...profile('replace_theme'), schemaVersion: 2,
            seeds: { canvas: '#112233', accent: '#abcdef', futureTone: '#fedcba' },
            style: { radius: 'round', fontFamily: 'Inter', futureInset: true }, css: '.card{}' });
        if (!parsed.ok) throw new Error('replace source rejected');
        const { seeds: _seeds, css: _css, ...draft } = parsed.document.profile;
        const admission = vi.spyOn(themes.ThemeProfileV1Schema, 'safeParse');
        const replaced = themes.mergeThemeProfileDocumentEdit(parsed.document, { ...draft, style: { radius: 'soft' } },
            { replaceKnownPresentation: true });
        const admissions = admission.mock.calls.length;
        admission.mockRestore();
        expect(admissions).toBe(1);
        expect(replaced.raw).toMatchObject({ schemaVersion: 2, seeds: { futureTone: '#fedcba' }, style: { radius: 'soft', futureInset: true } });
        expect(replaced.raw).not.toHaveProperty('css');
        expect(replaced.raw.seeds).not.toHaveProperty('canvas');
        expect(replaced.raw.style).not.toHaveProperty('fontFamily');
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
