import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createSessionMessagesFixture, flushHookEffects, standardCleanup } from '@/dev/testkit';
import type { Message } from '@happier-dev/session-core/messages';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { ChatTranscriptListItem, TranscriptViewportChangeState } from '../../../chatListTypes';
import type { TranscriptJumpHostDeps } from './useTranscriptJumpHost';
import {
    createTranscriptJumpHostTestHarness, createTranscriptJumpWebMetrics, emptyTranscriptJumpPage,
    restoreTranscriptJumpEnvironment, transcriptJumpPage,
} from './transcriptJumpHostTestHarness';

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

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
    beforeEach(async () => {
        initialReads.length = 0;
        read = () => Response.json(emptyTranscriptJumpPage());
        environment = await restoreTranscriptJumpEnvironment(url => {
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
        expect(getStorage().getState().sessionMessages.s1?.messagesById['message-50']?.seq).toBe(50);
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
        const hook = await harness.render();
        const stableJump = hook.getCurrent().jumpToTranscriptTarget;
        const landing = stableJump({ kind: 'seq', seq: 500 }, { preferTargetWindow: true });
        await vi.waitFor(() => expect(initialReads).toHaveLength(1));
        harness.rows.current = [{ kind: 'message', id: 'target-row', messageId: 'message-500', createdAt: 500, seq: null }];
        await hook.rerender(harness.props({
            resolveSeqForMessageId: id => getStorage().getState().sessionMessages.s1?.messagesById[id]?.seq ?? null,
        }));
        expect(hook.getCurrent().jumpToTranscriptTarget).toBe(stableJump);
        page.resolve(Response.json(transcriptJumpPage(500)));
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
        const hook = await harness.render();
        const landing = hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 500 }, { preferTargetWindow: true });
        await vi.waitFor(() => expect(harness.base.activeTargetWindowTargetRef.current).toEqual({ kind: 'seq', seq: 500 }));
        expect(harness.native.indexWrites).toEqual([]);
        harness.rows.current = [row(500)];
        await hook.rerender(harness.props());
        await expect(landing).resolves.toMatchObject({ status: 'window-rendered' });
        expect(harness.native.indexWrites).toHaveLength(1);
        await hook.unmount();
    });

    it('materializes a forked transcript own segment through the actual session history owner', async () => {
        const harness = createTranscriptJumpHostTestHarness();
        const hook = await harness.render({ forkedTranscriptEnabled: true });
        await hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 500 }, { preferTargetWindow: true });
        expect(initialReads.map(url => url.pathname)).toEqual(['/v2/sessions/s1/messages']);
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
        await vi.waitFor(() => expect(initialReads).toHaveLength(2));
        const replacement = harness.native.acquisitions[1];
        expect(replacement).not.toBe(harness.native.acquisitions[0]);
        firstPage.resolve(Response.json(transcriptJumpPage(500)));
        await expect(first).resolves.toEqual({ status: 'aborted' });
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
