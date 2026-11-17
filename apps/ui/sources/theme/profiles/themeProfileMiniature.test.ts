import { describe, expect, it } from 'vitest';
import { parseThemeProfileDocument } from '@happier-dev/protocol/account/settings/themeProfiles';
import { ThemeLibraryEntrySchema } from '@happier-dev/protocol/actions/themeActionFamily';
import { projectThemeLibraryEntry, projectThemeMiniaturePalette, projectThemeProfileDocumentPresentation } from './themeProfilePresentation';
import { FontFamilies } from '@/constants/Typography';
import { resolveThemeProfile } from './resolveThemeProfile';

describe('theme miniature projection', () => {
    it('projects both authored modes while keeping seed-only and single-mode documents in their own mode', () => {
        const parsed = parseThemeProfileDocument({ schemaVersion: 1, id: 'paired', name: 'Paired', createdAt: 'now', updatedAt: 'now',
            base: { light: 'light', dark: 'dark' }, assetAppearance: 'dark', seeds: { canvas: '#172033', accent: '#aabbcc' },
            overrides: { light: { 'background.canvas': '#fafafa' }, dark: { 'background.canvas': '#171717' } } });
        if (!parsed.ok) throw new Error('Invalid fixture');
        const entry = projectThemeLibraryEntry(parsed.document);
        expect(entry.modes).toEqual(['light', 'dark']);
        expect(entry.miniatures?.light).toMatchObject({ mode: 'light', canvas: '#fafafa' });
        expect(entry.miniatures?.dark).toMatchObject({ mode: 'dark', canvas: '#171717', accent: '#aabbcc' });
        expect(entry.miniature).toBe(entry.miniatures?.dark);
        expect(ThemeLibraryEntrySchema.parse(entry)).toEqual(entry);
        const single = projectThemeLibraryEntry({ ...parsed.document,
            profile: { ...parsed.document.profile, overrides: { light: {}, dark: parsed.document.profile.overrides.dark } } });
        expect(single.modes).toEqual(['dark']);
        expect(single.miniatures?.light).toBeUndefined();
        const seeded = projectThemeLibraryEntry({ ...parsed.document,
            profile: { ...parsed.document.profile, overrides: { light: {}, dark: {} } } });
        expect(seeded.modes).toEqual(['dark']);
        const inferred = projectThemeLibraryEntry({ ...parsed.document,
            profile: { ...parsed.document.profile, assetAppearance: undefined, overrides: { light: {}, dark: parsed.document.profile.overrides.dark } } });
        expect(inferred.modes).toEqual(['dark']);
    });
    it('resolves seeds before explicit overrides and preserves corner shape in a compact header', () => {
        const parsed = parseThemeProfileDocument({ schemaVersion: 1, id: 'theme', name: 'Theme', createdAt: 'now', updatedAt: 'now', base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: { 'text.secondary': '#999999', 'syntax.keyword': '#123456' } }, assetAppearance: 'dark', seeds: { canvas: '#172033', accent: '#aabbcc' }, style: { radius: 'sharp', fontFamily: 'Future Font' }, css: 'body { color: red }' });
        if (!parsed.ok) throw new Error('Invalid fixture');
        const entry = projectThemeLibraryEntry(parsed.document);
        expect(entry.miniature).toMatchObject({ canvas: '#172033', accent: '#aabbcc', mutedText: '#999999', radius: 'sharp' });
        expect(entry.miniature.text).toBe(resolveThemeProfile({ mode: 'dark', profile: parsed.document.profile }).colors.text.primary);
        expect(JSON.stringify(entry)).not.toContain('body {');
        expect(projectThemeMiniaturePalette(parsed.document.profile).overrides).toEqual({ 'text.secondary': '#999999' });
        const presented = projectThemeProfileDocumentPresentation(parsed.document);
        expect(presented.profile.style?.fontFamily).toBeUndefined();
        expect(presented.raw).toBe(parsed.document.raw);
        expect(entry.compatibility).toMatchObject({ status: 'partial', unsupportedPaths: ['style.fontFamily'] });
        const known = parseThemeProfileDocument({ ...parsed.document.raw, style: { fontFamily: FontFamilies.default.regular } });
        if (!known.ok) throw new Error('Invalid known font fixture');
        expect(projectThemeProfileDocumentPresentation(known.document).profile.style?.fontFamily).toBe(FontFamilies.default.regular);
    });
});

describe('seed resolution lifecycle', () => {
    it('keeps the other mode unchanged and invalidates only changed authored seeds', () => {
        const parsed = parseThemeProfileDocument({ schemaVersion: 1, id: 'seeded', name: 'Seeded', createdAt: 'now', updatedAt: 'now', base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} }, assetAppearance: 'dark', seeds: { canvas: '#172033', accent: '#aabbcc' } });
        if (!parsed.ok) throw new Error('Invalid fixture');
        const dark = resolveThemeProfile({ mode: 'dark', profile: parsed.document.profile });
        expect(resolveThemeProfile({ mode: 'dark', profile: { ...parsed.document.profile, seeds: { canvas: '#172033', accent: '#aabbcc' } } })).toBe(dark);
        const metadataEdit = { ...parsed.document.profile, updatedAt: 'later' };
        expect(resolveThemeProfile({ mode: 'dark', profile: metadataEdit })).toBe(dark);
        expect(resolveThemeProfile({ mode: 'dark', profile: { ...parsed.document.profile, seeds: { canvas: '#172034', accent: '#aabbcc' } } })).not.toBe(dark);
        expect(resolveThemeProfile({ mode: 'light', profile: parsed.document.profile }).colors.background.canvas).toBe(resolveThemeProfile({ mode: 'light', profile: null }).colors.background.canvas);
    });
});
