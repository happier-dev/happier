import * as React from 'react';
import type { MarkdownSpan } from '../parseMarkdown';
import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';
import type { FindDisplayText } from '@/components/markdown/rendering/markdownFindProjection';

export const MarkdownFindDecorationContext = React.createContext<ReadonlyMap<MarkdownSpan, readonly FindTextRange[]> | null>(null);

export function projectLeafRanges(leaf: FindDisplayText, sourceStart: number, ranges: readonly FindTextRange[]) {
    const result: FindTextRange[] = [];
    for (const range of ranges) {
        let start = -1;
        for (let index = 0; index <= leaf.text.length; index++) {
            const inside = index < leaf.text.length && leaf.sourceOffsets[index]! + sourceStart < range.end
                && leaf.sourceEnds[index]! + sourceStart > range.start;
            if (inside && start < 0) start = index;
            if (!inside && start >= 0) { result.push({ start, end: index, current: range.current }); start = -1; }
        }
    }
    return result;
}
