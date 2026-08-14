import { useEffect, useState } from 'react';

/**
 * Odometer-style number, built the way the Codex desktop app builds its digit
 * columns: one column per digit, each holding a vertical stack of 0–9 moved by
 * `translateY(-<n>lh)`. `lh` units make the geometry follow the inherited
 * line-height for free, and a `1ch` column plus tabular figures means nothing
 * shifts horizontally while the digits move.
 *
 * Two details that are easy to miss and that carry the whole effect:
 *
 * 1. Digit columns are keyed RIGHT TO LEFT by place value, never by string
 *    index. When the digit count changes (999 → 1,004) the ones column has to
 *    stay the ones column, or every digit re-keys and the row reshuffles
 *    instead of rolling.
 * 2. A column's offset only ever increases, so a carry (8 → 0) rolls FORWARD
 *    onto the next tile's zero instead of spinning backwards through eight
 *    digits. Codex's version does not do this; on a counter that only ever
 *    counts up, the backspin is the one thing that reads as broken.
 */

type RollPart =
    | { kind: 'digit'; key: string; digit: number }
    | { kind: 'static'; key: string; char: string };

function isDigit(char: string): boolean {
    return char >= '0' && char <= '9';
}

/**
 * Split a formatted number into place-value-keyed digit columns and static
 * separators (grouping commas, decimal points, unit suffixes).
 */
export function splitRollParts(text: string): RollPart[] {
    const chars = Array.from(text);
    let place = chars.filter(isDigit).length;

    return chars.map((char, index) => {
        if (!isDigit(char)) return { kind: 'static', key: `s${index}`, char };
        place -= 1;
        return { kind: 'digit', key: `d${place}`, digit: Number(char) };
    });
}

type RollingNumberProps = {
    /** Already-formatted text, e.g. "35,020". Non-digits render as static glyphs. */
    value: string;
    className?: string;
};

export function RollingNumber({ value, className = '' }: RollingNumberProps) {
    /**
     * Before mount — which includes the whole of the prerendered HTML — this
     * renders the number ONCE, as plain text, and nothing else.
     *
     * The odometer needs a hidden sr-only copy of the value beside a stack of
     * per-digit columns, and every one of those columns is a text node. In the
     * prerendered file that extracted as:
     *
     *     … Web app 35,020 3 5 , 0 2 0 downloads Scroll to explore …
     *
     * which is what a search snippet, an LLM ingestion pipeline, and
     * assert-crawlable's word count all saw. `stripDigitStacks` in
     * assert-crawlable existed to paper over it. Rendering plain text until the
     * component mounts removes the duplication at the source: the HTML says
     * "35,020" once, a visitor with no JS sees the number instead of nothing,
     * and the roll still plays for everyone else.
     *
     * `mounted` starts false on BOTH the server and the first client render, so
     * hydration matches; the effect flips it and the columns take over.
     */
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);

    if (!mounted) {
        return <span className={`rollnum ${className}`.trim()}>{value}</span>;
    }

    const parts = splitRollParts(value);

    return (
        <span className={`rollnum ${className}`.trim()}>
            {/* The visible digits are ten-deep stacks, so they are hidden from
                assistive tech and the real value is exposed as plain text. An
                aria-label on a role-less span is not reliably announced. */}
            <span className="sr-only">{value}</span>
            <span aria-hidden className="rollnum__glyphs">
                {parts.map((part, index) =>
                    part.kind === 'digit' ? (
                        <RollingDigit key={part.key} digit={part.digit} delayMs={index * 45} />
                    ) : (
                        <span key={part.key} className="rollnum__static">
                            {part.char}
                        </span>
                    ),
                )}
            </span>
        </span>
    );
}

function RollingDigit({ digit, delayMs }: { digit: number; delayMs: number }) {
    const [offset, setOffset] = useState(0);
    /**
     * False for the server render AND for the first client render, which is what
     * keeps hydration matching — both run the same pure function of `digit`. The
     * mount effect flips it and the real ten-deep stack takes over.
     *
     * Since RollingNumber now gates the whole odometer on ITS own mount, this
     * component never reaches the prerenderer at all — the note below is about
     * the first client render, which still has to be cheap and still has to
     * match what hydration expects.
     *
     * Before that flip the column renders ONE tile holding the actual digit. The
     * full stack is 20 tiles of "0123456789", so the previous version put ~110
     * stray digits into the prerendered HTML immediately after "35,020" in the
     * hero — text that lands in search snippets and in every non-JS extraction of
     * the page. One tile prerenders the number and nothing else.
     *
     * Visual consequence: the columns now roll up from 0 to their value once on
     * load instead of appearing already landed. To restore the old behaviour,
     * seed `useState(digit)` and drop `rolling` from the transform below.
     */
    const [rolling, setRolling] = useState(false);

    useEffect(() => {
        setRolling(true);
        // Advance to the next occurrence of `digit` below the current position,
        // so the column never travels upwards.
        setOffset((current) => current + ((digit - (current % 10) + 10) % 10));
    }, [digit]);

    // One tile ahead of the current offset is always enough to land the next roll.
    const rows = rolling ? (Math.floor(offset / 10) + 2) * 10 : 1;

    return (
        <span aria-hidden className="rollnum__col">
            <span className="rollnum__window">
                <span
                    className="rollnum__stack"
                    style={{ transform: `translateY(-${offset}lh)`, transitionDelay: `${delayMs}ms` }}
                >
                    {Array.from({ length: rows }, (_, row) => (
                        <span key={row}>{rolling ? row % 10 : digit}</span>
                    ))}
                </span>
            </span>
        </span>
    );
}
