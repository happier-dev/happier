import * as React from 'react';
import { matchFindText, type FindController, type FindOptions, type FindStatus, type FindTextRange } from '@happier-dev/plugin-ui/presentation';
import type { FileFindSeed } from '@/components/appShell/panes/fileFindSeedHandoff';
import { buildCodeLinesFromFile } from '@/components/ui/code/model/buildCodeLinesFromFile';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { projectMarkdownFindText, type FindDisplayText } from '@/components/markdown/rendering/markdownFindProjection';

export type FileViewerFindContent = Readonly<{ path: string; mode: 'file' | 'diff' | 'markdown'; text: string | null }>;

type FileViewerFindMatch = Readonly<{ lineId: string | null; line: number; ranges: readonly FindTextRange[] }>;
export type FileViewerFindSnapshot = Readonly<{
    open: boolean;
    query: string;
    options: FindOptions;
    status: FindStatus;
    lineTarget: string | null;
    markdownLineTarget: number | null;
    lineRanges: ReadonlyMap<string, readonly FindTextRange[]>;
    markdownRanges: readonly FindTextRange[];
    revealRevision: number;
}>;

function sourceRanges(projection: FindDisplayText, start: number, end: number): readonly FindTextRange[] {
    const ranges: FindTextRange[] = [];
    for (let offset = start; offset < end; offset++) {
        const sourceStart = projection.sourceOffsets[offset];
        const sourceEnd = projection.sourceEnds[offset];
        if (sourceStart === undefined || sourceEnd === undefined) continue;
        const previous = ranges[ranges.length - 1];
        if (previous && previous.end === sourceStart) ranges[ranges.length - 1] = { ...previous, end: sourceEnd };
        else ranges.push({ start: sourceStart, end: sourceEnd, current: false });
    }
    return ranges;
}

/** One ephemeral mounted file owner; closed refreshes never project or match its content. */
export function createFileViewerFindModel(read: () => FileViewerFindContent) {
    let snapshot: FileViewerFindSnapshot = { open: false, query: '', options: { matchCase: false, regex: false },
        status: { kind: 'idle' }, lineTarget: null, markdownLineTarget: null,
        lineRanges: new Map(), markdownRanges: [], revealRevision: 0 };
    let matches: readonly FileViewerFindMatch[] = [];
    let current = -1;
    let content: FileViewerFindContent | null = null;
    let lines: ReturnType<typeof buildCodeLinesFromFile> = [];
    let markdown: FindDisplayText | null = null;
    let markdownLineStarts: number[] = [];
    const listeners = new Set<() => void>();
    const publish = (update: Partial<FileViewerFindSnapshot>) => {
        snapshot = { ...snapshot, ...update };
        for (const listener of listeners) listener();
    };
    const decorate = (status: FindStatus) => {
        const lineRanges = new Map<string, readonly FindTextRange[]>();
        const markdownRanges: FindTextRange[] = [];
        matches.forEach((match, index) => {
            const ranges = match.ranges.map((range) => ({ ...range, current: index === current }));
            if (match.lineId) lineRanges.set(match.lineId, [...(lineRanges.get(match.lineId) ?? []), ...ranges]);
            else markdownRanges.push(...ranges);
        });
        const target = matches[current];
        publish({ status, lineRanges, markdownRanges, lineTarget: target?.lineId ?? null,
            markdownLineTarget: target && !target.lineId ? target.line : null,
            revealRevision: snapshot.revealRevision + 1 });
    };
    const results = () => decorate({ kind: 'results', current: current < 0 ? null : current + 1,
        total: matches.length, coverage: markdown?.incomplete ? 'partialErrors' : 'complete' });
    const refresh = (targetLine?: number, reset = false) => {
        if (!snapshot.open) return;
        const next = read();
        const previous = matches[current];
        if (!content || content.path !== next.path || content.mode !== next.mode || content.text !== next.text) {
            content = next;
            lines = next.text === null || next.mode === 'markdown' ? [] : next.mode === 'diff'
                ? buildCodeLinesFromUnifiedDiff({ unifiedDiff: next.text, hideFilePrelude: true })
                : buildCodeLinesFromFile({ text: next.text });
            markdown = next.mode === 'markdown' && next.text !== null ? projectMarkdownFindText(next.text) : null;
            markdownLineStarts = [0];
            if (markdown && next.text !== null) {
                for (let offset = 0; offset < next.text.length; offset++) {
                    if (next.text[offset] === '\n') markdownLineStarts.push(offset + 1);
                }
            }
        }
        matches = []; current = -1;
        if (next.text === null) { decorate({ kind: 'unavailable', reason: 'unsupportedEngine' }); return; }
        if (!snapshot.query) { decorate({ kind: 'idle' }); return; }
        const validation = matchFindText('', snapshot.query, snapshot.options);
        if ('invalidPattern' in validation) { decorate({ kind: 'invalidPattern' }); return; }
        if (markdown) {
            const result = matchFindText(markdown.text, snapshot.query, snapshot.options);
            if ('ranges' in result) matches = result.ranges.map(([start, end]) => {
                const source = markdown!.sourceOffsets[start] ?? next.text!.length;
                // Map offsets without rescanning the document for every match.
                let low = 0;
                let high = markdownLineStarts.length;
                while (low < high) {
                    const middle = Math.floor((low + high) / 2);
                    if (markdownLineStarts[middle]! <= source) low = middle + 1;
                    else high = middle;
                }
                return { lineId: null, line: low,
                    ranges: sourceRanges(markdown!, start, end) };
            });
        } else {
            matches = lines.filter((line) => !line.renderIsHeaderLine).flatMap((line) => {
                const result = matchFindText(line.renderCodeText, snapshot.query, snapshot.options);
                return 'ranges' in result ? result.ranges.map(([start, end]) => ({ lineId: line.id,
                    line: line.newLine ?? line.oldLine ?? 1, ranges: [{ start, end, current: false }] })) : [];
            });
        }
        if (targetLine !== undefined) current = matches.findIndex((match) => match.line >= targetLine);
        else if (!reset && previous) current = matches.findIndex((match) => match.lineId === previous.lineId
            && match.line === previous.line && match.ranges[0]?.start === previous.ranges[0]?.start);
        if (current < 0 && matches.length > 0) current = 0;
        results();
    };
    const model: FindController & {
        getSnapshot(): FileViewerFindSnapshot; subscribe(listener: () => void): () => void;
        open(): void; refresh(): void; applySeed(seed: FileFindSeed): boolean;
    } = {
        get query() { return snapshot.query; }, get options() { return snapshot.options; },
        get status() { return snapshot.status; }, capabilities: { regex: true, stop: false },
        setQuery(query) { publish({ query }); refresh(undefined, true); },
        setOptions(options) { publish({ options }); refresh(undefined, true); },
        step(direction) { if (!snapshot.open || !matches.length) return;
            current = (current + direction + matches.length) % matches.length; results(); },
        stop() {},
        close() { matches = []; current = -1; publish({ open: false, status: { kind: 'idle' },
            lineRanges: new Map(), markdownRanges: [], lineTarget: null, markdownLineTarget: null }); },
        open() { if (!snapshot.open) { publish({ open: true }); refresh(); } },
        refresh,
        getSnapshot: () => snapshot,
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        applySeed(seed) { const destination = read();
            if (seed.target.path !== destination.path || destination.text === null) return false;
            publish({ open: true, query: seed.query, options: seed.options });
            const anchor = seed.target.anchor;
            refresh(anchor?.kind === 'line' ? anchor.line : anchor?.startLine, true); return true; },
    };
    return model;
}

export type FileViewerFindModel = ReturnType<typeof createFileViewerFindModel>;

export function useFileViewerFind(content: FileViewerFindContent, active = true): FileViewerFindModel {
    const latest = React.useRef(content);
    latest.current = content;
    const model = React.useMemo(() => createFileViewerFindModel(() => latest.current), [content.path]);
    React.useEffect(() => { if (active) model.refresh(); }, [model, active, content.mode, content.text]);
    return model;
}
