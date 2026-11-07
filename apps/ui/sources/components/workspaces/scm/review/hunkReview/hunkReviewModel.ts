import { buildReviewUnits, type ReviewUnit } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { buildChangedFilesReviewFileIndex, type ChangedFilesReviewFileOrder } from '../changedFilesReviewFileIndex';

export type HunkReviewFile = Readonly<{ path: string; keys: readonly string[]; generated?: boolean; lockfile?: boolean; pending?: boolean }>;
export type LiveReviewFile = Readonly<{ path: string; unifiedDiff: string; generated?: boolean; lockfile?: boolean; pending?: boolean }>;

/** What a live file list fixes for the whole checkout: its order, each file's change units and its review rows. */
export type LiveReviewBase = Readonly<{
    /** Built on first read: a Review that passes its own admitted index never classifies the list twice. */
    getInventory: () => ReturnType<typeof buildChangedFilesReviewFileIndex>;
    unitsByPath: ReadonlyMap<string, readonly ReviewUnit[]>;
    files: readonly HunkReviewFile[];
}>;

const liveReviewBases = new WeakMap<readonly LiveReviewFile[], LiveReviewBase>();
const liveReviewRows = new WeakMap<LiveReviewFile, Readonly<{ units: readonly ReviewUnit[]; row: HunkReviewFile }>>();

/** A row's units and keys follow the row's own identity, so a list that keeps its unchanged rows re-derives only the rest. */
function getLiveReviewRow(file: LiveReviewFile) {
    let derived = liveReviewRows.get(file);
    if (!derived) {
        const units = buildReviewUnits(file.path, undefined, file.unifiedDiff);
        derived = { units, row: { ...file, keys: units.map(unit => unit.key) } };
        liveReviewRows.set(file, derived);
    }
    return derived;
}

/**
 * One base per live file list identity. The File page keeps its list per working snapshot, so opening
 * another file (a new page instance) reuses the order, units and rows instead of rebuilding them for every changed file.
 */
export function getLiveReviewBase(liveFiles: readonly LiveReviewFile[]): LiveReviewBase {
    const cached = liveReviewBases.get(liveFiles);
    if (cached) return cached;
    let inventory: ReturnType<typeof buildChangedFilesReviewFileIndex> | undefined;
    const unitsByPath = new Map<string, readonly ReviewUnit[]>();
    const files: HunkReviewFile[] = [];
    for (const file of liveFiles) {
        const derived = getLiveReviewRow(file);
        unitsByPath.set(file.path, derived.units);
        files.push(derived.row);
    }
    const base = {
        getInventory: () => inventory ??= buildChangedFilesReviewFileIndex(liveFiles.map(file => ({ fullPath: file.path, generated: file.generated, lockfile: file.lockfile }))),
        unitsByPath,
        files } satisfies LiveReviewBase;
    liveReviewBases.set(liveFiles, base);
    return base;
}

/**
 * The Review list's live files: every navigable path with its loaded diff, or pending until it loads. Diffs arrive
 * one file at a time, so unchanged rows and, when nothing a row shows moved (a load starting), the list itself are kept.
 */
export function buildLiveReviewFiles(previous: readonly LiveReviewFile[] | undefined, paths: readonly string[],
    diffs: ReadonlyMap<string, Readonly<{ status: string; diff: string }>> | null): readonly LiveReviewFile[] {
    let previousByPath: ReadonlyMap<string, LiveReviewFile> | null = null;
    let changed = previous?.length !== paths.length;
    const rows = paths.map((path, index) => {
        const state = diffs?.get(path);
        const unifiedDiff = state?.diff ?? '';
        const pending = state?.status !== 'loaded';
        let row = previous?.[index];
        // An inventory change shifts rows; find them by path once for that list instead of re-deriving them.
        if (row && row.path !== path) row = (previousByPath ??= new Map(previous!.map(file => [file.path, file]))).get(path);
        if (row && row.path === path && row.unifiedDiff === unifiedDiff && row.pending === pending) {
            if (row !== previous![index]) changed = true;
            return row;
        }
        changed = true;
        return { path, unifiedDiff, pending };
    });
    return changed || !previous ? rows : previous;
}

export type HunkReviewCursor = Readonly<{ path: string; key: string | null }>;

/** Re-resolve a rendered action against the current content table. */
export function resolveHunkReviewUnit<T extends Readonly<{ key: string }>>(input: Readonly<{
    renderedScopeId: string; currentScopeId: string; key: string; units: readonly T[];
}>): T | null {
    if (input.renderedScopeId !== input.currentScopeId) return null;
    return input.units.find(unit => unit.key === input.key) ?? null;
}

type NavigationOrder = Readonly<{
    files: readonly HunkReviewFile[];
    rankByFileIndex: readonly number[];
    openRanks: readonly number[];
    firstOpenKeys: readonly (string | null)[];
    lastOpenKeys: readonly (string | null)[];
}>;

/** Source Viewed changes one path at a time. Rank/select keeps both updates and moves logarithmic
 * at the observed 55,559-file inventory, without rebuilding the hunk or file-order projections. */
function buildFileViewedIndex(order: NavigationOrder, indexById: ReadonlyMap<string, number>, viewed: ReadonlySet<string>) {
    const reviewedPaths = new Set<string>();
    const tree = new Int32Array(order.files.length + 1);
    let version = 0;
    const add = (rank: number, delta: number) => {
        for (let index = rank + 1; index < tree.length; index += index & -index) tree[index]! += delta;
    };
    const prefix = (end: number) => {
        let count = 0;
        for (let index = end; index > 0; index -= index & -index) count += tree[index]!;
        return count;
    };
    for (let rank = 0; rank < order.files.length; rank += 1) {
        const path = order.files[rank]!.path;
        if (viewed.has(path)) reviewedPaths.add(path);
        else add(rank, 1);
    }
    return {
        reviewedPaths,
        getVersion: () => version,
        setViewed: (path: string, value: boolean) => {
            const fileIndex = indexById.get(path);
            if (fileIndex === undefined || reviewedPaths.has(path) === value) return;
            if (value) reviewedPaths.add(path); else reviewedPaths.delete(path);
            add(order.rankByFileIndex[fileIndex]!, value ? -1 : 1);
            version += 1;
        },
        nextRank: (rank: number, direction: 1 | -1): number | null => {
            const total = order.files.length - reviewedPaths.size;
            if (total === 0) return null;
            const before = prefix(direction === 1 ? rank + 1 : rank);
            let target = direction === 1 ? before + 1 : before;
            if (target > total) target = 1;
            if (target === 0) target = total;
            let index = 0;
            for (let step = 2 ** Math.floor(Math.log2(order.files.length)); step > 0; step = Math.floor(step / 2)) {
                const next = index + step;
                if (next < tree.length && tree[next]! < target) { index = next; target -= tree[next]!; }
            }
            return index;
        },
    };
}

/** Prepared alongside summary facts when content or marks change, never during a cursor read. */
export function buildHunkReviewNavigation(files: readonly HunkReviewFile[], marked: ReadonlySet<string>,
    inventory: ChangedFilesReviewFileOrder, viewedPaths?: ReadonlySet<string>) {
    const all: HunkReviewFile[] = [];
    const changes: HunkReviewFile[] = [];
    const allRanks: number[] = [];
    const changeRanks: number[] = [];
    const allOpen: number[] = [];
    const changeOpen: number[] = [];
    const firstOpenKeys: (string | null)[] = [];
    const lastOpenKeys: (string | null)[] = [];
    const numberOffsets: number[] = [];
    let offset = 0;
    for (const index of inventory.orderedFileIndices) {
        const file = files[index]!;
        let first: string | null = null;
        let last: string | null = null;
        for (const key of file.keys) {
            if (marked.has(key)) continue;
            first ??= key;
            last = key;
        }
        firstOpenKeys[index] = first;
        lastOpenKeys[index] = last;
        allRanks[index] = all.length;
        if (file.keys.length === 0 || first !== null) allOpen.push(all.length);
        all.push(file);
        changeRanks[index] = -1;
        numberOffsets[index] = file.keys.length === 0 && !file.pending ? 0 : offset;
        if (file.keys.length === 0 && !file.pending) continue;
        changeRanks[index] = changes.length;
        if (first !== null || (file.pending && file.keys.length === 0)) changeOpen.push(changes.length);
        changes.push(file);
        offset += file.keys.length;
    }
    const allOrder = { files: all, rankByFileIndex: allRanks, openRanks: allOpen, firstOpenKeys, lastOpenKeys } satisfies NavigationOrder;
    return {
        indexById: inventory.indexById, numberOffsets,
        all: allOrder,
        fileViewed: viewedPaths ? buildFileViewedIndex(allOrder, inventory.indexById, viewedPaths) : null,
        changes: { files: changes, rankByFileIndex: changeRanks, openRanks: changeOpen, firstOpenKeys, lastOpenKeys } satisfies NavigationOrder,
    };
}

export function moveHunkReviewCursor(navigation: ReturnType<typeof buildHunkReviewNavigation>, cursor: HunkReviewCursor | null,
    direction: 1 | -1, fileOnly = false): HunkReviewCursor | null {
    const order = fileOnly ? navigation.all : navigation.changes;
    const ordered = order.files;
    if (ordered.length === 0) return null;
    const sourceIndex = cursor ? navigation.indexById.get(cursor.path) : undefined;
    const fileIndex = sourceIndex === undefined ? -1 : order.rankByFileIndex[sourceIndex] ?? -1;
    const file = ordered[fileIndex];
    const index = !fileOnly && file && cursor?.key ? file.keys.indexOf(cursor.key) : -1;
    if (!file || (!fileOnly && index < 0)) {
        const first = ordered[direction === 1 ? 0 : ordered.length - 1]!;
        return { path: first.path, key: first.keys[direction === 1 ? 0 : first.keys.length - 1] ?? null };
    }
    if (!fileOnly) {
        const key = file.keys[index + direction];
        if (key) return { path: file.path, key };
    }
    if (fileOnly && navigation.fileViewed) {
        const rank = navigation.fileViewed.nextRank(fileIndex, direction);
        const candidate = ordered[rank ?? (fileIndex + direction + ordered.length) % ordered.length]!;
        return { path: candidate.path, key: candidate.keys[direction === 1 ? 0 : candidate.keys.length - 1] ?? null };
    }
    if (order.openRanks.length > 0) {
        // Upper bound forward, lower bound backward; wrapping can revisit this file last.
        let low = 0;
        let high = order.openRanks.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            const rank = order.openRanks[middle]!;
            if (rank < fileIndex || (direction === 1 && rank === fileIndex)) low = middle + 1;
            else high = middle;
        }
        const openIndex = ((direction === 1 ? low : low - 1) + order.openRanks.length) % order.openRanks.length;
        const candidateRank = order.openRanks[openIndex]!;
        const candidate = ordered[candidateRank]!;
        const candidateIndex = navigation.indexById.get(candidate.path)!;
        return { path: candidate.path, key: (direction === 1 ? order.firstOpenKeys : order.lastOpenKeys)[candidateIndex] ?? null };
    }
    const next = ordered[(fileIndex + direction + ordered.length) % ordered.length]!;
    return { path: next.path, key: next.keys[direction === 1 ? 0 : next.keys.length - 1] ?? null };
}

export function buildHunkReviewSummary(files: readonly HunkReviewFile[], marked: ReadonlySet<string>, viewedPaths?: ReadonlySet<string>) {
    let reviewed = 0;
    let total = 0;
    let count = 0;
    const reviewedPaths = new Set<string>();
    for (const file of files) {
        if (file.keys.length === 0) continue;
        count += 1;
        total += file.keys.length;
        const kept = file.keys.filter(key => marked.has(key)).length;
        reviewed += kept;
        if (!viewedPaths && kept === file.keys.length) reviewedPaths.add(file.path);
    }
    return { reviewed, total, files: viewedPaths ? files.length : count, remaining: total - reviewed,
        reviewedPaths: viewedPaths ?? reviewedPaths };
}

