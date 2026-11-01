import type { MarkdownBlock, MarkdownSourceRange, MarkdownTableAlignment } from "./parseMarkdown";
import { parseMarkdownSpans } from "./parseMarkdownSpans";

const MIN_CODE_FENCE_LENGTH = 3;
const MAX_CODE_FENCE_INDENT = 3;

type CodeFenceMarker = '`' | '~';

type OpeningCodeFence = {
    marker: CodeFenceMarker;
    length: number;
    indent: number;
    language: string | null;
};

type ParseMarkdownBlockOptions = Readonly<{
    includeSourceRanges?: boolean;
}>;

function buildSourceRange(startIndex: number, endExclusiveIndex: number): MarkdownSourceRange {
    return {
        startLine: startIndex + 1,
        endLine: Math.max(startIndex + 1, endExclusiveIndex),
    };
}

function withSourceRange<T extends MarkdownBlock>(
    block: T,
    options: ParseMarkdownBlockOptions,
    startIndex: number,
    endExclusiveIndex: number,
): T {
    if (options.includeSourceRanges !== true) return block;
    return {
        ...block,
        sourceRange: buildSourceRange(startIndex, endExclusiveIndex),
    };
}

function maybeSourceRange(
    options: ParseMarkdownBlockOptions,
    startIndex: number,
    endExclusiveIndex: number,
): MarkdownSourceRange | undefined {
    return options.includeSourceRanges === true ? buildSourceRange(startIndex, endExclusiveIndex) : undefined;
}

function getListIndentDepth(rawLine: string): number {
    const leadingSpaces = rawLine.match(/^\s*/)?.[0].length ?? 0;
    return Math.floor(leadingSpaces / 2);
}

function parseOpeningCodeFence(line: string): OpeningCodeFence | null {
    const match = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
    if (!match) return null;

    const indent = match[1].length;
    if (indent > MAX_CODE_FENCE_INDENT) return null;

    const fence = match[2];
    const marker = fence[0] as CodeFenceMarker;
    if (fence.length < MIN_CODE_FENCE_LENGTH) return null;

    const infoString = match[3].trim();
    if (marker === '`' && infoString.includes('`')) return null;

    return {
        marker,
        length: fence.length,
        indent,
        language: infoString || null,
    };
}

function isClosingCodeFence(line: string, openingFence: OpeningCodeFence): boolean {
    const match = line.match(/^( {0,3})(`{3,}|~{3,})[ \t]*$/);
    if (!match) return false;

    const fence = match[2];
    return fence[0] === openingFence.marker && fence.length >= openingFence.length;
}

function removeCodeFenceContentIndent(line: string, indent: number): string {
    if (indent <= 0) return line;

    let removableSpaces = 0;
    while (removableSpaces < indent && line[removableSpaces] === ' ') {
        removableSpaces++;
    }
    return line.slice(removableSpaces);
}

/**
 * Trims empty strings that result from leading/trailing pipe characters,
 * while preserving intentionally empty cells in the middle of the row.
 *
 * Example: "| A | | C |".split('|') = ['', ' A ', ' ', ' C ', '']
 * After trim: ['A', '', 'C'] - preserves the empty middle cell
 */
function trimPipeArtifacts(cells: string[]): string[] {
    let result = cells;
    // Remove leading empty string from "|..."
    if (result.length > 0 && result[0] === '') {
        result = result.slice(1);
    }
    // Remove trailing empty string from "...|"
    if (result.length > 0 && result[result.length - 1] === '') {
        result = result.slice(0, -1);
    }
    return result;
}

// GFM: `\|` is a literal pipe inside a cell (code spans included); every other `|` delimits a cell.
function splitTableRowCells(line: string): string[] {
    const cells: string[] = [];
    let current = '';
    for (let index = 0; index < line.length; index++) {
        const char = line[index];
        if (char === '\\' && line[index + 1] === '|') {
            current += '|';
            index++;
            continue;
        }
        if (char === '|') {
            cells.push(current.trim());
            current = '';
            continue;
        }
        current += char;
    }
    cells.push(current.trim());
    return trimPipeArtifacts(cells);
}

function parseTableAlignment(separatorCell: string): MarkdownTableAlignment {
    const cell = separatorCell.trim();
    const startsWithColon = cell.startsWith(':');
    const endsWithColon = cell.endsWith(':');

    if (startsWithColon && endsWithColon) return 'center';
    if (startsWithColon) return 'left';
    if (endsWithColon) return 'right';
    return 'default';
}

function parseTable(lines: string[], startIndex: number, options: ParseMarkdownBlockOptions): { table: MarkdownBlock | null; nextIndex: number } {
    let index = startIndex;
    const tableLines: string[] = [];

    // Collect consecutive lines that contain pipe characters to identify potential table rows
    while (index < lines.length && lines[index].includes('|')) {
        tableLines.push(lines[index]);
        index++;
    }

    if (tableLines.length < 2) {
        return { table: null, nextIndex: startIndex };
    }

    // Validate that the second line is a separator containing dashes, which distinguishes tables from plain text
    const separatorLine = tableLines[1].trim();
    const isSeparator = /^[|\s\-:=]*$/.test(separatorLine) && separatorLine.includes('-');

    if (!isSeparator) {
        return { table: null, nextIndex: startIndex };
    }

    // Extract header cells from the first line, trimming only leading/trailing pipe artifacts
    const headerLine = tableLines[0].trim();
    const headers = splitTableRowCells(headerLine);

    if (headers.length === 0) {
        return { table: null, nextIndex: startIndex };
    }

    const separatorCells = splitTableRowCells(separatorLine);
    const alignments = headers.map((_, columnIndex) =>
        parseTableAlignment(separatorCells[columnIndex] ?? '')
    );

    // Extract data rows from remaining lines (skipping the separator line), preserving empty cells
    const rows: string[][] = [];
    for (let i = 2; i < tableLines.length; i++) {
        const rowLine = tableLines[i].trim();
        if (rowLine.startsWith('|')) {
            const rowCells = splitTableRowCells(rowLine);

            // Pad row to match header count (handles rows with fewer cells)
            while (rowCells.length < headers.length) {
                rowCells.push('');
            }

            // Include rows (even if all cells are empty, as long as they have pipe structure)
            rows.push(rowCells);
        }
    }

    const table: MarkdownBlock = withSourceRange({
        type: 'table',
        headers,
        rows,
        alignments,
    }, options, startIndex, index);

    return { table, nextIndex: index };
}

/** Only a complete, dedicated option line is an interactive choice. */
export function readMarkdownOption(line: string): string | null {
    return line.trim().match(/^<option>(.*?)<\/option>$/)?.[1] ?? null;
}

export function parseMarkdownBlock(markdown: string, options: ParseMarkdownBlockOptions = {}) {
    const blocks: MarkdownBlock[] = [];
    const lines = markdown.split('\n');
    let index = 0;
    outer: while (index < lines.length) {
        const startIndex = index;
        const line = lines[index];
        index++;

        // Headers
        for (let i = 1; i <= 6; i++) {
            if (line.startsWith(`${'#'.repeat(i)} `)) {
                blocks.push(withSourceRange({
                    type: 'header',
                    level: i as 1 | 2 | 3 | 4 | 5 | 6,
                    content: parseMarkdownSpans(line.slice(i + 1).trim(), true),
                }, options, startIndex, index));
                continue outer;
            }
        }

        // Trim
        const trimmed = line.trim();

        // Code block
        const openingCodeFence = parseOpeningCodeFence(line);
        if (openingCodeFence) {
            const content: string[] = [];
            while (index < lines.length) {
                const nextLine = lines[index];
                if (isClosingCodeFence(nextLine, openingCodeFence)) {
                    index++;
                    break;
                }
                content.push(removeCodeFenceContentIndent(nextLine, openingCodeFence.indent));
                index++;
            }
            const contentString = content.join('\n');

            // Detect mermaid diagram language and route to appropriate block type
            if (openingCodeFence.language === 'mermaid') {
                blocks.push(withSourceRange({ type: 'mermaid', content: contentString }, options, startIndex, index));
            } else {
                blocks.push(withSourceRange({
                    type: 'code-block',
                    language: openingCodeFence.language,
                    content: contentString,
                }, options, startIndex, index));
            }
            continue;
        }

        // Horizontal rule
        if (trimmed === '---') {
            blocks.push(withSourceRange({ type: 'horizontal-rule' }, options, startIndex, index));
            continue;
        }

        // Options block
        const hasOptionsWrapper = trimmed.startsWith('<options>');
        const firstOption = readMarkdownOption(line);
        if (hasOptionsWrapper || firstOption !== null) {
            const items: string[] = firstOption === null ? [] : [firstOption];
            while (index < lines.length) {
                const nextLine = lines[index];
                if (nextLine.trim() === '</options>') {
                    index++;
                    break;
                }
                const option = readMarkdownOption(nextLine);
                if (option !== null) {
                    items.push(option);
                } else if (!hasOptionsWrapper) {
                    // Continuations have no enclosing block to delimit unrelated prose.
                    break;
                }
                index++;
            }
            if (items.length > 0) {
                blocks.push(withSourceRange({ type: 'options', items }, options, startIndex, index));
            }
            continue;
        }

        // If it is a numbered list
        const numberedListMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
        if (numberedListMatch) {
            let allLines = [{
                depth: getListIndentDepth(line),
                number: parseInt(numberedListMatch[2]),
                content: numberedListMatch[3],
                sourceIndex: startIndex,
            }];
            while (index < lines.length) {
                const nextLine = lines[index];
                const nextMatch = nextLine.match(/^(\s*)(\d+)\.\s+(.*)$/);
                if (!nextMatch) break;
                allLines.push({
                    depth: getListIndentDepth(nextLine),
                    number: parseInt(nextMatch[2]),
                    content: nextMatch[3],
                    sourceIndex: index,
                });
                index++;
            }
            blocks.push(withSourceRange({
                type: 'numbered-list',
                items: allLines.map((l) => ({
                    depth: l.depth,
                    number: l.number,
                    spans: parseMarkdownSpans(l.content, false),
                    sourceRange: maybeSourceRange(options, l.sourceIndex, l.sourceIndex + 1),
                })),
            }, options, startIndex, index));
            continue;
        }

        // If it is a list
        const bulletListMatch = line.match(/^(\s*)-\s+(.*)$/);
        if (bulletListMatch) {
            let allLines = [{ depth: getListIndentDepth(line), content: bulletListMatch[2], sourceIndex: startIndex }];
            while (index < lines.length) {
                const nextLine = lines[index];
                const nextMatch = nextLine.match(/^(\s*)-\s+(.*)$/);
                if (!nextMatch) break;
                allLines.push({ depth: getListIndentDepth(nextLine), content: nextMatch[2], sourceIndex: index });
                index++;
            }
            blocks.push(withSourceRange({
                type: 'list',
                items: allLines.map((l) => ({
                    depth: l.depth,
                    spans: parseMarkdownSpans(l.content, false),
                    sourceRange: maybeSourceRange(options, l.sourceIndex, l.sourceIndex + 1),
                })),
            }, options, startIndex, index));
            continue;
        }

        // Check for table
        if (trimmed.includes('|') && !trimmed.startsWith('```')) {
            const { table, nextIndex } = parseTable(lines, index - 1, options);
            if (table) {
                blocks.push(table);
                index = nextIndex;
                continue outer;
            }
        }

        // Fallback
        if (trimmed.length > 0) {
            blocks.push(withSourceRange({
                type: 'text',
                content: parseMarkdownSpans(trimmed, false),
            }, options, startIndex, index));
        }
    }
    return blocks;
}
