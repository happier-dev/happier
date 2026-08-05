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
    const [offset, setOffset] = useState(digit);

    useEffect(() => {
        // Advance to the next occurrence of `digit` below the current position,
        // so the column never travels upwards.
        setOffset((current) => current + ((digit - (current % 10) + 10) % 10));
    }, [digit]);

    // One tile ahead of the current offset is always enough to land the next roll.
    const rows = (Math.floor(offset / 10) + 2) * 10;

    return (
        <span aria-hidden className="rollnum__col">
            <span className="rollnum__window">
                <span
                    className="rollnum__stack"
                    style={{ transform: `translateY(-${offset}lh)`, transitionDelay: `${delayMs}ms` }}
                >
                    {Array.from({ length: rows }, (_, row) => (
                        <span key={row}>{row % 10}</span>
                    ))}
                </span>
            </span>
        </span>
    );
}
