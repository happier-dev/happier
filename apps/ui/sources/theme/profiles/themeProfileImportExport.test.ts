import { describe, expect, it } from 'vitest';

import { THEME_PROFILE_MAX_JSON_BYTES, THEME_PROFILE_MAX_OVERRIDES_PER_MODE, THEME_PROFILE_MAX_PROFILES } from './themeProfileConstants';
import { exportThemeProfileToJson, getSupportedThemeProfileImportFormats, importThemeProfileFromJson, migrateThemeProfileOverrideTokenIds } from './themeProfileImportExport';
import { THEME_PROFILE_PUBLIC_TOKEN_IDS } from './themeProfileTokenRegistry';
import type { ThemeProfileV1 } from './themeProfileTypes';

const profile: ThemeProfileV1 = {
    schemaVersion: 1,
    id: 'theme_ocean',
    name: 'Ocean Terminal',
    createdAt: '2026-05-11T00:00:00.000Z',
    updatedAt: '2026-05-11T00:00:00.000Z',
    base: { light: 'light', dark: 'dark' },
    overrides: {
        light: {
            'surface.base': '#ffffff',
            'unknown.token': '#111111',
            'background.canvas': 'red',
        },
        dark: {
            'background.canvas': '#0A0A0B',
        },
    },
};
const profileWithDarkAssets: ThemeProfileV1 & { assetAppearance: 'dark' } = {
    ...profile,
    assetAppearance: 'dark',
};

describe('theme profile import/export', () => {
    it('exports stable JSON and prunes empty, unknown, deprecated, and invalid overrides', () => {
        const exported = exportThemeProfileToJson(profile);
        const parsed = JSON.parse(exported) as { profile: ThemeProfileV1 };

        expect(parsed).toMatchObject({ kind: 'happier.themeProfile', schemaVersion: 1 });
        expect(parsed.profile.overrides.light).toEqual({ 'surface.base': '#ffffff' });
        expect(parsed.profile.overrides.dark).toEqual({ 'background.canvas': '#0A0A0B' });
        expect(exported).not.toContain('unknown.token');
        expect(exported).not.toContain('groupped.background');
    });

    it('can export a complete resolved theme for a single profile mode', () => {
        const exported = exportThemeProfileToJson({
            ...profile,
            overrides: { light: {}, dark: { 'background.canvas': '#08080A' } },
        }, { mode: 'dark', includeResolvedValues: true });
        const parsed = JSON.parse(exported) as { profile: ThemeProfileV1 };

        expect(parsed.profile.overrides.light).toEqual({});
        expect(parsed.profile.overrides.dark['background.canvas']).toBe('#08080A');
        expect(parsed.profile.overrides.dark['surface.base']).toBeDefined();
        expect(parsed.profile.overrides.dark['text.primary']).toBeDefined();
        expect(Object.keys(parsed.profile.overrides.dark).sort()).toEqual([...THEME_PROFILE_PUBLIC_TOKEN_IDS].sort());
    });

    it('imports valid exported JSON', () => {
        const exported = exportThemeProfileToJson({
            ...profileWithDarkAssets,
            overrides: { light: { 'background.canvas': '#fafafa' }, dark: {} },
        });

        const result = importThemeProfileFromJson(exported, { now: '2026-05-12T00:00:00.000Z' });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.profile.name).toBe('Ocean Terminal');
            expect(result.profile.overrides.light).toEqual({ 'background.canvas': '#fafafa' });
            expect((result.profile as ThemeProfileV1 & { assetAppearance?: string }).assetAppearance).toBe('dark');
            expect(result.warnings).toEqual([]);
        }
    });

    it('rejects malformed and unsupported JSON', () => {
        expect(importThemeProfileFromJson('{not json}', { now: '2026-05-12T00:00:00.000Z' }).ok).toBe(false);
        expect(importThemeProfileFromJson('{"kind":"other","schemaVersion":1}', { now: '2026-05-12T00:00:00.000Z' }).ok).toBe(false);
        expect(importThemeProfileFromJson('{"kind":"happier.themeProfile","schemaVersion":2}', { now: '2026-05-12T00:00:00.000Z' }).ok).toBe(false);
        expect(importThemeProfileFromJson('{"name":"Not a theme","type":"dark"}', { now: '2026-05-12T00:00:00.000Z' }).ok).toBe(false);
    });

    it('imports supported VS Code theme JSONC payloads with comments and trailing commas', () => {
        const result = importThemeProfileFromJson(`{
            "name": "Tokyo Night",
            "type": "dark",
            "colors": {
                "editor.background": "#1a1b26",
                "editor.foreground": "#a9b1d6",
                // VS Code theme files commonly include comments
                "input.background": "#14141b",
            },
            "tokenColors": [
                { "scope": "comment", "settings": { "foreground": "#515670" } },
            ],
        }`, { now: '2026-05-12T00:00:00.000Z' });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.profile.name).toBe('Tokyo Night');
            expect(result.profile.assetAppearance).toBe('dark');
            expect(result.profile.overrides.dark['background.canvas']).toBe('#1a1b26');
            expect(result.profile.overrides.dark['text.primary']).toBe('#a9b1d6');
            expect(result.profile.overrides.dark['control.input.background']).toBe('#14141b');
            expect(result.profile.overrides.dark['syntax.comment']).toBe('#515670');
        }
    });

    it('auto-detects and imports a supported VS Code theme JSON payload', () => {
        const json = JSON.stringify({
            name: 'Pitch Dark',
            type: 'dark',
            colors: {
                'editor.background': '#191724',
                'editor.foreground': '#E0DEF4',
                'activityBar.background': '#191724',
                'titleBar.activeBackground': '#191724',
                'panel.background': '#1F1D2E',
                'input.background': '#393552',
                'input.foreground': '#E0DEF4',
                'button.background': '#403D52',
                'button.foreground': '#E0DEF4',
            },
            tokenColors: [
                { scope: 'comment', settings: { foreground: '#6E6A86' } },
                { scope: 'string', settings: { foreground: '#9CCFD8' } },
                { scope: 'keyword', settings: { foreground: '#C4A7E7' } },
                { scope: 'constant.numeric', settings: { foreground: '#F6C177' } },
                { scope: 'entity.name.function', settings: { foreground: '#EBBCBA' } },
            ],
        });

        const result = importThemeProfileFromJson(json, { now: '2026-05-12T00:00:00.000Z' });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.profile.name).toBe('Pitch Dark');
            expect(result.profile.assetAppearance).toBe('dark');
            expect(result.profile.overrides.dark['background.canvas']).toBe('#191724');
            expect(result.profile.overrides.dark['surface.base']).toBe('#1F1D2E');
            expect(result.profile.overrides.dark['control.input.background']).toBe('#393552');
            expect(result.profile.overrides.dark['effect.surfaceHighlight']).toBe('transparent');
            expect(result.profile.overrides.dark['syntax.keyword']).toBe('#C4A7E7');
            expect(result.profile.overrides.dark['syntax.comment']).toBe('#6E6A86');
        }
    });

    it('exposes the supported import formats used by the import screen', () => {
        expect(getSupportedThemeProfileImportFormats().map((format) => format.id)).toEqual([
            'happier-theme-profile-json',
            'vscode-theme-json',
        ]);
    });

    it('rejects JSON payloads over the profile import size limit', () => {
        const oversizedJson = JSON.stringify({
            kind: 'happier.themeProfile',
            schemaVersion: 1,
            profile: {
                ...profile,
                name: 'x'.repeat(THEME_PROFILE_MAX_JSON_BYTES),
                overrides: { light: {}, dark: {} },
            },
        });

        expect(importThemeProfileFromJson(oversizedJson, { now: '2026-05-12T00:00:00.000Z' })).toEqual({ ok: false, error: 'tooLarge' });
    });

    it('warns on unknown public token ids and does not keep them in runtime overrides', () => {
        const json = JSON.stringify({
            kind: 'happier.themeProfile',
            schemaVersion: 1,
            profile: {
                ...profile,
                overrides: { light: { 'unknown.token': '#111111', 'background.canvas': '#fafafa' }, dark: {} },
            },
        });

        const result = importThemeProfileFromJson(json, { now: '2026-05-12T00:00:00.000Z' });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.profile.overrides.light).toEqual({ 'background.canvas': '#fafafa' });
            expect(result.warnings).toContainEqual({ code: 'unknownToken', tokenId: 'unknown.token', mode: 'light' });
        }
    });

    it('rejects imported profiles with invalid color values', () => {
        const json = JSON.stringify({
            kind: 'happier.themeProfile',
            schemaVersion: 1,
            profile: {
                ...profile,
                overrides: { light: { 'background.canvas': 'red' }, dark: {} },
            },
        });

        const result = importThemeProfileFromJson(json, { now: '2026-05-12T00:00:00.000Z' });

        expect(result).toEqual({ ok: false, error: 'invalidProfile' });
    });

    it('rejects imported profiles with non-string color values', () => {
        const json = JSON.stringify({
            kind: 'happier.themeProfile',
            schemaVersion: 1,
            profile: {
                ...profile,
                overrides: { light: { 'background.canvas': 42 }, dark: {} },
            },
        });

        const result = importThemeProfileFromJson(json, { now: '2026-05-12T00:00:00.000Z' });

        expect(result).toEqual({ ok: false, error: 'invalidProfile' });
    });

    it('rejects imports when the profile limit is already reached', () => {
        const exported = exportThemeProfileToJson({
            ...profile,
            overrides: { light: { 'background.canvas': '#fafafa' }, dark: {} },
        });
        const existingProfileIds = new Set(
            Array.from({ length: THEME_PROFILE_MAX_PROFILES }, (_, index) => `theme_${index}`),
        );

        const result = importThemeProfileFromJson(exported, {
            existingProfileIds,
            generateId: () => 'theme_imported',
            now: '2026-05-12T00:00:00.000Z',
        });

        expect(result).toEqual({ ok: false, error: 'invalidProfile' });
    });

    it('rejects imports with too many overrides in one mode', () => {
        const overrides = Object.fromEntries(
            Array.from({ length: THEME_PROFILE_MAX_OVERRIDES_PER_MODE + 1 }, (_, index) => [`unknown.${index}`, '#ffffff']),
        );
        const json = JSON.stringify({
            kind: 'happier.themeProfile',
            schemaVersion: 1,
            profile: {
                ...profile,
                overrides: { light: overrides, dark: {} },
            },
        });

        const result = importThemeProfileFromJson(json, { now: '2026-05-12T00:00:00.000Z' });

        expect(result).toEqual({ ok: false, error: 'invalidProfile' });
    });

    it('migrates deprecated token ids on import and when parsing persisted profile overrides', () => {
        expect(migrateThemeProfileOverrideTokenIds({
            'groupped.background': '#fafafa',
            surfaceHigh: '#eeeeee',
            warningCritical: '#ff0000',
            syntaxKeyword: '#123456',
            gitAddedText: '#00ff00',
        })).toEqual({
            overrides: {
                'background.canvas': '#fafafa',
                'surface.inset': '#eeeeee',
                'state.danger.foreground': '#ff0000',
                'syntax.keyword': '#123456',
                'versionControl.added.foreground': '#00ff00',
            },
            migratedTokenIds: ['groupped.background', 'surfaceHigh', 'warningCritical', 'syntaxKeyword', 'gitAddedText'],
        });
    });

    it('keeps canonical token values when deprecated aliases collide during import', () => {
        expect(migrateThemeProfileOverrideTokenIds({
            warningCritical: '#ff0000',
            'state.danger.foreground': '#505050',
        }).overrides).toEqual({
            'state.danger.foreground': '#505050',
        });

        const json = JSON.stringify({
            kind: 'happier.themeProfile',
            schemaVersion: 1,
            profile: {
                ...profile,
                overrides: {
                    light: {
                        warningCritical: '#ff0000',
                        'state.danger.foreground': '#505050',
                    },
                    dark: {},
                },
            },
        });

        const result = importThemeProfileFromJson(json, { now: '2026-05-12T00:00:00.000Z' });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.profile.overrides.light['state.danger.foreground']).toBe('#505050');
        }
    });

    it('generates a new id on collision and trims valid imported names', () => {
        const json = JSON.stringify({ kind: 'happier.themeProfile', schemaVersion: 1, profile: { ...profile, name: '  Imported Ocean  ', overrides: { light: {}, dark: {} } } });
        const result = importThemeProfileFromJson(json, {
            existingProfileIds: new Set(['theme_ocean']),
            generateId: () => 'theme_imported',
            now: '2026-05-12T00:00:00.000Z',
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.profile.id).toBe('theme_imported');
            expect(result.profile.name).toBe('Imported Ocean');
        }
    });

    it('generates a new id when an import uses a reserved built-in preset id', () => {
        const json = JSON.stringify({
            kind: 'happier.themeProfile',
            schemaVersion: 1,
            profile: { ...profile, id: 'premiumDark', overrides: { light: {}, dark: {} } },
        });

        const result = importThemeProfileFromJson(json, {
            existingProfileIds: new Set(),
            generateId: () => 'theme_imported',
            now: '2026-05-12T00:00:00.000Z',
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.profile.id).toBe('theme_imported');
        }
    });

    it('generates a new id when an import uses a reserved base theme id', () => {
        const json = JSON.stringify({
            kind: 'happier.themeProfile',
            schemaVersion: 1,
            profile: { ...profile, id: 'light', overrides: { light: {}, dark: {} } },
        });

        const result = importThemeProfileFromJson(json, {
            existingProfileIds: new Set(),
            generateId: () => 'theme_imported',
            now: '2026-05-12T00:00:00.000Z',
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.profile.id).toBe('theme_imported');
        }
    });

    it('generates a new id when an import uses the reserved editor route id', () => {
        const json = JSON.stringify({
            kind: 'happier.themeProfile',
            schemaVersion: 1,
            profile: { ...profile, id: 'new', overrides: { light: {}, dark: {} } },
        });

        const result = importThemeProfileFromJson(json, {
            existingProfileIds: new Set(),
            generateId: () => 'theme_imported',
            now: '2026-05-12T00:00:00.000Z',
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.profile.id).toBe('theme_imported');
        }
    });

    it('generates a new id when an import uses a route-unsafe id', () => {
        const json = JSON.stringify({
            kind: 'happier.themeProfile',
            schemaVersion: 1,
            profile: { ...profile, id: '../theme/profile?bad=true', overrides: { light: {}, dark: {} } },
        });

        const result = importThemeProfileFromJson(json, {
            existingProfileIds: new Set(),
            generateId: () => 'theme_imported',
            now: '2026-05-12T00:00:00.000Z',
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.profile.id).toBe('theme_imported');
        }
    });

    it('normalizes blank imported names to the safe default name', () => {
        const json = JSON.stringify({ kind: 'happier.themeProfile', schemaVersion: 1, profile: { ...profile, name: '   ', overrides: { light: {}, dark: {} } } });

        const result = importThemeProfileFromJson(json, { now: '2026-05-12T00:00:00.000Z' });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.profile.name).toBe('Imported theme');
        }
    });

    it('rejects imported names that are too long or contain control characters', () => {
        for (const name of ['Ocean\u0000Terminal', 'x'.repeat(65)]) {
            const json = JSON.stringify({ kind: 'happier.themeProfile', schemaVersion: 1, profile: { ...profile, name, overrides: { light: {}, dark: {} } } });

            expect(importThemeProfileFromJson(json, { now: '2026-05-12T00:00:00.000Z' })).toEqual({ ok: false, error: 'invalidProfile' });
        }
    });
});
