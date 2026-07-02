import { describe, expect, it } from 'vitest';

import {
    resolveMarkdownEditorTheme,
    type MarkdownEditorTheme,
} from './markdownEditorTheme';
import type { TiptapWebViewTheme } from './bridge/tiptapWebViewHtml';

/**
 * A minimal live-theme fixture shaped like the slice `resolveMarkdownEditorTheme`
 * reads (the real Unistyles theme carries much more).
 */
function makeThemeFixture(overrides?: { dark?: boolean }) {
    return {
        dark: overrides?.dark ?? true,
        colors: {
            surface: { inset: '#111111', elevated: '#222222' },
            text: { primary: '#eeeeee', secondary: '#aaaaaa', link: '#58a6ff' },
            border: { default: '#303030' },
            state: { active: { background: '#0a84ff33', foreground: '#0a84ff' } },
        },
    };
}

describe('resolveMarkdownEditorTheme', () => {
    it('maps Unistyles theme tokens to the shared prose token set', () => {
        const resolved = resolveMarkdownEditorTheme(makeThemeFixture());

        expect(resolved).toEqual({
            isDark: true,
            backgroundColor: '#111111',
            textColor: '#eeeeee',
            secondaryTextColor: '#aaaaaa',
            dividerColor: '#303030',
            selectionBackgroundColor: '#0a84ff33',
            selectionAccentColor: '#0a84ff',
            linkColor: '#58a6ff',
            codeBackgroundColor: '#222222',
        });
    });

    it('reflects the dark flag from the theme', () => {
        expect(resolveMarkdownEditorTheme(makeThemeFixture({ dark: false })).isDark).toBe(false);
        expect(resolveMarkdownEditorTheme(makeThemeFixture({ dark: true })).isDark).toBe(true);
    });

    it('coerces a missing dark flag to false', () => {
        const theme = makeThemeFixture();
        delete (theme as { dark?: boolean }).dark;

        expect(resolveMarkdownEditorTheme(theme).isDark).toBe(false);
    });

    it('produces a value assignable to the native WebView theme contract', () => {
        // The native surface hands the resolver's output straight to
        // buildTiptapWebViewHtml({ theme }). If the shapes diverge this stops
        // compiling, catching the drift F10 is meant to prevent.
        const resolved: MarkdownEditorTheme = resolveMarkdownEditorTheme(makeThemeFixture());
        const asWebViewTheme: TiptapWebViewTheme = resolved;

        expect(asWebViewTheme.backgroundColor).toBe('#111111');
    });
});
