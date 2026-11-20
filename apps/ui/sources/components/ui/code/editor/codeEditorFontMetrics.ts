export const CODE_EDITOR_BASE_FONT_SIZE = 13;
export const CODE_EDITOR_BASE_LINE_HEIGHT = 22;
/** Columns per tab in the editor (Monaco `tabSize`) and wherever its lines are drawn outside it. */
export const CODE_EDITOR_TAB_SIZE = 2;
/** One formatting policy for an editor model and a saved-file preview without a mounted model. */
export const CODE_EDITOR_FORMATTING_OPTIONS = Object.freeze({ tabSize: CODE_EDITOR_TAB_SIZE, insertSpaces: true });
export { CODE_EDITOR_BASE_LINE_HEIGHT as CODE_LINE_BASE_HEIGHT };
/** Existing code-view insets; editors consume the same geometry. */
export const CODE_GUTTER_METRICS = Object.freeze({ rowPadding: 8, numberPaddingLeft: 4, numberPaddingRight: 18, numberMinWidth: 24, numberFontSize: 11, columnGap: 6, reviewLaneWidth: 32,
    /** One column of a per-line marker lane (Explain's caption letters and their range brackets). */
    markerLaneWidth: 22 });
/**
 * The inset around a file's code on a page canvas: the code view, the diff and the editor that replaces them in
 * place all hold their first line and their numbers here, so View -> Edit moves nothing (files lab ED1).
 */
export const CODE_CANVAS_CONTENT_PADDING = 16;

export function resolveCodeEditorLineNumberDigits(text: string): number {
    return String(text.split(/\r\n|\r|\n/).length).length;
}

export type CodeEditorGutterMetrics = Readonly<{ numberWidth: number; textOffset: number }>;
export function resolveCodeEditorGutterMetrics(params: Readonly<{
    lineNumberDigits: number;
    /** Measured width of a digit in the code font, never an estimated glyph ratio. */
    digitWidth: number;
    reviewLaneWidth?: number;
    showLineNumbers?: boolean;
    columns?: 1 | 2;
}>): CodeEditorGutterMetrics {
    const numberWidth = params.showLineNumbers === false ? 0 : Math.max(CODE_GUTTER_METRICS.numberMinWidth, Math.round(Math.max(1, params.lineNumberDigits) * params.digitWidth));
    const columns = params.columns ?? 1;
    const textOffset = CODE_GUTTER_METRICS.rowPadding + (params.reviewLaneWidth ?? 0) + CODE_GUTTER_METRICS.numberPaddingLeft
        + columns * numberWidth + (params.showLineNumbers === false ? 0 : columns - 1) * CODE_GUTTER_METRICS.columnGap + CODE_GUTTER_METRICS.numberPaddingRight;
    return { numberWidth, textOffset };
}

export type CodeEditorFontMetrics = Readonly<{
    scale: number;
    fontSize: number;
    lineHeight: number;
    lineNumberFontSize: number;
}>;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function resolveCodeEditorFontMetrics(params: Readonly<{
    uiFontScale: number;
    osFontScale?: number;
}>): CodeEditorFontMetrics {
    const uiFontScale =
        typeof params.uiFontScale === 'number' && Number.isFinite(params.uiFontScale)
            ? clamp(params.uiFontScale, 0.5, 2.5)
            : 1;
    const osFontScale =
        typeof params.osFontScale === 'number' && Number.isFinite(params.osFontScale)
            ? Math.max(0.5, params.osFontScale)
            : 1;

    const scale = uiFontScale * osFontScale;
    return {
        scale,
        fontSize: Math.max(8, Math.round(CODE_EDITOR_BASE_FONT_SIZE * scale)),
        lineHeight: Math.max(10, Math.round(CODE_EDITOR_BASE_LINE_HEIGHT * scale)),
        lineNumberFontSize: Math.round(CODE_GUTTER_METRICS.numberFontSize * scale),
    };
}

