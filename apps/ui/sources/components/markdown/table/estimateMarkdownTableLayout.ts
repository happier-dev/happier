/**
 * Content-only column sizing for transcript tables.
 *
 * Text is never measured: widths are estimated from glyph classes so the table lays out in one
 * native/CSS flex pass. Each column gets a `natural` width (widest cell on one line) and a `floor`
 * (narrowest readable width). Rendering gives every cell of a column `flexBasis: natural`,
 * `flexShrink: shrink` and `minWidth: floor`; because flex shrinks items in proportion to
 * `flexShrink × flexBasis`, each column gives up width in proportion to `natural - floor`, every
 * column reaches its floor at the same time, and rows stay aligned without any measurement.
 * Estimates only need to be close: a slightly narrow estimate wraps one more word, a slightly wide
 * one leaves a little padding.
 */

export type MarkdownTableColumnLayout = Readonly<{
    /** Widest cell on one line, including cell padding and border (px). */
    natural: number;
    /** Narrowest width the column may shrink to (px); equals `natural` for short columns. */
    floor: number;
    /** Flex shrink factor, `(natural - floor) / natural`. */
    shrink: number;
}>;

export type MarkdownTableLayout = Readonly<{
    columns: readonly MarkdownTableColumnLayout[];
    /** Sum of natural widths: the table's width when space allows. */
    naturalWidth: number;
    /** Sum of floors: below this available width the table scrolls horizontally. */
    floorWidth: number;
}>;

export type EstimateMarkdownTableLayoutInput = Readonly<{
    headers: readonly string[];
    rows: readonly (readonly string[])[];
    /** Unscaled body font size of a cell (px). */
    fontSize: number;
    /** Combined in-app and system font scale applied by the text primitives. */
    fontScale: number;
    /** Horizontal padding plus border of one cell (px); not affected by font scale. */
    cellHorizontalChrome: number;
}>;

// Advance widths in em, calibrated against the app font (Inter at 16px) and rounded up so short
// cells err wide: a column that fits must never break a word. Ordinary lowercase letters average
// ~0.58em, capitals ~0.66em, m/w ~0.85em, narrow glyphs (i, l, t, r, punctuation) ~0.32em.
const LOWERCASE_EM = 0.6;
const UPPERCASE_EM = 0.7;
const EXTRA_WIDE_LATIN_EM = 0.9;
const NARROW_EM = 0.36;
const DIGIT_EM = 0.62;
const OTHER_EM = 0.6;
const SPACE_EM = 0.3;
const WIDE_EM = 1;
const NARROW_GLYPHS = new Set([...'ijlftr.,:;!|\'()[]']);
const EXTRA_WIDE_LATIN_GLYPHS = new Set([...'mwMW@%']);
// Rounding, kerning and the platform system font (iOS renders the system font, not Inter) differ
// from the classes by a few pixels; this slack keeps one-line cells on one line.
const COLUMN_SLACK_EM = 0.5;
// Header cells render semi-bold.
const HEADER_WEIGHT_FACTOR = 1.05;
// Columns up to this one-line width never wrap.
const SHORT_COLUMN_EM = 8;
// Wrapping columns keep at least this share of their one-line width (bounds the line count) and
// stay within a readable measure.
const FLOOR_SHARE = 1 / 6;
const FLOOR_MIN_EM = 6;
const FLOOR_MAX_EM = 12;
// Matches the cell's minimum width so empty columns stay tappable/visible.
const MIN_COLUMN_WIDTH = 40;

function glyphEm(char: string, codePoint: number): number {
    if (codePoint === 0x20 || codePoint === 0x09) return SPACE_EM;
    // Zero-width: combining marks, joiners, variation selectors.
    if ((codePoint >= 0x0300 && codePoint <= 0x036f)
        || (codePoint >= 0x200b && codePoint <= 0x200f)
        || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)) {
        return 0;
    }
    if ((codePoint >= 0x1100 && codePoint <= 0x115f)
        || (codePoint >= 0x2600 && codePoint <= 0x27bf)
        || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
        || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
        || (codePoint >= 0xf900 && codePoint <= 0xfaff)
        || (codePoint >= 0xfe30 && codePoint <= 0xfe4f)
        || (codePoint >= 0xff00 && codePoint <= 0xff60)
        || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
        || codePoint >= 0x1f000) {
        return WIDE_EM;
    }
    if (NARROW_GLYPHS.has(char)) return NARROW_EM;
    if (EXTRA_WIDE_LATIN_GLYPHS.has(char)) return EXTRA_WIDE_LATIN_EM;
    if (codePoint >= 0x61 && codePoint <= 0x7a) return LOWERCASE_EM;
    if (codePoint >= 0x41 && codePoint <= 0x5a) return UPPERCASE_EM;
    if (codePoint >= 0x30 && codePoint <= 0x39) return DIGIT_EM;
    return OTHER_EM;
}

type CellEstimate = Readonly<{ lineEm: number; longestWordEm: number }>;

function estimateCell(text: string): CellEstimate {
    let lineEm = 0;
    let wordEm = 0;
    let longestWordEm = 0;
    for (const char of text) {
        const codePoint = char.codePointAt(0) ?? 0;
        const width = glyphEm(char, codePoint);
        lineEm += width;
        if (codePoint === 0x20 || codePoint === 0x09) {
            wordEm = 0;
        } else if (width === WIDE_EM) {
            // CJK and emoji break between glyphs.
            wordEm = 0;
            longestWordEm = Math.max(longestWordEm, width);
        } else {
            wordEm += width;
            longestWordEm = Math.max(longestWordEm, wordEm);
        }
    }
    return { lineEm, longestWordEm };
}

export function estimateMarkdownTableLayout(input: EstimateMarkdownTableLayoutInput): MarkdownTableLayout {
    const pxPerEm = input.fontSize * input.fontScale;
    const columns: MarkdownTableColumnLayout[] = [];
    let naturalWidth = 0;
    let floorWidth = 0;

    for (let columnIndex = 0; columnIndex < input.headers.length; columnIndex += 1) {
        const header = estimateCell(input.headers[columnIndex] ?? '');
        let lineEm = header.lineEm * HEADER_WEIGHT_FACTOR;
        let longestWordEm = header.longestWordEm * HEADER_WEIGHT_FACTOR;
        for (const row of input.rows) {
            const cell = estimateCell(row[columnIndex] ?? '');
            if (cell.lineEm > lineEm) lineEm = cell.lineEm;
            if (cell.longestWordEm > longestWordEm) longestWordEm = cell.longestWordEm;
        }

        const floorEm = lineEm <= SHORT_COLUMN_EM
            ? lineEm
            : Math.min(lineEm, Math.min(FLOOR_MAX_EM, Math.max(FLOOR_MIN_EM, longestWordEm, lineEm * FLOOR_SHARE)));

        const natural = Math.max(MIN_COLUMN_WIDTH, Math.ceil((lineEm + COLUMN_SLACK_EM) * pxPerEm) + input.cellHorizontalChrome);
        const floor = Math.max(MIN_COLUMN_WIDTH, Math.ceil((floorEm + COLUMN_SLACK_EM) * pxPerEm) + input.cellHorizontalChrome);
        columns.push({ natural, floor, shrink: natural > floor ? (natural - floor) / natural : 0 });
        naturalWidth += natural;
        floorWidth += floor;
    }

    return { columns, naturalWidth, floorWidth };
}
