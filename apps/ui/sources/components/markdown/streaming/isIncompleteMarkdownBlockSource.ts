const MIN_CODE_FENCE_LENGTH = 3;
const MAX_CODE_FENCE_INDENT = 3;

type CodeFenceMarker = '`' | '~';

type OpeningCodeFence = Readonly<{
    marker: CodeFenceMarker;
    length: number;
}>;

export type IncompleteMarkdownBlockKind = 'code-fence' | 'mermaid-fence' | 'options' | 'table';

function parseOpeningCodeFence(line: string): (OpeningCodeFence & { language: string | null }) | null {
    const match = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
    if (!match) return null;
    if (match[1].length > MAX_CODE_FENCE_INDENT) return null;

    const fence = match[2];
    if (fence.length < MIN_CODE_FENCE_LENGTH) return null;

    const marker = fence[0] as CodeFenceMarker;
    const infoString = match[3].trim();
    if (marker === '`' && infoString.includes('`')) return null;

    return {
        marker,
        length: fence.length,
        language: infoString || null,
    };
}

function isClosingCodeFence(line: string, openingFence: OpeningCodeFence): boolean {
    const match = line.match(/^( {0,3})(`{3,}|~{3,})[ \t]*$/);
    if (!match) return false;

    const fence = match[2];
    return fence[0] === openingFence.marker && fence.length >= openingFence.length;
}

function isTableSeparator(line: string): boolean {
    const separatorLine = line.trim();
    return /^[|\s\-:=]*$/.test(separatorLine) && separatorLine.includes('-');
}

export function readIncompleteMarkdownBlockKind(source: string): IncompleteMarkdownBlockKind | null {
    const firstBreak = source.indexOf('\n');
    const firstLine = firstBreak < 0 ? source : source.slice(0, firstBreak);
    const openingFence = parseOpeningCodeFence(firstLine);
    if (openingFence) {
        // A settled fence normally ends at its closing marker. Its body can be large.
        if (firstBreak >= 0 && isClosingCodeFence(source.slice(source.lastIndexOf('\n') + 1), openingFence)) {
            return null;
        }
        const closed = firstBreak >= 0 && source.slice(firstBreak + 1).split('\n')
            .some((line) => isClosingCodeFence(line, openingFence));
        return closed ? null : openingFence.language === 'mermaid' ? 'mermaid-fence' : 'code-fence';
    }

    const trimmedFirstLine = firstLine.trim();
    if (trimmedFirstLine.startsWith('<options>')) {
        const closed = firstBreak >= 0 && source.slice(firstBreak + 1).split('\n').some((line) => line.trim() === '</options>');
        return closed ? null : 'options';
    }

    if (firstBreak >= 0 && firstLine.includes('|') && source.indexOf('\n', firstBreak + 1) < 0
        && isTableSeparator(source.slice(firstBreak + 1))) {
        return 'table';
    }

    return null;
}
