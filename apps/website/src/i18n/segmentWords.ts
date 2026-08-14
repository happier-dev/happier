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
 * WHY THIS DOES NOT USE `Intl.Segmenter`, HAVING BEEN WRITTEN TO
 * The site is PRERENDERED: the HTML is segmented in Node and then hydrated by
 * whatever browser the reader has. `Intl.Segmenter` for Chinese is dictionary
 * based, so its boundaries are an ICU-version detail, not a spec guarantee —
 * Node's ICU and the reader's ICU can legitimately disagree, and React would
 * hydrate a different number of spans than the server emitted. Firefox only
 * shipped it in 125, so a share of readers would take the fallback path while
 * the prerender took the ICU one, which is the same divergence by another
 * route.
 *
 * Per-character segmentation for CJK runs is deterministic everywhere, animates
 * the same way, and — the part that actually matters — restores the wrap
 * opportunities. The boundaries are less linguistic than ICU's. That is the
 * whole cost, and it buys server/client agreement.
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

/**
 * Returns the reveal units for `line`. Each unit is rendered in its own span;
 * `joiner` tells the caller what text node (if any) to emit after it — a space
 * for Latin, nothing for CJK, because inserting spaces between Chinese
 * characters is visibly wrong.
 */
export function segmentWords(line: string): ReadonlyArray<{ text: string; joiner: string }> {
    if (!hasCjk(line)) {
        const words = line.split(/\s+/).filter(Boolean);
        return words.map((text, index) => ({ text, joiner: index === words.length - 1 ? '' : ' ' }));
    }

    // Mixed CJK/Latin: segment the whole line, then re-attach a space only
    // where the original line actually had one.
    const raw = cjkAwareSegments(line);

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

/** Per-character for CJK runs, whole tokens for Latin runs. Deterministic. */
function cjkAwareSegments(line: string): string[] {
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
