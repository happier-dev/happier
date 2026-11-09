import type { Theme } from '@/theme';
import { parseThemeColor } from '@/theme/parseThemeColor';

export type CodeEditorSyntaxTheme = Readonly<{
    defaultColor: string;
    keywordColor: string;
    stringColor: string;
    commentColor: string;
    numberColor: string;
    functionColor: string;
}>;

export type CodeEditorTheme = Readonly<{
    monacoThemeName: 'happier-editor-light' | 'happier-editor-dark';
    isDark: boolean;
    backgroundColor: string;
    /** Floating engine widgets (the completion list, find) sit over code, so they are an opaque surface even when the page paints transparent. */
    widgetBackgroundColor: string;
    /** Monaco's sticky scroll header pins lines over the code scrolling beneath it: the editor's paint made opaque. */
    stickyBackgroundColor: string;
    textColor: string;
    dividerColor: string;
    lineNumberColor: string;
    activeLineColor: string;
    selectionColor: string;
    findMatchColor?: string;
    findCurrentMatchColor?: string;
    findCurrentMatchForeground?: string;
    /** The change gutter (P4-R9): added/modified bars in the diff add colour, the deletion wedge in ink. */
    changeAddedColor: string;
    changeDeletedColor: string;
    /** Problem squiggles (P7): rose for errors, amber for warnings; information and hints draw nothing. */
    diagnosticErrorColor?: string;
    diagnosticWarningColor?: string;
    /** A predicted next edit (P7-R33) in the same inline word marks as Replace and the diffs. */
    nextEdit?: Readonly<{ removedBackground: string; removedForeground: string; addedBackground: string; addedForeground: string; hintColor: string }>;
    syntax: CodeEditorSyntaxTheme;
}>;

type MonacoThemeData = Readonly<{
    base: 'vs' | 'vs-dark';
    inherit: true;
    rules: ReadonlyArray<Readonly<{ token: string; foreground: string }>>;
    colors: Readonly<Record<string, string>>;
}>;

type CodeEditorThemeSource = Readonly<{
    dark: boolean;
    colors: Pick<
        Theme['colors'],
        | 'accent'
        | 'border'
        | 'diff'
        | 'surface'
        | 'syntax'
        | 'text'
    > & Partial<Pick<Theme['colors'], 'find' | 'state'>>;
}>;

/** Share of the focus blue in the current-line fill. */
const ACTIVE_LINE_TINT = 0.07;
/** Share of the focus blue in a selection: a light wash with ink text, never the browser's solid highlight (ade-shell ask A1). */
const SELECTION_TINT = 0.12;

/** The current-line band (the caret's line in the editor, a landed line in the read view): a breath of the focus blue. */
export function resolveCodeActiveLineColor(accentBlue: string): string | null {
    return parseThemeColor(accentBlue)?.alpha(ACTIVE_LINE_TINT).rgb().string() ?? null;
}

/** The one code selection colour, shared by the read view, Monaco and CodeMirror. */
export function resolveCodeSelectionColor(accentBlue: string): string {
    return parseThemeColor(accentBlue)?.alpha(SELECTION_TINT).rgb().string() ?? accentBlue;
}

const AGENT_WASH_TINT = { light: 0.04, dark: 0.06 } as const;

/**
 * The block an agent is writing now (P5 Track, lab tr T1): a breath of ink, never a hue, so it reads as presence
 * rather than as a change. The read view, the diff and the editor overlay share it.
 */
export function resolveAgentWashColor(theme: Readonly<{ dark?: boolean; colors: Readonly<{ text: Readonly<{ primary: string }> }> }>): string {
    const ink = theme.colors.text.primary;
    return parseThemeColor(ink)?.alpha(theme.dark ? AGENT_WASH_TINT.dark : AGENT_WASH_TINT.light).rgb().string() ?? ink;
}

function withoutHash(value: string): string {
    return value.startsWith('#') ? value.slice(1) : value;
}

/** A see-through paint (the glass page) as it reads over the page surface beneath it, made opaque. */
function opaqueOver(color: string, below: string): string {
    const top = parseThemeColor(color);
    const base = parseThemeColor(below);
    if (!top || !base) return below;
    return top.alpha() >= 1 ? top.hex() : base.alpha(1).mix(top.alpha(1), top.alpha()).hex();
}

export function resolveCodeEditorTheme(theme: CodeEditorThemeSource, paint: Partial<Pick<CodeEditorTheme, 'backgroundColor' | 'activeLineColor'>> = {}): CodeEditorTheme {
    const colors = theme.colors;
    const backgroundColor = paint.backgroundColor ?? colors.surface.inset;
    return {
        monacoThemeName: theme.dark ? 'happier-editor-dark' : 'happier-editor-light',
        isDark: Boolean(theme.dark),
        backgroundColor,
        widgetBackgroundColor: colors.surface.elevated,
        stickyBackgroundColor: opaqueOver(backgroundColor, colors.surface.base),
        textColor: colors.text.primary,
        dividerColor: colors.border.default,
        lineNumberColor: colors.text.tertiary,
        // The caret's line: a breath of the focus blue across numbers and text (files lab ED1, `.ln.cur`).
        activeLineColor: paint.activeLineColor ?? resolveCodeActiveLineColor(colors.accent.blue) ?? colors.surface.elevated,
        selectionColor: resolveCodeSelectionColor(colors.accent.blue),
        findMatchColor: colors.find?.matchAll,
        findCurrentMatchColor: colors.find?.matchCurrent,
        findCurrentMatchForeground: colors.find?.matchCurrentForeground,
        changeAddedColor: colors.diff.added.border,
        changeDeletedColor: colors.text.secondary,
        diagnosticErrorColor: colors.state?.danger.foreground,
        diagnosticWarningColor: colors.state?.warning.foreground,
        nextEdit: {
            removedBackground: colors.diff.inlineRemoved.background, removedForeground: colors.diff.inlineRemoved.foreground,
            addedBackground: colors.diff.inlineAdded.background, addedForeground: colors.diff.inlineAdded.foreground,
            hintColor: colors.text.tertiary,
        },
        syntax: {
            defaultColor: colors.syntax.default,
            keywordColor: colors.syntax.keyword,
            stringColor: colors.syntax.string,
            commentColor: colors.syntax.comment,
            numberColor: colors.syntax.number,
            functionColor: colors.syntax.function,
        },
    };
}

/**
 * Monaco reads theme colors as hex only and paints anything else solid red (`Color.fromHex` falls back to
 * red), so the ink tokens (`rgba(...)` hairlines and meta ink) are converted here, at its one boundary.
 */
function toMonacoHex(value: string): string | null {
    if (/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(value)) return value.toLowerCase();
    const hexa = parseThemeColor(value)?.hexa().toLowerCase();
    return hexa === undefined ? null : hexa.endsWith('ff') ? hexa.slice(0, 7) : hexa;
}

export function buildMonacoEditorThemeData(editorTheme: CodeEditorTheme): MonacoThemeData {
    const syntax = editorTheme.syntax;
    return {
        base: editorTheme.isDark ? 'vs-dark' : 'vs',
        inherit: true,
        rules: [
            { token: '', foreground: withoutHash(syntax.defaultColor) },
            { token: 'comment', foreground: withoutHash(syntax.commentColor) },
            { token: 'string', foreground: withoutHash(syntax.stringColor) },
            { token: 'number', foreground: withoutHash(syntax.numberColor) },
            { token: 'keyword', foreground: withoutHash(syntax.keywordColor) },
            { token: 'operator', foreground: withoutHash(syntax.keywordColor) },
            { token: 'type', foreground: withoutHash(syntax.functionColor) },
            { token: 'function', foreground: withoutHash(syntax.functionColor) },
            { token: 'delimiter', foreground: withoutHash(syntax.defaultColor) },
        ],
        colors: Object.fromEntries(Object.entries({
            'editor.background': editorTheme.backgroundColor,
            'editor.foreground': syntax.defaultColor,
            'editorGutter.background': editorTheme.backgroundColor,
            'editorLineNumber.foreground': editorTheme.lineNumberColor,
            'editorLineNumber.activeForeground': editorTheme.textColor,
            'editorCursor.foreground': editorTheme.textColor,
            'editor.selectionBackground': editorTheme.selectionColor,
            'editor.inactiveSelectionBackground': editorTheme.activeLineColor,
            'editor.lineHighlightBackground': editorTheme.activeLineColor,
            'editor.lineHighlightBorder': '#00000000',
            'editorIndentGuide.background1': editorTheme.dividerColor,
            'editorIndentGuide.activeBackground1': editorTheme.lineNumberColor,
            'editorWidget.background': editorTheme.widgetBackgroundColor,
            // Pinned lines are in flow: the editor's own paint, an ink hairline under them, no shadow.
            'editorStickyScroll.background': editorTheme.stickyBackgroundColor,
            'editorStickyScrollGutter.background': editorTheme.stickyBackgroundColor,
            'editorStickyScrollHover.background': editorTheme.stickyBackgroundColor,
            'editorStickyScroll.border': editorTheme.dividerColor,
            'editorStickyScroll.shadow': '#00000000',
            'editorWidget.border': editorTheme.dividerColor,
            'input.background': editorTheme.backgroundColor,
            'input.foreground': editorTheme.textColor,
            'input.border': editorTheme.dividerColor,
        }).flatMap(([id, value]) => { const hex = toMonacoHex(value); return hex ? [[id, hex]] : []; })),
    };
}

/** Width of a change-gutter bar: an optical stroke, the same in both engines. */
const CHANGE_MARK_WIDTH_PX = 3;
const BLAME_MARK_WIDTH_PX = 2;

/**
 * The change gutter's three marks, drawn the same in Monaco and CodeMirror (ade-shell ED3): added is a solid
 * bar, modified the same bar dashed (blue stays reserved for focus and links), deleted a small wedge pointing
 * at the gap where lines were removed. Returned as CSS declarations so each engine applies them to its own
 * marker element.
 */
export function resolveCodeEditorChangeMarkStyles(theme: Pick<CodeEditorTheme, 'changeAddedColor' | 'changeDeletedColor'>) {
    const bar = { width: `${CHANGE_MARK_WIDTH_PX}px`, top: '0', bottom: '0', left: '0', position: 'absolute' } as const;
    return {
        added: { ...bar, background: theme.changeAddedColor },
        modified: { ...bar, background: `repeating-linear-gradient(to bottom, ${theme.changeAddedColor} 0 3px, transparent 3px 6px)` },
        deleted: { position: 'absolute', left: '0', bottom: '-4px', width: '0', height: '0',
            borderTop: '4px solid transparent', borderBottom: '4px solid transparent', borderLeft: `5px solid ${theme.changeDeletedColor}` },
    } as const;
}

/**
 * The same marks as one stylesheet, for an engine whose marker element is already placed in its gutter lane
 * (Monaco's line decoration, CodeMirror's gutter marker): the bars set only their stroke, the wedge hangs
 * from the element's lower edge.
 */
/**
 * Blame in Edit (P8 §3.7, BL1 notes): each run is the View column's 2 px ink edge bar, drawn at the start of
 * the engine's marker lane just after the numbers, stronger for the newer runs. The marker element spans the
 * lane, so the whole lane is the press target that opens the run's card.
 */
export function formatCodeEditorBlameMarkCss(theme: Pick<CodeEditorTheme, 'textColor'>, selector: (tone: 'recent' | 'older' | 'run') => string): string {
    const bar = (percent: number) => `{background:linear-gradient(to right,color-mix(in srgb,${theme.textColor} ${percent}%,transparent) 0 ${BLAME_MARK_WIDTH_PX}px,transparent ${BLAME_MARK_WIDTH_PX}px)!important;cursor:pointer}`;
    return [`${selector('recent')}${bar(60)}`, `${selector('older')}${bar(28)}`, `${selector('run')}${bar(28)}`].join('\n');
}

/** The engines' problem squiggle: a wavy underline in the state colour, the same in Monaco and CodeMirror. */
export function formatCodeEditorDiagnosticCss(theme: Pick<CodeEditorTheme, 'diagnosticErrorColor' | 'diagnosticWarningColor'>,
    selector: (severity: 'error' | 'warning') => string): string {
    return ([['error', theme.diagnosticErrorColor], ['warning', theme.diagnosticWarningColor]] as const)
        .filter((entry): entry is readonly ['error' | 'warning', string] => typeof entry[1] === 'string')
        .map(([severity, color]) => `${selector(severity)}{text-decoration:underline wavy ${color};text-decoration-skip-ink:none;text-underline-offset:3px}`)
        .join('\n');
}

export type CodeEditorNextEditPart = 'target' | 'removed' | 'added' | 'hint' | 'key';

/**
 * A predicted next edit (P7-R33), the same in Monaco and CodeMirror. `target` marks where it lands with a wash of
 * ink (a place, not yet a change); the preview strikes the old text in the removed word mark and shows the new text
 * beside it in the added one, exactly as Replace previews a match. `hint` is the quiet key line after the text.
 */
export function formatCodeEditorNextEditCss(theme: Pick<CodeEditorTheme, 'nextEdit' | 'textColor'>, selector: (part: CodeEditorNextEditPart) => string): string {
    const mark = theme.nextEdit;
    if (!mark) return '';
    const ink = (percent: number) => `color-mix(in srgb,${theme.textColor} ${percent}%,transparent)`;
    return [
        // A wash only: the engines split a range into one span per token, so a ring would box every token.
        `${selector('target')}{background:${ink(9)}}`,
        `${selector('removed')}{background:${mark.removedBackground};color:${mark.removedForeground}!important;text-decoration:line-through;text-decoration-color:color-mix(in srgb,${mark.removedForeground} 55%,transparent);border-radius:2px}`,
        `${selector('added')}{background:${mark.addedBackground};color:${mark.addedForeground}!important;border-radius:2px}`,
        `${selector('hint')}{color:${mark.hintColor}!important;font-style:normal;margin-left:.75ch;white-space:pre}`,
        `${selector('key')}{color:${mark.hintColor}!important;box-shadow:inset 0 0 0 1px ${ink(16)};border-radius:3px;padding:0 3px;margin-left:2ch}`,
    ].join('\n');
}

export function formatCodeEditorChangeMarkCss(theme: Pick<CodeEditorTheme, 'changeAddedColor' | 'changeDeletedColor'>, selector: (kind: 'added' | 'modified' | 'deleted') => string,
    options: Readonly<{ /** CSS length from the start of the engine's marker lane. */ inset?: string }> = {}): string {
    const styles = resolveCodeEditorChangeMarkStyles(theme);
    const wedge = styles.deleted;
    const inset = options.inset ? `;margin-left:${options.inset}!important` : '';
    return [
        `${selector('added')}{width:${styles.added.width}!important;background:${styles.added.background}!important${inset}}`,
        `${selector('modified')}{width:${styles.modified.width}!important;background:${styles.modified.background}!important${inset}}`,
        `${selector('deleted')}{background:none!important;overflow:visible!important${inset}}`,
        `${selector('deleted')}::after{content:'';position:absolute;left:0;bottom:${wedge.bottom};width:0;height:0;border-top:${wedge.borderTop};border-bottom:${wedge.borderBottom};border-left:${wedge.borderLeft}}`,
    ].join('\n');
}
