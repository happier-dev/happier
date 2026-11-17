import { describe, expect, it } from 'vitest';
import { parseThemeProfileDocument } from '@happier-dev/protocol/account/settings/themeProfiles';
import { ArtifactCreateIdV1Schema } from '@happier-dev/protocol/artifacts/artifactIdV1';

import { THEME_PROFILE_MAX_OVERRIDES_PER_MODE } from './themeProfileConstants';
import { createThemeProfileId, exportThemeProfileToJson, getSupportedThemeProfileImportFormats, importThemeProfileFromJson, migrateThemeProfileOverrideTokenIds } from './themeProfileImportExport';
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
    it('resolves local VS Code parent resources before importing the editable copy', async () => {
        const resources = new Map([
            ['file:///themes/base.json', JSON.stringify({ colors: { 'editor.background': '#112233', 'editor.foreground': '#445566' } })],
        ]);
        const options = { now: profile.updatedAt, resource: { id: 'file:///themes/child.json',
            read: async (relativePath: string, fromResourceId: string) => {
                const id = new URL(relativePath, fromResourceId).href;
                const text = resources.get(id);
                if (text === undefined) throw new Error('File does not exist');
                return { id, text };
            },
        } };
        const result = await importThemeProfileFromJson(JSON.stringify({ include: './base.json', name: 'Child', type: 'dark',
            colors: { 'editor.foreground': '#abcdef' } }), options);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.profile.overrides.dark).toMatchObject({ 'background.canvas': '#112233', 'text.primary': '#abcdef' });
    });
    it('reports an unavailable parent instead of importing a partial VS Code theme', async () => {
        const result = await importThemeProfileFromJson(JSON.stringify({ include: './missing.json', name: 'Child', type: 'dark',
            colors: { 'editor.background': '#112233' } }), { now: profile.updatedAt });
        expect(result).toMatchObject({ ok: false, error: 'include_unavailable', relativePath: './missing.json' });
    });
    it('allocates Artifact-compatible creation ids so the editor route keeps the acknowledged identity', () => {
        expect(ArtifactCreateIdV1Schema.safeParse(createThemeProfileId()).success).toBe(true);
    });
    it('exports and imports a retained newer document without replacing its unknown presentation', async () => {
        const raw = { ...profile, schemaVersion: 2, overrides: { light: {}, dark: {} },
            style: { radius: 'future-shape', futureGlow: { strength: 0.7 } },
            futurePresentation: { material: 'ink' } };
        const read = parseThemeProfileDocument(raw);
        expect(read.ok).toBe(true);
        if (!read.ok) return;
        const exported = exportThemeProfileToJson(read.document);
        expect(JSON.parse(exported).profile).toEqual(raw);
        const imported = await importThemeProfileFromJson(exported, { now: profile.updatedAt });
        expect(imported.ok).toBe(true);
        if (imported.ok) {
            expect(imported.document.raw).toEqual({ ...raw, id: imported.profile.id });
            expect(imported.profile.id).not.toBe(raw.id);
            expect(imported.document.compatibility.status).toBe('partial');
        }
    });
    it('adds resolved colours to an export without losing a newer document presentation', () => {
        const raw = { ...profile, schemaVersion: 2, overrides: { light: {}, dark: { 'background.canvas': '#08080A', 'future.ink': '#abcdef' } },
            style: { radius: 'future-shape', futureGlow: { strength: 0.7 } },
            futurePresentation: { material: 'ink' } };
        const read = parseThemeProfileDocument(raw);
        expect(read.ok).toBe(true);
        if (!read.ok) return;
        const exported = JSON.parse(exportThemeProfileToJson(read.document, { mode: 'dark', includeResolvedValues: true }));
        expect(exported.profile).toMatchObject(raw);
        expect(exported.profile.overrides.dark['surface.base']).toBeDefined();
        expect(exported.profile.overrides.dark['text.primary']).toBeDefined();
        expect(exported.profile.overrides.light).toEqual({});
    });
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

    it('imports valid exported JSON', async () => {
        const exported = exportThemeProfileToJson({
            ...profileWithDarkAssets,
            overrides: { light: { 'background.canvas': '#fafafa' }, dark: {} },
        });

        const result = await importThemeProfileFromJson(exported, { now: '2026-05-12T00:00:00.000Z' });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.profile.name).toBe('Ocean Terminal');
            expect(result.profile.overrides.light).toEqual({ 'background.canvas': '#fafafa' });
            expect((result.profile as ThemeProfileV1 & { assetAppearance?: string }).assetAppearance).toBe('dark');
            expect(result.warnings).toEqual([]);
        }
    });

    it('rejects malformed and unsupported JSON', async () => {
        expect((await importThemeProfileFromJson('{not json}', { now: '2026-05-12T00:00:00.000Z' })).ok).toBe(false);
        expect((await importThemeProfileFromJson('{"kind":"other","schemaVersion":1}', { now: '2026-05-12T00:00:00.000Z' })).ok).toBe(false);
        expect((await importThemeProfileFromJson('{"kind":"happier.themeProfile","schemaVersion":2}', { now: '2026-05-12T00:00:00.000Z' })).ok).toBe(false);
        expect((await importThemeProfileFromJson('{"name":"Not a theme","type":"dark"}', { now: '2026-05-12T00:00:00.000Z' })).ok).toBe(false);
    });

    it('imports supported VS Code theme JSONC payloads with comments and trailing commas', async () => {
        const result = await importThemeProfileFromJson(`{
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

    it('auto-detects and imports a supported VS Code theme JSON payload', async () => {
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

        const result = await importThemeProfileFromJson(json, { now: '2026-05-12T00:00:00.000Z' });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.profile.name).toBe('Pitch Dark');
            expect(result.profile.assetAppearance).toBe('dark');
            expect(result.profile.overrides.dark['background.canvas']).toBe('#191724');
            expect(result.profile.overrides.dark['surface.base']).toBe('#1F1D2E');
            expect(result.profile.overrides.dark['composer.chipTint']).toBe('#6E6A86');
            expect(result.profile.overrides.dark['control.input.background']).toBe('#393552');
            // No edge-ink override: an imported theme lights its edges with its own text ink.
            expect(result.profile.overrides.dark['effect.surfaceHighlight']).toBeUndefined();
            expect(result.profile.overrides.dark['syntax.keyword']).toBe('#C4A7E7');
            expect(result.profile.overrides.dark['syntax.comment']).toBe('#6E6A86');
        }
    });

    it('paints imported messages with the theme neutral surface and text, not its accent button', async () => {
        const json = JSON.stringify({
            name: 'Harbor Light',
            type: 'light',
            colors: {
                'editor.background': '#FFFFFF',
                'editor.foreground': '#24292F',
                'editorWidget.background': '#EEF1F4',
                'button.background': '#1F6FEB',
                'button.foreground': '#FFFFFF',
            },
        });

        const result = await importThemeProfileFromJson(json, { now: '2026-10-23T00:00:00.000Z' });

        expect(result.ok).toBe(true);
        if (result.ok) {
            const light = result.profile.overrides.light;
            // The person's prompt reads as the theme's neutral raised surface with its own body ink;
            // the accent button (white on blue) stays a button.
            expect(light['message.user.background']).toBe(light['surface.elevated']);
            expect(light['message.user.foreground']).toBe(light['text.primary']);
            expect(light['message.agent.foreground']).toBe(light['text.primary']);
            expect(light['control.button.primary.background']).toBe('#1F6FEB');
        }
    });

    it('exposes the supported import formats used by the import screen', () => {
        expect(getSupportedThemeProfileImportFormats().map((format) => format.id)).toEqual([
            'happier-theme-profile-json',
            'vscode-theme-json',
        ]);
    });


    it('warns on unknown public token ids and does not keep them in runtime overrides', async () => {
        const json = JSON.stringify({
            kind: 'happier.themeProfile',
            schemaVersion: 1,
            profile: {
                ...profile,
                overrides: { light: { 'unknown.token': '#111111', 'background.canvas': '#fafafa' }, dark: {} },
            },
        });

        const result = await importThemeProfileFromJson(json, { now: '2026-05-12T00:00:00.000Z' });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.profile.overrides.light).toEqual({ 'background.canvas': '#fafafa' });
            expect(result.warnings).toContainEqual({ code: 'unknownToken', tokenId: 'unknown.token', mode: 'light' });
        }
    });

    it('rejects imported profiles with invalid color values', async () => {
        const json = JSON.stringify({
            kind: 'happier.themeProfile',
            schemaVersion: 1,
            profile: {
                ...profile,
                overrides: { light: { 'background.canvas': 'red' }, dark: {} },
            },
        });

        const result = await importThemeProfileFromJson(json, { now: '2026-05-12T00:00:00.000Z' });

        expect(result).toEqual({ ok: false, error: 'invalidProfile' });
    });

    it('rejects imported profiles with non-string color values', async () => {
        const json = JSON.stringify({
            kind: 'happier.themeProfile',
            schemaVersion: 1,
            profile: {
                ...profile,
                overrides: { light: { 'background.canvas': 42 }, dark: {} },
            },
        });

        const result = await importThemeProfileFromJson(json, { now: '2026-05-12T00:00:00.000Z' });

        expect(result).toEqual({ ok: false, error: 'invalidProfile' });
    });


    it('rejects imports with too many overrides in one mode', async () => {
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

        const result = await importThemeProfileFromJson(json, { now: '2026-05-12T00:00:00.000Z' });

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

    it('keeps canonical token values when deprecated aliases collide during import', async () => {
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

        const result = await importThemeProfileFromJson(json, { now: '2026-05-12T00:00:00.000Z' });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.profile.overrides.light['state.danger.foreground']).toBe('#505050');
        }
    });

    it('creates a fresh copy identity without acquiring existing profiles and trims imported names', async () => {
        const json = JSON.stringify({ kind: 'happier.themeProfile', schemaVersion: 1, profile: { ...profile, name: '  Imported Ocean  ', overrides: { light: {}, dark: {} } } });
        const result = await importThemeProfileFromJson(json, {
            generateId: () => 'theme_imported',
            now: '2026-05-12T00:00:00.000Z',
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.profile.id).toBe('theme_imported');
            expect(result.profile.name).toBe('Imported Ocean');
        }
    });

    it('generates a new id when an import uses a reserved built-in preset id', async () => {
        const json = JSON.stringify({
            kind: 'happier.themeProfile',
            schemaVersion: 1,
            profile: { ...profile, id: 'premiumDark', overrides: { light: {}, dark: {} } },
        });

        const result = await importThemeProfileFromJson(json, {
            generateId: () => 'theme_imported',
            now: '2026-05-12T00:00:00.000Z',
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.profile.id).toBe('theme_imported');
        }
    });

    it('generates a new id when an import uses a reserved base theme id', async () => {
        const json = JSON.stringify({
            kind: 'happier.themeProfile',
            schemaVersion: 1,
            profile: { ...profile, id: 'light', overrides: { light: {}, dark: {} } },
        });

        const result = await importThemeProfileFromJson(json, {
            generateId: () => 'theme_imported',
            now: '2026-05-12T00:00:00.000Z',
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.profile.id).toBe('theme_imported');
        }
    });

    it('generates a new id when an import uses the reserved editor route id', async () => {
        const json = JSON.stringify({
            kind: 'happier.themeProfile',
            schemaVersion: 1,
            profile: { ...profile, id: 'new', overrides: { light: {}, dark: {} } },
        });

        const result = await importThemeProfileFromJson(json, {
            generateId: () => 'theme_imported',
            now: '2026-05-12T00:00:00.000Z',
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.profile.id).toBe('theme_imported');
        }
    });

    it('generates a new id when an import uses a route-unsafe id', async () => {
        const json = JSON.stringify({
            kind: 'happier.themeProfile',
            schemaVersion: 1,
            profile: { ...profile, id: '../theme/profile?bad=true', overrides: { light: {}, dark: {} } },
        });

        const result = await importThemeProfileFromJson(json, {
            generateId: () => 'theme_imported',
            now: '2026-05-12T00:00:00.000Z',
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.profile.id).toBe('theme_imported');
        }
    });

    it('normalizes blank imported names to the safe default name', async () => {
        const json = JSON.stringify({ kind: 'happier.themeProfile', schemaVersion: 1, profile: { ...profile, name: '   ', overrides: { light: {}, dark: {} } } });

        const result = await importThemeProfileFromJson(json, { now: '2026-05-12T00:00:00.000Z' });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.profile.name).toBe('Imported theme');
        }
    });

    it('rejects imported names that are too long or contain control characters', async () => {
        for (const name of ['Ocean\u0000Terminal', 'x'.repeat(65)]) {
            const json = JSON.stringify({ kind: 'happier.themeProfile', schemaVersion: 1, profile: { ...profile, name, overrides: { light: {}, dark: {} } } });

            expect(await importThemeProfileFromJson(json, { now: '2026-05-12T00:00:00.000Z' })).toEqual({ ok: false, error: 'invalidProfile' });
        }
    });
});


describe('portable presentation retention', () => {
    it('round trips CSS, seeds, corners, typeface and future presentation', async () => {
        const portable = { ...profile, overrides: { light: {}, dark: {} }, seeds: { canvas: '#112233', accent: '#abcdef' },
            style: { radius: 'round', fontFamily: 'Inter', futureGlow: true }, css: '[data-surface="card"]{opacity:.9}',
            futurePresentation: { blur: 3 } };
        const exported = JSON.parse(exportThemeProfileToJson(portable));
        expect(exported.profile).toMatchObject(portable);
        const imported = await importThemeProfileFromJson(JSON.stringify(exported), { now: portable.updatedAt });
        expect(imported.ok).toBe(true);
        if (imported.ok) {
            expect(imported.document.raw).toMatchObject({ ...portable, id: imported.profile.id });
            expect(imported.profile.id).not.toBe(portable.id);
        }
    });
});


describe('Artifact-owned theme capacity', () => {
    it('imports a CSS-rich profile beyond former settings import limits', async () => {
        const portable = { ...profile, overrides: { light: {}, dark: {} }, css: '.card{color:red}\n'.repeat(5000) };
        const result = await importThemeProfileFromJson(JSON.stringify({ kind: 'happier.themeProfile', schemaVersion: 1, profile: portable }),
            { now: portable.updatedAt });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.profile.css).toBe(portable.css);
    });
});
