/**
 * Split a line into the units the word-reveal animation staggers over.
 *
 * WHY THIS EXISTS
 * `RevealText` used `line.split(' ')`, and `.reveal-word` is
 * `display: inline-block` (src/styles/globals.css:347). Chinese, Japanese and
 * Korean text contains no spaces, so every CJK line collapsed into a SINGLE
 * reveal span. Two consequences:
 *   1. The signature per-word stagger degenerated into one whole-line blur-in.
 *   2. Anywhere the caller also sets `white-space: nowrap` — which
 *      `HeroHeadline` does per group (src/components/HeroHeadline.tsx:118) —
 *      the line can no longer wrap at all, so it overflows the viewport.
 *
 * `Intl.Segmenter` with `granularity: 'word'` gives real CJK word boundaries
 * (Chrome 87+, Safari 14.1+, Firefox 125+, Node 16+). Where it is missing we
 * fall back to per-character segmentation for CJK runs, which still animates
 * and still wraps — only the boundaries are less linguistic.
 *
 * Latin text is unchanged: for a space-separated line this returns exactly what
 * `split(' ')` returned, so English rendering is byte-identical to before.
 */

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ가-힯]/;

/**
 * Characters forbidden at the start of a CJK line (避头点 / kinsoku shori).
 * Closing punctuation, sentence-final marks and the ellipsis fuse onto the unit
 * before them rather than becoming their own wrappable span.
 */
const NO_LINE_START = /^[、。，．・：；？！）〕］｝〉》」』】…‥ー〜～％‰℃]+$/;

export function hasCjk(text: string): boolean {
    return CJK.test(text);
}

type Segmenter = {
    segment: (input: string) => Iterable<{ segment: string }>;
};

const segmenterCache = new Map<string, Segmenter | null>();

function getSegmenter(locale: string): Segmenter | null {
    if (segmenterCache.has(locale)) return segmenterCache.get(locale) ?? null;
    let created: Segmenter | null = null;
    const ctor = (Intl as unknown as { Segmenter?: new (l: string, o: { granularity: string }) => Segmenter }).Segmenter;
    if (typeof ctor === 'function') {
        try {
            created = new ctor(locale, { granularity: 'word' });
        } catch {
            created = null;
        }
    }
    segmenterCache.set(locale, created);
    return created;
}

/**
 * Returns the reveal units for `line`. Each unit is rendered in its own span;
 * `joiner` tells the caller what text node (if any) to emit after it — a space
 * for Latin, nothing for CJK, because inserting spaces between Chinese
 * characters is visibly wrong.
 */
export function segmentWords(line: string, locale: string): ReadonlyArray<{ text: string; joiner: string }> {
    if (!hasCjk(line)) {
        const words = line.split(' ');
        return words.map((text, index) => ({ text, joiner: index === words.length - 1 ? '' : ' ' }));
    }

    // Mixed CJK/Latin: segment the whole line, then re-attach a space only
    // where the original line actually had one.
    const segmenter = getSegmenter(locale);
    const raw: string[] = segmenter
        ? Array.from(segmenter.segment(line), (s) => s.segment)
        : fallbackSegments(line);

    const units: { text: string; joiner: string }[] = [];
    for (const piece of raw) {
        if (piece === ' ') {
            if (units.length > 0) units[units.length - 1].joiner = ' ';
            continue;
        }
        if (piece.trim() === '') continue;

        // 避头点 — CJK closing punctuation may never begin a line. Because each
        // unit becomes its own inline-block span, a standalone "。" is a real
        // wrap opportunity and Chinese readers see it drop to the next line.
        // Fusing it onto the preceding unit removes the break point entirely.
        if (units.length > 0 && NO_LINE_START.test(piece)) {
            const previous = units[units.length - 1];
            if (previous.joiner === '') {
                previous.text += piece;
                continue;
            }
        }
        units.push({ text: piece, joiner: '' });
    }
    return units.length > 0 ? units : [{ text: line, joiner: '' }];
}

/** Per-character for CJK runs, whole tokens for Latin runs. */
function fallbackSegments(line: string): string[] {
    const out: string[] = [];
    let latin = '';
    for (const char of line) {
        if (CJK.test(char)) {
            if (latin) {
                out.push(latin);
                latin = '';
            }
            out.push(char);
        } else if (char === ' ') {
            if (latin) {
                out.push(latin);
                latin = '';
            }
            out.push(' ');
        } else {
            latin += char;
        }
    }
    if (latin) out.push(latin);
    return out;
}
