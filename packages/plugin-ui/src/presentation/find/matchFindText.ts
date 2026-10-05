import type { FindOptions } from './findTypes.js';

export type FindTextMatchRange = [start16: number, end16: number];
export type FindTextMatchResult = { ranges: FindTextMatchRange[] } | { invalidPattern: true };

/** Match the display string without changing its UTF-16 coordinate space. */
export function matchFindText(text: string, query: string, options: FindOptions): FindTextMatchResult {
    if (query.length === 0) return { ranges: [] };
    const pattern = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let expression: RegExp;
    try {
        expression = new RegExp(pattern, options.matchCase ? 'gu' : 'giu');
    } catch {
        return { invalidPattern: true };
    }

    const ranges: FindTextMatchRange[] = [];
    let match: RegExpExecArray | null;
    while ((match = expression.exec(text)) !== null) {
        ranges.push([match.index, match.index + match[0].length]);
        if (match[0].length === 0) {
            // RegExp.exec does not advance an empty global match. Advancing a scalar
            // avoids repeating a match inside a surrogate pair under the Unicode flag.
            const point = text.codePointAt(expression.lastIndex);
            expression.lastIndex += point !== undefined && point > 0xffff ? 2 : 1;
        }
    }
    return { ranges };
}
