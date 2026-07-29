/**
 * A jump landing OWNS the current navigation anchor until the reader genuinely
 * scrolls. A landing settles the renderer window one or two rows ABOVE the target
 * row, because the previous turn's tail still grazes the viewport top. Geometric
 * containment then answers "the previous turn" — true, and useless as "where the
 * reader is".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { TranscriptNavigationEntry } from '@/components/sessions/transcript/navigation/transcriptNavigationTypes';

import type { ScrollableChatListRef } from '../../transcriptScrollableListTypes';
import {
    clearTranscriptNavigationVisibilityStore,
    getTranscriptNavigationVisibilityStore,
} from '../../visibility/transcriptNavigationVisibilityStore';
import { useTranscriptJumpHost } from './useTranscriptJumpHost';

vi.mock('@/sync/sync', () => ({
    sync: {
        getSessionTargetWindowState: vi.fn(() => ({
            isWindowMode: false,
            windowMaxSeq: null,
            windowMinSeq: null,
        })),
        loadOlderMessages: vi.fn(async () => ({ status: 'no_more' })),
        loadOlderMessagesForkAware: vi.fn(async () => ({ status: 'no_more' })),
        loadTargetWindowMessages: vi.fn(async () => null),
        subscribeSessionTargetWindowState: vi.fn(() => () => {}),
    },
}));

type JumpHostDeps = Parameters<typeof useTranscriptJumpHost>[0];

const SESSION_ID = 'session-landing';
const FIRST_TURN_ANCHOR = 'session-landing:user-turn:7';
const SECOND_TURN_ANCHOR = 'session-landing:user-turn:12';

function createRef<T>(current: T): { current: T } {
    return { current };
}

function userMessage(id: string, seq: number): Message {
    return {
        kind: 'user-text',
        id,
        localId: id,
        createdAt: seq,
        text: `prompt ${seq}`,
        seq,
        transcriptBlockIndex: 0,
    } as unknown as Message;
}

function agentMessage(id: string, seq: number, blockIndex: number): Message {
    return {
        kind: 'agent-text',
        id,
        localId: id,
        createdAt: seq * 10 + blockIndex,
        text: `answer ${seq}.${blockIndex}`,
        seq,
        transcriptBlockIndex: blockIndex,
        isThinking: false,
    } as unknown as Message;
}

/**
 * Source rows 0..3 belong to turn 7, rows 4..9 to turn 12. Turn 12's prompt row
 * is source index 4.
 */
const MESSAGES: Readonly<Record<string, Message>> = {
    u1: userMessage('u1', 7),
    a1: agentMessage('a1', 7, 1),
    a2: agentMessage('a2', 7, 2),
    a3: agentMessage('a3', 7, 3),
    u2: userMessage('u2', 12),
    a4: agentMessage('a4', 12, 1),
    a5: agentMessage('a5', 12, 2),
    a6: agentMessage('a6', 12, 3),
    a7: agentMessage('a7', 12, 4),
    a8: agentMessage('a8', 12, 5),
};

const LIST_DATA = Object.entries(MESSAGES).map(([messageId, message]) => ({
    kind: 'message' as const,
    id: `row-${messageId}`,
    messageId,
    createdAt: message.createdAt,
    seq: message.seq,
}));

function turnEntry(params: Readonly<{ id: string; seq: number }>): TranscriptNavigationEntry {
    return {
        id: params.id,
        sessionId: SESSION_ID,
        seq: params.seq,
        routeMessageId: null,
        transcriptBlockIndex: 0,
        kind: 'user-turn',
        role: 'user',
        label: `prompt ${params.seq}`,
        promptPreview: `prompt ${params.seq}`,
        responsePreview: null,
        createdAtMs: params.seq,
        pinned: false,
        pinnedAtMs: null,
        loaded: true,
    };
}

const ENTRIES: readonly TranscriptNavigationEntry[] = [
    turnEntry({ id: FIRST_TURN_ANCHOR, seq: 7 }),
    turnEntry({ id: SECOND_TURN_ANCHOR, seq: 12 }),
];

function createHostMembers(visibleRange: { startIndex: number; endIndex: number }) {
    const rendererWindow = { ...visibleRange };
    const listRef = createRef<ScrollableChatListRef | null>({
        readVisibleSourceIndexRange: () => ({ ...rendererWindow }),
        scrollToIndex: vi.fn(),
        scrollToOffset: vi.fn(),
    } as unknown as ScrollableChatListRef);
    return { listRef, rendererWindow };
}

function buildDeps(overrides: Readonly<{
    entries?: readonly TranscriptNavigationEntry[];
    listRef: { current: ScrollableChatListRef | null };
}>): JumpHostDeps {
    return {
        activeTargetWindowTargetRef: createRef(null),
        applyExplicitJumpTakeoverApplyEffects: vi.fn(),
        beginExplicitJumpWriteBarrier: vi.fn(),
        canonicalWindowedItemsRef: createRef(LIST_DATA),
        committedMessagesCount: LIST_DATA.length,
        commitBottomFollowModeState: vi.fn(),
        commitExplicitReturnToLiveTailState: vi.fn(),
        commitScrollPinState: vi.fn(),
        currentSessionIdRef: createRef(SESSION_ID),
        emitViewportChange: vi.fn(() => true),
        endExplicitJumpWriteBarrier: vi.fn(),
        executeViewportCommand: vi.fn(() => true),
        executeViewportCommandWithAnimation: vi.fn(() => true),
        forkedTranscriptEnabled: false,
        hasMoreOlderRef: createRef<boolean | null>(false),
        invalidateViewportAnchorCapture: vi.fn(),
        isLoaded: true,
        isPinnedRef: createRef(false),
        itemsRef: createRef(LIST_DATA),
        jumpToSeq: null,
        lastPinOffsetForIntentRef: createRef<number | null>(null),
        lastNativeRestoreIndexCommandRef: createRef(null),
        lastRouteJumpProtectionClearingWebMovementAtMsRef: createRef(Number.NEGATIVE_INFINITY),
        lastScrollOffsetForIntentRef: createRef<number | null>(null),
        lifecycleHost: {
            armNativeExplicitJumpConfirmation: vi.fn(),
            clearNativeExplicitJumpConfirmation: vi.fn(),
            planExplicitJumpTakeover: vi.fn(() => ({
                explicitJumpTakeoverEffects: [],
                state: { bottomFollowState: { dragSession: null, mode: 'released' } },
            })),
        },
        listContentHeight: 4000,
        listContentHeightRef: createRef(4000),
        listData: LIST_DATA,
        listLayoutHeight: 600,
        listRef: overrides.listRef,
        messagesById: MESSAGES,
        onJumpLanded: undefined,
        onSuccessfulRouteJumpSettled: vi.fn(),
        onViewportChangeRef: createRef(undefined),
        pendingJumpSeqViewportPromotionRef: createRef(null),
        pinThresholdPx: 72,
        pinThresholdPxRef: createRef(72),
        pinToBottom: vi.fn(() => true),
        platformOS: 'ios',
        promotedJumpSeqViewportProtectionRef: createRef(null),
        readCurrentNativeDistanceFromBottom: vi.fn(() => null),
        resolveJumpToSeqIndexForCommandRef: createRef(() => null),
        resolveSeqForMessageId: (messageId: string) => MESSAGES[messageId]?.seq ?? null,
        resolveSyncLoadOlderOptions: vi.fn(() => undefined),
        resolveTargetWindowItemSeq: vi.fn(() => null),
        resolveViewportCommand: vi.fn((input: unknown) => input),
        resolveWebScrollMetrics: vi.fn(() => null),
        scrollPin: { isPinned: false, lastActivityKey: null, newActivityCount: 0 },
        scrollPinRef: createRef({ isPinned: false, lastActivityKey: null, newActivityCount: 0 }),
        sessionId: SESSION_ID,
        stampViewportAnchorForEmit: vi.fn((anchor: unknown) => anchor ?? null),
        targetWindowHasMoreNewer: false,
        targetWindowIsWindowMode: false,
        transcriptNavigationEntries: overrides.entries ?? ENTRIES,
        transcriptNavigationRuntimeAnchorsRef: createRef([]),
        waitForNextVisualUpdate: vi.fn(() => Promise.resolve()),
        wantsPinnedRef: createRef(false),
    } as unknown as JumpHostDeps;
}

describe('transcript jump landing owns the navigation anchor', () => {
    afterEach(() => {
        clearTranscriptNavigationVisibilityStore(SESSION_ID);
    });

    it('publishes the landed turn as current even when the renderer leads with the previous turn', async () => {
        const store = getTranscriptNavigationVisibilityStore(SESSION_ID);
        // Renderer settles one row ABOVE turn 12's prompt row (source index 4).
        const { listRef, rendererWindow } = createHostMembers({ startIndex: 3, endIndex: 8 });
        const hook = await renderHook(
            (deps: JumpHostDeps) => useTranscriptJumpHost(deps),
            { initialProps: buildDeps({ listRef }) },
        );
        let unsubscribe = () => {};
        try {
            await act(async () => {
                unsubscribe = store.subscribe(vi.fn());
            });
            await flushHookEffects();
            expect(store.get().currentAnchorId).toBe(FIRST_TURN_ANCHOR);

            // No scroll event follows the landing: the landing itself must publish.
            await act(async () => {
                await hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 12 });
            });
            expect(store.get()).toEqual({
                currentAnchorId: SECOND_TURN_ANCHOR,
                visibleAnchorIds: [SECOND_TURN_ANCHOR],
            });

            // The landing's own programmatic scroll echo must not release intent.
            await act(async () => {
                hook.getCurrent().observeTranscriptNavigationVisibilityForSession({
                    genuineUserMovement: false,
                });
            });
            expect(store.get().currentAnchorId).toBe(SECOND_TURN_ANCHOR);

            // A genuine reader scroll releases it, and containment resumes: the
            // reader moving back up onto the previous turn makes it current again.
            rendererWindow.startIndex = 1;
            rendererWindow.endIndex = 6;
            await act(async () => {
                hook.getCurrent().observeTranscriptNavigationVisibilityForSession({
                    genuineUserMovement: true,
                });
            });
            expect(store.get().currentAnchorId).toBe(FIRST_TURN_ANCHOR);
        } finally {
            await act(async () => {
                unsubscribe();
            });
            await hook.unmount();
        }
    });

    it('drops the landed anchor when its entry leaves the anchor set', async () => {
        const store = getTranscriptNavigationVisibilityStore(SESSION_ID);
        const { listRef } = createHostMembers({ startIndex: 3, endIndex: 8 });
        const hook = await renderHook(
            (deps: JumpHostDeps) => useTranscriptJumpHost(deps),
            { initialProps: buildDeps({ listRef }) },
        );
        let unsubscribe = () => {};
        try {
            await act(async () => {
                unsubscribe = store.subscribe(vi.fn());
            });
            await act(async () => {
                await hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 12 });
            });
            expect(store.get().currentAnchorId).toBe(SECOND_TURN_ANCHOR);

            await hook.rerender(buildDeps({
                entries: [ENTRIES[0]!],
                listRef,
            }));
            await flushHookEffects();

            expect(store.get().currentAnchorId).toBe(FIRST_TURN_ANCHOR);
        } finally {
            await act(async () => {
                unsubscribe();
            });
            await hook.unmount();
        }
    });
});
