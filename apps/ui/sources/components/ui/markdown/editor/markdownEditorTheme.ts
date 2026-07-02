/**
 * Shared prose/editor theme resolver for the unified `MarkdownEditor` (Lane F / F10).
 *
 * Both editing surfaces — the web `@tiptap/react` surface and the native
 * TipTap-in-WebView surface — need the SAME normalized prose token set
 * (background/text/links/code/selection). Before this module each surface
 * inlined its own `useUnistyles()` → token mapping, which drifts. This is the
 * single source of truth: pass the live Unistyles theme, get back the prose
 * tokens both surfaces consume.
 *
 * The returned shape is exactly `TiptapWebViewTheme` (the contract the native
 * `buildTiptapWebViewHtml` already consumes) plus an `isDark` flag, so the native
 * surface can hand the result straight to the HTML builder and the web surface can
 * read individual tokens.
 *
 * R18: this module is PURE TS (no `@tiptap/*` import) so it is safe to import from
 * the native graph. It echoes `code/editor/editorTheme.ts` in spirit.
 */

/**
 * Normalized prose tokens shared by both markdown editor surfaces.
 *
 * `MarkdownEditorTheme` is intentionally identical in shape to the WebView HTML
 * builder's `TiptapWebViewTheme` (the native surface assigns one to the other
 * directly). It is declared here — rather than imported from `bridge/` — so this
 * pure module never pulls the bridge (and its generated bundle string) into a
 * consumer that does not need it; the bridge's `TiptapWebViewTheme` is structurally
 * assignable to this type.
 */
export type MarkdownEditorTheme = Readonly<{
    /** Whether the active app theme is dark (drives in-WebView affordances). */
    isDark: boolean;
    /** Editor surface background — matches the raw editor (`surface.inset`). */
    backgroundColor: string;
    /** Primary prose text + caret color. */
    textColor: string;
    /** Muted text (blockquotes, secondary chrome). */
    secondaryTextColor: string;
    /** Borders, blockquote rule, horizontal rule. */
    dividerColor: string;
    /** Selection highlight background. */
    selectionBackgroundColor: string;
    /** Selection accent / focus foreground. */
    selectionAccentColor: string;
    /** Link text color. */
    linkColor: string;
    /** Inline-code + code-block background. */
    codeBackgroundColor: string;
}>;

/**
 * Minimal structural view of the Unistyles theme this resolver reads. Kept loose
 * (the live theme carries far more) but typed enough to catch a missing token.
 */
type MarkdownEditorThemeInput = {
    dark?: boolean;
    colors: {
        surface: { inset: string; elevated: string };
        text: { primary: string; secondary: string; link: string };
        border: { default: string };
        state: { active: { background: string; foreground: string } };
    };
};

/**
 * Resolves the shared prose tokens from a live Unistyles theme.
 *
 * Both surfaces call this with `useUnistyles().theme` so their token mapping can
 * never drift apart (F10). The native surface passes the result straight to
 * `buildTiptapWebViewHtml({ theme })`; the web surface reads the individual tokens
 * for its `EditorContent` styling.
 */
export function resolveMarkdownEditorTheme(theme: MarkdownEditorThemeInput): MarkdownEditorTheme {
    const colors = theme.colors;
    return {
        isDark: Boolean(theme.dark),
        backgroundColor: colors.surface.inset,
        textColor: colors.text.primary,
        secondaryTextColor: colors.text.secondary,
        dividerColor: colors.border.default,
        selectionBackgroundColor: colors.state.active.background,
        selectionAccentColor: colors.state.active.foreground,
        linkColor: colors.text.link,
        codeBackgroundColor: colors.surface.elevated,
    };
}
