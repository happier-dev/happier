import { buildPlaceholderUnifiedDiff } from './derivePendingNormalizedToolChange';

export type TurnDiffFileStats = Readonly<{
    oldTextBytes?: number;
    newTextBytes?: number;
    unifiedDiffBytes?: number;
    addedLines?: number;
    removedLines?: number;
}>;

export type TurnDiffFileEntry = Record<string, unknown> & Readonly<{
    file_path: string;
    unified_diff?: string;
    oldText?: string;
    newText?: string;
    description?: string;
}>;

export type BoundedTurnDiffFileEntry = TurnDiffFileEntry & Readonly<{
    truncated?: true;
    stats?: TurnDiffFileStats;
}>;

export type BoundTurnDiffFilesResult = Readonly<{
    files: BoundedTurnDiffFileEntry[];
    truncatedFileCount: number;
}>;

function byteLength(text: string): number {
    return Buffer.byteLength(text, 'utf8');
}

function countUnifiedDiffChangedLines(unifiedDiff: string): Readonly<{ addedLines: number; removedLines: number }> {
    let addedLines = 0;
    let removedLines = 0;
    for (const line of unifiedDiff.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) addedLines += 1;
        else if (line.startsWith('-') && !line.startsWith('---')) removedLines += 1;
    }
    return { addedLines, removedLines };
}

function buildTruncatedEntry(params: Readonly<{
    entry: TurnDiffFileEntry;
    stats: TurnDiffFileStats;
}>): BoundedTurnDiffFileEntry {
    const { oldText: _oldText, newText: _newText, unified_diff: _unifiedDiff, ...metadata } = params.entry;
    return {
        ...metadata,
        unified_diff: buildPlaceholderUnifiedDiff(
            params.entry.file_path,
            params.entry.description ?? 'Diff too large',
        ),
        truncated: true,
        stats: params.stats,
    };
}

function buildBoundedTextDiff(params: Readonly<{
    entry: TurnDiffFileEntry;
    oldText: string;
    newText: string;
    maxBytes: number;
}>): string | null {
    const oldLines = params.oldText.split('\n');
    const newLines = params.newText.split('\n');

    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
        prefix += 1;
    }

    let suffix = 0;
    while (
        suffix < oldLines.length - prefix
        && suffix < newLines.length - prefix
        && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
        suffix += 1;
    }

    const context = 3;
    const oldStart = Math.max(0, prefix - context);
    const newStart = Math.max(0, prefix - context);
    const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + context);
    const newEnd = Math.min(newLines.length, newLines.length - suffix + context);
    const oldRemovedStart = prefix;
    const oldRemovedEnd = oldLines.length - suffix;
    const newAddedStart = prefix;
    const newAddedEnd = newLines.length - suffix;

    const lines = [
        `diff --git a/${params.entry.file_path} b/${params.entry.file_path}`,
        `--- a/${params.entry.file_path}`,
        `+++ b/${params.entry.file_path}`,
        `@@ -${oldStart + 1},${oldEnd - oldStart} +${newStart + 1},${newEnd - newStart} @@`,
    ];

    for (let index = oldStart; index < oldRemovedStart; index += 1) lines.push(` ${oldLines[index]}`);
    for (let index = oldRemovedStart; index < oldRemovedEnd; index += 1) lines.push(`-${oldLines[index]}`);
    for (let index = newAddedStart; index < newAddedEnd; index += 1) lines.push(`+${newLines[index]}`);
    for (let index = oldRemovedEnd; index < oldEnd; index += 1) lines.push(` ${oldLines[index]}`);

    const unifiedDiff = lines.join('\n');
    return byteLength(unifiedDiff) <= params.maxBytes ? unifiedDiff : null;
}

export function boundTurnDiffFiles(params: Readonly<{
    files: readonly TurnDiffFileEntry[];
    fileBudgetBytes: number;
    turnBudgetBytes: number;
}>): BoundTurnDiffFilesResult {
    const fileBudget = params.fileBudgetBytes > 0 ? params.fileBudgetBytes : Number.POSITIVE_INFINITY;
    let remainingTurnBudget = params.turnBudgetBytes > 0 ? params.turnBudgetBytes : Number.POSITIVE_INFINITY;
    const files: BoundedTurnDiffFileEntry[] = [];
    let truncatedFileCount = 0;

    for (const entry of params.files) {
        const allowed = Math.min(fileBudget, remainingTurnBudget);
        const hasTextPair = typeof entry.oldText === 'string' && typeof entry.newText === 'string';

        if (hasTextPair) {
            const oldText = entry.oldText!;
            const newText = entry.newText!;
            const oldTextBytes = byteLength(oldText);
            const newTextBytes = byteLength(newText);
            if (oldTextBytes + newTextBytes <= allowed) {
                files.push(entry);
                remainingTurnBudget -= oldTextBytes + newTextBytes;
                continue;
            }

            const boundedDiff = buildBoundedTextDiff({ entry, oldText, newText, maxBytes: allowed });
            if (boundedDiff !== null) {
                const { oldText: _oldText, newText: _newText, ...metadata } = entry;
                files.push({
                    ...metadata,
                    unified_diff: boundedDiff,
                    stats: { oldTextBytes, newTextBytes },
                });
                remainingTurnBudget -= byteLength(boundedDiff);
                continue;
            }

            files.push(buildTruncatedEntry({ entry, stats: { oldTextBytes, newTextBytes } }));
            truncatedFileCount += 1;
            continue;
        }

        if (typeof entry.unified_diff === 'string') {
            const unifiedDiffBytes = byteLength(entry.unified_diff);
            if (unifiedDiffBytes <= allowed) {
                files.push(entry);
                remainingTurnBudget -= unifiedDiffBytes;
                continue;
            }

            files.push(buildTruncatedEntry({
                entry,
                stats: {
                    unifiedDiffBytes,
                    ...countUnifiedDiffChangedLines(entry.unified_diff),
                },
            }));
            truncatedFileCount += 1;
            continue;
        }

        files.push(entry);
    }

    return { files, truncatedFileCount };
}
