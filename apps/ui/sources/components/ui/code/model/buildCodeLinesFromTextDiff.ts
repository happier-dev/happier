import { calculateUnifiedDiff } from '@/components/ui/code/model/diff/calculateDiff';

import type { CodeLine } from './codeLineTypes';

export function buildCodeLinesFromTextDiff(params: {
    oldText: string;
    newText: string;
    contextLines: number;
}): CodeLine[] {
    const result = calculateUnifiedDiff(params.oldText, params.newText, params.contextLines);
    const out: CodeLine[] = [];

    for (let h = 0; h < result.hunks.length; h++) {
        const hunk = result.hunks[h];
        out.push({
            id: `th:${h}`,
            sourceIndex: out.length,
            kind: 'header',
            oldLine: null,
            newLine: null,
            renderPrefixText: '',
            renderCodeText: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
            renderIsHeaderLine: true,
            selectable: false,
        });

        for (let i = 0; i < hunk.lines.length; i++) {
            const line = hunk.lines[i];
            if (line.type === 'add') {
                out.push({
                    id: `ta:${h}:${i}`,
                    sourceIndex: out.length,
                    kind: 'add',
                    oldLine: null,
                    newLine: line.newLineNumber ?? null,
                    renderPrefixText: '+',
                    renderCodeText: line.content,
                    renderIsHeaderLine: false,
                    selectable: true,
                });
            } else if (line.type === 'remove') {
                out.push({
                    id: `tr:${h}:${i}`,
                    sourceIndex: out.length,
                    kind: 'remove',
                    oldLine: line.oldLineNumber ?? null,
                    newLine: null,
                    renderPrefixText: '-',
                    renderCodeText: line.content,
                    renderIsHeaderLine: false,
                    selectable: true,
                });
            } else {
                out.push({
                    id: `tc:${h}:${i}`,
                    sourceIndex: out.length,
                    kind: 'context',
                    oldLine: line.oldLineNumber ?? null,
                    newLine: line.newLineNumber ?? null,
                    renderPrefixText: ' ',
                    renderCodeText: line.content,
                    renderIsHeaderLine: false,
                    selectable: false,
                });
            }
        }
    }

    return out;
}
