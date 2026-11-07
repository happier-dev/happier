import * as React from 'react';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { getScmComparisonDiscardRestriction, type ScmWorkingEntry, type ScmComparisonDiscardReason } from '@happier-dev/protocol/scm';
import type { ScmComparison } from '@happier-dev/protocol/scm/comparison';
import { buildReviewUnits, buildScmFileReviewUnits, buildScmReviewScopeId, type ReviewUnit } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { formatHunk } from '@happier-dev/protocol/diff/hunks';
import { useScmReviewedMarks, type ScmReviewedMarks } from '@/components/sessions/files/comparison/useScmReviewedMarks';
import { useCapturedFileByPath, type CapturedFileByPath } from '@/components/sessions/files/comparison/useCapturedFileByPath';
import { useScmFileViewed, useScmFileViewedFile, useScmFileViewedStatus } from '@/components/sessions/files/comparison/useScmFileViewed';
import type { ScmFileViewedSource } from '@/sync/domains/scm/fileViewed';
import type { DiffHunkAction, DiffHunkInfo, DiffHunkReviewState, DiffViewerHunks } from '@/components/ui/code/diff/diffViewerTypes';
import type { ScmDiffSummaryHost } from '@/sync/ops/scmDiffSummary/results';
import { getLiveReviewBase, buildHunkReviewNavigation, buildHunkReviewSummary, moveHunkReviewCursor, resolveHunkReviewUnit, type HunkReviewCursor, type HunkReviewFile } from './hunkReviewModel';
import { buildChangedFilesReviewFileIndex, type ChangedFilesReviewFileOrder } from '../changedFilesReviewFileIndex';
import { t } from '@/text';
import { getErrorMessage } from '@/utils/errors/getErrorMessage';

function describeDiscardRestriction(reason: ScmComparisonDiscardReason): string {
    switch (reason) {
        case 'staged': return t('hunkReview.discardStaged');
        case 'renamed_or_copied': return t('hunkReview.discardRenamedOrCopied');
        case 'untracked': return t('hunkReview.discardUntracked');
        case 'added_file': return t('hunkReview.noticeUnsupported');
    }
}

export type HunkReviewSource = Readonly<{ kind: 'captured'; comparison: ScmComparison }>
    | Readonly<{ kind: 'live'; root: string }>;
type UnitsByPath = Readonly<{ get(path: string): readonly ReviewUnit[] | undefined }>;
export type HunkReviewActionTarget = Readonly<{
    path: string;
    changeKey: string;
    expectedHash?: string;
    source: HunkReviewSource;
    unit: ReviewUnit;
}>;

/** The same keyed review actions serve a diff row and a tracked editor marker. */
export type HunkReviewChangeActions<DraftResult = never> = Readonly<{
    state: DiffHunkReviewState;
    keep: () => void;
    discard?: () => Promise<void | DraftResult>;
    ask?: () => void;
    copy: () => void;
    disabledReason: (action: DiffHunkAction) => string | null;
}>;

export type HunkReviewControllerParams = Readonly<{
    enabled?: boolean;
    active?: boolean;
    source: HunkReviewSource;
    path: string;
    unifiedDiff: string;
    /** Reuse the reading surface's captured lookup rather than indexing the same inventory twice. */
    capturedFileByPath?: CapturedFileByPath | null;
    contentHash?: string | null;
    host: ScmDiffSummaryHost | null;
    serverId: string | null;
    writeUnavailableReason?: string | null;
    /** A parent comparison reuses its one Account observer across rendered files. */
    marks?: ScmReviewedMarks;
    /** An admitted source is shared by the comparison and its file rows; null explicitly disables it. */
    fileViewed?: ScmFileViewedSource | null;
    /** The live comparison's currently loaded files, when reviewing several files. */
    liveFiles?: readonly Readonly<{ path: string; unifiedDiff: string; generated?: boolean; lockfile?: boolean; pending?: boolean }>[];
    /** The parent Review's admitted inventory, aligned with liveFiles; picker and hunk cursor share this index. */
    fileIndex?: ChangedFilesReviewFileOrder;
    /** Actual working-snapshot facts, not a kind inferred from a path or diff header. */
    liveEntries?: readonly Pick<ScmWorkingEntry, 'path' | 'kind' | 'hasIncludedDelta'>[];
    onNavigate?: (cursor: HunkReviewCursor) => void;
    onDiscard?: (target: HunkReviewActionTarget) => void | Promise<void>;
    onAsk?: (target: HunkReviewActionTarget) => void | Promise<void>;
    onOutOfDate?: () => void;
    discardDisabledReason?: string | null;
    undo?: () => void;
    onReviewAction?: () => void;
}>;

/** Review navigation, content identity and Keep share one owner on all reading surfaces. */
export function useHunkReviewController(params: HunkReviewControllerParams) {
    const writeClipboard = useClipboardWrite(params.serverId);
    const captured = params.source.kind === 'captured' ? params.source.comparison : null;
    const active = params.enabled !== false && params.active !== false;
    const ownedFileViewed = useScmFileViewed({ comparison: captured, host: params.host, serverId: params.serverId,
        enabled: params.fileViewed === undefined && params.enabled !== false, active, refreshToken: captured });
    const fileViewed = params.fileViewed === undefined ? ownedFileViewed : params.fileViewed;
    const fileViewedState = useScmFileViewedFile(fileViewed, params.path, active);
    const fileViewedStatus = useScmFileViewedStatus(fileViewed, active);
    const setFileViewed = React.useCallback((path: string, viewed: boolean) =>
        fileViewed?.setViewed(path, viewed) ?? Promise.resolve(false), [fileViewed]);
    const singlePath = captured || params.liveFiles ? null : params.path;
    // A live file list fixes the checkout's order, units and rows once per list; only the open file's diff varies per page.
    const liveBase = React.useMemo(() => !captured && params.liveFiles ? getLiveReviewBase(params.liveFiles) : null, [captured, params.liveFiles]);
    // Inventory structure owns classification/order. Content and cursor changes only read it.
    const inventory = React.useMemo(() => params.fileIndex ?? liveBase?.getInventory() ?? buildChangedFilesReviewFileIndex<Readonly<{
        fullPath: string; generated?: boolean; lockfile?: boolean }>>(
        captured ? captured.inventory.files.map(file => ({ fullPath: file.path, generated: file.generated, lockfile: file.lockfile }))
            : [{ fullPath: singlePath ?? '', generated: undefined, lockfile: undefined }]),
    [params.fileIndex, liveBase, captured?.inventory.files, singlePath]);
    const openLiveUnits = React.useMemo(() => !captured ? buildReviewUnits(params.path, undefined, params.unifiedDiff) : null,
        [captured, params.path, params.unifiedDiff]);
    const unitsByPath = React.useMemo<UnitsByPath>(() => {
        if (liveBase) return { get: path => path === params.path ? openLiveUnits! : liveBase.unitsByPath.get(path) };
        const result = new Map<string, readonly ReviewUnit[]>();
        if (captured) {
            for (const file of captured.inventory.files) result.set(file.path, buildScmFileReviewUnits(file.path === params.path
                ? { ...file, evidence: { state: 'available', unifiedDiff: params.unifiedDiff } } : file));
        } else {
            result.set(params.path, openLiveUnits!);
        }
        return result;
    }, [liveBase, captured?.inventory.files, params.path, params.unifiedDiff, openLiveUnits]);
    const units = unitsByPath.get(params.path) ?? [];
    // Discard authority is decided per mounted row and per render; resolve its file by path, not by scanning.
    const capturedFileByPath = useCapturedFileByPath(captured, params.capturedFileByPath);
    const liveEntryByPath = React.useMemo(() => params.liveEntries ? new Map(params.liveEntries.map(entry => [entry.path, entry])) : null,
        [params.liveEntries]);
    const files = React.useMemo<readonly HunkReviewFile[]>(() => {
        if (captured) return inventory.items.map(item => ({ path: item.id,
            keys: (unitsByPath.get(item.id) ?? []).map(unit => unit.key),
            pending: capturedFileByPath?.get(item.id)?.evidence.state === 'deferred' }));
        if (liveBase) {
            const index = inventory.indexById.get(params.path);
            const row = index === undefined ? undefined : liveBase.files[index];
            const keys = units.map(unit => unit.key);
            // The open file's diff is the page's own, so its row is never a pending (unloaded) one.
            if (!row || (!row.pending && row.keys.length === keys.length && row.keys.every((key, i) => key === keys[i]))) return liveBase.files;
            const next = liveBase.files.slice();
            next[index!] = { ...row, keys, pending: false };
            return next;
        }
        return [{ path: params.path, keys: units.map(unit => unit.key) }];
    }, [captured !== null, capturedFileByPath, liveBase, params.path, units, unitsByPath, inventory]);
    const liveSource = React.useMemo(() => params.source.kind === 'live' ? {
        repositoryRootPath: params.source.root, source: { kind: 'workingTree' as const }, changeKeys: files.flatMap(file => file.keys),
    } : undefined, [params.source.kind, params.source.kind === 'live' ? params.source.root : null, files]);
    const ownedMarks = useScmReviewedMarks({ comparison: params.marks || params.enabled === false ? null : captured,
        source: params.marks || params.enabled === false ? undefined : liveSource, host: params.host, serverId: params.serverId,
        writeUnavailableReason: params.writeUnavailableReason });
    const marks = params.marks ?? ownedMarks;
    const writeUnavailableReason = params.writeUnavailableReason ?? marks.unavailableReason;
    const scopeId = buildScmReviewScopeId(params.source.kind === 'captured'
        ? { repositoryRootPath: params.source.comparison.repository.rootPath, source: params.source.comparison.source }
        : { repositoryRootPath: params.source.root, source: { kind: 'workingTree' } });
    const marked = React.useMemo(() => new Set(marks.record?.reviewedChangeKeys ?? []), [marks.record]);
    const [selection, setSelection] = React.useState<HunkReviewCursor | null>(null);
    // The change the page last moved to (navigation, Keep advance); `reading` once the reader's own scroll
    // chose the current change, so the page never jumps under the reader and the next move always lands.
    const [revealed, setRevealed] = React.useState<HunkReviewCursor | 'reading' | null>(null);
    const [table, setTable] = React.useState<readonly DiffHunkInfo[]>([]);
    const [discardingKey, setDiscardingKey] = React.useState<string | null>(null);
    const currentKey = selection?.path === params.path && units.some(unit => unit.key === selection.key)
        ? selection.key : units[0]?.key ?? null;
    const cursor = inventory.indexById.has(params.path) ? { path: params.path, key: currentKey } : null;
    const latest = React.useRef({ params, unitsByPath, capturedFileByPath, liveEntryByPath, marks, marked, files, cursor, scopeId, writeUnavailableReason });
    latest.current = { params, unitsByPath, capturedFileByPath, liveEntryByPath, marks, marked, files, cursor, scopeId, writeUnavailableReason };
    const onHunks = React.useCallback((next: readonly DiffHunkInfo[]) => {
        setTable(previous => previous.length === next.length && previous.every((hunk, index) =>
            hunk.key === next[index]?.key && hunk.firstChangeLineId === next[index]?.firstChangeLineId) ? previous : next);
    }, []);
    const moveTo = (next: HunkReviewCursor) => {
        setSelection(next);
        setRevealed(next);
        params.onNavigate?.(next);
    };
    const navigate = (direction: 1 | -1, fileOnly = false) => {
        const next = moveHunkReviewCursor(navigation, cursor, direction, fileOnly);
        if (next) moveTo(next);
    };
    const findUnit = (key: string, path = params.path) => resolveHunkReviewUnit({ key, renderedScopeId: scopeId,
            currentScopeId: latest.current.scopeId, units: latest.current.unitsByPath.get(path) ?? [] });
    const resolve = (key: string, path = params.path) => {
        const unit = findUnit(key, path);
        if (!unit) { params.onOutOfDate?.(); return null; }
        return unit;
    };
    const keep = (key: string, path = params.path) => {
        const unit = resolve(key, path);
        if (!unit || latest.current.writeUnavailableReason) return;
        params.onReviewAction?.();
        const keeping = !latest.current.marked.has(unit.key);
        marks.setReviewedKeys([unit.key], keeping);
        // Letting a change go (its row, the phone long-press menu) makes it the current one, where the reader is.
        if (!keeping && path === params.path) { setSelection({ path, key: unit.key }); setRevealed('reading'); }
    };
    // The handler retains the hash that accompanied its rendered row. Current key membership
    // is resolved at invocation; the canonical Discard owner guards the displayed bytes.
    const displayedHash = params.contentHash ?? null;
    const target = (key: string, path: string): HunkReviewActionTarget | null => {
        const unit = resolve(key, path);
        return unit ? { path, changeKey: key, ...(path === params.path && displayedHash ? { expectedHash: displayedHash } : {}),
            source: params.source, unit } : null;
    };
    const restrictionFor = (key: string | null, path = params.path) => {
        const current = latest.current;
        if (current.params.source.kind === 'captured') {
            const file = current.capturedFileByPath?.get(path);
            const unit = current.unitsByPath.get(path)?.find(unit => unit.key === key);
            return file && unit ? getScmComparisonDiscardRestriction({ kind: 'captured', file, hunkIndexes: [unit.hunkIndex] }) : null;
        }
        return getScmComparisonDiscardRestriction({ kind: 'live',
            entry: current.liveEntryByPath?.get(path), hunks: true });
    };
    const offersDiscard = (key: string | null, path = params.path) => Boolean(params.onDiscard) && restrictionFor(key, path)?.reason !== 'added_file';
    const discard = async (key: string, path = params.path) => {
        const current = target(key, path);
        if (!current || latest.current.params.discardDisabledReason || restrictionFor(key, path) || !params.onDiscard) return;
        params.onReviewAction?.();
        setDiscardingKey(key);
        try { await params.onDiscard(current); }
        finally { setDiscardingKey(null); }
    };
    const ask = (key: string, path = params.path) => {
        const current = target(key, path);
        if (current) void params.onAsk?.(current);
    };
    const copy = (key: string, path: string) => {
        const unit = resolve(key, path);
        if (unit) void writeClipboard(formatHunk(unit.hunk));
    };
    const { summary, navigation } = React.useMemo(() => ({
        summary: buildHunkReviewSummary(files, marked, fileViewed?.getViewedPaths()),
        navigation: buildHunkReviewNavigation(files, marked, inventory, fileViewed?.getViewedPaths()),
    }), [files, marked, inventory, fileViewed, active]);
    const viewedIndex = navigation.fileViewed;
    React.useSyncExternalStore(React.useCallback(listener => {
        if (!fileViewed || !viewedIndex || !active) return () => {};
        return fileViewed.subscribeChanges(path => {
            viewedIndex.setViewed(path, fileViewed.getFile(path).state === 'viewed');
            listener();
        });
    }, [fileViewed, viewedIndex, active]), viewedIndex?.getVersion ?? (() => 0), () => 0);
    const reviewedPaths = viewedIndex?.reviewedPaths ?? summary.reviewedPaths;
    const currentIndex = currentKey ? units.findIndex(unit => unit.key === currentKey) : -1;
    const revealKey = revealed === 'reading' ? null
        : revealed?.path === params.path && units.some(unit => unit.key === revealed.key) ? revealed.key : units[0]?.key ?? null;
    const nextFile = moveHunkReviewCursor(navigation, cursor, 1, true);
    const stateOfKey = (key: string): DiffHunkReviewState => discardingKey === key ? 'discarding' : marked.has(key) ? 'kept' : 'open';
    const disabledReason = (action: DiffHunkAction, key = currentKey, path = params.path) => {
        if (action === 'keep') return writeUnavailableReason ? getErrorMessage(writeUnavailableReason) : null;
        if (action !== 'discard') return null;
        const restriction = restrictionFor(key, path);
        return restriction ? describeDiscardRestriction(restriction.reason) : params.discardDisabledReason ?? null;
    };
    const changeActionsForKey = <DraftResult = never,>(key: string, options?: Readonly<{
        /** Dirty Discard is an editor transaction, so Machine reachability does not disable it. */
        discardInDraft?: () => Promise<DraftResult>;
    }>): HunkReviewChangeActions<DraftResult> | null => {
        // This reader runs while the peek renders; refresh only from an attempted stale action.
        if (!findUnit(key)) return null;
        const discardInDraft = options?.discardInDraft;
        return {
            state: stateOfKey(key), keep: () => keep(key), copy: () => copy(key, params.path),
            ...(params.onAsk ? { ask: () => ask(key) } : {}),
            disabledReason: action => action === 'discard' && discardInDraft ? null : disabledReason(action, key),
            ...(discardInDraft ? { discard: async () => {
                if (!resolve(key)) return;
                params.onReviewAction?.();
                setDiscardingKey(key);
                try { return await discardInDraft(); }
                finally { setDiscardingKey(null); }
            } } : offersDiscard(key) ? { discard: () => discard(key) } : {}),
        };
    };
    // Publish a per-file model only when its rendered facts change. Editor draft persistence
    // rerenders the retained review too; fresh hunk objects would rebuild every Pierre row.
    // Command changes republish; an old row retains its displayed hash/scope and action writer.
    const liveRoot = params.source.kind === 'live' ? params.source.root : null;
    const hunksForPath = React.useMemo(() => {
        const published = new Map<string, DiffViewerHunks>();
        return (path: string): DiffViewerHunks => {
            const previous = published.get(path);
            if (previous) return previous;
            const index = inventory.indexById.get(path);
            const offset = index === undefined ? 0 : navigation.numberOffsets[index] ?? 0;
            const next: DiffViewerHunks = {
                ...(path === params.path ? { onHunks } : {}),
                currentIndex: path === params.path && currentIndex >= 0 ? currentIndex : null, numberOffset: offset, numberTotal: summary.total,
                stateOf: hunk => stateOfKey(hunk.key),
                disabledReason: (hunk, action) => disabledReason(action, hunk.key, path),
                actions: { keep: hunk => keep(hunk.key, path), copy: hunk => copy(hunk.key, path),
                    ...(offersDiscard(unitsByPath.get(path)?.[0]?.key ?? null, path) ? { discard: (hunk: DiffHunkInfo) => { void discard(hunk.key, path); } } : {}),
                    ...(params.onAsk ? { ask: (hunk: DiffHunkInfo) => ask(hunk.key, path) } : {}) },
            };
            published.set(path, next);
            return next;
        };
    }, [captured, liveRoot, scopeId, params.path, displayedHash, params.liveEntries,
        params.discardDisabledReason, writeUnavailableReason, marked, discardingKey,
        currentIndex, inventory, navigation, summary.total, unitsByPath, marks.setReviewedKeys,
        onHunks, params.onOutOfDate, params.onReviewAction, params.onDiscard, params.onAsk, writeClipboard]);
    const reviewUnitsForPath = React.useCallback((path: string) => unitsByPath.get(path) ?? [], [unitsByPath]);
    const hunks = hunksForPath(params.path);
    return {
        fileViewed, fileViewedState, fileViewedStatus, reviewedPaths, setFileViewed,
        hunks, hunksForPath, changeActionsForKey, reviewUnitsForPath,
        reviewUnits: units, cursor, currentIndex, currentHunk: table.find(hunk => hunk.key === currentKey) ?? null,
        /** Where the page should be scrolled: the change last moved to, never one the reader scrolled onto. */
        revealHunk: table.find(hunk => hunk.key === revealKey) ?? null,
        /** Phone: the change crossing the reading line becomes current (P5 §3.11) without scrolling the page. */
        followReadingLine: (key: string) => {
            if (key === currentKey || !units.some(unit => unit.key === key)) return;
            setSelection({ path: params.path, key });
            setRevealed('reading');
        },
        /**
         * The File page's review line: changes are counted within the open file; the rest of the comparison is
         * counted in files, since another file's changes are unknown until its diff loads (a pending file is left).
         */
        strip: { current: currentIndex < 0 ? 0 : currentIndex + 1, total: units.length,
            reviewed: units.filter(unit => marked.has(unit.key)).length,
            fileReviewKind: fileViewed ? 'sourceViewed' as const : 'local' as const,
            fileCountsKnown: !fileViewed || fileViewedStatus.headOid !== null,
            filesLeft: (fileViewed ? navigation.all.files.length : navigation.changes.files.length) - reviewedPaths.size,
            canKeepAll: !fileViewed && !writeUnavailableReason && units.some(unit => !marked.has(unit.key)),
            nextFile: nextFile?.path !== params.path ? nextFile?.path ?? null : null,
            fileComplete: fileViewed ? fileViewedState.state === 'viewed' : units.length > 0 && units.every(unit => marked.has(unit.key)) },
        next: () => navigate(1), previous: () => navigate(-1), nextFile: () => navigate(1, true), previousFile: () => navigate(-1, true),
        keepCurrent: () => { if (currentKey) keep(currentKey); },
        /** The phone bar's Keep: mark the current change, then glide to the next open change in this file. */
        keepCurrentAndAdvance: () => {
            if (!currentKey || latest.current.writeUnavailableReason) return;
            const keeping = !marked.has(currentKey);
            keep(currentKey);
            if (!keeping) return;
            const at = units.findIndex(unit => unit.key === currentKey);
            const open = [...units.slice(at + 1), ...units.slice(0, Math.max(0, at))].find(unit => !marked.has(unit.key));
            if (open) moveTo({ path: params.path, key: open.key });
        },
        discardCurrent: offersDiscard(currentKey) ? () => { if (currentKey) void discard(currentKey); } : undefined,
        discardUnavailableReason: restrictionFor(currentKey)?.reason ?? null,
        discardDisabledReason: disabledReason('discard'),
        askCurrent: params.onAsk ? () => { if (currentKey) ask(currentKey); } : undefined,
        keepAll: () => { if (!fileViewed && !writeUnavailableReason && units.length > 0) {
            params.onReviewAction?.(); marks.setReviewedKeys(units.map(unit => unit.key), true);
        } },
        reset: () => { if (!latest.current.writeUnavailableReason) latest.current.marks.clear(); }, undo: params.undo,
    };
}
