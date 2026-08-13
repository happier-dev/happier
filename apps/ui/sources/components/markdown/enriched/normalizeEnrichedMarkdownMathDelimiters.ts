function withoutCarriageReturn(line: string): Readonly<{ text: string; suffix: string }> {
    return line.endsWith('\r')
        ? { text: line.slice(0, -1), suffix: '\r' }
        : { text: line, suffix: '' };
}

function isUnescapedAt(value: string, index: number): boolean {
    let precedingBackslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
        precedingBackslashes += 1;
    }
    return precedingBackslashes % 2 === 0;
}

function findUnescapedSequence(value: string, sequence: string, start: number): number {
    let index = value.indexOf(sequence, start);
    while (index >= 0) {
        if (isUnescapedAt(value, index)) return index;
        index = value.indexOf(sequence, index + sequence.length);
    }
    return -1;
}

function findInlineMathClosingDelimiter(value: string, start: number): number {
    for (let index = start; index < value.length - 1; index += 1) {
        if (value[index] !== '\\' || !isUnescapedAt(value, index)) continue;

        const delimiter = value[index + 1];
        if (delimiter === '(') return -1;
        if (delimiter === ')') return index;
    }
    return -1;
}

function findBalancedClosingDelimiter(
    value: string,
    openingIndex: number,
    opening: '[' | '(',
    closing: ']' | ')',
): number {
    let depth = 0;
    for (let index = openingIndex; index < value.length; index += 1) {
        const char = value[index];
        if (char === '\\') {
            index += 1;
            continue;
        }
        if (char === opening) {
            depth += 1;
            continue;
        }
        if (char !== closing) continue;
        depth -= 1;
        if (depth === 0) return index;
    }
    return -1;
}

function findProtectedBracketEnd(line: string, openingIndex: number): number {
    const labelEnd = findBalancedClosingDelimiter(line, openingIndex, '[', ']');
    if (labelEnd < 0) return line.length;

    const destinationStart = labelEnd + 1;
    if (line[destinationStart] === '(') {
        const destinationEnd = findBalancedClosingDelimiter(line, destinationStart, '(', ')');
        return destinationEnd < 0 ? line.length : destinationEnd + 1;
    }
    if (line[destinationStart] === '[') {
        const referenceEnd = findBalancedClosingDelimiter(line, destinationStart, '[', ']');
        return referenceEnd < 0 ? line.length : referenceEnd + 1;
    }
    if (line[destinationStart] === ':') {
        return line.length;
    }
    return labelEnd + 1;
}

function findCodeSpanEnd(line: string, openingIndex: number): number {
    let runLength = 1;
    while (line[openingIndex + runLength] === '`') runLength += 1;

    let cursor = openingIndex + runLength;
    while (cursor < line.length) {
        const candidate = line.indexOf('`', cursor);
        if (candidate < 0) return line.length;

        let candidateLength = 1;
        while (line[candidate + candidateLength] === '`') candidateLength += 1;
        if (candidateLength === runLength) return candidate + candidateLength;
        cursor = candidate + candidateLength;
    }
    return line.length;
}

function findBareUrlEnd(line: string, openingIndex: number): number | null {
    const scheme = line.slice(openingIndex, openingIndex + 'https://'.length).toLowerCase();
    if (
        !scheme.startsWith('https://')
        && !scheme.startsWith('http://')
        && !scheme.startsWith('www.')
    ) {
        return null;
    }

    let cursor = openingIndex;
    while (cursor < line.length && !/[\s<]/.test(line[cursor]!)) cursor += 1;
    return cursor;
}

function findProtectedInlineRegionEnd(line: string, openingIndex: number): number | null {
    const char = line[openingIndex]!;
    const lowerChar = char.toLowerCase();
    const bareUrlEnd = lowerChar === 'h' || lowerChar === 'w'
        ? findBareUrlEnd(line, openingIndex)
        : null;
    if (bareUrlEnd !== null) return bareUrlEnd;

    if (char === '`' && isUnescapedAt(line, openingIndex)) {
        return findCodeSpanEnd(line, openingIndex);
    }

    if (char === '[' && isUnescapedAt(line, openingIndex)) {
        return findProtectedBracketEnd(line, openingIndex);
    }

    if (char !== '<' || !isUnescapedAt(line, openingIndex)) return null;
    const autolinkEnd = line.indexOf('>', openingIndex + 1);
    return autolinkEnd < 0 ? null : autolinkEnd + 1;
}

function normalizeInlineMathDelimiters(line: string): string {
    let output = '';
    let index = 0;

    while (index < line.length) {
        const char = line[index]!;

        const protectedEnd = findProtectedInlineRegionEnd(line, index);
        if (protectedEnd !== null) {
            output += line.slice(index, protectedEnd);
            index = protectedEnd;
            continue;
        }

        if (
            char === '\\' &&
            line[index + 1] === '(' &&
            isUnescapedAt(line, index)
        ) {
            const closingIndex = findInlineMathClosingDelimiter(line, index + 2);
            if (closingIndex >= 0) {
                const expression = line.slice(index + 2, closingIndex).trim();
                if (expression.length > 0) {
                    output += `$${expression}$`;
                    index = closingIndex + 2;
                    continue;
                }
            }
        }

        output += char;
        index += 1;
    }

    return output;
}

function isWhitespaceOrPunctuation(char: string | undefined): boolean {
    return char === undefined || /[\s\p{P}\p{S}]/u.test(char);
}

function containsDollarMathDelimiters(line: string): boolean {
    let openerLength: number | null = null;
    let index = 0;

    while (index < line.length) {
        const char = line[index]!;

        const protectedEnd = findProtectedInlineRegionEnd(line, index);
        if (protectedEnd !== null) {
            index = protectedEnd;
            continue;
        }

        if (char !== '$' || !isUnescapedAt(line, index)) {
            index += 1;
            continue;
        }

        let delimiterEnd = index + 1;
        while (line[delimiterEnd] === '$') delimiterEnd += 1;
        const delimiterLength = delimiterEnd - index;
        if (delimiterLength > 2) {
            index = delimiterEnd;
            continue;
        }

        const canOpen = isWhitespaceOrPunctuation(line[index - 1]);
        const canClose = isWhitespaceOrPunctuation(line[delimiterEnd]);
        if (canClose && openerLength === delimiterLength) return true;
        if (canOpen) openerLength = delimiterLength;
        index = delimiterEnd;
    }

    return false;
}

function replaceStandaloneDelimiter(line: string, delimiter: '\\[' | '\\]'): string {
    const delimiterIndex = line.indexOf(delimiter);
    return `${line.slice(0, delimiterIndex)}$$${line.slice(delimiterIndex + delimiter.length)}`;
}

function normalizeClosedSingleLineDisplayMath(line: string): string | null {
    const firstNonWhitespace = line.search(/\S/);
    if (firstNonWhitespace < 0 || !line.startsWith('\\[', firstNonWhitespace)) return null;

    const closingIndex = findUnescapedSequence(line, '\\]', firstNonWhitespace + 2);
    if (closingIndex < 0 || line.slice(closingIndex + 2).trim().length > 0) return null;

    const expression = line.slice(firstNonWhitespace + 2, closingIndex).trim();
    if (!expression) return null;

    return `${line.slice(0, firstNonWhitespace)}$$${expression}$$${line.slice(closingIndex + 2)}`;
}

type MarkdownListContext = Readonly<{
    quoteDepth: number;
    contentIndent: number;
}>;

type MarkdownListMarker = Readonly<{
    markerIndent: number;
    contentIndent: number;
    contentOffset: number;
}>;

type MarkdownFence = Readonly<{
    marker: '`' | '~';
    length: number;
    quoteDepth: number;
    contentIndent: number;
}>;

function readIndent(value: string, start = 0): Readonly<{ columns: number; offset: number }> {
    let columns = 0;
    let offset = start;
    while (offset < value.length) {
        const char = value[offset];
        if (char === ' ') {
            columns += 1;
            offset += 1;
            continue;
        }
        if (char === '\t') {
            columns += 4 - (columns % 4);
            offset += 1;
            continue;
        }
        break;
    }
    return { columns, offset };
}

function stripBlockquotePrefix(line: string): Readonly<{
    content: string;
    contentOffset: number;
    quoteDepth: number;
}> {
    let offset = 0;
    let quoteDepth = 0;

    while (offset < line.length) {
        let cursor = offset;
        let leadingSpaces = 0;
        while (leadingSpaces < 3 && line[cursor] === ' ') {
            cursor += 1;
            leadingSpaces += 1;
        }
        if (line[cursor] !== '>') break;

        cursor += 1;
        if (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
        offset = cursor;
        quoteDepth += 1;
    }

    return { content: line.slice(offset), contentOffset: offset, quoteDepth };
}

function parseMarkdownListMarker(content: string): MarkdownListMarker | null {
    const indentation = readIndent(content);
    let cursor = indentation.offset;
    const markerStart = cursor;
    const marker = content[cursor];

    if (marker === '-' || marker === '+' || marker === '*') {
        cursor += 1;
    } else {
        let digits = 0;
        while (digits < 9 && /[0-9]/.test(content[cursor] ?? '')) {
            cursor += 1;
            digits += 1;
        }
        if (digits === 0 || (content[cursor] !== '.' && content[cursor] !== ')')) return null;
        cursor += 1;
    }

    if (cursor >= content.length) {
        const markerWidth = cursor - markerStart;
        return {
            markerIndent: indentation.columns,
            contentIndent: indentation.columns + markerWidth + 1,
            contentOffset: cursor,
        };
    }
    if (content[cursor] !== ' ' && content[cursor] !== '\t') return null;

    const padding = readIndent(content, cursor);
    const paddingColumns = padding.columns;
    const markerWidth = cursor - markerStart;
    const consumedPaddingColumns = paddingColumns > 4 ? 1 : Math.max(paddingColumns, 1);
    let contentOffset = cursor;
    let consumedColumns = 0;
    while (contentOffset < padding.offset && consumedColumns < consumedPaddingColumns) {
        const char = content[contentOffset];
        consumedColumns += char === '\t' ? 4 - (consumedColumns % 4) : 1;
        contentOffset += 1;
    }

    return {
        markerIndent: indentation.columns,
        contentIndent: indentation.columns + markerWidth + consumedPaddingColumns,
        contentOffset,
    };
}

function offsetAfterIndent(value: string, columns: number): number {
    if (columns <= 0) return 0;
    const indentation = readIndent(value);
    if (indentation.columns < columns) return indentation.offset;

    let consumedColumns = 0;
    let offset = 0;
    while (offset < indentation.offset && consumedColumns < columns) {
        const char = value[offset];
        consumedColumns += char === '\t' ? 4 - (consumedColumns % 4) : 1;
        offset += 1;
    }
    return offset;
}

function sliceAfterIndent(value: string, columns: number): string {
    return value.slice(offsetAfterIndent(value, columns));
}

function findOpeningFence(content: string): Readonly<{ marker: '`' | '~'; length: number }> | null {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(content);
    if (!match) return null;
    const run = match[1]!;
    return { marker: run[0] as '`' | '~', length: run.length };
}

function isClosingFence(content: string, fence: MarkdownFence): boolean {
    const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(content);
    return Boolean(match && match[1]![0] === fence.marker && match[1]!.length >= fence.length);
}

/**
 * Maps the TeX delimiters emitted by coding agents onto the `$` / `$$`
 * contract understood by react-native-enriched-markdown. Top-level fenced
 * blocks are separated by splitMarkdownRenderSegments; nested fences,
 * indented code, and inline Markdown-owned regions are kept literal so code,
 * links, and URLs cannot accidentally become math.
 */
export function normalizeEnrichedMarkdownMathDelimiters(markdown: string): string {
    const lines = markdown.split('\n');
    const output: string[] = [];
    const listStack: MarkdownListContext[] = [];
    let pendingDisplay: Readonly<{
        lines: string[];
        quoteDepth: number;
        contentIndent: number;
    }> | null = null;
    let fencedCode: MarkdownFence | null = null;

    for (let index = 0; index < lines.length; index += 1) {
        const originalLine = lines[index]!;
        const { text: line, suffix } = withoutCarriageReturn(originalLine);
        const blockquote = stripBlockquotePrefix(line);

        if (pendingDisplay) {
            const pendingContainerContent = pendingDisplay.quoteDepth === blockquote.quoteDepth
                ? sliceAfterIndent(blockquote.content, pendingDisplay.contentIndent)
                : null;

            if (pendingContainerContent?.trim() === '\\[') {
                output.push(...pendingDisplay.lines);
                pendingDisplay = {
                    ...pendingDisplay,
                    lines: [originalLine],
                };
                continue;
            }

            if (pendingContainerContent?.trim() === '\\]') {
                const openingLine = withoutCarriageReturn(pendingDisplay.lines[0]!);
                output.push(`${replaceStandaloneDelimiter(openingLine.text, '\\[')}${openingLine.suffix}`);
                output.push(...pendingDisplay.lines.slice(1));
                output.push(`${replaceStandaloneDelimiter(line, '\\]')}${suffix}`);
                pendingDisplay = null;
                continue;
            }

            pendingDisplay.lines.push(originalLine);
            continue;
        }

        if (fencedCode) {
            output.push(originalLine);
            const fenceContent = fencedCode.quoteDepth === blockquote.quoteDepth
                ? sliceAfterIndent(blockquote.content, fencedCode.contentIndent)
                : blockquote.content;
            if (isClosingFence(fenceContent, fencedCode)) fencedCode = null;
            continue;
        }

        if (listStack[listStack.length - 1]?.quoteDepth !== blockquote.quoteDepth) {
            listStack.length = 0;
        }

        const indentation = readIndent(blockquote.content);
        const markerCandidate = parseMarkdownListMarker(blockquote.content);
        let listMarker: MarkdownListMarker | null = null;

        if (markerCandidate) {
            while (
                listStack.length > 0
                && markerCandidate.markerIndent < listStack[listStack.length - 1]!.contentIndent
            ) {
                listStack.pop();
            }
            const parentIndent = listStack[listStack.length - 1]?.contentIndent ?? 0;
            if (markerCandidate.markerIndent <= parentIndent + 3) {
                listMarker = markerCandidate;
                listStack.push({
                    quoteDepth: blockquote.quoteDepth,
                    contentIndent: markerCandidate.contentIndent,
                });
            }
        }

        if (!listMarker && blockquote.content.trim().length > 0) {
            while (
                listStack.length > 0
                && indentation.columns < listStack[listStack.length - 1]!.contentIndent
            ) {
                listStack.pop();
            }
        }

        const containerIndent = listMarker?.contentIndent
            ?? listStack[listStack.length - 1]?.contentIndent
            ?? 0;
        const containerContent = listMarker
            ? blockquote.content.slice(listMarker.contentOffset)
            : sliceAfterIndent(blockquote.content, containerIndent);
        const containerContentOffset = blockquote.contentOffset + (
            listMarker?.contentOffset
            ?? offsetAfterIndent(blockquote.content, containerIndent)
        );
        const isIndentedCode = listMarker
            ? readIndent(containerContent).columns >= 4
            : indentation.columns >= containerIndent + 4;
        if (isIndentedCode) {
            output.push(originalLine);
            continue;
        }

        const openingFence = findOpeningFence(containerContent);
        if (openingFence) {
            fencedCode = {
                ...openingFence,
                quoteDepth: blockquote.quoteDepth,
                contentIndent: containerIndent,
            };
            output.push(originalLine);
            continue;
        }

        if (containerContent.trim() === '\\[') {
            pendingDisplay = {
                lines: [originalLine],
                quoteDepth: blockquote.quoteDepth,
                contentIndent: containerIndent,
            };
            continue;
        }

        const singleLineDisplay = normalizeClosedSingleLineDisplayMath(containerContent);
        output.push(singleLineDisplay === null
            ? `${normalizeInlineMathDelimiters(line)}${suffix}`
            : `${line.slice(0, containerContentOffset)}${singleLineDisplay}${suffix}`);
    }

    if (pendingDisplay) output.push(...pendingDisplay.lines);

    return output.join('\n');
}

/**
 * Returns whether a small Markdown fragment contains math that the enriched
 * renderer can parse. This lets legacy-owned containers such as table cells
 * opt into the math-capable renderer without changing plain-cell behavior.
 */
export function containsRenderableEnrichedMarkdownMath(markdown: string): boolean {
    if (normalizeEnrichedMarkdownMathDelimiters(markdown) !== markdown) return true;

    return markdown.split('\n').some((originalLine) => {
        const { text: line } = withoutCarriageReturn(originalLine);
        if (line.startsWith('\t') || line.startsWith('    ')) return false;
        return containsDollarMathDelimiters(line);
    });
}
