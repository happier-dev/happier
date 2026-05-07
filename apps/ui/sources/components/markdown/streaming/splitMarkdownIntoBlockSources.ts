import { readIncompleteMarkdownBlockKind, type IncompleteMarkdownBlockKind } from './isIncompleteMarkdownBlockSource';

const MIN_CODE_FENCE_LENGTH = 3;
const MAX_CODE_FENCE_INDENT = 3;

type CodeFenceMarker = '`' | '~';

type OpeningCodeFence = Readonly<{
    marker: CodeFenceMarker;
    length: number;
}>;

export type MarkdownBlockSource = Readonly<{
    index: number;
    source: string;
    incompleteKind: IncompleteMarkdownBlockKind | null;
}>;

function parseOpeningCodeFence(line: string): OpeningCodeFence | null {
    const match = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
    if (!match) return null;
    if (match[1].length > MAX_CODE_FENCE_INDENT) return null;

    const fence = match[2];
    if (fence.length < MIN_CODE_FENCE_LENGTH) return null;
    if (fence[0] === '`' && match[3].trim().includes('`')) return null;

    return {
        marker: fence[0] as CodeFenceMarker,
        length: fence.length,
    };
}

function isClosingCodeFence(line: string, openingFence: OpeningCodeFence): boolean {
    const match = line.match(/^( {0,3})(`{3,}|~{3,})[ \t]*$/);
    if (!match) return false;

    const fence = match[2];
    return fence[0] === openingFence.marker && fence.length >= openingFence.length;
}

function getListLineKind(line: string): 'bullet' | 'numbered' | null {
    if (/^(\s*)-\s+(.*)$/.test(line)) return 'bullet';
    if (/^(\s*)(\d+)\.\s+(.*)$/.test(line)) return 'numbered';
    return null;
}

function isTableSeparator(line: string): boolean {
    const separatorLine = line.trim();
    return /^[|\s\-:=]*$/.test(separatorLine) && separatorLine.includes('-');
}

function buildSource(lines: string[], startIndex: number, endIndex: number, sourceIndex: number): MarkdownBlockSource {
    const source = lines.slice(startIndex, endIndex).join('\n');
    return {
        index: sourceIndex,
        source,
        incompleteKind: readIncompleteMarkdownBlockKind(source),
    };
}

export function splitMarkdownIntoBlockSources(markdown: string): MarkdownBlockSource[] {
    const lines = markdown.split('\n');
    const sources: MarkdownBlockSource[] = [];
    let index = 0;

    while (index < lines.length) {
        const startIndex = index;
        const line = lines[index] ?? '';
        const trimmed = line.trim();

        if (trimmed.length === 0) {
            index++;
            continue;
        }

        const openingFence = parseOpeningCodeFence(line);
        if (openingFence) {
            index++;
            while (index < lines.length) {
                const nextLine = lines[index] ?? '';
                index++;
                if (isClosingCodeFence(nextLine, openingFence)) {
                    break;
                }
            }
            sources.push(buildSource(lines, startIndex, index, sources.length));
            continue;
        }

        if (trimmed.startsWith('<options>')) {
            index++;
            while (index < lines.length) {
                const nextLine = lines[index] ?? '';
                index++;
                if (nextLine.trim() === '</options>') {
                    break;
                }
            }
            sources.push(buildSource(lines, startIndex, index, sources.length));
            continue;
        }

        const listKind = getListLineKind(line);
        if (listKind) {
            index++;
            while (index < lines.length && getListLineKind(lines[index] ?? '') === listKind) {
                index++;
            }
            sources.push(buildSource(lines, startIndex, index, sources.length));
            continue;
        }

        if (line.includes('|')) {
            index++;
            while (index < lines.length && (lines[index] ?? '').includes('|')) {
                index++;
            }
            const tableLines = lines.slice(startIndex, index);
            if (tableLines.length >= 2 && isTableSeparator(tableLines[1] ?? '')) {
                sources.push(buildSource(lines, startIndex, index, sources.length));
                continue;
            }
            index = startIndex + 1;
        } else {
            index++;
        }

        sources.push(buildSource(lines, startIndex, index, sources.length));
    }

    return sources;
}
