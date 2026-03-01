export type CodeHighlightingBudgetLimits = Readonly<{
    maxBytes: number;
    maxLines: number;
    maxLineLength: number;
}>;

export type CodeHighlightingBudget = Readonly<{
    normalizedCode: string;
    bytesOk: boolean;
    lines: readonly string[] | null;
    linesOk: boolean;
    lineLengthOk: boolean;
    withinBudget: boolean;
}>;

export function evaluateCodeHighlightingBudget(code: string, limits: CodeHighlightingBudgetLimits): CodeHighlightingBudget {
    const normalizedCode = String(code ?? '').replace(/\r\n/g, '\n');

    const maxBytes = limits.maxBytes ?? 0;
    const maxLines = limits.maxLines ?? 0;
    const maxLineLength = limits.maxLineLength ?? 0;

    const bytesOk = maxBytes <= 0 || normalizedCode.length <= maxBytes;
    if (!bytesOk) {
        return {
            normalizedCode,
            bytesOk,
            lines: null,
            linesOk: true,
            lineLengthOk: true,
            withinBudget: false,
        };
    }

    const lines = normalizedCode.split('\n');
    const linesOk = maxLines <= 0 || lines.length <= maxLines;

    let lineLengthOk = true;
    if (maxLineLength > 0) {
        for (const line of lines) {
            if (line.length > maxLineLength) {
                lineLengthOk = false;
                break;
            }
        }
    }

    const withinBudget = bytesOk && linesOk && lineLengthOk;

    return {
        normalizedCode,
        bytesOk,
        lines,
        linesOk,
        lineLengthOk,
        withinBudget,
    };
}
