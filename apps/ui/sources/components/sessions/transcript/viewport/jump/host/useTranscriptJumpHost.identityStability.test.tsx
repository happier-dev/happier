import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createSessionMessagesFixture, flushHookEffects, standardCleanup } from '@/dev/testkit';
import type { Message } from '@happier-dev/session-core/messages';
import { buildMessageRouteId } from '@happier-dev/session-core/messages';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { SessionMessagesPageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import type { ChatTranscriptListItem, TranscriptViewportChangeState } from '../../../chatListTypes';
import type { TranscriptJumpHostDeps } from './useTranscriptJumpHost';
import type { TranscriptJumpResult } from '../transcriptJumpTargetTypes';
import type { restoreTranscriptJumpEnvironment } from './transcriptJumpHostTestHarness';

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { createTranscriptFindModel } = await import('../../../find/useTranscriptFind');
const { revealTranscriptFindMatch } = await import('../../../find/revealTranscriptFindMatch');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { sync } = await import('@/sync/sync');
const { resolveChatFindSeed } = await import('@/components/appShell/panes/fileFindSeedHandoff');
const { normalizeExternalSessionTranscriptMessages } = await import('@/sync/runtime/external/normalizeExternalSessionTranscriptMessages');
const {
    createTranscriptJumpHostTestHarness, createTranscriptJumpWebMetrics, emptyTranscriptJumpPage,
    restoreTranscriptJumpEnvironment: restoreJumpEnvironment, transcriptJumpPage,
} = await import('./transcriptJumpHostTestHarness');

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
const row = (seq: number, id = 'row-' + seq): ChatTranscriptListItem => ({
    kind: 'message', id, messageId: 'message-' + seq, seq, createdAt: seq,
});
let environment: Awaited<ReturnType<typeof restoreTranscriptJumpEnvironment>>;
let read: (url: URL) => Response | Promise<Response>;
const initialReads: URL[] = [];

describe('useTranscriptJumpHost actual owner lifetime and identity', () => {
    it('lands cold and warm History seeds on the first occurrence in the exact older message after many tool rows', async () => {
        const identity = { agentId: 'claude', remoteSessionId: 'long-history-turn' };
        const item = (id: string, seq: number, tool: boolean): ExternalSessionTranscriptRawMessageV1 => ({
            id, createdAtMs: seq, raw: { role: 'agent', content: { type: 'output', data: {
                type: 'assistant', message: { content: tool
                    ? [{ type: 'tool_use', id: `call-${id}`, name: 'Bash', input: { command: 'echo harbor' } }]
                    : [{ type: 'text', text: 'The selected harbor message has another harbor occurrence.' }] },
            } } },
        });
        const targetItem = item('claude:matched', 100, false);
        const prefix = Array.from({ length: 80 }, (_, index) => item(`claude:tool-${index}`, index + 1, true));
        const middle = Array.from({ length: 10 }, (_, index) => item(`claude:middle-${index}`, index + 110, true));
        const tail = [item('claude:tail', 200, true)];
        const normalize = (items: readonly ExternalSessionTranscriptRawMessageV1[]) =>
            normalizeExternalSessionTranscriptMessages(items, identity).map(message => ({ ...message, seq: message.createdAt }));
        const harness = createTranscriptJumpHostTestHarness();
        // External renderer commits consume the real reducer's current message identities.
        const commitRows = async () => {
            const stored = getStorage().getState().sessionMessages.s1!;
            harness.messages.current = stored.messagesById;
            harness.rows.current = stored.messageIdsOldestFirst.map(messageId => ({
                kind: 'message', id: `row-${messageId}`, messageId,
                seq: stored.messagesById[messageId]!.seq ?? null, createdAt: stored.messagesById[messageId]!.createdAt,
            }));
        };
        const pages = [tail, middle, [...prefix, targetItem]];
        read = () => {
            const items = pages.shift();
            if (!items) throw new Error('The jump read beyond the addressed target');
            return Response.json(SessionMessagesPageV1Schema.parse({
                messages: normalize(items).map(message => ({ id: message.id, seq: message.seq, localId: message.localId,
                    sidechainId: null, createdAt: message.createdAt, updatedAt: message.createdAt,
                    content: { t: 'plain', v: items.find(item => item.createdAtMs === message.createdAt)!.raw } })),
                hasMore: true, nextBeforeSeq: items[0]!.createdAtMs, nextAfterSeq: null,
            }));
        };
        await sync.loadOlderMessagesFromCursor('s1', 201);
        initialReads.length = 0;
        await commitRows();
        const hook = await harness.render({ hasMoreOlderRef: { current: true }, waitForNextVisualUpdate: commitRows });
        const seed = resolveChatFindSeed({ query: 'harbor', target: { kind: 'native-message', ...identity, sourceItemId: targetItem.id } });
        const jumps: TranscriptJumpResult[] = [];
        const model = createTranscriptFindModel({
            readCorpus: () => {
                const stored = getStorage().getState().sessionMessages.s1!;
                return { messages: stored.messageIdsOldestFirst.map(id => stored.messagesById[id]!),
                    history: { isLoaded: true, hasOlder: true, isLoadingOlder: false } };
            },
            loadPage: null, jumpToTarget: async (target, context) => {
                const result = await hook.getCurrent().jumpToTranscriptTarget(target, context);
                jumps.push(result);
                return result;
            },
            afterLoad: commitRows,
            reveal: (match, context) => revealTranscriptFindMatch(match, {
                items: harness.rows.current, setToolCallsGroupExpanded() {}, setThinkingExpanded() {},
                readClearancePx: () => 0, waitForVisualUpdate: commitRows,
                jumpToTarget: (target, options) => hook.getCurrent().jumpToTranscriptTarget(target, options),
            }, context),
        });
        try {
            for (const open of ['cold', 'warm']) {
                await act(async () => { await model.applySeed(seed); });
                expect(jumps[0], open).toEqual({ status: 'scrolled', target: seed.target });
                expect(initialReads, open).toHaveLength(2);
                const currentId = model.getOverview().currentMessageId;
                const current = currentId ? getStorage().getState().sessionMessages.s1!.messagesById[currentId] : null;
                expect(current ? buildMessageRouteId(current) : null, open)
                    .toBe(seed.target.kind === 'route-message-id' ? seed.target.routeMessageId : null);
                expect(model.rowStore.getSnapshot(currentId!)?.blocks.flatMap(block => block.sourceRanges)
                    .filter(range => range.current).map(range => range.start), open).toEqual([13]);
                expect(harness.rows.current[harness.native.indexWrites.at(-1)!.index]).toMatchObject({ messageId: currentId });
                expect(pages, open).toHaveLength(0);
            }
        } finally { model.dispose(); await hook.unmount(); }
    });
    it('exhausts an opaque missing target without scrolling a different loaded row', async () => {
        read = () => Response.json({ ...transcriptJumpPage(100), hasMore: true, nextBeforeSeq: 100 });
        await sync.loadOlderMessagesFromCursor('s1', 101);
        read = () => Response.json(emptyTranscriptJumpPage());
        const harness = createTranscriptJumpHostTestHarness({ rows: [row(100)] });
        const hook = await harness.render({ hasMoreOlderRef: { current: true } });
        try {
            await expect(hook.getCurrent().jumpToTranscriptTarget({ kind: 'route-message-id', routeMessageId: 'missing-native-item' }))
                .resolves.toEqual({ status: 'not-found', reason: 'exhausted' });
            expect(harness.native.indexWrites).toEqual([]);
            expect(harness.scheduler.current.explicitJumpActive).toBe(false);
        } finally { await hook.unmount(); }
    });
    it('releases an opaque-target jump on cancellation without reading the next older page', async () => {
        read = () => Response.json({ ...transcriptJumpPage(100), hasMore: true, nextBeforeSeq: 100 });
        await sync.loadOlderMessagesFromCursor('s1', 101);
        initialReads.length = 0;
        const page = deferred<Response>();
        read = () => page.promise;
        const harness = createTranscriptJumpHostTestHarness({ rows: [row(100)] });
        const hook = await harness.render({ hasMoreOlderRef: { current: true } });
        const intent = new AbortController();
        try {
            const landing = hook.getCurrent().jumpToTranscriptTarget({ kind: 'route-message-id', routeMessageId: 'older-native-item' },
                { signal: intent.signal });
            await vi.waitFor(() => expect(initialReads).toHaveLength(1));
            intent.abort();
            expect(harness.scheduler.current.explicitJumpActive).toBe(false);
            page.resolve(Response.json(transcriptJumpPage(50)));
            await expect(landing).resolves.toEqual({ status: 'aborted' });
            expect(initialReads).toHaveLength(1);
            expect(harness.native.indexWrites).toEqual([]);
        } finally { await hook.unmount(); }
    });
    it('reveals a counted loaded Find match outside the partly loaded rendered window', async () => {
        const message: Message = { kind: 'user-text', id: 'message-50', realID: 'message-50',
            localId: null, seq: 50, createdAt: 50, text: 'needle' };
        const tail: Message = { kind: 'user-text', id: 'message-100', realID: 'message-100',
            localId: null, seq: 100, createdAt: 100, text: 'latest' };
        const items = [row(50), row(100)];
        getStorage().setState(state => ({ sessionMessages: { ...state.sessionMessages,
            s1: createSessionMessagesFixture({ messagesById: { [message.id]: message, [tail.id]: tail },
                messageIdsOldestFirst: [message.id, tail.id], isLoaded: true }),
        } }));
        const harness = createTranscriptJumpHostTestHarness({ rows: [items[1]!],
            messages: { [message.id]: message, [tail.id]: tail } });
        harness.metrics.current = createTranscriptJumpWebMetrics({ rows: [{ id: 'row-100', top: 0 }], scrollTop: 1500 });
        const element = harness.metrics.current.element;
        // HTTP and renderer geometry are system boundaries. The real source activates the target
        // window; its commit and recycler mount are represented by advancing these boundary facts.
        read = () => {
            harness.rows.current = [items[0]!];
            const item = element.ownerDocument.createElement('div');
            item.dataset.testid = 'transcript-item-row-50';
            item.getBoundingClientRect = () => ({ top: 500 - element.scrollTop, bottom: 600 - element.scrollTop,
                height: 100, width: 800, left: 0, right: 800, x: 0, y: 500 - element.scrollTop, toJSON() {} });
            element.appendChild(item);
            return Response.json(transcriptJumpPage(50));
        };
        const hook = await harness.render({ platformOS: 'web', hasMoreOlderRef: { current: true },
            itemsRef: { current: items }, resolveWebScrollMetrics: () => ({
                ...harness.metrics.current!, scrollTop: element.scrollTop,
            }) });
        const outcomes: TranscriptJumpResult[] = [];
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages: [message, tail],
                history: { isLoaded: true, hasOlder: true, isLoadingOlder: false } }),
            loadPage: null, jumpToTarget: hook.getCurrent().jumpToTranscriptTarget,
            reveal: (match, context) => revealTranscriptFindMatch(match, { items,
                setToolCallsGroupExpanded() {}, setThinkingExpanded() {}, waitForVisualUpdate: async () => {},
                readClearancePx: () => 96,
                jumpToTarget: async (target, options) => {
                    const result = await hook.getCurrent().jumpToTranscriptTarget(target, options);
                    outcomes.push(result);
                    return result;
                } }, context),
        });
        await act(async () => { model.setQuery('needle'); });
        await vi.waitFor(() => expect(outcomes[0]).toMatchObject({ status: 'window-rendered' }));
        await model.settled();
        expect(model.status).toMatchObject({ current: 1, total: 1, coverage: 'loaded' });
        expect(element.scrollTop).toBe(404);
        expect(element.querySelector('[data-testid="transcript-item-row-50"]')).not.toBeNull();
        model.dispose();
        await hook.unmount();
    });
    it('centres an already mounted Find result by its persisted route identity when no capsule covers the top', async () => {
        const message: Message = { kind: 'user-text', id: 'internal-find', realID: 'persisted-find',
            localId: null, seq: 50, createdAt: 1, text: 'needle' };
        getStorage().setState(state => ({ sessionMessages: { ...state.sessionMessages,
            s1: createSessionMessagesFixture({ messagesById: { [message.id]: message },
                messageIdsOldestFirst: [message.id], isLoaded: true }),
        } }));
        const items: ChatTranscriptListItem[] = [{ kind: 'message', id: 'find-row',
            messageId: message.id, seq: 50, createdAt: 1 }];
        const harness = createTranscriptJumpHostTestHarness({ rows: items, messages: { [message.id]: message } });
        harness.metrics.current = createTranscriptJumpWebMetrics({ rows: [{ id: 'find-row', top: -1000 }], scrollTop: 1500 });
        const element = harness.metrics.current.element;
        const item = element.querySelector('[data-testid="transcript-item-find-row"]')!;
        item.getBoundingClientRect = () => ({ top: 500 - element.scrollTop, bottom: 600 - element.scrollTop,
            height: 100, width: 800, left: 0, right: 800, x: 0, y: 500 - element.scrollTop, toJSON() {} });
        const hook = await harness.render({ platformOS: 'web', resolveWebScrollMetrics: () => ({
            ...harness.metrics.current!, scrollTop: element.scrollTop,
        }) });
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages: [message], history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } }),
            loadPage: null, jumpToTarget: hook.getCurrent().jumpToTranscriptTarget,
            reveal: (match, context) => revealTranscriptFindMatch(match, { items,
                setToolCallsGroupExpanded() {}, setThinkingExpanded() {}, waitForVisualUpdate: async () => {},
                readClearancePx: () => 0, jumpToTarget: hook.getCurrent().jumpToTranscriptTarget }, context),
        });
        await act(async () => { model.setQuery('needle'); await model.settled(); });
        expect(model.status).toMatchObject({ current: 1, total: 1 });
        expect(element.scrollTop).toBe(300);
        expect(initialReads).toEqual([]);
        model.dispose();
        await hook.unmount();
    });
    beforeEach(async () => {
        initialReads.length = 0;
        read = () => Response.json(emptyTranscriptJumpPage());
        environment = await restoreJumpEnvironment(url => {
            if (url.searchParams.has('beforeSeq')) {
                initialReads.push(url);
                return read(url);
            }
            return Response.json(emptyTranscriptJumpPage());
        });
    });
    afterEach(async () => { await environment.dispose(); standardCleanup(); });

    it('releases a Find takeover synchronously on abort and rejects its late HTTP page', async () => {
        const page = deferred<Response>();
        read = () => page.promise;
        const harness = createTranscriptJumpHostTestHarness();
        const hook = await harness.render();
        const intent = new AbortController();
        const landing = hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 50 },
            { preferTargetWindow: true, signal: intent.signal });
        await vi.waitFor(() => expect(initialReads).toHaveLength(1));
        expect(harness.scheduler.current.explicitJumpActive).toBe(true);
        expect(harness.native.activeOperation).not.toBeNull();
        intent.abort();
        expect(harness.scheduler.current.explicitJumpActive).toBe(false);
        expect(harness.native.activeOperation).toBeNull();
        page.resolve(Response.json(transcriptJumpPage(50)));
        await expect(landing).resolves.toEqual({ status: 'aborted' });
        expect(harness.native.indexWrites).toEqual([]);
        await hook.unmount();
    });

    it('settles a current route only after its real explicit barrier closes', async () => {
        const harness = createTranscriptJumpHostTestHarness();
        read = () => { harness.rows.current = [row(50)]; return Response.json(transcriptJumpPage(50)); };
        const hook = await harness.render({ jumpToSeq: 50 });
        await vi.waitFor(() => expect(harness.settledRoutes).toEqual(['s1']));
        expect(harness.scheduler.current.explicitJumpActive).toBe(false);
        expect(harness.native.activeOperation).toBeNull();
        expect(harness.native.indexWrites.at(-1)).toMatchObject({ index: 0, viewPosition: 0.5 });
        expect(Object.values(getStorage().getState().sessionMessages.s1?.messagesById ?? {})
            .find((message) => 'realID' in message && message.realID === 'message-50')?.seq).toBe(50);
        await hook.unmount();
    });

    it('does not let a superseded route load settle the replacement attempt', async () => {
        const firstPage = deferred<Response>();
        read = url => url.searchParams.get('beforeSeq') === '51'
            ? firstPage.promise : Response.json(emptyTranscriptJumpPage());
        const harness = createTranscriptJumpHostTestHarness();
        const hook = await harness.render({ jumpToSeq: 50 });
        await vi.waitFor(() => expect(initialReads).toHaveLength(1));
        await hook.rerender(harness.props({ jumpToSeq: 51 }));
        await vi.waitFor(() => expect(initialReads).toHaveLength(2));
        firstPage.resolve(Response.json(transcriptJumpPage(50)));
        await flushHookEffects();
        expect(harness.settledRoutes).toEqual([]);
        expect(harness.native.indexWrites).toEqual([]);
        await hook.unmount();
    });

    it('retries a temporarily unavailable route after relevant layout changes', async () => {
        read = () => { throw new TypeError('Failed to fetch'); };
        const harness = createTranscriptJumpHostTestHarness();
        const hook = await harness.render({ jumpToSeq: 50 });
        await vi.waitFor(() => expect(initialReads).toHaveLength(1));
        await flushHookEffects();
        await hook.rerender(harness.props({ jumpToSeq: 50, committedMessagesCount: 2, listContentHeight: 1100 }));
        await vi.waitFor(() => expect(initialReads).toHaveLength(2));
        expect(harness.settledRoutes).toEqual([]);
        await hook.unmount();
    });

    it('preempts an explicit jump and its durable promotion on genuine user takeover', async () => {
        const page = deferred<Response>();
        read = () => page.promise;
        const harness = createTranscriptJumpHostTestHarness();
        const hook = await harness.render({ jumpToSeq: 50 });
        await vi.waitFor(() => expect(initialReads).toHaveLength(1));
        harness.base.pendingJumpSeqViewportPromotionRef.current = { seq: 50, sessionId: 's1', emitViewportChange: () => {} };
        harness.base.promotedJumpSeqViewportProtectionRef.current = { promotedAtMs: Date.now(), seq: 50, sessionId: 's1' };
        hook.getCurrent().preemptExplicitJumpForUserTakeover();
        expect(harness.base.pendingJumpSeqViewportPromotionRef.current).toBeNull();
        expect(harness.base.promotedJumpSeqViewportProtectionRef.current).toBeNull();
        expect(harness.settledRoutes).toEqual(['s1']);
        expect(harness.scheduler.current.explicitJumpActive).toBe(false);
        page.resolve(Response.json(transcriptJumpPage(50)));
        await flushHookEffects();
        expect(harness.native.indexWrites).toEqual([]);
        await hook.rerender(harness.props({ jumpToSeq: 50, committedMessagesCount: 2, listContentHeight: 1100 }));
        await flushHookEffects();
        expect(initialReads).toHaveLength(1);
        expect(harness.settledRoutes).toEqual(['s1']);
        await hook.unmount();
    });

    it('keeps callbacks stable across fresh deps objects and unrelated store publication', async () => {
        const harness = createTranscriptJumpHostTestHarness();
        const hook = await harness.render();
        const first = hook.getCurrent();
        await hook.rerender(harness.props());
        await act(async () => { getStorage().setState(state => ({ settings: { ...state.settings,
            toolViewTimelineChromeMode: state.settings.toolViewTimelineChromeMode === 'cards' ? 'activity_feed' : 'cards',
        } })); });
        await hook.rerender(harness.props());
        const second = hook.getCurrent();
        expect(second.promotePendingJumpSeqViewportSnapshot).toBe(first.promotePendingJumpSeqViewportSnapshot);
        expect(second.flushPendingJumpSeqViewportPromotionForExit).toBe(first.flushPendingJumpSeqViewportPromotionForExit);
        expect(second.shouldSuppressGenericViewportStateForProtectedJumpSeq).toBe(first.shouldSuppressGenericViewportStateForProtectedJumpSeq);
        expect(second.jumpToBottom).toBe(first.jumpToBottom);
        expect(second.jumpToTranscriptTarget).toBe(first.jumpToTranscriptTarget);
        expect(second.handleTranscriptNavigationRailJump).toBe(first.handleTranscriptNavigationRailJump);
        expect(second.handleTranscriptNavigationPaneEntryPress).toBe(first.handleTranscriptNavigationPaneEntryPress);
        expect(second.onScrollToIndexFailed).toBe(first.onScrollToIndexFailed);
        await hook.unmount();
    });

    it('returns one coherent promotion snapshot before its deferred public viewport publication', async () => {
        const harness = createTranscriptJumpHostTestHarness();
        const published: TranscriptViewportChangeState[] = [];
        harness.metrics.current = createTranscriptJumpWebMetrics({ clientHeight: 600, scrollHeight: 4000, scrollTop: 3350 });
        harness.base.pendingJumpSeqViewportPromotionRef.current = { seq: 42, sessionId: 's1',
            emitViewportChange: state => { published.push(state); } };
        const hook = await harness.render({ platformOS: 'web' });
        expect(hook.getCurrent().flushPendingJumpSeqViewportPromotionForExit()).toEqual({
            source: 'jump-promotion', viewport: { anchor: null, capturedAtMs: expect.any(Number),
                isPinned: true, offsetY: 0, shouldRestoreViewport: false },
        });
        expect(harness.base.pendingJumpSeqViewportPromotionRef.current).toBeNull();
        expect(published).toEqual([]);
        await Promise.resolve();
        expect(published).toEqual([{ anchor: null, isPinned: true, offsetY: 50, shouldRestoreViewport: false }]);
        await hook.unmount();
    });

    it('uses the latest committed resolver after real target-window materialization', async () => {
        const page = deferred<Response>();
        read = () => page.promise;
        const harness = createTranscriptJumpHostTestHarness();
        const hook = await harness.render({ resolveSeqForMessageId: () => null });
        const stableJump = hook.getCurrent().jumpToTranscriptTarget;
        const landing = stableJump({ kind: 'seq', seq: 500 }, { preferTargetWindow: true });
        await vi.waitFor(() => expect(initialReads).toHaveLength(1));
        page.resolve(Response.json(transcriptJumpPage(500)));
        const readMaterializedTarget = () => Object.values(getStorage().getState().sessionMessages.s1?.messagesById ?? {})
            .find((message) => 'realID' in message && message.realID === 'message-500');
        await vi.waitFor(() => expect(readMaterializedTarget()).toBeDefined());
        const message = readMaterializedTarget()!;
        // Native target-window landing waits for the renderer's committed rows
        // before it can scroll. Its later visual-update callback cannot supply
        // that commit; publish the real reducer identity at the renderer boundary.
        harness.rows.current = [{ kind: 'message', id: 'target-row', messageId: message.id, createdAt: message.createdAt, seq: null }];
        await hook.rerender(harness.props({
            resolveSeqForMessageId: id => getStorage().getState().sessionMessages.s1?.messagesById[id]?.seq ?? null,
        }));
        expect(hook.getCurrent().jumpToTranscriptTarget).toBe(stableJump);
        await expect(landing).resolves.toMatchObject({ status: 'window-rendered', target: { kind: 'seq', seq: 500 } });
        expect(harness.native.indexWrites.at(-1)).toMatchObject({ index: 0 });
        await hook.unmount();
    });

    it('derives reveal threshold from the current committed render, not an earlier ref', async () => {
        const harness = createTranscriptJumpHostTestHarness();
        const patch: Partial<TranscriptJumpHostDeps> = { listLayoutHeight: 100, pinThresholdPx: 72,
            scrollPin: { isPinned: false, lastActivityKey: 'm1', newActivityCount: 0 } };
        const hook = await harness.render(patch);
        await act(async () => { hook.getCurrent().commitJumpToBottomDistanceForVisibility(100); });
        expect(hook.getCurrent().jumpToBottomAffordance.isVisible).toBe(true);
        await hook.rerender(harness.props({ ...patch, pinThresholdPx: 120 }));
        expect(harness.base.pinThresholdPxRef.current).toBe(120);
        expect(hook.getCurrent().jumpToBottomAffordance.isVisible).toBe(false);
        await hook.unmount();
    });

    it('offers return to the live tail for unreached newer content, not window presence', async () => {
        const harness = createTranscriptJumpHostTestHarness();
        const hook = await harness.render();
        expect(hook.getCurrent().jumpToBottomAffordance.isVisible).toBe(false);
        await hook.rerender(harness.props({ targetWindowHasNewerBeyondRenderedWindow: true }));
        expect(hook.getCurrent().jumpToBottomAffordance).toEqual({ count: 0, isVisible: true, presentation: 'standard' });
        await hook.unmount();
    });

    it('enters renderer takeover and the real barrier before the external history read', async () => {
        const harness = createTranscriptJumpHostTestHarness();
        read = () => {
            expect(harness.native.activeOperation).not.toBeNull();
            expect(harness.scheduler.current.explicitJumpActive).toBe(true);
            expect(harness.lifecycleHost.getState().sessionId).toBe('s1');
            return Response.json(emptyTranscriptJumpPage());
        };
        const hook = await harness.render();
        await expect(hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 500 }, { preferTargetWindow: true }))
            .resolves.toEqual({ status: 'not-found', reason: 'unavailable' });
        expect(initialReads).toHaveLength(1);
        expect(harness.native.releases).toEqual(harness.native.acquisitions);
        expect(harness.scheduler.current.explicitJumpActive).toBe(false);
        await hook.unmount();
    });

    it('waits for a loaded target to enter the committed native renderer window', async () => {
        read = () => Response.json(transcriptJumpPage(500));
        const harness = createTranscriptJumpHostTestHarness();
        const onJumpLanded = vi.fn();
        const hook = await harness.render({ onJumpLanded });
        const landing = hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 500 }, { preferTargetWindow: true });
        await vi.waitFor(() => expect(harness.base.activeTargetWindowTargetRef.current).toEqual({ kind: 'seq', seq: 500 }));
        expect(harness.native.indexWrites).toEqual([]);
        expect(onJumpLanded).not.toHaveBeenCalled();
        harness.rows.current = [row(500)];
        await hook.rerender(harness.props({ onJumpLanded }));
        await expect(landing).resolves.toMatchObject({ status: 'window-rendered' });
        expect(harness.native.indexWrites).toHaveLength(1);
        expect(onJumpLanded).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });

    it('materializes a forked transcript own segment through the actual session history owner', async () => {
        const harness = createTranscriptJumpHostTestHarness();
        const hook = await harness.render({ forkedTranscriptEnabled: true });
        await hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 500 }, { preferTargetWindow: true });
        expect(initialReads.map(url => url.pathname)).toEqual(['/v1/sessions/s1/messages']);
        expect(harness.native.indexWrites).toEqual([]);
        await hook.unmount();
    });

    it('publishes measured native detachment, explicitly returns, then uses a fresh repeated landing', async () => {
        const harness = createTranscriptJumpHostTestHarness({ rows: [row(100)] });
        harness.native.distance = 5000;
        const hook = await harness.render();
        await act(async () => { await hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 100 }); });
        expect(harness.wantsPinned.current).toBe(false);
        expect(harness.isPinned.current).toBe(false);
        expect(harness.base.lastPinOffsetForIntentRef.current).toBe(5000);
        expect(harness.bottomFollow.current).toEqual({ dragSession: null, mode: 'released' });
        expect(harness.viewport.at(-1)).toEqual({ isPinned: false, offsetY: 5000, shouldRestoreViewport: true });
        await hook.rerender(harness.props());
        expect(hook.getCurrent().jumpToBottomAffordance.isVisible).toBe(true);
        await act(async () => { hook.getCurrent().jumpToBottom(); });
        expect(harness.wantsPinned.current).toBe(true);
        expect(harness.isPinned.current).toBe(true);
        expect(harness.viewport.at(-1)).toMatchObject({ isPinned: true, offsetY: 0, shouldRestoreViewport: false });
        await hook.rerender(harness.props());
        expect(hook.getCurrent().jumpToBottomAffordance.isVisible).toBe(false);
        harness.native.distance = 8000;
        await act(async () => { await hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 100 }); });
        expect(harness.base.lastPinOffsetForIntentRef.current).toBe(8000);
        expect(harness.viewport.at(-1)).toEqual({ isPinned: false, offsetY: 8000, shouldRestoreViewport: true });
        await hook.unmount();
    });

    it('does not invent native detachment without a measured older landing', async () => {
        const harness = createTranscriptJumpHostTestHarness({ rows: [row(100)] });
        const hook = await harness.render({ platformOS: 'android' });
        await expect(hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 100 }))
            .resolves.toEqual({ status: 'scrolled', target: { kind: 'seq', seq: 100 } });
        expect(harness.wantsPinned.current).toBe(true);
        expect(harness.isPinned.current).toBe(true);
        expect(harness.viewport).toEqual([]);
        expect(harness.native.indexWrites).toHaveLength(1);
        await hook.unmount();
    });

    it('does not detach when the actual native driver cannot write', async () => {
        const harness = createTranscriptJumpHostTestHarness({ rows: [row(100)] });
        harness.listRef.current = null;
        harness.native.distance = 5000;
        const hook = await harness.render();
        await expect(hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 100 }))
            .resolves.toEqual({ status: 'not-found', reason: 'unavailable' });
        expect(harness.wantsPinned.current).toBe(true);
        expect(harness.isPinned.current).toBe(true);
        expect(harness.viewport).toEqual([]);
        await hook.unmount();
    });

    it('keeps a newer same-target takeover suspended after a stale load completes', async () => {
        const firstPage = deferred<Response>();
        const secondPage = deferred<Response>();
        read = () => initialReads.length === 1 ? firstPage.promise : secondPage.promise;
        const harness = createTranscriptJumpHostTestHarness();
        const hook = await harness.render();
        const first = hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 500 }, { preferTargetWindow: true });
        await vi.waitFor(() => expect(initialReads).toHaveLength(1));
        const second = hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 500 }, { preferTargetWindow: true });
        const replacement = harness.native.acquisitions[1];
        expect(replacement).not.toBe(harness.native.acquisitions[0]);
        firstPage.resolve(Response.json(transcriptJumpPage(500)));
        await expect(first).resolves.toEqual({ status: 'aborted' });
        await vi.waitFor(() => expect(initialReads).toHaveLength(2));
        expect(harness.native.activeOperation).toBe(replacement);
        expect(harness.scheduler.current.explicitJumpActive).toBe(true);
        secondPage.resolve(Response.json(emptyTranscriptJumpPage()));
        await expect(second).resolves.toEqual({ status: 'not-found', reason: 'unavailable' });
        expect(harness.native.activeOperation).toBeNull();
        expect(harness.scheduler.current.explicitJumpActive).toBe(false);
        expect(harness.native.releases).toEqual(harness.native.acquisitions);
        expect(harness.viewport).toEqual([]);
        await hook.unmount();
    });

    it('releases the captured old-session renderer without releasing its replacement', async () => {
        const aPage = deferred<Response>();
        const bPage = deferred<Response>();
        read = url => url.pathname.includes('/s1/') ? aPage.promise : bPage.promise;
        const harness = createTranscriptJumpHostTestHarness();
        const replacement = createTranscriptJumpHostTestHarness({ sessionId: 's2' });
        const hook = await harness.render();
        const a = hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 100 }, { preferTargetWindow: true });
        await vi.waitFor(() => expect(initialReads).toHaveLength(1));
        harness.listRef.current = replacement.renderer;
        await hook.rerender(harness.props({ sessionId: 's2' }));
        const b = hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 200 }, { preferTargetWindow: true });
        await vi.waitFor(() => expect(initialReads).toHaveLength(2));
        const bOperation = replacement.native.activeOperation;
        aPage.resolve(Response.json(transcriptJumpPage(100)));
        await expect(a).resolves.toEqual({ status: 'aborted' });
        expect(harness.native.activeOperation).toBeNull();
        expect(replacement.native.activeOperation).toBe(bOperation);
        bPage.resolve(Response.json(emptyTranscriptJumpPage()));
        await expect(b).resolves.toEqual({ status: 'not-found', reason: 'unavailable' });
        expect(replacement.native.activeOperation).toBeNull();
        expect(replacement.native.releases).toEqual(replacement.native.acquisitions);
        await hook.unmount();
    });

    it('attests and scrolls the exact route row instead of a neighbor sharing its seq', async () => {
        const target = { kind: 'route-message-id' as const, routeMessageId: 'local:target', seqHint: 500 };
        const messages: Record<string, Message> = Object.fromEntries(['wrong', 'target'].map(id => [id, {
            kind: 'user-text', id, localId: id, seq: 500, createdAt: 1, text: id,
        } satisfies Message]));
        getStorage().setState(state => ({ sessionMessages: { ...state.sessionMessages,
            s1: createSessionMessagesFixture({ messagesById: messages, messageIdsOldestFirst: ['wrong', 'target'], isLoaded: true }),
        } }));
        const harness = createTranscriptJumpHostTestHarness({ rows: [
            { kind: 'message', id: 'wrong-route', messageId: 'wrong', seq: 500, createdAt: 1 },
            { kind: 'message', id: 'exact-route', messageId: 'target', seq: 500, createdAt: 1 },
        ], messages });
        harness.metrics.current = createTranscriptJumpWebMetrics({ rows: [{ id: 'exact-route', top: 200 }] });
        const hook = await harness.render({ platformOS: 'web' });
        await expect(hook.getCurrent().jumpToTranscriptTarget(target, { align: { kind: 'center' } }))
            .resolves.toEqual({ status: 'scrolled', target });
        expect(harness.metrics.current.element.querySelector('[data-testid="transcript-item-exact-route"]')).not.toBeNull();
        expect(harness.native.indexWrites).toEqual([]);
        expect(initialReads).toEqual([]);
        await hook.unmount();
    });
});
