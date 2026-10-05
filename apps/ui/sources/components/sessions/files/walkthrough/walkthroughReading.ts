import {
    isScmSelectionReviewed,
    type ScmComparison,
    type ScmComparisonFile,
    type ScmChangeOccurrence,
    type ScmDiffSummaryAnalysisCoverage,
    type ScmDiffSummaryOutputState,
    type ScmDiffSummaryWalkthrough,
    type ScmReviewedMarksRecord,
    type ScmDiffSummaryResult,
} from '@happier-dev/protocol';
import { parsePatch } from 'diff';

import { countHunkLines, isMetadataOccurrence, locateComparisonOccurrences, type LocatedOccurrence } from '@/components/sessions/files/comparison/comparisonOccurrences';

/**
 * The reading projection of one walkthrough over its exact comparison (Walkthrough lab WT1-A, WT2, WT8-F2).
 * Prose comes from the saved result; code comes only from the captured comparison, by exact occurrence
 * reference. Source coverage, the model's reading and the person's marks stay three separate counts.
 */
export type WalkthroughReadingInput = Readonly<{
    comparison: ScmComparison;
    /** The walkthrough output's progress; null when no walkthrough was requested for this comparison. */
    walkthrough: Readonly<{ state: ScmDiffSummaryOutputState; value?: ScmDiffSummaryWalkthrough; reason?: string }> | null;
    analysis: ScmDiffSummaryAnalysisCoverage | null;
    reviewed: ScmReviewedMarksRecord | null;
    provenance?: ScmDiffSummaryResult['walkthroughProvenance'];
}>;

/** none: nothing requested · inventory: every file, no prose yet · arriving: stops land in order. */
export type WalkthroughPhase = 'none' | 'inventory' | 'arriving' | 'complete' | 'partial' | 'failed' | 'cancelled';

export type WalkthroughStopFile = Readonly<{
    path: string;
    previousPath: string | null;
    changeKind: string;
    /** Only this stop's hunks of the file, as a unified diff. Empty when the evidence is unavailable. */
    unifiedDiff: string;
    rangeLabel: string | null;
    added: number;
    removed: number;
    unavailableReason: string | null;
}>;

export type WalkthroughStop = Readonly<{
    id: string;
    number: number;
    title: string;
    explanationMarkdown: string;
    /** Saved explanation blocks remain distinct from the narrator's prose. */
    reviewExplanations?: ScmDiffSummaryWalkthrough['stops'][number]['reviewExplanations'];
    importance: 'low' | 'medium' | 'high' | null;
    changeRefs: readonly string[];
    files: readonly WalkthroughStopFile[];
    /** The file names under the stop's title in the contents ("SettingsModal.tsx · useModalLayout.ts"). */
    fileCue: string;
    /** Only the person's explicit mark on every exact change of this stop. */
    reviewed: boolean;
    provenance?: NonNullable<ScmDiffSummaryResult['walkthroughProvenance']>['stops'][number];
}>;

export type WalkthroughOtherChange = Readonly<{
    path: string;
    added: number;
    removed: number;
    lockfile: boolean;
    generated: boolean;
    binary: boolean | null;
    unavailableReason: string | null;
}>;

export type WalkthroughInventoryRow = Readonly<{
    path: string;
    changeKind: string;
    added: number;
    removed: number;
    lockfile: boolean;
    generated: boolean;
    reading: 'read' | 'reading' | 'unavailable';
}>;

/** One miniature of the optional overview strip: a sampled silhouette of a file's changed lines. */
export type WalkthroughCodeMapFile = Readonly<{
    path: string;
    label: string;
    generated: boolean;
    lines: readonly Readonly<{ kind: 'added' | 'removed' | 'context'; widthPct: number }>[];
    stopIds: readonly string[];
}>;

export type WalkthroughExplainNote = Readonly<{
    key: string;
    stop: WalkthroughStop | null;
    secondary: boolean;
}>;

export type WalkthroughReading = Readonly<{
    phase: WalkthroughPhase;
    title: string | null;
    titleEdited?: boolean;
    intro: string | null;
    readingHint: string | null;
    failureReason: string | null;
    source: Readonly<{
        fileCount: number;
        changeCount: number;
        added: number;
        removed: number;
        unavailableCount: number;
        inventoryState: ScmComparison['inventory']['state'];
    }>;
    analysis: Readonly<{ analysed: number; total: number; parts?: ScmDiffSummaryAnalysisCoverage['parts'] }> | null;
    stops: readonly WalkthroughStop[];
    reviewedCount: number;
    others: readonly WalkthroughOtherChange[];
    inventory: readonly WalkthroughInventoryRow[];
    /** Files: the stop numbers explaining each file, in stop order. */
    stopNumbersByPath: ReadonlyMap<string, readonly number[]>;
    /** Files Explain: for each file, per hunk (file order), the stops explaining that hunk. */
    stopIdsByHunk: ReadonlyMap<string, readonly (readonly string[])[]>;
    /** Files Explain: each stop appears at its first hunk in each file; unassigned hunks retain a note. */
    explainNotesByHunk: ReadonlyMap<string, readonly (readonly WalkthroughExplainNote[])[]>;
    /** The overview strip's miniatures; above {@link CODE_MAP_FOLDER_THRESHOLD} files they group by folder. */
    codeMap: readonly WalkthroughCodeMapFile[];
}>;

/** Past this many files a miniature per file stops being readable (lab WT1-A3: group by folder). */
export const CODE_MAP_FOLDER_THRESHOLD = 40;
const CODE_MAP_ROWS = 14;

function sampleSilhouette(hunks: readonly string[]): WalkthroughCodeMapFile['lines'] {
    const body = hunks.flatMap((hunk) => hunk.split('\n').slice(1));
    const step = Math.max(1, Math.ceil(body.length / CODE_MAP_ROWS));
    const lines: { kind: 'added' | 'removed' | 'context'; widthPct: number }[] = [];
    for (let index = 0; index < body.length && lines.length < CODE_MAP_ROWS; index += step) {
        const line = body[index]!;
        const kind = line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : 'context';
        lines.push({ kind, widthPct: Math.min(100, 28 + Math.round(line.trim().length * 1.4)) });
    }
    return lines;
}

function folderOf(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash >= 0 ? path.slice(0, slash) : '';
}

function fileName(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash >= 0 ? path.slice(slash + 1) : path;
}

function rangeLabel(occurrences: readonly ScmChangeOccurrence[]): string | null {
    const spans = occurrences
        .filter((occurrence) => !isMetadataOccurrence(occurrence))
        .map((occurrence) => (occurrence.after.lineCount > 0 ? occurrence.after : occurrence.before))
        .filter((span) => span.lineCount > 0);
    if (spans.length === 0) return null;
    const start = Math.min(...spans.map((span) => span.startLine));
    const end = Math.max(...spans.map((span) => span.startLine + span.lineCount - 1));
    return start === end ? `L${start}` : `L${start}–${end}`;
}

function fileDiffHeader(file: ScmComparisonFile): string {
    const before = file.previousPath ?? file.path;
    return [
        `diff --git a/${before} b/${file.path}`,
        file.changeKind === 'added' ? '--- /dev/null' : `--- a/${before}`,
        file.changeKind === 'deleted' ? '+++ /dev/null' : `+++ b/${file.path}`,
    ].join('\n');
}

function resolvePhase(walkthrough: WalkthroughReadingInput['walkthrough']): WalkthroughPhase {
    if (!walkthrough) return 'none';
    switch (walkthrough.state) {
        case 'pending': return 'inventory';
        case 'writing': return walkthrough.value ? 'arriving' : 'inventory';
        case 'complete': return 'complete';
        case 'partial': return 'partial';
        case 'failed': return 'failed';
        case 'cancelled': return 'cancelled';
    }
}

export function buildWalkthroughReading(input: WalkthroughReadingInput): WalkthroughReading {
    const { comparison } = input;
    const { located, hunksByPath } = locateComparisonOccurrences(comparison);
    let added = 0;
    let removed = 0;
    let unavailableCount = 0;
    const changeCount = located.size;
    for (const file of comparison.inventory.files) {
        for (const hunk of hunksByPath.get(file.path) ?? []) {
            const lines = countHunkLines(hunk);
            added += lines.added;
            removed += lines.removed;
        }
        if (file.evidence.state === 'unavailable') unavailableCount += 1;
    }

    const value = input.walkthrough?.value ?? null;
    const provenanceById = new Map(input.provenance?.stops.map((stop) => [stop.stopId, stop] as const));
    const stopIdsByHunk = new Map<string, string[][]>(
        comparison.inventory.files.map((file) => [file.path, (hunksByPath.get(file.path) ?? []).map(() => [])]),
    );
    const stopNumbersByPath = new Map<string, number[]>();
    const stops: WalkthroughStop[] = (value?.stops ?? []).map((stop, index) => {
        const number = index + 1;
        const byPath = new Map<string, LocatedOccurrence[]>();
        for (const ref of stop.changeRefs) {
            const entry = located.get(ref);
            if (!entry) continue;
            const group = byPath.get(entry.file.path);
            if (group) group.push(entry);
            else byPath.set(entry.file.path, [entry]);
            if (entry.hunkIndex !== null) stopIdsByHunk.get(entry.file.path)?.[entry.hunkIndex]?.push(stop.id);
        }
        const files = [...byPath.values()].map((entries): WalkthroughStopFile => {
            const file = entries[0]!.file;
            const hunks = hunksByPath.get(file.path) ?? [];
            const selected = entries
                .map((entry) => entry.hunkIndex)
                .filter((hunkIndex): hunkIndex is number => hunkIndex !== null)
                .sort((left, right) => left - right)
                .map((hunkIndex) => hunks[hunkIndex]!);
            const lines = selected.reduce((sum, hunk) => {
                const next = countHunkLines(hunk);
                return { added: sum.added + next.added, removed: sum.removed + next.removed };
            }, { added: 0, removed: 0 });
            const numbers = stopNumbersByPath.get(file.path) ?? [];
            if (!numbers.includes(number)) stopNumbersByPath.set(file.path, [...numbers, number]);
            let unifiedDiff = '';
            let unavailableReason = file.evidence.state === 'unavailable' ? file.evidence.reason : null;
            if (file.evidence.state === 'available' && selected.length > 0) {
                const patch = [fileDiffHeader(file), ...selected].join('\n') + '\n';
                try {
                    // A partial hunk is not usable evidence. Validate the selected patch before
                    // a renderer can log malformed rows or silently produce an empty card.
                    const parsed = parsePatch(patch);
                    if (parsed.length === 1 && parsed[0]!.hunks.length === selected.length) unifiedDiff = patch;
                    else unavailableReason = 'invalid_diff';
                } catch {
                    unavailableReason = 'invalid_diff';
                }
            } else if (file.evidence.state === 'available' && entries.some((entry) => !isMetadataOccurrence(entry.occurrence))) {
                unavailableReason = 'invalid_diff';
            }
            return {
                path: file.path,
                previousPath: file.previousPath ?? null,
                changeKind: file.changeKind,
                unifiedDiff,
                rangeLabel: rangeLabel(entries.map((entry) => entry.occurrence)),
                added: lines.added,
                removed: lines.removed,
                unavailableReason,
            };
        });
        return {
            id: stop.id,
            number,
            title: stop.title,
            explanationMarkdown: stop.explanationMarkdown,
            reviewExplanations: stop.reviewExplanations,
            importance: stop.importance ?? null,
            changeRefs: stop.changeRefs,
            files,
            fileCue: files.map((file) => fileName(file.path)).join(' · '),
            reviewed: isScmSelectionReviewed(input.reviewed, comparison.id, stop.changeRefs),
            ...(provenanceById.has(stop.id) ? { provenance: provenanceById.get(stop.id) } : {}),
        };
    });

    const stopsById = new Map(stops.map((stop) => [stop.id, stop]));
    const explainNotesByHunk = new Map<string, WalkthroughExplainNote[][]>();
    for (const [path, perHunk] of stopIdsByHunk) {
        const seen = new Set<string>();
        explainNotesByHunk.set(path, perHunk.map((stopIds, hunkIndex) => {
            if (stopIds.length === 0) return [{ key: `none:${hunkIndex}`, stop: null, secondary: false }];
            const notes: WalkthroughExplainNote[] = [];
            stopIds.forEach((stopId, order) => {
                const stop = stopsById.get(stopId);
                if (!stop || seen.has(stopId)) return;
                seen.add(stopId);
                notes.push({ key: stopId, stop, secondary: order > 0 });
            });
            return notes;
        }));
    }

    const otherPaths: string[] = [];
    for (const ref of value?.otherChangeRefs ?? []) {
        const entry = located.get(ref);
        if (entry && !otherPaths.includes(entry.file.path)) otherPaths.push(entry.file.path);
    }
    const filesByPath = new Map(comparison.inventory.files.map((file) => [file.path, file]));
    const fileLines = (file: ScmComparisonFile) => (hunksByPath.get(file.path) ?? []).reduce((sum, hunk) => {
        const next = countHunkLines(hunk);
        return { added: sum.added + next.added, removed: sum.removed + next.removed };
    }, { added: 0, removed: 0 });
    const others: WalkthroughOtherChange[] = otherPaths.map((path) => {
        const file = filesByPath.get(path)!;
        return {
            path,
            ...fileLines(file),
            lockfile: file.lockfile,
            generated: file.generated,
            binary: file.binary,
            unavailableReason: file.evidence.state === 'unavailable' ? file.evidence.reason : null,
        };
    });

    const analysed = new Set(input.analysis?.analysedChangeRefs ?? []);
    const inventory: WalkthroughInventoryRow[] = comparison.inventory.files.map((file) => ({
        path: file.path,
        changeKind: file.changeKind,
        ...fileLines(file),
        lockfile: file.lockfile,
        generated: file.generated,
        reading: file.evidence.state === 'unavailable'
            ? 'unavailable'
            : file.occurrences.every((occurrence) => analysed.has(occurrence.id)) ? 'read' : 'reading',
    }));

    const stopIdsByPath = new Map<string, string[]>();
    for (const [path, perHunk] of stopIdsByHunk) {
        stopIdsByPath.set(path, [...new Set(perHunk.flat())]);
    }
    const perFile: WalkthroughCodeMapFile[] = comparison.inventory.files.map((file) => ({
        path: file.path,
        label: fileName(file.path),
        generated: file.generated || file.lockfile,
        lines: sampleSilhouette(hunksByPath.get(file.path) ?? []),
        stopIds: stopIdsByPath.get(file.path) ?? [],
    }));
    const codeMap = perFile.length <= CODE_MAP_FOLDER_THRESHOLD ? perFile : [...perFile.reduce((groups, file) => {
        const folder = folderOf(file.path);
        const group = groups.get(folder);
        if (!group) {
            groups.set(folder, { ...file, path: folder, label: fileName(folder) || folder, stopIds: [...file.stopIds] });
        } else {
            groups.set(folder, {
                ...group,
                generated: group.generated && file.generated,
                lines: group.lines.length >= CODE_MAP_ROWS ? group.lines : [...group.lines, ...file.lines].slice(0, CODE_MAP_ROWS),
                stopIds: [...new Set([...group.stopIds, ...file.stopIds])],
            });
        }
        return groups;
    }, new Map<string, WalkthroughCodeMapFile>()).values()];

    return {
        codeMap,
        phase: resolvePhase(input.walkthrough),
        title: value?.title ?? null,
        ...(input.provenance ? { titleEdited: input.provenance.titleEdited } : {}),
        intro: value?.intro && value.intro.trim().length > 0 ? value.intro : null,
        readingHint: value?.readingHint ?? null,
        failureReason: input.walkthrough?.reason ?? null,
        source: {
            fileCount: comparison.inventory.files.length,
            changeCount,
            added,
            removed,
            unavailableCount,
            inventoryState: comparison.inventory.state,
        },
        analysis: input.analysis ? { analysed: input.analysis.analysedChangeRefs.length, total: changeCount,
            ...(input.analysis.parts ? { parts: input.analysis.parts } : {}) } : null,
        stops,
        reviewedCount: stops.filter((stop) => stop.reviewed).length,
        others,
        inventory,
        stopNumbersByPath,
        stopIdsByHunk,
        explainNotesByHunk,
    };
}

/** No walkthrough of this comparison exists yet: the view invites one and points at Files. */
export const EMPTY_WALKTHROUGH_READING: WalkthroughReading = {
    phase: 'none',
    title: null,
    intro: null,
    readingHint: null,
    failureReason: null,
    source: { fileCount: 0, changeCount: 0, added: 0, removed: 0, unavailableCount: 0, inventoryState: 'complete' },
    analysis: null,
    stops: [],
    reviewedCount: 0,
    others: [],
    inventory: [],
    stopNumbersByPath: new Map(),
    stopIdsByHunk: new Map(),
    explainNotesByHunk: new Map(),
    codeMap: [],
};
