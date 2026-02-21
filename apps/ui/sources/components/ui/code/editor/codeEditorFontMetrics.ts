export const CODE_EDITOR_BASE_FONT_SIZE = 13;
export const CODE_EDITOR_BASE_LINE_HEIGHT = 20;

export type CodeEditorFontMetrics = Readonly<{
    scale: number;
    fontSize: number;
    lineHeight: number;
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
    };
}

