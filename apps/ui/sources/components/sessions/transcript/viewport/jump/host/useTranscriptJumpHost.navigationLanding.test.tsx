import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { Message } from '@happier-dev/session-core/messages';
import type { ChatTranscriptListItem } from '../../../chatListTypes';
import { createSessionMessagesFixture, flushHookEffects, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { TranscriptNavigationEntry } from '../../../navigation/transcriptNavigationTypes';
import { clearTranscriptNavigationVisibilityStore, getTranscriptNavigationVisibilityStore } from '../../visibility/transcriptNavigationVisibilityStore';
import type { restoreTranscriptJumpEnvironment as RestoreTranscriptJumpEnvironment } from './transcriptJumpHostTestHarness';
import {
    applyTranscriptJumpHighlightForJumpResult,
    clearTranscriptJumpHighlight,
    markTranscriptJumpHighlightPainted,
    readActiveTranscriptJumpHighlight,
    subscribeToTranscriptJumpHighlight,
    TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS,
} from '../../../navigation/transcriptJumpHighlightStore';

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { createTranscriptJumpHostTestHarness, createTranscriptJumpWebMetrics, restoreTranscriptJumpEnvironment } = await import('./transcriptJumpHostTestHarness');

const SESSION_ID = 'session-landing';
const FIRST = SESSION_ID + ':user-turn:7';
const SECOND = SESSION_ID + ':user-turn:12';
function user(id: string, seq: number): Message {
    return { kind: 'user-text', id, localId: id, createdAt: seq, text: 'prompt ' + seq, seq, transcriptBlockIndex: 0 };
}
function agent(id: string, seq: number, block: number): Message {
    return { kind: 'agent-text', id, localId: id, createdAt: seq * 10 + block, text: 'answer ' + seq + '.' + block,
        seq, transcriptBlockIndex: block, isThinking: false };
}
const MESSAGES: Readonly<Record<string, Message>> = {
    u1: user('u1', 7), a1: agent('a1', 7, 1), a2: agent('a2', 7, 2), a3: agent('a3', 7, 3),
    u2: user('u2', 12), a4: agent('a4', 12, 1), a5: agent('a5', 12, 2),
    a6: agent('a6', 12, 3), a7: agent('a7', 12, 4), a8: agent('a8', 12, 5),
};
const ROWS: readonly ChatTranscriptListItem[] = Object.entries(MESSAGES).map(([messageId, message]) => ({
    kind: 'message', id: 'row-' + messageId, messageId, createdAt: message.createdAt, seq: message.seq ?? null,
}));
function entry(id: string, seq: number): TranscriptNavigationEntry {
    return { id, sessionId: SESSION_ID, seq, routeMessageId: null, transcriptBlockIndex: 0,
        kind: 'user-turn', role: 'user', label: 'prompt ' + seq, promptPreview: 'prompt ' + seq,
        responsePreview: null, createdAtMs: seq, pinned: false, pinnedAtMs: null, loaded: true };
}
const ENTRIES = [entry(FIRST, 7), entry(SECOND, 12)];
let environment: Awaited<ReturnType<typeof RestoreTranscriptJumpEnvironment>>;

describe('transcript jump landing owns the navigation anchor', () => {
    beforeEach(async () => {
        environment = await restoreTranscriptJumpEnvironment();
        getStorage().setState(state => ({ sessionMessages: { ...state.sessionMessages,
            [SESSION_ID]: createSessionMessagesFixture({
                messageIdsOldestFirst: Object.keys(MESSAGES), messagesById: { ...MESSAGES }, isLoaded: true,
            }),
        } }));
    });
    afterEach(async () => {
        clearTranscriptJumpHighlight();
        vi.useRealTimers();
        clearTranscriptNavigationVisibilityStore(SESSION_ID);
        await environment.dispose();
        standardCleanup();
    });

    it('publishes a covered DOM landing when presented and starts expiry only after its row paints', async () => {
        vi.useFakeTimers();
        getStorage().getState().sessionMessages[SESSION_ID]!.reducerState.messageIds.set('source-answer', 'a2');
        const harness = createTranscriptJumpHostTestHarness({ sessionId: SESSION_ID, rows: ROWS, messages: MESSAGES });
        harness.metrics.current = createTranscriptJumpWebMetrics({
            rows: ROWS.map((row, index) => ({ id: row.id, top: index * 100 })), scrollTop: 0,
        });
        const address = { serverId: environment.home.id, sessionId: SESSION_ID };
        const route = { platformOS: 'web' as const, jumpToSeq: 7, jumpToMessageId: 'server:source-answer',
            onJumpLanded: (result: Parameters<typeof applyTranscriptJumpHighlightForJumpResult>[1]) => {
                applyTranscriptJumpHighlightForJumpResult(address, result);
            } };
        const publications: Array<ReturnType<typeof readActiveTranscriptJumpHighlight>> = [];
        const unsubscribe = subscribeToTranscriptJumpHighlight(() => publications.push(readActiveTranscriptJumpHighlight()));
        const hook = await harness.render({ ...route, isTranscriptPresented: false });
        try {
            await flushHookEffects();
            expect(harness.settledRoutes).toEqual([SESSION_ID]);
            expect(readActiveTranscriptJumpHighlight()).toBeNull();
            expect(publications).toEqual([]);
            await act(async () => { vi.advanceTimersByTime(TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS * 2); });
            await hook.rerender(harness.props({ ...route, isTranscriptPresented: true }));
            expect(readActiveTranscriptJumpHighlight()).toMatchObject({ sessionAddress: address, routeMessageId: 'server:source-answer' });
            expect(publications).toHaveLength(1);
            // The jump host reports the landing; the row separately acknowledges painting its cue.
            await act(async () => { vi.advanceTimersByTime(TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS * 2); });
            const highlight = readActiveTranscriptJumpHighlight();
            expect(highlight).not.toBeNull();
            markTranscriptJumpHighlightPainted(highlight!.token);
            await act(async () => { vi.advanceTimersByTime(TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS - 1); });
            expect(readActiveTranscriptJumpHighlight()).not.toBeNull();
            await act(async () => { vi.advanceTimersByTime(1); });
            expect(readActiveTranscriptJumpHighlight()).toBeNull();
            expect(publications).toHaveLength(2);
            await act(async () => {
                await hook.getCurrent().jumpToTranscriptTarget({ kind: 'route-message-id', routeMessageId: 'server:source-answer', seqHint: 7 });
            });
            expect(readActiveTranscriptJumpHighlight()).toMatchObject({ routeMessageId: 'server:source-answer' });
            expect(publications).toHaveLength(3);
        } finally {
            unsubscribe();
            await hook.unmount();
        }
    });

    it.each(['abort', 'reader takeover', 'live tail', 'Session change'] as const)('discards a covered landing after %s', async (retirement) => {
        const harness = createTranscriptJumpHostTestHarness({ sessionId: SESSION_ID, rows: ROWS, messages: MESSAGES });
        const controller = new AbortController();
        const props = { isTranscriptPresented: false,
            onJumpLanded: (result: Parameters<typeof applyTranscriptJumpHighlightForJumpResult>[1]) => {
                applyTranscriptJumpHighlightForJumpResult({ serverId: environment.home.id, sessionId: SESSION_ID }, result);
            } };
        const hook = await harness.render(props);
        try {
            await act(async () => {
                await hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 7 }, { signal: controller.signal });
            });
            expect(readActiveTranscriptJumpHighlight()).toBeNull();
            if (retirement === 'abort') controller.abort();
            if (retirement === 'reader takeover') hook.getCurrent().preemptExplicitJumpForUserTakeover();
            if (retirement === 'live tail') hook.getCurrent().jumpToBottom();
            await hook.rerender(harness.props({ ...props, isTranscriptPresented: true,
                ...(retirement === 'Session change' ? { sessionId: 's2' } : {}) }));
            expect(readActiveTranscriptJumpHighlight()).toBeNull();
        } finally {
            await hook.unmount();
        }
    });

    it('lands a Find reveal without the attention cue; its match fill is the only current mark', async () => {
        const harness = createTranscriptJumpHostTestHarness({ sessionId: SESSION_ID, rows: ROWS, messages: MESSAGES });
        const landed: unknown[] = [];
        const hook = await harness.render({ onJumpLanded: (result: unknown) => { landed.push(result); } });
        try {
            await act(async () => {
                await hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 7 }, { landingCue: false });
            });
            expect(harness.native.indexWrites.at(-1)).toMatchObject({ index: 0 });
            expect(landed).toEqual([]);
            await act(async () => { await hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 12 }); });
            expect(landed).toEqual([{ status: 'scrolled', target: { kind: 'seq', seq: 12 } }]);
        } finally {
            await hook.unmount();
        }
    });

    it('lands a route message on the exact answer rather than the first row at the same sequence', async () => {
        getStorage().getState().sessionMessages[SESSION_ID]!.reducerState.messageIds.set('source-answer', 'a2');
        getStorage().getState().sessionMessages[SESSION_ID]!.reducerState.messageIds.set('second-answer', 'a3');
        const harness = createTranscriptJumpHostTestHarness({ sessionId: SESSION_ID, rows: ROWS, messages: MESSAGES });
        const landed: unknown[] = [];
        const route = { jumpToSeq: 7, jumpToMessageId: 'server:source-answer', onJumpLanded: (result: unknown) => { landed.push(result); } };
        const hook = await harness.render(route);
        try {
            await flushHookEffects();
            expect(harness.native.indexWrites.at(-1)).toMatchObject({ index: 2, viewPosition: 0.5 });
            expect(landed).toContainEqual({ status: 'scrolled', target: { kind: 'route-message-id', routeMessageId: 'server:source-answer', seqHint: 7 } });
            await hook.rerender(harness.props({ ...route, jumpToMessageId: 'server:second-answer' }));
            await flushHookEffects();
            expect(harness.native.indexWrites.at(-1)).toMatchObject({ index: 3, viewPosition: 0.5 });
        } finally {
            await hook.unmount();
        }
    });

    it('publishes the landed turn until genuine reader movement releases it', async () => {
        const store = getTranscriptNavigationVisibilityStore(SESSION_ID);
        const harness = createTranscriptJumpHostTestHarness({ sessionId: SESSION_ID, rows: ROWS, messages: MESSAGES, isPinned: false });
        harness.native.visibleRange = { startIndex: 3, endIndex: 8 };
        const hook = await harness.render({ transcriptNavigationEntries: ENTRIES });
        const unsubscribe = store.subscribe(() => {});
        try {
            await flushHookEffects();
            expect(store.get().currentAnchorId).toBe(FIRST);
            await act(async () => { await hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 12 }); });
            expect(store.get()).toEqual({ currentAnchorId: SECOND, visibleAnchorIds: [SECOND] });
            expect(harness.native.indexWrites.at(-1)).toMatchObject({ index: 4, animated: true, viewPosition: 0.5 });

            await act(async () => { hook.getCurrent().observeTranscriptNavigationVisibilityForSession({ genuineUserMovement: false }); });
            expect(store.get().currentAnchorId).toBe(SECOND);
            harness.native.visibleRange = { startIndex: 1, endIndex: 6 };
            await act(async () => { hook.getCurrent().observeTranscriptNavigationVisibilityForSession({ genuineUserMovement: true }); });
            expect(store.get().currentAnchorId).toBe(FIRST);
        } finally {
            unsubscribe();
            await hook.unmount();
        }
    });

    it('drops the landed anchor when its entry leaves the anchor set', async () => {
        const store = getTranscriptNavigationVisibilityStore(SESSION_ID);
        const harness = createTranscriptJumpHostTestHarness({ sessionId: SESSION_ID, rows: ROWS, messages: MESSAGES, isPinned: false });
        harness.native.visibleRange = { startIndex: 3, endIndex: 8 };
        const hook = await harness.render({ transcriptNavigationEntries: ENTRIES });
        const unsubscribe = store.subscribe(() => {});
        try {
            await act(async () => { await hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 12 }); });
            expect(store.get().currentAnchorId).toBe(SECOND);
            await hook.rerender(harness.props({ transcriptNavigationEntries: [ENTRIES[0]!] }));
            await flushHookEffects();
            expect(store.get().currentAnchorId).toBe(FIRST);
        } finally {
            unsubscribe();
            await hook.unmount();
        }
    });
});
