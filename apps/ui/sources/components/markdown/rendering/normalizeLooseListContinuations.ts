type OrderedListMarker = Readonly<{
    indent: string;
    number: number;
    marker: string;
    content: string;
}>;

const orderedListMarkerPattern = /^( {0,3})(\d+\.)(\s+)(.*)$/;
const openingCodeFencePattern = /^( {0,3})(`{3,}|~{3,})(.*)$/;

type CodeFenceMarker = Readonly<{
    marker: '`' | '~';
    length: number;
}>;

function parseOpeningCodeFence(line: string): CodeFenceMarker | null {
    const match = line.match(openingCodeFencePattern);
    if (!match) return null;

    const fence = match[2] ?? '';
    if (fence[0] === '`' && (match[3] ?? '').trim().includes('`')) return null;

    return {
        marker: fence[0] as '`' | '~',
        length: fence.length,
    };
}

function isClosingCodeFence(line: string, openingFence: CodeFenceMarker): boolean {
    const match = line.match(/^( {0,3})(`{3,}|~{3,})[ \t]*$/);
    if (!match) return false;

    const fence = match[2] ?? '';
    return fence[0] === openingFence.marker && fence.length >= openingFence.length;
}

function parseOrderedListMarker(line: string): OrderedListMarker | null {
    const match = line.match(orderedListMarkerPattern);
    if (!match) return null;

    return {
        indent: match[1] ?? '',
        number: Number.parseInt(match[2] ?? '', 10),
        marker: match[2] ?? '',
        content: match[4] ?? '',
    };
}

function readLeadingSpaceCount(line: string): number {
    return line.match(/^ */)?.[0].length ?? 0;
}

function isBlankLine(line: string): boolean {
    return line.trim().length === 0;
}

function isThematicBreak(line: string): boolean {
    return /^( {0,3})(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

function isBlockBoundary(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/^( {0,3})#{1,6}\s+/.test(line)) return true;
    if (/^( {0,3})(`{3,}|~{3,})/.test(line)) return true;
    if (trimmed.startsWith('<options>')) return true;
    if (isThematicBreak(line)) return true;

    return /^(?:\*\*[^*\n].*\*\*|__[^_\n].*__)$/.test(trimmed);
}

function isExpectedNextOrderedMarker(current: OrderedListMarker, next: OrderedListMarker): boolean {
    return next.number === current.number + 1 || next.number === 1;
}

function findNextOrderedMarkerIndex(
    lines: readonly string[],
    startIndex: number,
    marker: OrderedListMarker,
): number | null {
    for (let index = startIndex; index < lines.length; index++) {
        const line = lines[index] ?? '';
        if (isBlankLine(line)) continue;

        const nextMarker = parseOrderedListMarker(line);
        if (!nextMarker) return null;

        return nextMarker.indent.length === marker.indent.length &&
            isExpectedNextOrderedMarker(marker, nextMarker)
            ? index
            : null;
    }

    return null;
}

function isOutlineStyleMarker(marker: OrderedListMarker): boolean {
    const content = marker.content.trim();
    if (!content) return true;
    if (content.endsWith(':')) return true;
    if (/^(?:\*\*[^*\n]+\*\*|__[^_\n]+__)$/.test(content)) return true;
    if (/[.!?]$/.test(content)) return false;

    return content.length <= 96;
}

function shouldNormalizeLooseContinuation(
    lines: readonly string[],
    marker: OrderedListMarker,
    continuationStartIndex: number,
): number | null {
    if (!isOutlineStyleMarker(marker)) return null;

    const firstContinuationLine = lines[continuationStartIndex] ?? '';
    if (!firstContinuationLine || isBlankLine(firstContinuationLine)) return null;
    if (parseOrderedListMarker(firstContinuationLine)) return null;
    if (isBlockBoundary(firstContinuationLine)) return null;
    if (readLeadingSpaceCount(firstContinuationLine) > marker.indent.length) return null;

    return findNextOrderedMarkerIndex(lines, continuationStartIndex + 1, marker);
}

function indentLooseContinuationLine(line: string, continuationIndent: string): string {
    if (isBlankLine(line)) return line;
    if (readLeadingSpaceCount(line) >= continuationIndent.length) return line;
    return `${continuationIndent}${line}`;
}

/**
 * LLMs often emit "outline" markdown as:
 *
 * 1. **Short title**
 *
 * Description paragraph.
 *
 * CommonMark treats that description as a paragraph outside the list item unless
 * it is indented. Normalize only clear ordered-list outline continuations so the
 * transcript renders the intended structure without changing unrelated prose.
 */
export function normalizeLooseListContinuations(markdown: string): string {
    const lines = markdown.split('\n');
    let changed = false;

    for (let index = 0; index < lines.length; index++) {
        const openingFence = parseOpeningCodeFence(lines[index] ?? '');
        if (openingFence) {
            index++;
            while (index < lines.length && !isClosingCodeFence(lines[index] ?? '', openingFence)) {
                index++;
            }
            continue;
        }

        const marker = parseOrderedListMarker(lines[index] ?? '');
        if (!marker) continue;

        let continuationStartIndex = index + 1;
        while (continuationStartIndex < lines.length && isBlankLine(lines[continuationStartIndex] ?? '')) {
            continuationStartIndex++;
        }

        const nextMarkerIndex = shouldNormalizeLooseContinuation(lines, marker, continuationStartIndex);
        if (nextMarkerIndex === null) {
            continue;
        }

        const continuationIndent = `${marker.indent}${' '.repeat(marker.marker.length + 1)}`;
        let continuationEndIndex = continuationStartIndex;
        while (continuationEndIndex < nextMarkerIndex) {
            const line = lines[continuationEndIndex] ?? '';
            if (parseOrderedListMarker(line)) break;
            if (isBlockBoundary(line)) break;
            continuationEndIndex++;
        }

        for (let lineIndex = continuationStartIndex; lineIndex < continuationEndIndex; lineIndex++) {
            const line = lines[lineIndex] ?? '';
            const indentedLine = indentLooseContinuationLine(line, continuationIndent);
            if (indentedLine !== line) {
                lines[lineIndex] = indentedLine;
                changed = true;
            }
        }

        index = continuationEndIndex - 1;
    }

    return changed ? lines.join('\n') : markdown;
}
