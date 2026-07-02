/**
 * Shared prose stylesheet for the rich markdown editor (web + native WebView).
 *
 * The rich editor renders a real `.ProseMirror` contenteditable (DOM on web, DOM
 * inside the WebView on native). Without explicit CSS it inherits the document's
 * default font (e.g. `Times`) and browser-default heading/code styling + the
 * default focus outline — which does NOT match the app's markdown rendering.
 *
 * This builder emits a CSS string that mirrors `buildEnrichedMarkdownStyle`
 * (the SAME spec `MarkdownView` uses): base 16px body scaled by `uiFontScale`,
 * headings at 1.5 / 1.25 / 1.125x in the semibold UI face, inline code at 0.88x
 * in the mono face, proportional heading line-heights, and the same block
 * spacing. Font families are INJECTED by the caller (the web surface passes the
 * app web fonts; the native WebView passes system fonts it can actually resolve),
 * so this module stays pure (no `@tiptap/*`, no Platform branching) and is safe
 * to import from the native graph (R18).
 *
 * Keep the multipliers/spacing in sync with `buildEnrichedMarkdownStyle` in
 * `components/markdown/enriched/useEnrichedMarkdownStyle.ts` — that is the source
 * of truth for how the app renders markdown.
 */

export type MarkdownProseFonts = Readonly<{
    /** Body / paragraph / list face. */
    body: string;
    /** Heading + strong face (semibold). */
    heading: string;
    /** Inline code + code-block face (monospace). */
    mono: string;
}>;

export type MarkdownProseColors = Readonly<{
    /** Primary text (`theme.colors.text.primary`). */
    text: string;
    /** Secondary text — blockquote (`theme.colors.text.secondary`). */
    secondaryText: string;
    /** Link color (`theme.colors.text.link`). */
    link: string;
    /** Inline-code background (`theme.colors.surface.selected`). */
    inlineCodeBackground: string;
    /** Code-block background (`theme.colors.surface.elevated`). */
    codeBlockBackground: string;
    /** Dividers: code-block border, blockquote rule, hr (`theme.colors.border.default`). */
    divider: string;
}>;

export type MarkdownProseStyleInput = Readonly<{
    fonts: MarkdownProseFonts;
    colors: MarkdownProseColors;
    /** In-app font scale (`localSettings.uiFontScale`); defaults to 1. */
    uiFontScale?: number;
}>;

/** Semibold weight for the app default face (`Typography.FontWeights.semiBold`). */
const SEMIBOLD_WEIGHT = 500;

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

/**
 * Builds the prose CSS, scoped to `scopeSelector` (e.g. `.happier-md-prose` on
 * web, `.ProseMirror` in the native WebView). All rules are prefixed so the
 * stylesheet is reusable and never leaks to other content.
 */
export function buildMarkdownProseCss(scopeSelector: string, input: MarkdownProseStyleInput): string {
    const scale = typeof input.uiFontScale === 'number' && Number.isFinite(input.uiFontScale) && input.uiFontScale > 0
        ? input.uiFontScale
        : 1;
    const { fonts, colors } = input;

    // Mirrors buildEnrichedMarkdownStyle: base 16 / lineHeight 24, scaled.
    const base = round2(16 * scale);
    const baseLh = round2(24 * scale);
    const inlineCode = round2(base * 0.88);
    const codeBlock = round2(14 * scale);
    const codeBlockLh = round2(20 * scale);
    const h1 = round2(base * 1.5);
    const h2 = round2(base * 1.25);
    const h3 = round2(base * 1.125);
    const h6 = round2(base * 0.875);
    const h1Lh = Math.max(baseLh, round2(h1 * 1.3));
    const h2Lh = Math.max(baseLh, round2(h2 * 1.35));
    const h3Lh = Math.max(baseLh, round2(h3 * 1.4));
    const h6Lh = Math.max(round2(baseLh * 0.875), round2(h6 * 1.4));
    const listIndent = round2(28 * scale);

    const s = scopeSelector;
    return [
        `${s} { font-family: ${fonts.body}; font-size: ${base}px; line-height: ${baseLh}px; color: ${colors.text}; }`,
        // Kill the browser's default focus ring on the contenteditable (web).
        `${s}:focus, ${s}:focus-visible { outline: none; }`,
        `${s} p { margin: 0 0 8px; }`,
        `${s} h1, ${s} h2, ${s} h3, ${s} h4, ${s} h5, ${s} h6 { font-family: ${fonts.heading}; font-weight: ${SEMIBOLD_WEIGHT}; color: ${colors.text}; }`,
        `${s} h1 { font-size: ${h1}px; line-height: ${h1Lh}px; margin: 18px 0 10px; }`,
        `${s} h2 { font-size: ${h2}px; line-height: ${h2Lh}px; margin: 16px 0 8px; }`,
        `${s} h3 { font-size: ${h3}px; line-height: ${h3Lh}px; margin: 14px 0 8px; }`,
        `${s} h4, ${s} h5 { font-size: ${base}px; line-height: ${baseLh}px; margin: 10px 0 6px; }`,
        `${s} h6 { font-size: ${h6}px; line-height: ${h6Lh}px; margin: 8px 0 6px; }`,
        `${s} strong { font-family: ${fonts.heading}; font-weight: ${SEMIBOLD_WEIGHT}; }`,
        `${s} em { font-style: italic; }`,
        `${s} a { color: ${colors.link}; text-decoration: underline; }`,
        `${s} ul, ${s} ol { margin: 0 0 8px; padding-left: ${listIndent}px; }`,
        `${s} li { margin: 0 0 2px; }`,
        `${s} code { font-family: ${fonts.mono}; font-size: ${inlineCode}px; background: ${colors.inlineCodeBackground}; color: ${colors.text}; border-radius: 4px; padding: 1px 4px; }`,
        `${s} pre { background: ${colors.codeBlockBackground}; border: 1px solid ${colors.divider}; border-radius: 8px; padding: 12px; overflow-x: auto; }`,
        `${s} pre code { font-family: ${fonts.mono}; font-size: ${codeBlock}px; line-height: ${codeBlockLh}px; background: transparent; padding: 0; border-radius: 0; }`,
        `${s} blockquote { color: ${colors.secondaryText}; border-left: 2px solid ${colors.divider}; margin: 0 0 8px; padding-left: 10px; }`,
        `${s} hr { border: none; border-top: 1px solid ${colors.divider}; margin: 8px 0; }`,
        `${s} ul[data-type="taskList"] { list-style: none; padding-left: 0; }`,
        `${s} ul[data-type="taskList"] li { display: flex; align-items: flex-start; gap: 6px; }`,
        `${s} ul[data-type="taskList"] li > label { margin-top: 3px; }`,
    ].join('\n');
}
