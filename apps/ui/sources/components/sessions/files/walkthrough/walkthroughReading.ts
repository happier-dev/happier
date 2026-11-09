import type { ScmReviewedMarksRecord } from '@happier-dev/protocol/scm/reviewedMarks';
import { createScmReviewedSelections, type ScmReviewedMarksRecordSource } from '@/sync/domains/scm/diffSummary/reviewedMarks';
import type { ScmComparison, ScmComparisonFile, ScmChangeOccurrence } from '@happier-dev/protocol/scm/comparison';
import type { ScmDiffSummaryAnalysisCoverage, ScmDiffSummaryOutputState, ScmDiffSummaryWalkthrough } from '@happier-dev/protocol/scm/diffSummary';
import type { ScmDiffSummaryResult } from '@happier-dev/protocol/scm/diffSummaryResult';
import { parsePatch } from 'diff';

import { isMetadataOccurrence, locateComparisonOccurrences, type LocatedOccurrence } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { parseUnifiedDiffHunks } from '@happier-dev/protocol/diff/hunks';
import { compareScmPaths } from '@/scm/scmStatusFiles';
import type { WalkthroughReviewedSource } from './walkthroughReviewedProjection';

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
    reviewedRecordSource?: ScmReviewedMarksRecordSource;
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
    suggestedQuestions?: ScmDiffSummaryWalkthrough['stops'][number]['suggestedQuestions'];
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
    changeKind: string;
    added: number;
    removed: number;
    lockfile: boolean;
    generated: boolean;
    binary: boolean | null;
    unavailableReason: string | null;
    /** The file's hunks this walkthrough leaves outside its stops, as a unified diff; empty when unavailable. */
    unifiedDiff: string;
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
    /** Mounted personal facts have keyed subscriptions independent of captured reading structure. */
    reviewedSource?: WalkthroughReviewedSource;
    /** Captured code has an immutable lifetime independent of personal reviewed facts. */
    code: Readonly<{ stops: readonly Pick<WalkthroughStop, 'id' | 'files'>[]; others: readonly WalkthroughOtherChange[] }>;
    phase: WalkthroughPhase;
    title: string | null;
    titleEdited?: boolean;
    intro: string | null;
    readingHint: string | null;
    source: Readonly<{
        fileCount: number;
        changeCount: number;
        added: number;
        removed: number;
        linesKnown: boolean;
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

export type WalkthroughReadingProgress = Readonly<{
    phase: WalkthroughPhase;
    title: string | null;
    stops: readonly Pick<WalkthroughStop, 'id' | 'title' | 'changeRefs' | 'reviewed'>[];
    reviewedCount: number;
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

/** The same complete-patch boundary for a whole file and a still-usable subset of its hunks. */
function completeFilePatch(file: ScmComparisonFile, hunks: readonly string[]): string | null {
    const patch = [fileDiffHeader(file), ...hunks].join('\n') + '\n';
    try {
        const parsed = parsePatch(patch);
        return parsed.length === 1 && parsed[0]!.hunks.length === hunks.length ? patch : null;
    } catch {
        return null;
    }
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

/** Shared reading progress; Board consumes it without parsing captured code or building reading-view detail. */
export function buildWalkthroughReadingProgress(input: Readonly<{
    comparison: ScmComparison;
    walkthrough: WalkthroughReadingInput['walkthrough'];
    reviewed: WalkthroughReadingInput['reviewed'];
}>): WalkthroughReadingProgress {
    const value = input.walkthrough?.value ?? null;
    const selections = input.reviewed ? createScmReviewedSelections(input.comparison, value?.stops ?? []) : null;
    selections?.apply(input.reviewed);
    const stops = (value?.stops ?? []).map((stop, index) => ({
        id: stop.id,
        title: stop.title,
        changeRefs: stop.changeRefs,
        reviewed: selections?.isReviewed(index) ?? false,
    }));
    return {
        phase: resolvePhase(input.walkthrough),
        title: value?.title ?? null,
        stops,
        reviewedCount: selections?.getReviewedCount() ?? 0,
    };
}

export function buildWalkthroughReading(input: WalkthroughReadingInput): WalkthroughReading {
    const { comparison } = input;
    const progress = buildWalkthroughReadingProgress(input);
    const { located, hunksByPath } = locateComparisonOccurrences(comparison);
    let added = 0;
    let removed = 0;
    let unavailableCount = 0;
    const evidenceByPath = new Map<string, Readonly<{ declaredAvailable: boolean; unavailableReason: string | null }>>();
    const changeCount = located.size;
    for (const file of comparison.inventory.files) {
        const hunks = hunksByPath.get(file.path) ?? [];
        const evidence = file.evidence;
        const unavailableReason = evidence.state === 'unavailable' ? evidence.reason : null;
        const declaredAvailable = unavailableReason === null;
        const textualCount = file.occurrences.filter((occurrence) => !isMetadataOccurrence(occurrence)).length;
        const fullReason = declaredAvailable && (textualCount > hunks.length
            || (hunks.length > 0 && completeFilePatch(file, hunks) === null)) ? 'invalid_diff' : unavailableReason;
        evidenceByPath.set(file.path, { declaredAvailable, unavailableReason: fullReason });
        for (const hunk of hunks) {
            const lines = parseUnifiedDiffHunks(hunk).flatMap((entry) => entry.lines);
            added += lines.filter((line) => line.kind === 'add').length;
            removed += lines.filter((line) => line.kind === 'remove').length;
        }
        if (fullReason !== null) unavailableCount += 1;
    }

    /** A selection's exact hunks as one patch: the same boundary for a stop's code and the hunks left outside stops. */
    const selectedPatch = (file: ScmComparisonFile, entries: readonly LocatedOccurrence[], selected: readonly string[]) => {
        const evidence = evidenceByPath.get(file.path)!;
        if (evidence.declaredAvailable && selected.length > 0) {
            // Fully valid files need no repeated parsing per selection. If another hunk is
            // malformed, retain this complete selected subset rather than hide useful code.
            const patch = evidence.unavailableReason === null
                ? [fileDiffHeader(file), ...selected].join('\n') + '\n'
                : completeFilePatch(file, selected);
            return patch !== null ? { unifiedDiff: patch, unavailableReason: null } : { unifiedDiff: '', unavailableReason: 'invalid_diff' };
        }
        if (evidence.declaredAvailable && entries.some((entry) => !isMetadataOccurrence(entry.occurrence))) {
            return { unifiedDiff: '', unavailableReason: 'invalid_diff' };
        }
        return { unifiedDiff: '', unavailableReason: evidence.unavailableReason };
    };
    const selectedHunks = (path: string, entries: readonly LocatedOccurrence[]) => {
        const hunks = hunksByPath.get(path) ?? [];
        return [...new Set(entries.map((entry) => entry.hunkIndex).filter((hunkIndex): hunkIndex is number => hunkIndex !== null))]
            .sort((left, right) => left - right)
            .map((hunkIndex) => hunks[hunkIndex]!);
    };

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
            const selected = selectedHunks(file.path, entries);
            const lines = selected.reduce((sum, hunk) => {
                const body = parseUnifiedDiffHunks(hunk).flatMap((entry) => entry.lines);
                const next = { added: body.filter((line) => line.kind === 'add').length, removed: body.filter((line) => line.kind === 'remove').length };
                return { added: sum.added + next.added, removed: sum.removed + next.removed };
            }, { added: 0, removed: 0 });
            const numbers = stopNumbersByPath.get(file.path) ?? [];
            if (!numbers.includes(number)) stopNumbersByPath.set(file.path, [...numbers, number]);
            const { unifiedDiff, unavailableReason } = selectedPatch(file, entries, selected);
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
            ...progress.stops[index]!,
            number,
            explanationMarkdown: stop.explanationMarkdown,
            suggestedQuestions: stop.suggestedQuestions,
            reviewExplanations: stop.reviewExplanations,
            importance: stop.importance ?? null,
            files,
            fileCue: files.map((file) => fileName(file.path)).join(' · '),
            ...(provenanceById.has(stop.id) ? { provenance: provenanceById.get(stop.id) } : {}),
        };
    });

    const stopsById = new Map(stops.map((stop) => [stop.id, stop]));
    const explainNotesByHunk = new Map<string, WalkthroughExplainNote[][]>();
    // One full note per stop, at its first hunk in Files' order; the stop's later files carry its title only.
    const explained = new Set<string>();
    for (const path of [...stopIdsByHunk.keys()].sort(compareScmPaths)) {
        const seen = new Set<string>();
        explainNotesByHunk.set(path, stopIdsByHunk.get(path)!.map((stopIds, hunkIndex) => {
            if (stopIds.length === 0) return [{ key: `none:${hunkIndex}`, stop: null, secondary: false }];
            const notes: WalkthroughExplainNote[] = [];
            stopIds.forEach((stopId, order) => {
                const stop = stopsById.get(stopId);
                if (!stop || seen.has(stopId)) return;
                seen.add(stopId);
                notes.push({ key: stopId, stop, secondary: order > 0 || explained.has(stopId) });
                explained.add(stopId);
            });
            return notes;
        }));
    }

    const otherEntriesByPath = new Map<string, LocatedOccurrence[]>();
    for (const ref of value?.otherChangeRefs ?? []) {
        const entry = located.get(ref);
        if (!entry) continue;
        const group = otherEntriesByPath.get(entry.file.path);
        if (group) group.push(entry);
        else otherEntriesByPath.set(entry.file.path, [entry]);
    }
    const otherPaths = [...otherEntriesByPath.keys()];
    const filesByPath = new Map(comparison.inventory.files.map((file) => [file.path, file]));
    const fileLines = (file: ScmComparisonFile) => (hunksByPath.get(file.path) ?? []).reduce((sum, hunk) => {
        const body = parseUnifiedDiffHunks(hunk).flatMap((entry) => entry.lines);
        const next = { added: body.filter((line) => line.kind === 'add').length, removed: body.filter((line) => line.kind === 'remove').length };
        return { added: sum.added + next.added, removed: sum.removed + next.removed };
    }, { added: 0, removed: 0 });
    const others: WalkthroughOtherChange[] = otherPaths.map((path) => {
        const file = filesByPath.get(path)!;
        return {
            path,
            changeKind: file.changeKind,
            ...fileLines(file),
            lockfile: file.lockfile,
            generated: file.generated,
            binary: file.binary,
            unavailableReason: evidenceByPath.get(file.path)!.unavailableReason,
            unifiedDiff: selectedPatch(file, otherEntriesByPath.get(path)!, selectedHunks(path, otherEntriesByPath.get(path)!)).unifiedDiff,
        };
    });

    const analysed = new Set(input.analysis?.analysedChangeRefs ?? []);
    const inventory: WalkthroughInventoryRow[] = comparison.inventory.files.map((file) => ({
        path: file.path,
        changeKind: file.changeKind,
        ...fileLines(file),
        lockfile: file.lockfile,
        generated: file.generated,
        reading: evidenceByPath.get(file.path)!.unavailableReason !== null
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
    // The map follows the walk: files the first stop explains lead, and the rest keep a natural path order
    // (group-2 before group-10), so the outline a stop draws reads left to right with the stream.
    const stopOrder = new Map(stops.map((stop, index) => [stop.id, index]));
    const firstStop = (file: WalkthroughCodeMapFile) => Math.min(...file.stopIds.map((id) => stopOrder.get(id) ?? Infinity), Infinity);
    codeMap.sort((left, right) => (firstStop(left) - firstStop(right))
        || compareScmPaths(left.path, right.path));

    return {
        code: { stops, others },
        codeMap,
        phase: progress.phase,
        title: progress.title,
        ...(input.provenance ? { titleEdited: input.provenance.titleEdited } : {}),
        intro: value?.intro && value.intro.trim().length > 0 ? value.intro : null,
        readingHint: value?.readingHint ?? null,
        source: {
            fileCount: comparison.inventory.files.length,
            changeCount,
            added,
            removed,
            linesKnown: comparison.inventory.state === 'complete' && unavailableCount === 0,
            unavailableCount,
            inventoryState: comparison.inventory.state,
        },
        analysis: input.analysis ? { analysed: input.analysis.analysedChangeRefs.length, total: changeCount,
            ...(input.analysis.parts ? { parts: input.analysis.parts } : {}) } : null,
        stops,
        reviewedCount: progress.reviewedCount,
        others,
        inventory,
        stopNumbersByPath,
        stopIdsByHunk,
        explainNotesByHunk,
    };
}

/** No walkthrough of this comparison exists yet: the view invites one and points at Files. */
export const EMPTY_WALKTHROUGH_READING: WalkthroughReading = {
    code: { stops: [], others: [] },
    phase: 'none',
    title: null,
    intro: null,
    readingHint: null,
    source: { fileCount: 0, changeCount: 0, added: 0, removed: 0, linesKnown: true, unavailableCount: 0, inventoryState: 'complete' },
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

/** One stop as a question's context names it (lab WT3-D1 "Stop 3 · SettingsSheet.tsx L9–14"), from its saved revision. */
export type WalkthroughStopContext = Readonly<{ number: number; fileName: string | null; rangeLabel: string | null }>;

export function readWalkthroughStopContext(saved: ScmDiffSummaryResult, stopId: string): WalkthroughStopContext | null {
    const output = saved.output.success ? saved.output : null;
    const walkthrough = output?.outputs?.walkthrough;
    const index = walkthrough?.value?.stops.findIndex((stop) => stop.id === stopId) ?? -1;
    if (!output || !walkthrough || index < 0) return null;
    const file = output.comparison
        ? buildWalkthroughReading({ comparison: output.comparison, walkthrough, analysis: null, reviewed: null })
            .stops.find((stop) => stop.id === stopId)?.files[0] ?? null
        : null;
    return { number: index + 1, fileName: file ? fileName(file.path) : null, rangeLabel: file?.rangeLabel ?? null };
}
