import { describe, expect, it } from 'vitest';

import { estimateMarkdownTableLayout } from './estimateMarkdownTableLayout';

const base = { fontSize: 16, fontScale: 1, cellHorizontalChrome: 33 } as const;
const em = base.fontSize;
/** Every column keeps half an em of slack beyond its estimated text width. */
const slack = 0.5 * em;

/** A single-column layout whose only body cell holds `text` (headers render semi-bold, so tests size body text). */
function bodyColumn(text: string, fontScale = 1) {
    return estimateMarkdownTableLayout({ ...base, fontScale, headers: [''], rows: [[text]] }).columns[0]!;
}

describe('estimateMarkdownTableLayout', () => {
    it('sizes every column to its widest single-line cell when the table fits', () => {
        const layout = estimateMarkdownTableLayout({
            ...base,
            headers: ['A', 'Status'],
            rows: [['1', 'ok'], ['22', 'pending']],
        });

        expect(layout.columns).toHaveLength(2);
        const [first, second] = layout.columns;
        // Short columns never wrap: their floor is their natural width and they never shrink.
        expect(first!.floor).toBe(first!.natural);
        expect(first!.shrink).toBe(0);
        expect(second!.floor).toBe(second!.natural);
        // "pending" is the widest cell of the second column.
        expect(second!.natural).toBeGreaterThan(first!.natural);
        expect(layout.naturalWidth).toBe(first!.natural + second!.natural);
        expect(layout.floorWidth).toBe(layout.naturalWidth);
    });

    it('lets a long prose column wrap down to a bounded floor while short columns stay on one line', () => {
        const prose = 'This column holds a long explanation that would never fit on a phone screen in one line of text';
        const layout = estimateMarkdownTableLayout({
            ...base,
            headers: ['Id', 'Notes'],
            rows: [['7', prose]],
        });

        const [id, notes] = layout.columns;
        expect(id!.shrink).toBe(0);
        expect(notes!.floor).toBeLessThan(notes!.natural);
        expect(notes!.shrink).toBeCloseTo((notes!.natural - notes!.floor) / notes!.natural);
        // Prose floor clamps to the configured maximum readable measure (12em + chrome).
        expect(notes!.floor).toBeLessThanOrEqual(12 * em + base.cellHorizontalChrome + 1);
        expect(notes!.floor).toBeGreaterThanOrEqual(6 * em + base.cellHorizontalChrome);
    });

    it('never underestimates short words with capitals, so a fitting column does not break them mid-word', () => {
        // Rendered Inter widths at 16px, measured in the browser: "Green" 45.8px, semi-bold "Key" 29.2px.
        expect(bodyColumn('Green').natural - base.cellHorizontalChrome).toBeGreaterThanOrEqual(46);
        const header = estimateMarkdownTableLayout({ ...base, headers: ['Key'], rows: [['A']] }).columns[0]!;
        expect(header.natural - base.cellHorizontalChrome).toBeGreaterThanOrEqual(30);
    });

    it('keeps the longest word unbroken when it is narrower than the clamp', () => {
        const layout = estimateMarkdownTableLayout({
            ...base,
            headers: ['Notes'],
            rows: [['a b c d e f g h i j k l m n o p q r s t u v w x y z a b c d e f g h i j k l m n o p internationalization']],
        });
        const notes = layout.columns[0]!;
        const longestWordWidth = bodyColumn('internationalization').natural;
        expect(notes.floor).toBe(longestWordWidth);
    });

    it('clamps unbreakable tokens such as URLs instead of forcing a huge column', () => {
        const url = 'https://example.com/a/really/long/path/that/keeps/going/and/going/without/any/spaces/at/all.html';
        const layout = estimateMarkdownTableLayout({ ...base, headers: ['Link'], rows: [[url]] });
        const link = layout.columns[0]!;
        expect(link.natural).toBeGreaterThan(40 * em);
        expect(link.floor).toBeLessThanOrEqual(12 * em + slack + base.cellHorizontalChrome + 1);
    });

    it('weights CJK and emoji glyphs as full-width', () => {
        const latin = bodyColumn('abcd');
        const cjk = bodyColumn('漢字漢字');
        const emoji = bodyColumn('😀😀😀😀');
        expect(cjk.natural - base.cellHorizontalChrome).toBe(4 * em + slack);
        expect(emoji.natural).toBe(cjk.natural);
        expect(latin.natural).toBeLessThan(cjk.natural);
    });

    it('scales text widths with the font scale but not the cell chrome', () => {
        const one = bodyColumn('漢字');
        const two = bodyColumn('漢字', 2);
        expect(two.natural - base.cellHorizontalChrome).toBe(2 * (one.natural - base.cellHorizontalChrome));
    });

    it('reports a floor width wider than a phone when columns cannot all wrap enough, so the table scrolls', () => {
        const prose = 'long words everywhere across a description column that needs wrapping to be readable';
        const layout = estimateMarkdownTableLayout({
            ...base,
            headers: ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'],
            rows: [Array.from({ length: 8 }, () => prose)],
        });
        expect(layout.floorWidth).toBeGreaterThan(390);
        expect(layout.floorWidth).toBeLessThan(layout.naturalWidth);
        expect(layout.floorWidth).toBe(layout.columns.reduce((sum, column) => sum + column.floor, 0));
    });

    it('fits ragged rows to the header column count', () => {
        const layout = estimateMarkdownTableLayout({ ...base, headers: ['A', 'B'], rows: [['x'], ['1', '2', 'ignored extra cell']] });
        expect(layout.columns).toHaveLength(2);
        expect(layout.columns[1]!.natural).toBe(estimateMarkdownTableLayout({ ...base, headers: ['B'], rows: [['2']] }).columns[0]!.natural);
        expect(layout.columns[0]!.natural).toBe(estimateMarkdownTableLayout({ ...base, headers: ['A'], rows: [['x']] }).columns[0]!.natural);
    });
});
