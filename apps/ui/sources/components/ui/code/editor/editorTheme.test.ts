import { describe, expect, it } from 'vitest';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';

import { buildMonacoEditorThemeData, resolveCodeEditorTheme, resolveCodeSelectionColor } from './editorTheme';

const colors = {
    accent: { blue: '#0a84ff' },
    border: { default: 'rgba(0, 0, 0, 0.08)' },
    surface: { base: '#fafafa', inset: '#f6f8fa', elevated: '#ffffff' },
    syntax: {
        default: '#24292f', keyword: '#cf222e', string: '#0a3069',
        comment: '#6e7781', number: '#0550ae', function: '#8250df',
    },
    text: { primary: '#1c1c1e', tertiary: 'rgba(60, 60, 67, 0.6)' },
};

describe('buildMonacoEditorThemeData', () => {
    it('hands Monaco hex colors only, because it paints any other expression solid red', () => {
        const theme = buildMonacoEditorThemeData(resolveCodeEditorTheme(createThemeFixture({ dark: false, colors })));

        expect(theme.colors['editorIndentGuide.background1']).toBe('#00000014');
        expect(theme.colors['editorLineNumber.foreground']).toBe('#3c3c4399');
        for (const value of Object.values(theme.colors)) expect(value).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/u);
    });

    it('paints floating widgets (the completion list) opaque even when the page paints the editor transparent', () => {
        const editorTheme = resolveCodeEditorTheme(createThemeFixture({ dark: false, colors }), { backgroundColor: 'transparent' });

        expect(buildMonacoEditorThemeData(editorTheme).colors['editorWidget.background']).toBe('#ffffff');
    });

    it('keeps the sticky scroll header opaque over the code scrolling under it, edged by an ink hairline', () => {
        // The page paints the editor see-through (glass); Monaco would inherit that for its sticky header,
        // so the line scrolling beneath showed through the pinned one.
        const editorTheme = resolveCodeEditorTheme(createThemeFixture({ dark: false, colors }), { backgroundColor: 'rgba(255, 255, 255, 0.5)' });
        const themeColors = buildMonacoEditorThemeData(editorTheme).colors;

        expect(themeColors['editorStickyScroll.background']).toMatch(/^#[0-9a-f]{6}$/u);
        expect(themeColors['editorStickyScrollGutter.background']).toBe(themeColors['editorStickyScroll.background']);
        expect(themeColors['editorStickyScroll.shadow']).toBe('#00000000');
        expect(themeColors['editorStickyScroll.border']).toBe('#00000014');
    });

    it('paints the selection as a light wash of the focus blue, not the solid accent (ask A1)', () => {
        const editorTheme = resolveCodeEditorTheme(createThemeFixture({ dark: false, colors }));

        expect(editorTheme.selectionColor).toBe(resolveCodeSelectionColor('#0a84ff'));
        expect(buildMonacoEditorThemeData(editorTheme).colors['editor.selectionBackground']).toBe('#0a84ff1f');
    });
});
