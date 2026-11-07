/**
 * `jumpToTop` loads every older page, then lands on the first row. A second press, a genuine user
 * scroll or a session change abandons the load without landing.
 */
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';

import type { ScrollableChatListRef } from '../../transcriptScrollableListTypes';
import { useTranscriptJumpHost } from './useTranscriptJumpHost';

vi.mock('@/sync/sync', () => ({
    sync: {
        loadOlderMessages: vi.fn(async () => ({ status: 'no_more' })),
        loadOlderMessagesForkAware: vi.fn(async () => ({ status: 'no_more' })),
        loadTargetWindowMessages: vi.fn(),
    },
}));

type JumpHostDeps = Parameters<typeof useTranscriptJumpHost>[0];

function createRef<T>(current: T): { current: T } {
    return { current };
}

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((nextResolve) => {
        resolve = nextResolve;
    });
    return { promise, resolve };
}

function createStableMembers() {
    return {
        activeTargetWindowTargetRef: createRef(null),
        applyExplicitJumpTakeoverApplyEffects: vi.fn(),
        beginExplicitJumpWriteBarrier: vi.fn(),
        canonicalWindowedItemsRef: createRef<Array<Record<string, unknown> & { id: string }>>([]),
        commitBottomFollowModeState: vi.fn(),
        commitExplicitReturnToLiveTailState: vi.fn(),
        commitJumpToBottomDistanceForVisibility: vi.fn(),
        commitScrollPinState: vi.fn(),
        currentSessionIdRef: createRef('s1'),
        emitViewportChange: vi.fn(() => true),
        endExplicitJumpWriteBarrier: vi.fn(),
        executeViewportCommand: vi.fn(() => true),
        executeViewportCommandWithAnimation: vi.fn(() => true),
        hasMoreOlderRef: createRef<boolean | null>(true),
        observeOlderLoadResult: () => {},
        handleNativeRestoreIndexFailure: vi.fn(() => false),
        invalidateViewportAnchorCapture: vi.fn(),
        itemsRef: createRef([]),
        isTranscriptJumpTargetInRenderedWindow: vi.fn(() => true),
        isPinnedRef: createRef(true),
        lastNativeRestoreIndexCommandRef: createRef(null),
        lastPinOffsetForIntentRef: createRef<number | null>(null),
        lastRouteJumpProtectionClearingWebMovementAtMsRef: createRef(Number.NEGATIVE_INFINITY),
        lastScrollOffsetForIntentRef: createRef<number | null>(null),
        lifecycleHost: {
            armNativeExplicitJumpConfirmation: vi.fn(),
            clearNativeExplicitJumpConfirmation: vi.fn(),
            planExplicitJumpTakeover: vi.fn(() => ({
                explicitJumpTakeoverEffects: [],
                state: { bottomFollowState: { dragSession: null, mode: 'following' } },
            })),
        },
        listContentHeightRef: createRef(1000),
        listRef: createRef<ScrollableChatListRef | null>(null),
        messagesById: {},
        onViewportChangeRef: createRef(undefined),
        onRouteJumpSettled: vi.fn(),
        pendingJumpSeqViewportPromotionRef:
            createRef<JumpHostDeps['pendingJumpSeqViewportPromotionRef']['current']>(null),
        pinThresholdPx: 72,
        pinThresholdPxRef: createRef(72),
        pinToBottom: vi.fn(() => true),
        promotedJumpSeqViewportProtectionRef:
            createRef<JumpHostDeps['promotedJumpSeqViewportProtectionRef']['current']>(null),
        readCurrentNativeDistanceFromBottom:
            vi.fn<JumpHostDeps['readCurrentNativeDistanceFromBottom']>(() => null),
        rendererKind: 'legendList',
        resolveJumpToSeqIndexForCommandRef: createRef(() => null),
        resolveSeqForMessageId: vi.fn(() => null),
        resolveSyncLoadOlderOptions: vi.fn(() => undefined),
        resolveTargetWindowItemSeq: vi.fn(() => null),
        resolveViewportCommand: vi.fn((input: unknown) => input),
        resolveWebScrollMetrics: vi.fn<() => WebTranscriptScrollMetrics | null>(() => null),
        scrollPinRef: createRef({ isPinned: true, lastActivityKey: null, newActivityCount: 0 }),
        stampViewportAnchorForEmit: vi.fn((anchor: unknown) => anchor ?? null),
        // ChatList holds this as a plain React ref, so it is a STABLE member —
        // a fresh ref object per render would be a fixture artifact, not the
        // deps-object churn this contract is about.
        transcriptNavigationRuntimeAnchorsRef: createRef([]),
        waitForNextVisualUpdate: vi.fn(() => Promise.resolve()),
        webDomObservation: {
            observeGenuineScrollMovement: vi.fn(() => ({
                isGenuineUserMovement: false,
                upwardIntent: false,
            })),
        },
        wantsPinnedRef: createRef(true),
    };
}

function buildDeps(members: ReturnType<typeof createStableMembers>): JumpHostDeps {
    return {
        ...members,
        committedMessagesCount: 1,
        forkedTranscriptEnabled: false,
        isLoaded: true,
        jumpAnimateScroll: true,
        jumpEnabled: true,
        jumpMinNewCount: 1,
        jumpRevealOffsetThresholdPx: 72,
        jumpToBottomDistanceFromBottom: 0,
        jumpToSeq: null,
        listContentHeight: 1000,
        listData: [],
        listLayoutHeight: 500,
        onJumpLanded: undefined,
        platformOS: 'web',
        scrollPin: { isPinned: true, lastActivityKey: null, newActivityCount: 0 },
        sessionId: 's1',
        targetWindowHasMoreNewer: false,
        targetWindowHasNewerBeyondRenderedWindow: false,
        transcriptNavigationEntries: [],
        transcriptNavigationRenderedSources: [],
        usesNativeFlashListBottomMaintenance: false,
    } as unknown as JumpHostDeps;
}


type OlderResult = { loaded: number; hasMore: boolean; status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight' };

function setup(loadOlder: (options?: unknown) => Promise<OlderResult | null>) {
    const members = createStableMembers();
    const rows = [{ id: 'a', seq: 7 }, { id: 'b', seq: 3 }, { id: 'c', seq: 9 }].map((row) => ({
        kind: 'message' as const,
        id: `row-${row.id}`,
        messageId: row.id,
        createdAt: row.seq,
        seq: row.seq,
    }));
    const seqByMessageId: Record<string, number> = { a: 7, b: 3, c: 9 };
    members.itemsRef.current = rows as never;
    members.canonicalWindowedItemsRef.current = rows as never;
    members.resolveSeqForMessageId = ((messageId: string) => seqByMessageId[messageId] ?? null) as never;
    members.resolveTargetWindowItemSeq = vi.fn((item: { seq?: number }) => item.seq ?? null) as never;
    const deps = {
        ...buildDeps(members),
        hasMoreOlder: true,
        loadOlder,
        listData: rows,
    } as JumpHostDeps;
    return { members, deps };
}

function landedSeqs(members: ReturnType<typeof createStableMembers>): number[] {
    // The landing may issue its command more than once (verify pass); distinct targets matter.
    return [...new Set(members.resolveViewportCommand.mock.calls
        .map(([input]) => input as { type?: string; seq?: number })
        .filter((input) => input.type === 'jump-to-seq')
        .map((input) => input.seq as number))];
}

describe('useTranscriptJumpHost jumpToTop', () => {
    it('loads every older page, then lands on the oldest loaded row', async () => {
        const pages: OlderResult[] = [
            { loaded: 50, hasMore: true, status: 'loaded' },
            { loaded: 50, hasMore: true, status: 'loaded' },
            { loaded: 5, hasMore: false, status: 'loaded' },
        ];
        const loadOlder = vi.fn(async () => pages.shift() ?? null);
        const { members, deps } = setup(loadOlder);
        const hook = await renderHook((next: JumpHostDeps) => useTranscriptJumpHost(next), { initialProps: deps });

        await act(async () => { await hook.getCurrent().jumpToTop(); });

        expect(loadOlder).toHaveBeenCalledTimes(3);
        expect(landedSeqs(members)).toEqual([3]);
        expect(hook.getCurrent().jumpToTopLoading).toBe(false);
        await hook.unmount();
    });

    it('a second press cancels the load and never lands', async () => {
        const second = (() => {
            let resolve!: (value: OlderResult) => void;
            const promise = new Promise<OlderResult>((r) => { resolve = r; });
            return { promise, resolve };
        })();
        const loadOlder = vi.fn()
            .mockResolvedValueOnce({ loaded: 50, hasMore: true, status: 'loaded' })
            .mockReturnValueOnce(second.promise);
        const { members, deps } = setup(loadOlder);
        const hook = await renderHook((next: JumpHostDeps) => useTranscriptJumpHost(next), { initialProps: deps });

        let firstPress!: Promise<void>;
        await act(async () => { firstPress = hook.getCurrent().jumpToTop(); await flushHookEffects(); });
        expect(hook.getCurrent().jumpToTopLoading).toBe(true);

        await act(async () => { await hook.getCurrent().jumpToTop(); });
        second.resolve({ loaded: 50, hasMore: true, status: 'loaded' });
        await act(async () => { await firstPress; });

        expect(loadOlder).toHaveBeenCalledTimes(2);
        expect(landedSeqs(members)).toEqual([]);
        expect(hook.getCurrent().jumpToTopLoading).toBe(false);
        await hook.unmount();
    });

    it('a genuine user scroll abandons the load', async () => {
        const second = (() => {
            let resolve!: (value: OlderResult) => void;
            const promise = new Promise<OlderResult>((r) => { resolve = r; });
            return { promise, resolve };
        })();
        const loadOlder = vi.fn()
            .mockResolvedValueOnce({ loaded: 50, hasMore: true, status: 'loaded' })
            .mockReturnValueOnce(second.promise);
        const { members, deps } = setup(loadOlder);
        const hook = await renderHook((next: JumpHostDeps) => useTranscriptJumpHost(next), { initialProps: deps });

        let press!: Promise<void>;
        await act(async () => { press = hook.getCurrent().jumpToTop(); await flushHookEffects(); });
        await act(async () => { hook.getCurrent().preemptExplicitJumpForUserTakeover(); });
        second.resolve({ loaded: 50, hasMore: false, status: 'loaded' });
        await act(async () => { await press; });

        expect(loadOlder).toHaveBeenCalledTimes(2);
        expect(landedSeqs(members)).toEqual([]);
        await hook.unmount();
    });

    it('stops without landing when the page loader is not ready', async () => {
        const loadOlder = vi.fn(async () => ({ loaded: 0, hasMore: true, status: 'not_ready' as const }));
        const { members, deps } = setup(loadOlder);
        const hook = await renderHook((next: JumpHostDeps) => useTranscriptJumpHost(next), { initialProps: deps });

        await act(async () => { await hook.getCurrent().jumpToTop(); });

        expect(landedSeqs(members)).toEqual([]);
        await hook.unmount();
    });
});
