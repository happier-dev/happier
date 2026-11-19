import { matchFindText, type FindTextRange } from '@happier-dev/plugin-ui/presentation';

/** Literal query marks for Search and prompt previews, in display-text UTF-16 coordinates. */
export function queryRanges(text: string, query: string, current = false): readonly FindTextRange[] | undefined {
    if (!query.trim()) return undefined;
    const result = matchFindText(text, query.trim(), { matchCase: false, regex: false });
    return 'ranges' in result ? result.ranges.map(([start, end]) => ({ start, end, current })) : undefined;
}

/**
 * Whether a label tinted for `left` shows the same marks as for `right`: a refined query that marks the same
 * ranges keeps the row it already drew (Search rows reuse their option across refinements).
 */
export function sameQueryMarks(label: string, left: string | undefined, right: string | undefined): boolean {
    if (left === right) return true;
    // Item also uses the presence of a search query for its line allowance. Keep that presentation fact.
    if (Boolean(left) !== Boolean(right)) return false;
    const before = left ? queryRanges(label, left) : undefined;
    const after = right ? queryRanges(label, right) : undefined;
    return (before?.length ?? 0) === (after?.length ?? 0)
        && (before?.every((range, index) => range.start === after?.[index]?.start && range.end === after?.[index]?.end) ?? true);
}
