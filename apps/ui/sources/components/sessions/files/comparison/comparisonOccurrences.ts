import type { ScmChangeOccurrence, ScmComparison, ScmComparisonFile } from '@happier-dev/protocol';

/**
 * Where each exact change occurrence of a captured comparison sits in its file's evidence: a file's k-th
 * textual occurrence is its k-th `@@` hunk; metadata occurrences (mode, rename, binary) carry no code.
 * The Walkthrough reading and the Commits proposal both project occurrences through this one owner.
 */
export type LocatedOccurrence = Readonly<{ file: ScmComparisonFile; occurrence: ScmChangeOccurrence; hunkIndex: number | null }>;

export type ComparisonOccurrences = Readonly<{
    located: ReadonlyMap<string, LocatedOccurrence>;
    hunksByPath: ReadonlyMap<string, readonly string[]>;
}>;

export function isMetadataOccurrence(occurrence: ScmChangeOccurrence): boolean {
    return occurrence.before.startLine === 0 && occurrence.before.lineCount === 0
        && occurrence.after.startLine === 0 && occurrence.after.lineCount === 0;
}

/** The `@@` hunks of a file's diff, in order. */
export function splitUnifiedDiffHunks(unifiedDiff: string): string[] {
    const hunks: string[] = [];
    let current: string[] | null = null;
    for (const line of unifiedDiff.split('\n')) {
        if (line.startsWith('@@')) {
            if (current) hunks.push(current.join('\n'));
            current = [line];
        } else if (line.startsWith('diff --git ')) {
            if (current) hunks.push(current.join('\n'));
            current = null;
        } else if (current) {
            current.push(line);
        }
    }
    if (current) hunks.push(current.join('\n'));
    return hunks.map((hunk) => hunk.replace(/\n+$/, ''));
}

export function countHunkLines(hunk: string): Readonly<{ added: number; removed: number }> {
    let added = 0;
    let removed = 0;
    for (const line of hunk.split('\n').slice(1)) {
        if (line.startsWith('+')) added += 1;
        else if (line.startsWith('-')) removed += 1;
    }
    return { added, removed };
}

export function locateComparisonOccurrences(comparison: ScmComparison): ComparisonOccurrences {
    const located = new Map<string, LocatedOccurrence>();
    const hunksByPath = new Map<string, string[]>();
    for (const file of comparison.inventory.files) {
        const hunks = splitUnifiedDiffHunks(file.evidence.unifiedDiff ?? '');
        hunksByPath.set(file.path, hunks);
        let hunkIndex = 0;
        for (const occurrence of file.occurrences) {
            const textual = !isMetadataOccurrence(occurrence) && hunkIndex < hunks.length;
            located.set(occurrence.id, { file, occurrence, hunkIndex: textual ? hunkIndex : null });
            if (textual) hunkIndex += 1;
        }
    }
    return { located, hunksByPath };
}
