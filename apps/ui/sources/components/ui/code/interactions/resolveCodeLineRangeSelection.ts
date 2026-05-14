import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';

export type CodeLineInteractionMode = 'read' | 'comment' | 'commitSelection';

export function resolveCodeLineRangeSelection(params: Readonly<{
    lines: readonly CodeLine[];
    startLineId: string;
    endLineId: string;
    includeLine?: (line: CodeLine) => boolean;
}>): readonly CodeLine[] {
    const startIndex = params.lines.findIndex((line) => line.id === params.startLineId);
    const endIndex = params.lines.findIndex((line) => line.id === params.endLineId);
    if (startIndex < 0 || endIndex < 0) return [];

    const from = Math.min(startIndex, endIndex);
    const to = Math.max(startIndex, endIndex);
    const includeLine = params.includeLine ?? ((line: CodeLine) => !line.renderIsHeaderLine);
    return params.lines.slice(from, to + 1).filter(includeLine);
}
