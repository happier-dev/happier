import { matchFindText, type FindTextRange } from '@happier-dev/plugin-ui/presentation';

/** Literal query marks for Search and prompt previews, in display-text UTF-16 coordinates. */
export function queryRanges(text: string, query: string, current = false): readonly FindTextRange[] | undefined {
    if (!query.trim()) return undefined;
    const result = matchFindText(text, query.trim(), { matchCase: false, regex: false });
    return 'ranges' in result ? result.ranges.map(([start, end]) => ({ start, end, current })) : undefined;
}
