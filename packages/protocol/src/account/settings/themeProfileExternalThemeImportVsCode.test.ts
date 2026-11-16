import { describe, expect, it } from 'vitest';
import {
    VS_CODE_THEME_IMPORT_ADAPTER,
    parseThemeImportJsonLikeText,
    resolveVsCodeThemeIncludes,
} from './themeProfileExternalThemeImportVsCode.js';

const map = (theme: Record<string, unknown>) => VS_CODE_THEME_IMPORT_ADAPTER.parse(theme, { now: '2026-11-16T00:00:00Z' });

describe('portable VS Code theme import', () => {
    it('keeps child workbench, token and semantic precedence after parent resolution', async () => {
        const reads: string[] = [];
        const resolved = await resolveVsCodeThemeIncludes({
            root: { id: 'child.json', text: JSON.stringify({ include: './parent.json', name: 'Child', type: 'light', colors: { 'editor.findMatchBackground': '#AABBCC80' }, tokenColors: [], semanticTokenColors: { function: '#445566' } }) },
            read: async (path, from) => {
                reads.push(`${from}:${path}`);
                return { id: 'parent.json', text: `{
                    // Includes accept the same JSON-like format as paste.
                    "name": "Parent", "type": "dark",
                    "colors": {"sideBar.background":"#112233", "editor.findMatchBackground":"#AABB00"},
                    "tokenColors": [{"scope":"comment", "settings":{"foreground":"#ABCDEF"}}],
                    "semanticTokenColors": {"function":"#FF0000", "number":"#998877"},
                }` };
            },
        });
        expect(reads).toEqual(['child.json:./parent.json']);
        expect(resolved).toMatchObject({ name: 'Child', type: 'light', tokenColors: [], colors: { 'sideBar.background': '#112233', 'editor.findMatchBackground': '#AABBCC80' }, semanticTokenColors: { function: '#445566', number: '#998877' } });
        const profile = map(resolved);
        expect(profile?.overrides.light).toMatchObject({ 'surface.base': '#112233', 'find.matchCurrent': '#AABBCC80', 'syntax.function': '#445566', 'syntax.number': '#998877' });
        expect(profile?.overrides.light['syntax.comment']).toBeUndefined();
    });

    it('inherits token colors and reads each file in a valid include chain once', async () => {
        const reads: string[] = [];
        const files: Record<string, string> = {
            'parent.json': '{"include":"base.json","colors":{"sideBar.background":"#222222"}}',
            'base.json': '{"type":"dark","tokenColors":[{"scope":"comment","settings":{"foreground":"#334455"}}]}',
        };
        const theme = await resolveVsCodeThemeIncludes({
            root: { id: 'root.json', text: '{"include":"parent.json"}' },
            read: async (path) => { reads.push(path); return { id: path, text: files[path] }; },
        });
        expect(reads).toEqual(['parent.json', 'base.json']);
        expect(map(theme)?.overrides.dark['syntax.comment']).toBe('#334455');
    });

    it('reports unavailable includes with the resource and original cause', async () => {
        const cause = Object.assign(new Error('File missing'), { code: 'ENOENT' });
        await expect(resolveVsCodeThemeIncludes({
            root: { id: 'root.json', text: '{"include":"missing.json"}' },
            read: async () => { throw cause; },
        })).rejects.toMatchObject({ code: 'include_unavailable', resourceId: 'root.json', relativePath: 'missing.json', cause });
    });

    it('settles normalized-identity include cycles as an import issue', async () => {
        await expect(resolveVsCodeThemeIncludes({
            root: { id: 'root.json', text: '{"include":"./alias.json"}' },
            read: async () => ({ id: 'root.json', text: '{}' }),
        })).rejects.toMatchObject({ code: 'include_cycle', resourceId: 'root.json', relativePath: './alias.json' });
    });

    it('preserves cancellation through read and subsequent parsing boundaries', async () => {
        const controller = new AbortController();
        const reason = new Error('Import cancelled');
        await expect(resolveVsCodeThemeIncludes({
            root: { id: 'root.json', text: '{"include":"parent.json"}' },
            signal: controller.signal,
            read: async (_path, _from, signal) => { expect(signal).toBe(controller.signal); controller.abort(reason); return { id: 'parent.json', text: '{}' }; },
        })).rejects.toBe(reason);
    });

    it('rejects invalid included documents instead of importing a partial theme', async () => {
        await expect(resolveVsCodeThemeIncludes({ root: { id: 'root.json', text: '{"include":"parent.json"}' }, read: async () => ({ id: 'parent.json', text: '[]' }) })).rejects.toMatchObject({ code: 'invalid_theme', resourceId: 'parent.json' });
    });

    it('maps distinct workbench roles and preserves neutral message surfaces', () => {
        const profile = map({ type: 'dark', colors: {
            'editor.background': '#101112', 'sideBar.background': '#202122', 'sideBar.foreground': '#303132', 'sideBar.border': '#404142',
            'editorPane.background': '#505152', 'quickInput.background': '#606162', 'textCodeBlock.background': '#707172',
            'button.background': '#808182', 'editor.selectionBackground': '#90919280', 'editor.findMatchBackground': '#A0A1A280',
            'editor.findMatchForeground': '#B0B1B2', 'editor.findMatchHighlightBackground': '#C0C1C280',
            'editorError.foreground': '#D0D1D2', 'editorWarning.foreground': '#E0E1E2',
            'badge.background': '#F0F1F2', 'badge.foreground': '#010203',
        } });
        expect(profile?.overrides.dark).toMatchObject({
            'background.canvas': '#101112', 'surface.base': '#202122', 'text.secondary': '#303132', 'border.surface': '#404142',
            'surface.inset': '#707172', 'surface.elevated': '#606162', 'surface.selected': '#90919280',
            'control.button.primary.background': '#808182', 'find.matchCurrent': '#A0A1A280', 'find.matchCurrentForeground': '#B0B1B2',
            'find.matchAll': '#C0C1C280', 'state.danger.foreground': '#D0D1D2', 'state.warning.foreground': '#E0E1E2',
            'message.user.background': '#606162', 'state.active.background': '#F0F1F2', 'state.active.foreground': '#010203',
        });
    });

    it('keeps a usable selection surface when the external selection fill is invisible', () => {
        const profile = map({ colors: { 'editor.background': '#112233', 'editor.selectionBackground': '#44556600' } });
        expect(profile?.overrides.dark['surface.selected']).toBe('#112233');
    });

    it('parses JSON-like documents without rewriting commas inside string values', () => {
        expect(parseThemeImportJsonLikeText('{/* note */"name":"Comma,}","colors":{},}')).toEqual({ name: 'Comma,}', colors: {} });
    });
});
