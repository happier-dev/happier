import type { MarkdownRenderSegment } from './markdownRenderSegmentTypes';

function isSameSegment(previous: MarkdownRenderSegment, next: MarkdownRenderSegment): boolean {
    if (previous.type !== next.type
        || previous.key !== next.key
        || previous.sourceStart !== next.sourceStart
        || previous.sourceLength !== next.sourceLength
        || previous.sourceHash !== next.sourceHash
        || previous.markdown !== next.markdown
        || previous.first !== next.first
        || previous.last !== next.last
        || previous.sourceRange.startLine !== next.sourceRange.startLine
        || previous.sourceRange.endLine !== next.sourceRange.endLine) {
        return false;
    }
    if (previous.type === 'enriched-markdown' && next.type === 'enriched-markdown') {
        return previous.renderMarkdown === next.renderMarkdown;
    }
    return true;
}

/**
 * Re-splitting a growing message rebuilds every segment. Keep the previous object for each segment
 * whose source and position are unchanged, so memoized blocks before the streaming tail (tables,
 * code blocks) do not re-render on every chunk. Returns `previous` itself when nothing changed.
 */
export function reuseUnchangedMarkdownRenderSegments(
    previous: MarkdownRenderSegment[] | null,
    next: MarkdownRenderSegment[],
): MarkdownRenderSegment[] {
    if (!previous || previous === next) return next;
    let changed = previous.length !== next.length;
    const reconciled = next.map((segment, index) => {
        const prior = previous[index];
        if (prior && isSameSegment(prior, segment)) return prior;
        changed = true;
        return segment;
    });
    return changed ? reconciled : previous;
}
