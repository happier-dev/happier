import type { CodeLine } from './codeLineTypes';

function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
    // @@ -a,b +c,d @@
    const match = /^@@\s+-([0-9]+)(?:,[0-9]+)?\s+\+([0-9]+)(?:,[0-9]+)?\s+@@/.exec(line);
    if (!match) return null;
    return { oldStart: Number(match[1]), newStart: Number(match[2]) };
}

function isDiffHeaderLine(line: string): boolean {
    return (
        line.startsWith('diff --git ')
        || line.startsWith('index ')
        || line.startsWith('--- ')
        || line.startsWith('+++ ')
        || line.startsWith('@@')
    );
}

export function buildCodeLinesFromUnifiedDiff(params: { unifiedDiff: string }): CodeLine[] {
    const rawLines = params.unifiedDiff.replace(/\r\n/g, '\n').split('\n');

    const out: CodeLine[] = [];

    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;

    for (let i = 0; i < rawLines.length; i++) {
        const raw = rawLines[i] ?? '';

        if (raw.startsWith('@@')) {
            const header = parseHunkHeader(raw);
            if (header) {
                oldLine = header.oldStart;
                newLine = header.newStart;
                inHunk = true;
            }
            out.push({
                id: `h:${i}`,
                sourceIndex: i,
                kind: 'header',
                oldLine: null,
                newLine: null,
                renderPrefixText: '',
                renderCodeText: raw,
                renderIsHeaderLine: true,
                selectable: false,
            });
            continue;
        }

        if (!inHunk && isDiffHeaderLine(raw)) {
            out.push({
                id: `hd:${i}`,
                sourceIndex: i,
                kind: 'header',
                oldLine: null,
                newLine: null,
                renderPrefixText: '',
                renderCodeText: raw,
                renderIsHeaderLine: true,
                selectable: false,
            });
            continue;
        }

        if (!inHunk) {
            // Unknown prelude content; treat as header-style.
            out.push({
                id: `p:${i}`,
                sourceIndex: i,
                kind: 'header',
                oldLine: null,
                newLine: null,
                renderPrefixText: '',
                renderCodeText: raw,
                renderIsHeaderLine: true,
                selectable: false,
            });
            continue;
        }

        const prefix = raw.slice(0, 1);
        const codeText = raw.slice(1);

        if (prefix === '+' && !raw.startsWith('+++')) {
            const line: CodeLine = {
                id: `a:${i}`,
                sourceIndex: i,
                kind: 'add',
                oldLine: null,
                newLine,
                renderPrefixText: '+',
                renderCodeText: codeText,
                renderIsHeaderLine: false,
                selectable: true,
            };
            out.push(line);
            newLine += 1;
            continue;
        }

        if (prefix === '-' && !raw.startsWith('---')) {
            const line: CodeLine = {
                id: `r:${i}`,
                sourceIndex: i,
                kind: 'remove',
                oldLine,
                newLine: null,
                renderPrefixText: '-',
                renderCodeText: codeText,
                renderIsHeaderLine: false,
                selectable: true,
            };
            out.push(line);
            oldLine += 1;
            continue;
        }

        // Context line (" ") or blank line inside hunk.
        if (prefix === ' ') {
            out.push({
                id: `c:${i}`,
                sourceIndex: i,
                kind: 'context',
                oldLine,
                newLine,
                renderPrefixText: ' ',
                renderCodeText: codeText,
                renderIsHeaderLine: false,
                selectable: false,
            });
            oldLine += 1;
            newLine += 1;
            continue;
        }

        out.push({
            id: `x:${i}`,
            sourceIndex: i,
            kind: 'context',
            oldLine,
            newLine,
            renderPrefixText: '',
            renderCodeText: raw,
            renderIsHeaderLine: false,
            selectable: false,
        });
    }

    return out;
}
