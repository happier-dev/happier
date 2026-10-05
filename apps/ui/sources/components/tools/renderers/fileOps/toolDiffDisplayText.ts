import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { buildCodeLinesFromTextDiff } from '@/components/ui/code/model/buildCodeLinesFromTextDiff';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import type { DiffFileEntry } from '@/components/ui/code/model/diff/diffViewModel';
import { diffFileDisplayPath, diffFileDisplayStats, diffFileDisplayKind } from '@/components/ui/code/diff/DiffFilesListView';
import { toolTextBlock } from '../core/toolDisplayTextTypes';

/** Full context is derived from the supplied text, without another presentation cap. */
export function toolDiffContextLines(oldText: string, newText: string) {
    return Math.max(oldText.split('\n').length, newText.split('\n').length);
}

export function buildToolFileDiffLines(file: Pick<DiffFileEntry, 'unifiedDiff' | 'oldText' | 'newText'>, fullContext = true): readonly CodeLine[] {
    if (typeof file.unifiedDiff === 'string') {
        return buildCodeLinesFromUnifiedDiff({ unifiedDiff: file.unifiedDiff, hideFilePrelude: true });
    }
    if (typeof file.oldText !== 'string' || typeof file.newText !== 'string') return [];
    return buildCodeLinesFromTextDiff({ oldText: file.oldText, newText: file.newText,
        contextLines: fullContext ? toolDiffContextLines(file.oldText, file.newText) : 3 });
}

export function projectToolDiffLines(lines: readonly CodeLine[], prefix: string) {
    return lines.flatMap((line) => toolTextBlock(`${prefix}-line-${line.id}`, line.renderCodeText));
}

export function projectToolFileDiffDisplayText(files: readonly DiffFileEntry[], prefix: string) {
    return files.flatMap((file, index) => [
        ...toolTextBlock(`${prefix}-${index}-path`, diffFileDisplayPath(file)),
        ...toolTextBlock(`${prefix}-${index}-stats`, diffFileDisplayStats(file)),
        ...toolTextBlock(`${prefix}-${index}-kind`, diffFileDisplayKind(file)),
        ...projectToolDiffLines(buildToolFileDiffLines(file), `${prefix}-${index}`),
    ]);
}

export function toolDiffFindProps(lines: readonly CodeLine[], prefix: string, ranges: (blockId: string) => readonly FindTextRange[] | undefined) {
    const findRangesByLineId = new Map<string, readonly FindTextRange[]>();
    let scrollToLineId: string | undefined;
    for (const line of lines) {
        const matches = ranges(`${prefix}-line-${line.id}`);
        if (!matches?.length) continue;
        findRangesByLineId.set(line.id, matches);
        if (matches.some((range) => range.current)) scrollToLineId = line.id;
    }
    return { findRangesByLineId, scrollToLineId };
}
