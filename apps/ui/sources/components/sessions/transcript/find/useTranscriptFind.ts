import * as React from 'react';
import { matchFindText, type FindController, type FindOptions, type FindStatus, type FindCoverage } from '@happier-dev/plugin-ui/presentation';
import type { Message, TranscriptOlderPageLoadResult } from '@happier-dev/session-core/messages';
import type { TranscriptHistoryState } from '../source/types';
import type { TranscriptJumpResult, TranscriptJumpTarget } from '../viewport/jump/transcriptJumpTargetTypes';
import { projectTranscriptFindText, type TranscriptFindTextBlock, type TranscriptFindTextContext } from './transcriptFindText';
import { createTranscriptFindRowStore, type TranscriptFindRowSnapshot, type TranscriptFindSourceRange } from './transcriptFindRowStore';
import { resolveTranscriptFindCoverage } from './transcriptFindCoverage';

export type TranscriptFindMatch = Readonly<{ messageId: string; blockId: string; start: number; end: number; message: Message }>;
export type TranscriptFindCorpus = Readonly<{
    messages: readonly Message[];
    history: TranscriptHistoryState;
    displayContexts?: ReadonlyMap<string, TranscriptFindTextContext>;
    hasPendingText?: boolean;
    hasUnreadableText?: boolean;
}>;
export type TranscriptFindModelInput = Readonly<{
    readCorpus(): TranscriptFindCorpus;
    loadPage: ((direction: 'older' | 'newer') => Promise<TranscriptOlderPageLoadResult>) | null;
    jumpToTarget(target: TranscriptJumpTarget, context: Readonly<{ signal: AbortSignal }>): Promise<TranscriptJumpResult>;
    reveal(match: TranscriptFindMatch, context: Readonly<{ signal: AbortSignal }>): Promise<void>;
    afterLoad?: () => Promise<void>;
}>;

export type TranscriptFindSnapshot = Readonly<{ open: boolean; query: string; options: FindOptions; status: FindStatus }>;
/** Where the matches are, for the overview ruler: matched messages in transcript order and the current one. */
export type TranscriptFindOverview = Readonly<{ messageIds: readonly string[]; currentMessageId: string | null }>;
const EMPTY_OVERVIEW: TranscriptFindOverview = { messageIds: [], currentMessageId: null };

/** One mounted transcript owns Find; messages and paging remain owned by its source. */
export function createTranscriptFindModel(input: TranscriptFindModelInput) {
    let snapshot: TranscriptFindSnapshot = { open: false, query: '', options: { matchCase: false, regex: false }, status: { kind: 'idle' } };
    let matches: readonly TranscriptFindMatch[] = [];
    let current: TranscriptFindMatch | null = null;
    let overview = EMPTY_OVERVIEW;
    let seedTarget: TranscriptJumpTarget | null = null;
    let operation = 0;
    let revealRequest = 0;
    let searching = false;
    let stopped = false;
    let partialErrors = false;
    let pending: Promise<void> = Promise.resolve();
    let navigation: AbortController | null = null;
    function invalidateOperation() {
        navigation?.abort();
        navigation = null;
        return ++operation;
    }
    function startNavigation() {
        navigation?.abort();
        navigation = new AbortController();
        return { signal: navigation.signal };
    }
    const listeners = new Set<() => void>();
    const rowStore = createTranscriptFindRowStore();
    const projections = new Map<string, Readonly<{ message: Message; context: TranscriptFindTextContext | undefined; blocks: readonly TranscriptFindTextBlock[] }>>();

    const sameMatch = (a: TranscriptFindMatch | null, b: TranscriptFindMatch) => a?.messageId === b.messageId
        && a.blockId === b.blockId && a.start === b.start && a.end === b.end;
    const messageMatchesTarget = (message: Message, target: TranscriptJumpTarget) => target.kind === 'route-message-id'
        ? message.id === target.routeMessageId || message.realID === target.routeMessageId || message.localId === target.routeMessageId
        : message.seq === target.seq;
    function sameDisplayContext(a: TranscriptFindTextContext | undefined, b: TranscriptFindTextContext | undefined) {
        if (a === b) return true;
        if (!a || !b) return false;
        const keys = Object.keys(a) as (keyof TranscriptFindTextContext)[];
        return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
    }
    function emit(status: FindStatus) {
        snapshot = { ...snapshot, status };
        for (const listener of listeners) listener();
    }
    function coverage(history: TranscriptFindCorpus['history']): FindCoverage {
        const corpus = input.readCorpus();
        const omittedDisplayText = [...projections.values()].some(({ blocks }) => blocks.some((block) => block.incomplete));
        return resolveTranscriptFindCoverage({ ...corpus, history, stopped, partialErrors,
            hasUnreadableText: corpus.hasUnreadableText || omittedDisplayText });
    }
    function publishRows() {
        const blocksByMessage = new Map<string, Map<string, TranscriptFindSourceRange[]>>();
        for (const match of matches) {
            const block = projections.get(match.messageId)?.blocks.find((candidate) => candidate.id === match.blockId);
            if (!block) continue;
            const blocks = blocksByMessage.get(match.messageId) ?? new Map<string, TranscriptFindSourceRange[]>();
            blocksByMessage.set(match.messageId, blocks);
            const ranges = blocks.get(match.blockId) ?? [];
            blocks.set(match.blockId, ranges);
            // Markup can interrupt visible text. Publish the distinct source spans, never
            // highlight a link destination or a Markdown delimiter between visible glyphs.
            let start: number | null = null;
            let end = 0;
            for (let i = match.start; i < match.end; i += 1) {
                const nextStart = block.sourceOffsets[i];
                const nextEnd = block.sourceEnds[i];
                if (start !== null && nextStart !== end) { ranges.push({ start, end, current: sameMatch(current, match) }); start = null; }
                if (start === null) start = nextStart;
                end = nextEnd;
            }
            if (start !== null) ranges.push({ start, end, current: sameMatch(current, match) });
        }
        const rows = new Map<string, TranscriptFindRowSnapshot>();
        for (const [messageId, blocks] of blocksByMessage) {
            rows.set(messageId, {
                blocks: [...blocks].map(([id, sourceRanges]) => ({ id, sourceRanges })),
                ...(current?.messageId === messageId ? { reveal: { blockId: current.blockId, requestId: revealRequest } } : {}),
            });
        }
        rowStore.publish(rows);
        publishOverview();
    }
    function clearRows() { rowStore.clear(); overview = EMPTY_OVERVIEW; }
    function publishOverview() {
        const messageIds: string[] = [];
        for (const match of matches) if (messageIds.at(-1) !== match.messageId) messageIds.push(match.messageId);
        const currentMessageId = current?.messageId ?? null;
        // A stable reference while the set and the current message hold, so the ruler skips the render.
        if (currentMessageId === overview.currentMessageId && messageIds.length === overview.messageIds.length
            && messageIds.every((id, index) => id === overview.messageIds[index])) return;
        overview = messageIds.length ? { messageIds, currentMessageId } : EMPTY_OVERVIEW;
    }
    function recompute(selectFirst: boolean) {
        if (!snapshot.open || snapshot.query === '') { matches = []; current = null; clearRows(); emit({ kind: 'idle' }); return; }
        const corpus = input.readCorpus();
        const next: TranscriptFindMatch[] = [];
        const present = new Set<string>();
        for (const message of corpus.messages) {
            present.add(message.id);
            const previous = projections.get(message.id);
            const context = corpus.displayContexts?.get(message.id);
            const blocks = previous?.message === message && sameDisplayContext(previous.context, context)
                ? previous.blocks : projectTranscriptFindText(message, context);
            projections.set(message.id, { message, context, blocks });
            for (const block of blocks) {
                const result = matchFindText(block.text, snapshot.query, snapshot.options);
                if ('invalidPattern' in result) { matches = []; current = null; clearRows(); emit({ kind: 'invalidPattern' }); return; }
                for (const [start, end] of result.ranges) next.push({ messageId: message.id, blockId: block.id, start, end, message });
            }
        }
        // Validate even an empty corpus, so an invalid pattern is never misreported as zero.
        if ('invalidPattern' in matchFindText('', snapshot.query, snapshot.options)) { matches = []; current = null; clearRows(); emit({ kind: 'invalidPattern' }); return; }
        for (const id of projections.keys()) if (!present.has(id)) projections.delete(id);
        matches = next;
        if (seedTarget) {
            const target = seedTarget;
            current = matches.find((match) => messageMatchesTarget(match.message, target)) ?? null;
            if (current) seedTarget = null;
        } else {
            current = matches.find((match) => sameMatch(current, match)) ?? (selectFirst ? matches[0] ?? null : null);
        }
        publishRows();
        const currentIndex = current ? matches.indexOf(current) + 1 : null;
        emit(searching ? { kind: 'searching', current: currentIndex, total: matches.length } : {
            kind: 'results', current: currentIndex, total: matches.length, coverage: coverage(corpus.history),
        });
    }
    function revealSelected() {
        if (!current) return Promise.resolve();
        revealRequest += 1;
        publishRows();
        const match = current;
        const token = operation;
        const context = startNavigation();
        pending = input.reveal(match, context).catch(() => {
            if (context.signal.aborted || !snapshot.open || token !== operation || !sameMatch(current, match)) return;
            partialErrors = true;
            recompute(false);
        });
        return pending;
    }
    function select(match: TranscriptFindMatch | null) {
        current = match;
        recompute(false);
        revealSelected();
    }
    function search(direction: 'older' | 'newer', stepFrom: TranscriptFindMatch | null) {
        if (!input.loadPage || searching || !snapshot.open || snapshot.query === '' || snapshot.status.kind === 'invalidPattern') return;
        const token = invalidateOperation();
        stopped = false;
        searching = true;
        emit({ kind: 'searching', current: current ? matches.indexOf(current) + 1 : null, total: matches.length });
        pending = (async () => {
            while (snapshot.open && token === operation) {
                const result = await input.loadPage!(direction);
                await input.afterLoad?.();
                if (!snapshot.open || token !== operation) return;
                if (result.status === 'retryable_error') { partialErrors = true; break; }
                if (result.status === 'in_flight' || result.status === 'not_ready') break;
                recompute(false);
                const index = stepFrom ? matches.findIndex((match) => sameMatch(stepFrom, match)) : -1;
                const next = direction === 'older' ? (index > 0 ? matches[index - 1] : stepFrom ? null : matches.at(-1))
                    : (index >= 0 ? matches[index + 1] : matches[0]);
                if (next) { current = next; revealSelected(); break; }
                if (!result.hasMore) break;
            }
            if (!snapshot.open || token !== operation) return;
            searching = false;
            recompute(false);
        })().catch(() => {
            if (!snapshot.open || token !== operation) return;
            searching = false;
            partialErrors = true;
            recompute(false);
        });
    }
    const controller: FindController = {
        get query() { return snapshot.query; },
        get options() { return snapshot.options; },
        get status() { return snapshot.status; },
        get capabilities() { return { regex: true, stop: searching }; },
        setQuery(query) {
            if (snapshot.query === query && snapshot.open) return;
            seedTarget = null;
            invalidateOperation(); searching = false; stopped = false; current = null;
            snapshot = { ...snapshot, query, open: true };
            recompute(true); revealSelected();
        },
        setOptions(options) {
            if (snapshot.options.matchCase === options.matchCase && snapshot.options.regex === options.regex) return;
            seedTarget = null;
            invalidateOperation(); searching = false; stopped = false; current = null;
            snapshot = { ...snapshot, options }; recompute(true); revealSelected();
        },
        step(direction) {
            if (!snapshot.open || searching) return;
            seedTarget = null;
            const index = current ? matches.findIndex((match) => sameMatch(current, match)) : -1;
            const next = index < 0 ? (direction === 1 ? matches[0] : matches.at(-1)) : matches[index + direction];
            if (next) { select(next); return; }
            const history = input.readCorpus().history;
            if ((direction === -1 && history.hasOlder) || (direction === 1 && history.hasNewer)) { search(direction === -1 ? 'older' : 'newer', current); return; }
            if (coverage(history) === 'complete' && matches.length) select(direction === 1 ? matches[0] : matches.at(-1) ?? null);
        },
        stop() { invalidateOperation(); searching = false; stopped = true; seedTarget = null; recompute(false); },
        close() { invalidateOperation(); searching = false; stopped = false; seedTarget = null; snapshot = { ...snapshot, open: false }; matches = []; current = null; projections.clear(); clearRows(); emit({ kind: 'idle' }); },
    };
    return {
        get query() { return controller.query; }, get options() { return controller.options; }, get status() { return controller.status; }, get capabilities() { return controller.capabilities; },
        setQuery: controller.setQuery, setOptions: controller.setOptions, step: controller.step, stop: controller.stop, close: controller.close,
        open() { snapshot = { ...snapshot, open: true }; recompute(true); },
        refresh() {
            const pendingSeed = seedTarget !== null;
            recompute(true);
            if (pendingSeed && current && !searching) revealSelected();
        },
        searchOlder() { seedTarget = null; search('older', matches[0] ?? null); },
        applySeed(seed: Readonly<{ query: string; options: FindOptions; target: TranscriptJumpTarget }>) {
            invalidateOperation(); searching = false; stopped = false; current = null;
            seedTarget = seed.target;
            snapshot = { ...snapshot, query: seed.query, options: seed.options, open: true };
            const targetLoaded = input.readCorpus().messages.some((message) => messageMatchesTarget(message, seed.target));
            searching = !targetLoaded;
            recompute(false);
            if (targetLoaded) return pending = revealSelected();
            const token = operation;
            const context = startNavigation();
            pending = (async () => {
                // Target-window/older loading and cancellation stay with the jump owner.
                const result = await input.jumpToTarget(seed.target, context);
                await input.afterLoad?.();
                if (!snapshot.open || token !== operation) return;
                searching = false;
                const unavailable = result.status === 'not-found' || result.status === 'aborted';
                if (unavailable) seedTarget = null;
                recompute(unavailable);
                await revealSelected();
            })().catch(() => {
                if (!snapshot.open || token !== operation) return;
                searching = false;
                partialErrors = true;
                recompute(false);
            });
            return pending;
        },
        rowStore,
        getSnapshot: () => snapshot,
        getOverview: () => overview,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        async settled() { await pending; },
        dispose() { controller.close(); listeners.clear(); },
    };
}

export type TranscriptFindModel = ReturnType<typeof createTranscriptFindModel>;

/** The host keeps the controller stable; only the bar and changed message rows subscribe. */
export function useTranscriptFind(input: TranscriptFindModelInput): TranscriptFindModel {
    const latest = React.useRef(input);
    latest.current = input;
    const [model] = React.useState(() => createTranscriptFindModel({
        readCorpus: () => latest.current.readCorpus(),
        loadPage: (direction) => latest.current.loadPage?.(direction) ?? Promise.resolve({ loaded: 0, hasMore: true, status: 'not_ready' }),
        jumpToTarget: (target, context) => latest.current.jumpToTarget(target, context),
        reveal: (match, context) => latest.current.reveal(match, context),
        afterLoad: () => latest.current.afterLoad?.() ?? Promise.resolve(),
    }));
    React.useEffect(() => () => { model.dispose(); }, [model]);
    return model;
}
