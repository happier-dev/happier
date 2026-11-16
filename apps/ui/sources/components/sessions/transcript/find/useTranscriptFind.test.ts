import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';
import { matchFindText } from '@happier-dev/plugin-ui/presentation';
import type { TranscriptJumpResult, TranscriptJumpTarget } from '../viewport/jump/transcriptJumpTargetTypes';
import { createTranscriptFindModel } from './useTranscriptFind';
import { revealTranscriptFindMatch } from './revealTranscriptFindMatch';
import { createDeferred } from '@/dev/testkit';

function message(id: string, text: string, seq = 1): Message {
    return { kind: 'user-text', id, localId: null, createdAt: seq, seq, text };
}

const noJump = async (): Promise<TranscriptJumpResult> => ({ status: 'not-found', reason: 'unsupported' });

// Call-through spy: the real matcher runs; the count shows how much text one refresh re-matches.
vi.mock('@happier-dev/plugin-ui/presentation', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/plugin-ui/presentation')>();
    return { ...actual, matchFindText: vi.fn(actual.matchFindText) };
});

describe('transcript Find model', () => {
    it('steps through admitted matches without rereading the corpus or republishing unaffected rows', async () => {
        let messages = Array.from({ length: 2000 }, (_, index) => message(`row-${index}`, 'needle', index + 1));
        let corpusReads = 0;
        const model = createTranscriptFindModel({
            readCorpus: () => {
                corpusReads += 1;
                return { messages, history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } };
            },
            loadPage: null, jumpToTarget: noJump, reveal: async () => {},
        });
        model.setQuery('needle');
        await model.settled();
        const changed: string[] = [];
        const subscriptions = messages.map(row => model.rowStore.subscribe(row.id, () => changed.push(row.id)));
        corpusReads = 0;
        try {
            model.step(1);
            await model.settled();
            expect(model.status).toMatchObject({ current: 2, total: 2000, coverage: 'complete' });
            expect({ corpusReads, changed }).toEqual({ corpusReads: 0, changed: ['row-0', 'row-1'] });

            // Source changes still enter through refresh, so navigation cannot keep an obsolete match set.
            messages = [messages[0]!, ...messages.slice(2), message('appended', 'needle', 2001)];
            model.refresh();
            expect(model.status).toMatchObject({ current: 1, total: 2000 });
            model.step(1);
            await model.settled();
            expect(model.getOverview().currentMessageId).toBe('row-2');
        } finally {
            subscriptions.forEach(stop => stop());
            model.dispose();
        }
    });

    it('re-seats the current selection without stepping and leaves stopped or closed Find alone', async () => {
        const landed: string[] = [];
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages: [message('first', 'needle'), message('second', 'needle', 2)],
                history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } }),
            loadPage: null, jumpToTarget: noJump,
            reveal: (match, context) => revealTranscriptFindMatch(match, {
                items: [], setToolCallsGroupExpanded() {}, setThinkingExpanded() {}, waitForVisualUpdate: async () => {},
                readClearancePx: () => 0,
                jumpToTarget: async target => {
                    if (target.kind === 'route-message-id') landed.push(target.routeMessageId);
                    return { status: 'scrolled', target };
                },
            }, context),
        });
        model.setQuery('needle'); await model.settled();
        model.step(1); await model.settled();
        await model.revealCurrent();
        expect(model.status).toMatchObject({ current: 2, total: 2 });
        expect(model.query).toBe('needle');
        model.stop(); await model.revealCurrent();
        model.close(); await model.revealCurrent();
        expect(landed).toEqual(['first', 'second', 'second']);
        model.dispose();
    });
    it.each(['close', 'stop', 'query', 'options', 'step'] as const)('does not start an obsolete chat reveal jump after %s during its visual wait', async (intent) => {
        const frame = createDeferred<void>();
        const landed: string[] = [];
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages: [message('first', 'needle different'), message('second', 'needle', 2)],
                history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } }),
            loadPage: null, jumpToTarget: noJump,
            reveal: (match, context) => revealTranscriptFindMatch(match, {
                items: [], setToolCallsGroupExpanded() {}, setThinkingExpanded() {},
                waitForVisualUpdate: () => frame.promise, readClearancePx: () => 0,
                jumpToTarget: async (target) => {
                    if (target.kind === 'route-message-id') landed.push(target.routeMessageId);
                    return { status: 'scrolled', target };
                },
            }, context),
        });
        model.setQuery('needle');
        if (intent === 'query') model.setQuery('different');
        else if (intent === 'options') model.setOptions({ matchCase: true, regex: false });
        else if (intent === 'step') model.step(1);
        else model[intent]();
        frame.resolve();
        await model.settled();
        expect(landed).toEqual(intent === 'step' ? ['second'] : intent === 'query' || intent === 'options' ? ['first'] : []);
    });
    it('asks the jump host once to reveal the current mark below the capsule as it is now', async () => {
        let clearance = 64;
        const aligns: unknown[] = [];
        const reveal = () => revealTranscriptFindMatch({ messageId: 'm', message: message('m', 'needle') } as never, {
            items: [], setToolCallsGroupExpanded() {}, setThinkingExpanded() {}, waitForVisualUpdate: async () => {},
            readClearancePx: () => clearance,
            jumpToTarget: async (target, options) => { aligns.push(options.align); return { status: 'scrolled', target }; },
        }, { signal: new AbortController().signal });
        await reveal();
        clearance = 102;
        await reveal();
        expect(aligns).toEqual([
            { kind: 'reveal', clearancePx: 64, focusTestId: 'find-match-current' },
            { kind: 'reveal', clearancePx: 102, focusTestId: 'find-match-current' },
        ]);
    });
    it('excludes diagrams without making transcript text coverage incomplete', () => {
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages: [message('diagram', '```mermaid\ngraph TD; A-->B\n```'), message('plain', 'needle')],
                history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } }),
            loadPage: null, jumpToTarget: noJump, reveal: async () => {},
        });
        model.setQuery('needle');
        expect(model.status).toMatchObject({ total: 1, coverage: 'complete' });
        model.setQuery('graph');
        expect(model.status).toMatchObject({ total: 0, coverage: 'complete' });
    });
    it('resolves a History seed outside the loaded window before selecting its addressed match', async () => {
        let messages = [message('first', 'needle', 20)];
        const revealed: string[] = [];
        const target = { kind: 'route-message-id' as const, routeMessageId: 'history-local-id' };
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages, history: { isLoaded: true, hasOlder: true, isLoadingOlder: false } }),
            loadPage: null,
            jumpToTarget: async (requested) => {
                expect(requested).toEqual(target);
                messages = [message('target', 'needle', 2), ...messages];
                messages[0] = { ...messages[0]!, localId: 'history-local-id' };
                return { status: 'window-rendered', target, windowId: 'history-window' };
            },
            reveal: async (match) => { revealed.push(match.messageId); },
        });
        model.applySeed({ query: 'needle', options: { matchCase: false, regex: false }, target });
        await model.settled();
        expect(revealed).toEqual(['target']);
        expect(model.status).toMatchObject({ kind: 'results', current: 1, total: 2 });
    });
    it.each([{ status: 'not-found', reason: 'exhausted' }, { status: 'aborted' }] satisfies TranscriptJumpResult[])(
        'keeps Find open on the query when the seed jump is $status', async (result) => {
            const revealed: string[] = [];
            const model = createTranscriptFindModel({
                readCorpus: () => ({ messages: [message('loaded', 'needle')],
                    history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } }),
                loadPage: null, jumpToTarget: async () => result,
                reveal: async (match) => { revealed.push(match.messageId); },
            });
            model.applySeed({ query: 'needle', options: { matchCase: false, regex: false },
                target: { kind: 'route-message-id', routeMessageId: 'missing' } });
            await model.settled();
            expect(model.getSnapshot()).toMatchObject({ open: true, query: 'needle' });
            expect(model.status).toMatchObject({ kind: 'results', current: 1, total: 1 });
            expect(revealed).toEqual(['loaded']);
        });
    it.each(['query', 'close', 'stop'] as const)('does not publish a late seed landing after a newer %s intent', async (intent) => {
        let finish: (result: TranscriptJumpResult) => void = () => {};
        let messages = [message('loaded', 'different')];
        const revealed: string[] = [];
        const target: TranscriptJumpTarget = { kind: 'route-message-id', routeMessageId: 'target' };
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages, history: { isLoaded: true, hasOlder: true, isLoadingOlder: false } }),
            loadPage: null,
            jumpToTarget: () => new Promise<TranscriptJumpResult>((resolve) => { finish = resolve; }),
            reveal: async (match) => { revealed.push(match.messageId); },
        });
        model.applySeed({ query: 'needle', options: { matchCase: false, regex: false }, target });
        if (intent === 'query') model.setQuery('different');
        else model[intent]();
        messages = [message('target', 'needle'), ...messages];
        finish({ status: 'scrolled', target });
        await model.settled();
        expect(revealed).toEqual(intent === 'query' ? ['loaded'] : []);
        expect(model.getSnapshot().open).toBe(intent !== 'close');
        expect(model.query).toBe(intent === 'query' ? 'different' : 'needle');
    });
    it('keeps a travelling target pending until its source row arrives instead of revealing an unrelated match', async () => {
        let messages = [message('first', 'needle', 1)];
        let finish: (result: TranscriptJumpResult) => void = () => {};
        const revealed: string[] = [];
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages, history: { isLoaded: true, hasOlder: true, isLoadingOlder: false } }),
            loadPage: null,
            jumpToTarget: () => new Promise<TranscriptJumpResult>((resolve) => { finish = resolve; }),
            reveal: async (match) => { revealed.push(match.messageId); },
        });
        model.applySeed({ query: 'needle', options: { matchCase: false, regex: false },
            target: { kind: 'route-message-id', routeMessageId: 'target' } });
        model.refresh();
        expect(revealed).toEqual([]);
        expect(model.status).toMatchObject({ kind: 'searching', total: 1 });
        messages = [...messages, message('target', 'needle', 2)];
        model.refresh();
        finish({ status: 'scrolled', target: { kind: 'route-message-id', routeMessageId: 'target' } });
        await model.settled();
        expect(revealed).toEqual(['target']);
        expect(model.status).toMatchObject({ current: 2, total: 2 });
    });
    it('re-matches only changed messages when a long transcript gains an arrival or an older page', async () => {
        let messages = Array.from({ length: 2000 }, (_, index) => message(`row-${index}`, index % 100 === 0 ? 'needle' : 'plain', index + 10));
        let older = 0;
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages, history: { isLoaded: true, hasOlder: older < 1, isLoadingOlder: false } }),
            loadPage: async () => {
                older += 1;
                messages = [...Array.from({ length: 5 }, (_, index) => message(`older-${index}`, 'plain', index + 1)), ...messages];
                return { loaded: 5, hasMore: false, status: 'loaded' };
            },
            jumpToTarget: noJump, reveal: async () => {},
        });
        const calls = vi.mocked(matchFindText);
        try {
            model.setQuery('needle');
            await model.settled();
            expect(model.status).toMatchObject({ total: 20 });

            calls.mockClear();
            messages = [...messages, message('arrival', 'needle', 3000)];
            model.refresh();
            expect(model.status).toMatchObject({ total: 21 });
            const perArrival = calls.mock.calls.length;

            calls.mockClear();
            model.searchOlder();
            await model.settled();
            const perOlderPage = calls.mock.calls.length;
            expect(older).toBe(1);
            // One block per new message, plus the empty-corpus pattern check per recompute
            // (the page's recompute and the settle after the search).
            expect({ perArrival, perOlderPage }).toEqual({ perArrival: 2, perOlderPage: 7 });
        } finally {
            model.dispose();
        }
    });

    it('Search older continues past existing hits until an older page contains the query', async () => {
        let messages = [message('loaded', 'needle', 3)];
        let page = 0;
        const revealed: string[] = [];
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages, history: { isLoaded: true, hasOlder: page < 2, isLoadingOlder: false } }),
            loadPage: async () => {
                page += 1;
                messages = [message(`older-${page}`, page === 2 ? 'needle' : 'no hit', 3 - page), ...messages];
                return { loaded: 1, hasMore: page < 2, status: 'loaded' };
            },
            jumpToTarget: noJump,
            reveal: async (match) => { revealed.push(match.messageId); },
        });
        model.setQuery('needle');
        await model.settled();
        model.searchOlder();
        await model.settled();
        expect(page).toBe(2);
        expect(revealed).toEqual(['loaded', 'older-2']);
        expect(model.status).toMatchObject({ current: 1, total: 2, coverage: 'complete' });
    });
    it('opens a travelling query at its addressed result without first jumping to another hit', async () => {
        const revealed: string[] = [];
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages: [message('first', 'needle', 1), { ...message('target', 'needle', 2), realID: 'persisted-target' }],
                history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } }),
            loadPage: null, jumpToTarget: noJump, reveal: async (match) => { revealed.push(match.messageId); },
        });
        model.applySeed({ query: 'needle', options: { matchCase: false, regex: false },
            target: { kind: 'route-message-id', routeMessageId: 'server:persisted-target' } });
        await model.settled();
        expect(revealed).toEqual(['target']);
        expect(model.status).toMatchObject({ kind: 'results', current: 2, total: 2 });
    });

    it('does not certify pending or unreadable display text complete even after all message pages load', () => {
        let unreadable = false;
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages: [], history: { isLoaded: true, hasOlder: false, isLoadingOlder: false },
                hasPendingText: !unreadable, hasUnreadableText: unreadable }),
            loadPage: null, jumpToTarget: noJump, reveal: async () => {},
        });
        model.setQuery('needle');
        expect(model.status).toMatchObject({ kind: 'results', total: 0, coverage: 'loaded' });
        unreadable = true;
        model.refresh();
        expect(model.status).toMatchObject({ kind: 'results', total: 0, coverage: 'partialErrors' });
    });
    it('searches the source corpus beyond mounted rows, keeps the current match on append, and reveals through the host', async () => {
        let messages = [message('offscreen', 'the needle', 1), message('visible', 'tail', 2)];
        const revealed: string[] = [];
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages, history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } }),
            loadPage: null,
            jumpToTarget: noJump,
            reveal: async (match) => { revealed.push(match.messageId); },
        });
        model.open();
        model.setQuery('needle');
        await model.settled();
        expect(model.status).toMatchObject({ kind: 'results', current: 1, total: 1, coverage: 'complete' });
        expect(revealed).toEqual(['offscreen']);
        messages = [...messages, message('append', 'needle', 3)];
        model.refresh();
        expect(model.status).toMatchObject({ current: 1, total: 2 });
        expect(revealed).toEqual(['offscreen']);
        model.step(1);
        await model.settled();
        expect(revealed.at(-1)).toBe('append');
        expect(model.status).toMatchObject({ current: 2, total: 2 });
    });

    it('keeps the current match in the count while older pages are searched ("2 of 4 so far")', () => {
        const messages = [message('a', 'needle', 1), message('b', 'needle needle', 2), message('c', 'needle', 3)];
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages, history: { isLoaded: true, hasOlder: true, isLoadingOlder: false } }),
            loadPage: () => new Promise(() => {}),
            jumpToTarget: noJump,
            reveal: async () => {},
        });
        model.open();
        model.setQuery('needle');
        model.step(1);
        expect(model.status).toMatchObject({ kind: 'results', current: 2, total: 4 });
        model.searchOlder();
        expect(model.status).toEqual({ kind: 'searching', current: 2, total: 4 });
    });
    it('loads older pages on demand, marks unreadable content partial, and never cancels the sync page on Stop', async () => {
        let messages = [message('tail', 'tail')];
        let hasOlder = true;
        let finish: ((value: { loaded: number; hasMore: boolean; status: 'loaded' }) => void) | undefined;
        let loads = 0;
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages, history: { isLoaded: true, hasOlder, isLoadingOlder: false } }),
            loadPage: async () => {
                loads += 1;
                return await new Promise<{ loaded: number; hasMore: boolean; status: 'loaded' }>((resolve) => { finish = resolve; });
            },
            jumpToTarget: noJump,
            reveal: async () => {},
        });
        model.open();
        model.setQuery('needle');
        expect(loads).toBe(0);
        expect(model.status).toMatchObject({ total: 0, coverage: 'loaded' });
        model.searchOlder();
        expect(model.status.kind).toBe('searching');
        model.stop();
        messages = [message('older', 'needle'), ...messages];
        hasOlder = false;
        finish?.({ loaded: 1, hasMore: false, status: 'loaded' });
        await model.settled();
        expect(model.status).toMatchObject({ total: 0, coverage: 'olderRemaining' });
        // The real source still receives the late page. A later user intent searches it.
        model.setQuery('needle ');
        model.setQuery('needle');
        expect(model.status).toMatchObject({ total: 1, coverage: 'complete' });

        const unreadable = createTranscriptFindModel({
            readCorpus: () => ({ messages: [], history: { isLoaded: true, hasOlder: true, isLoadingOlder: false } }),
            loadPage: async () => ({ loaded: 0, hasMore: true, status: 'retryable_error' }),
            jumpToTarget: noJump,
            reveal: async () => {},
        });
        unreadable.open();
        unreadable.setQuery('needle');
        unreadable.searchOlder();
        await unreadable.settled();
        expect(unreadable.status).toMatchObject({ kind: 'results', total: 0, coverage: 'partialErrors' });
    });

    it('refreshes live appends and edits after Stop while preserving the current match', () => {
        let messages = [message('current', 'needle'), message('tail', 'tail', 2)];
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages, history: { isLoaded: true, hasOlder: true, isLoadingOlder: false } }),
            loadPage: () => new Promise(() => {}), jumpToTarget: noJump, reveal: async () => {},
        });
        model.setQuery('needle');
        model.searchOlder();
        model.stop();
        messages = [...messages, message('live', 'needle', 3)];
        model.refresh();
        expect(model.status).toMatchObject({ kind: 'results', total: 2, current: 1 });
        expect(model.getOverview().currentMessageId).toBe('current');
        messages = messages.map(row => row.id === 'tail' ? message('tail', 'needle needle', 2) : row);
        model.refresh();
        expect(model.status).toMatchObject({ kind: 'results', total: 4, current: 1 });
        expect(model.rowStore.getSnapshot('tail')?.blocks[0]?.sourceRanges).toHaveLength(2);
        expect(model.getOverview().currentMessageId).toBe('current');
        model.dispose();
    });

    it('does not wrap an incomplete target window and does not certify a missing newer frontier complete', async () => {
        const directions: string[] = [];
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages: [message('window', 'needle')], history: {
                isLoaded: true, hasOlder: false, hasNewer: true, isLoadingOlder: false,
            } }),
            loadPage: async (direction) => { directions.push(direction); return { loaded: 0, hasMore: true, status: 'not_ready' }; },
            jumpToTarget: noJump,
            reveal: async () => {},
        });
        model.open();
        model.setQuery('needle');
        model.step(1);
        await model.settled();
        expect(directions).toEqual(['newer']);
        expect(model.status).toMatchObject({ current: 1, total: 1, coverage: 'loaded' });
    });

    it('retires old query and closed-surface async results', async () => {
        let finish: ((value: { loaded: number; hasMore: boolean; status: 'loaded' }) => void) | undefined;
        let messages = [message('tail', 'tail')];
        const revealed: string[] = [];
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages, history: { isLoaded: true, hasOlder: true, isLoadingOlder: false } }),
            loadPage: async () => await new Promise<{ loaded: number; hasMore: boolean; status: 'loaded' }>((resolve) => { finish = resolve; }),
            jumpToTarget: noJump,
            reveal: async (match) => { revealed.push(match.messageId); },
        });
        model.open();
        model.setQuery('needle');
        model.searchOlder();
        model.close();
        messages = [message('old', 'needle'), ...messages];
        finish?.({ loaded: 1, hasMore: false, status: 'loaded' });
        await model.settled();
        expect(model.status.kind).toBe('idle');
        expect(model.getSnapshot().open).toBe(false);
        expect(revealed).toEqual([]);
    });
    it('publishes the matched messages in transcript order with the current one, for the overview ruler', () => {
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages: [message('a', 'needle and needle'), message('b', 'nothing', 2), message('c', 'needle', 3)],
                history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } }),
            loadPage: null, jumpToTarget: noJump, reveal: async () => {},
        });
        expect(model.getOverview().messageIds).toEqual([]);
        model.setQuery('needle');
        const first = model.getOverview();
        expect(first).toEqual({ messageIds: ['a', 'c'], currentMessageId: 'a' });
        model.step(1);
        // Two matches in one message are one place on the ruler: stepping inside it keeps the projection.
        expect(model.getOverview()).toBe(first);
        model.step(1);
        expect(model.getOverview()).toEqual({ messageIds: ['a', 'c'], currentMessageId: 'c' });
        model.close();
        expect(model.getOverview().messageIds).toEqual([]);
    });

    it('keeps coverage truthful: a match that cannot be scrolled to was still searched, and a paging error belongs to its own search', async () => {
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages: [message('a', 'needle'), message('b', 'needle', 2)],
                history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } }),
            loadPage: null, jumpToTarget: noJump,
            reveal: async () => { throw new Error('row not mounted'); },
        });
        model.setQuery('needle');
        await model.settled();
        expect(model.status).toMatchObject({ kind: 'results', current: 1, total: 2, coverage: 'complete' });

        let failing = true;
        const paged = createTranscriptFindModel({
            readCorpus: () => ({ messages: [message('a', 'needle')], history: { isLoaded: true, hasOlder: failing, isLoadingOlder: false } }),
            loadPage: async () => failing ? { loaded: 0, hasMore: true, status: 'retryable_error' }
                : { loaded: 0, hasMore: false, status: 'no_more' },
            jumpToTarget: noJump, reveal: async () => {},
        });
        paged.setQuery('needle');
        paged.searchOlder();
        await paged.settled();
        expect(paged.status).toMatchObject({ coverage: 'partialErrors' });
        failing = false;
        // Retry the same query through the same source, without closing Find.
        // A successful retry must clear only the previous paging failure.
        paged.searchOlder();
        await paged.settled();
        expect(paged.status).toMatchObject({ coverage: 'complete' });
        paged.close();
        paged.setQuery('needle');
        expect(paged.status).toMatchObject({ kind: 'results', total: 1, coverage: 'complete' });
    });
});
