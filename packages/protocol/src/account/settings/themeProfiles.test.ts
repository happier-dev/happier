import { describe, expect, it } from 'vitest';
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
