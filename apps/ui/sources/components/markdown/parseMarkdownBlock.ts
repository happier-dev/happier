import type { MarkdownBlock, MarkdownTableAlignment } from "./parseMarkdown";
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

function parseTableAlignment(separatorCell: string): MarkdownTableAlignment {
    const cell = separatorCell.trim();
    const startsWithColon = cell.startsWith(':');
    const endsWithColon = cell.endsWith(':');

    if (startsWithColon && endsWithColon) return 'center';
    if (startsWithColon) return 'left';
    if (endsWithColon) return 'right';
    return 'default';
}

function parseTable(lines: string[], startIndex: number): { table: MarkdownBlock | null; nextIndex: number } {
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
    const headers = trimPipeArtifacts(
        headerLine.split('|').map(cell => cell.trim())
    );

    if (headers.length === 0) {
        return { table: null, nextIndex: startIndex };
    }

    const separatorCells = trimPipeArtifacts(
        separatorLine.split('|').map(cell => cell.trim())
    );
    const alignments = headers.map((_, columnIndex) =>
        parseTableAlignment(separatorCells[columnIndex] ?? '')
    );

    // Extract data rows from remaining lines (skipping the separator line), preserving empty cells
    const rows: string[][] = [];
    for (let i = 2; i < tableLines.length; i++) {
        const rowLine = tableLines[i].trim();
        if (rowLine.startsWith('|')) {
            let rowCells = trimPipeArtifacts(
                rowLine.split('|').map(cell => cell.trim())
            );

            // Pad row to match header count (handles rows with fewer cells)
            while (rowCells.length < headers.length) {
                rowCells.push('');
            }

            // Include rows (even if all cells are empty, as long as they have pipe structure)
            rows.push(rowCells);
        }
    }

    const table: MarkdownBlock = {
        type: 'table',
        headers,
        rows,
        alignments,
    };

    return { table, nextIndex: index };
}

export function parseMarkdownBlock(markdown: string) {
    const blocks: MarkdownBlock[] = [];
    const lines = markdown.split('\n');
    let index = 0;
    outer: while (index < lines.length) {
        const line = lines[index];
        index++;

        // Headers
        for (let i = 1; i <= 6; i++) {
            if (line.startsWith(`${'#'.repeat(i)} `)) {
                blocks.push({ type: 'header', level: i as 1 | 2 | 3 | 4 | 5 | 6, content: parseMarkdownSpans(line.slice(i + 1).trim(), true) });
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
                blocks.push({ type: 'mermaid', content: contentString });
            } else {
                blocks.push({ type: 'code-block', language: openingCodeFence.language, content: contentString });
            }
            continue;
        }

        // Horizontal rule
        if (trimmed === '---') {
            blocks.push({ type: 'horizontal-rule' });
            continue;
        }

        // Options block
        if (trimmed.startsWith('<options>')) {
            let items: string[] = [];
            while (index < lines.length) {
                const nextLine = lines[index];
                if (nextLine.trim() === '</options>') {
                    index++;
                    break;
                }
                // Extract content from <option> tags
                const optionMatch = nextLine.match(/<option>(.*?)<\/option>/);
                if (optionMatch) {
                    items.push(optionMatch[1]);
                }
                index++;
            }
            if (items.length > 0) {
                blocks.push({ type: 'options', items });
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
            }];
            while (index < lines.length) {
                const nextLine = lines[index];
                const nextMatch = nextLine.match(/^(\s*)(\d+)\.\s+(.*)$/);
                if (!nextMatch) break;
                allLines.push({
                    depth: getListIndentDepth(nextLine),
                    number: parseInt(nextMatch[2]),
                    content: nextMatch[3],
                });
                index++;
            }
            blocks.push({
                type: 'numbered-list',
                items: allLines.map((l) => ({ depth: l.depth, number: l.number, spans: parseMarkdownSpans(l.content, false) })),
            });
            continue;
        }

        // If it is a list
        const bulletListMatch = line.match(/^(\s*)-\s+(.*)$/);
        if (bulletListMatch) {
            let allLines = [{ depth: getListIndentDepth(line), content: bulletListMatch[2] }];
            while (index < lines.length) {
                const nextLine = lines[index];
                const nextMatch = nextLine.match(/^(\s*)-\s+(.*)$/);
                if (!nextMatch) break;
                allLines.push({ depth: getListIndentDepth(nextLine), content: nextMatch[2] });
                index++;
            }
            blocks.push({
                type: 'list',
                items: allLines.map((l) => ({ depth: l.depth, spans: parseMarkdownSpans(l.content, false) })),
            });
            continue;
        }

        // Check for table
        if (trimmed.includes('|') && !trimmed.startsWith('```')) {
            const { table, nextIndex } = parseTable(lines, index - 1);
            if (table) {
                blocks.push(table);
                index = nextIndex;
                continue outer;
            }
        }

        // Fallback
        if (trimmed.length > 0) {
            blocks.push({ type: 'text', content: parseMarkdownSpans(trimmed, false) });
        }
    }
    return blocks;
}
