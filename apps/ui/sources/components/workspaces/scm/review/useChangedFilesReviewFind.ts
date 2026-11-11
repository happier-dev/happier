import * as React from 'react';
import { matchFindText, type FindController, type FindOptions, type FindStatus, type FindTextRange } from '@happier-dev/plugin-ui/presentation';
import type { ChangedFilesReviewDiffStateSource } from './ChangedFilesReviewDiffStore';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { isTextReadableFileViewerKind, resolveFileViewerKind } from '@/scm/utils/filePresentation';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { expandUnifiedDiffContext } from '@/components/ui/code/model/expandUnifiedDiffContext';
import { reconcileCodeLineFindRanges } from '@/components/ui/code/model/reconcileCodeLineFindRanges';

export type ReviewFindTarget = Readonly<{ filePath: string; lineId: string }>;
type FileSnapshot = Readonly<{ count: number; ranges: ReadonlyMap<string, readonly FindTextRange[]>; lines?: readonly CodeLine[] }>;
export type ReviewFindSnapshot = Readonly<{ open: boolean; query: string; options: FindOptions; status: FindStatus }>;
type Input = Readonly<{
    paths: readonly string[];
    binaryPaths?: ReadonlySet<string>;
    intraLineDiff?: Parameters<typeof buildCodeLinesFromUnifiedDiff>[0]['intraLineDiff'];
    diffStateSource: ChangedFilesReviewDiffStateSource;
    reveal(target: ReviewFindTarget | null): void;
    /** When one file is shown in several places (a walkthrough's stops), each place is its own key; this names its file. */
    filePathOf?(key: string): string;
}>;
const EMPTY_FILE: FileSnapshot = { count: 0, ranges: new Map() };
type Match = ReviewFindTarget & Readonly<{ start: number; end: number }>;

function sameFile(left: FileSnapshot, right: FileSnapshot): boolean {
    return left.count === right.count && left.ranges === right.ranges && left.lines === right.lines;
}

/** Ephemeral projection of the review loader's bytes; the loader remains the only fetch owner. */

export function createChangedFilesReviewFind() {
    let snapshot: ReviewFindSnapshot = { open: false, query: '', options: { matchCase: false, regex: false }, status: { kind: 'idle' } };
    const listeners = new Set<() => void>();
    const fileListeners = new Map<string, Set<() => void>>();
    const files = new Map<string, FileSnapshot>();
    const parsed = new Map<string, {
        diff: string;
        baseText: string | undefined;
        intraLineDiff: Input['intraLineDiff'];
        lines: readonly CodeLine[];
        incomplete: boolean;
        matched?: Readonly<{ query: string; options: FindOptions; matches: readonly Match[] }>;
    }>();
    let input: Input | null = null;
    let unsubscribes: Array<() => void> = [];
    let matches: Match[] = [];
    let current: Match | null = null;
    const refolders = new Map<string, NonNullable<FindController['refold']>>();
    const publish = () => { for (const listener of listeners) listener(); };
    const decorate = () => {
        const rangesByPath = new Map<string, Map<string, FindTextRange[]>>();
        for (const match of matches) {
            let ranges = rangesByPath.get(match.filePath);
            if (!ranges) { ranges = new Map(); rangesByPath.set(match.filePath, ranges); }
            const line = ranges.get(match.lineId) ?? [];
            line.push({ start: match.start, end: match.end, current: match === current });
            ranges.set(match.lineId, line);
        }
        for (const path of new Set([...files.keys(), ...(input?.paths ?? [])])) {
            const draft = rangesByPath.get(path);
            const ranges = draft ? reconcileCodeLineFindRanges((files.get(path) ?? EMPTY_FILE).ranges, draft) : EMPTY_FILE.ranges;
            const lines = snapshot.open ? parsed.get(path)?.lines : undefined;
            const next = ranges.size === 0 && !lines ? EMPTY_FILE : {
                count: [...ranges.values()].reduce((sum, line) => sum + line.length, 0), ranges, ...(lines ? { lines } : {}),
            };
            if (sameFile(files.get(path) ?? EMPTY_FILE, next)) continue;
            if (next === EMPTY_FILE) files.delete(path);
            else files.set(path, next);
            for (const listener of fileListeners.get(path) ?? []) listener();
        }
    };
    const refresh = (resetCurrent = false) => {
        const previousCurrent = current;
        const previousIndex = matches.indexOf(previousCurrent!);
        matches = [];
        let pending = false;
        let partial = false;
        let invalid = false;
        if (snapshot.open && snapshot.query && input) {
            invalid = 'invalidPattern' in matchFindText('', snapshot.query, snapshot.options);
            if (!invalid) for (const path of input.paths) {
                const viewer = resolveFileViewerKind({ path: input.filePathOf?.(path) ?? path, isBinaryContent: input.binaryPaths?.has(path) });
                if (!isTextReadableFileViewerKind(viewer.kind)) { partial = true; continue; }
                const state = input.diffStateSource.getDiffState(path);
                if (state.status === 'idle' || state.status === 'loading') { pending = true; continue; }
                if (state.status === 'error' || /^Binary files .* differ$/m.test(state.diff) || /^GIT binary patch$/m.test(state.diff)) {
                    partial = true; continue;
                }
                if (state.context?.status === 'loading') pending = true;
                if (state.context?.status === 'unavailable') partial = true;
                const baseText = state.context?.status === 'loaded' ? state.context.baseText : undefined;
                let projection = parsed.get(path);
                if (!projection || projection.diff !== state.diff || projection.baseText !== baseText || projection.intraLineDiff !== input.intraLineDiff) {
                    const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: state.diff, hideFilePrelude: true, intraLineDiff: input.intraLineDiff });
                    const expanded = baseText === undefined ? lines : expandUnifiedDiffContext({ unifiedDiff: state.diff, baseText, lines });
                    projection = { diff: state.diff, baseText, intraLineDiff: input.intraLineDiff, lines: expanded ?? lines, incomplete: expanded === null };
                    parsed.set(path, projection);
                }
                if (projection.incomplete) partial = true;
                const cached = projection.matched;
                if (!cached || cached.query !== snapshot.query || cached.options.regex !== snapshot.options.regex
                    || cached.options.matchCase !== snapshot.options.matchCase) {
                    const fileMatches: Match[] = [];
                    for (const line of projection.lines) {
                        if (line.renderIsHeaderLine) continue;
                        const result = matchFindText(line.renderCodeText, snapshot.query, snapshot.options);
                        if ('ranges' in result) for (const [start, end] of result.ranges) fileMatches.push({ filePath: path, lineId: line.id, start, end });
                    }
                    projection.matched = { query: snapshot.query, options: snapshot.options, matches: fileMatches };
                }
                for (const match of projection.matched!.matches) matches.push(match);
            }
        }
        current = previousCurrent && !resetCurrent ? matches.find((match) => match.filePath === previousCurrent.filePath
            && match.lineId === previousCurrent.lineId && match.start === previousCurrent.start && match.end === previousCurrent.end) ?? null : null;
        current ??= matches[resetCurrent ? 0 : Math.max(0, Math.min(previousIndex, matches.length - 1))] ?? null;
        const status: FindStatus = !snapshot.open || !snapshot.query ? { kind: 'idle' } : invalid ? { kind: 'invalidPattern' }
            : pending ? { kind: 'searching', current: current ? matches.indexOf(current) + 1 : null, total: matches.length }
            : { kind: 'results', total: matches.length, current: current ? matches.indexOf(current) + 1 : null,
                files: new Set(matches.map((match) => input?.filePathOf?.(match.filePath) ?? match.filePath)).size, coverage: partial ? 'partialErrors' : 'complete' };
        snapshot = { ...snapshot, status };
        decorate(); publish();
        if (previousCurrent && !current) input?.reveal(null);
        if (current && (resetCurrent || !previousCurrent || current.filePath !== previousCurrent.filePath || current.lineId !== previousCurrent.lineId)) {
            input?.reveal({ filePath: current.filePath, lineId: current.lineId });
        }
    };
    const observe = () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
        unsubscribes = snapshot.open && input ? input.paths.map((path) => input!.diffStateSource.subscribe(path, () => refresh())) : [];
    };
    return {
        get query() { return snapshot.query; }, get options() { return snapshot.options; },
        get status() { return snapshot.status; }, capabilities: { regex: true, stop: false },
        getSnapshot: () => snapshot,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        subscribeFile(path: string, listener: () => void) {
            const set = fileListeners.get(path) ?? new Set(); set.add(listener); fileListeners.set(path, set);
            return () => { set.delete(listener); if (!set.size) fileListeners.delete(path); };
        },
        getFileSnapshot: (path: string) => files.get(path) ?? EMPTY_FILE,
        registerRefold(path: string, refold: NonNullable<FindController['refold']>) {
            refolders.set(path, refold);
            return () => { if (refolders.get(path) === refold) refolders.delete(path); };
        },
        refold(): ReturnType<NonNullable<FindController['refold']>> {
            if (!current) return 'noRevealedFold';
            return refolders.get(current.filePath)?.() ?? 'unsupported';
        },
        connect(next: Input) {
            input = next;
            for (const path of parsed.keys()) if (!next.paths.includes(path)) parsed.delete(path);
            observe(); refresh();
            return () => { for (const unsubscribe of unsubscribes) unsubscribe(); unsubscribes = []; input = null; };
        },
        open() { if (snapshot.open) return; snapshot = { ...snapshot, open: true }; observe(); refresh(); },
        setQuery(query: string) { if (snapshot.query === query) return; snapshot = { ...snapshot, query }; refresh(true); },
        setOptions(options: FindOptions) {
            if (options.regex === snapshot.options.regex && options.matchCase === snapshot.options.matchCase) return;
            snapshot = { ...snapshot, options }; refresh(true);
        },
        step(direction: 1 | -1) {
            if (!matches.length) return;
            current = matches[(matches.indexOf(current!) + direction + matches.length) % matches.length];
            refresh();
            input?.reveal({ filePath: current!.filePath, lineId: current!.lineId });
        },
        stop() {},
        close() { snapshot = { ...snapshot, open: false }; parsed.clear(); observe(); refresh(); input?.reveal(null); },
    };
}

export type ChangedFilesReviewFindModel = ReturnType<typeof createChangedFilesReviewFind>;
export function useChangedFilesReviewFind(input?: Input) {
    const [model] = React.useState(createChangedFilesReviewFind);
    React.useEffect(() => input ? model.connect(input) : undefined, [model, input?.paths, input?.binaryPaths, input?.intraLineDiff, input?.diffStateSource, input?.reveal, input?.filePathOf]);
    return model;
}
