/**
 * Identity-stability contract for the M7 jump/navigation host.
 *
 * ChatList passes a fresh deps object literal on normal renders. The host's jump,
 * route, navigation, and promotion callbacks must therefore depend on individual
 * fields rather than the whole deps object.
 */
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

import { useTranscriptJumpHost } from './useTranscriptJumpHost';

type JumpHostDeps = Parameters<typeof useTranscriptJumpHost>[0];

function createRef<T>(current: T): { current: T } {
    return { current };
}

function createStableMembers() {
    return {
        activeTargetWindowTargetRef: createRef(null),
        applyExplicitJumpTakeoverApplyEffects: vi.fn(),
        beginExplicitJumpWriteBarrier: vi.fn(),
        canonicalWindowedItemsRef: createRef([]),
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
        listRef: createRef(null),
        messagesById: {},
        onViewportChangeRef: createRef(undefined),
        pendingJumpSeqViewportPromotionRef: createRef(null),
        pinThresholdPxRef: createRef(72),
        pinToBottom: vi.fn(() => true),
        promotedJumpSeqViewportProtectionRef: createRef(null),
        readCurrentNativeDistanceFromBottom: vi.fn(() => null),
        resolveJumpToSeqIndexForCommandRef: createRef(() => null),
        resolveSeqForMessageId: vi.fn(() => null),
        resolveJumpTargetIndexFromRenderedWindow: vi.fn(() => ({ status: 'found', index: 0 })),
        resolveSyncLoadOlderOptions: vi.fn(() => undefined),
        resolveTargetWindowItemSeq: vi.fn(() => null),
        resolveViewportCommand: vi.fn((input: unknown) => input),
        resolveWebScrollMetrics: vi.fn(() => null),
        scrollPinRef: createRef({ isPinned: true, lastActivityKey: null, newActivityCount: 0 }),
        stampViewportAnchorForEmit: vi.fn((anchor: unknown) => anchor ?? null),
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
        listLayoutWidthPx: 600,
        onJumpLanded: undefined,
        platformOS: 'web',
        scrollPin: { isPinned: true, lastActivityKey: null, newActivityCount: 0 },
        sessionId: 's1',
        targetWindowHasMoreNewer: false,
        targetWindowIsWindowMode: false,
        transcriptContentMaxWidth: 720,
        transcriptNavigationEntries: [],
        transcriptNavigationRuntimeAnchorsRef: createRef([]),
        transcriptNavigationRenderedSources: [],
        usesNativeFlashListBottomMaintenance: false,
    } as unknown as JumpHostDeps;
}

describe('useTranscriptJumpHost identity stability', () => {
    it('keeps jump and navigation callbacks stable across fresh deps object identities', async () => {
        const members = createStableMembers();
        const hook = await renderHook(
            (deps: JumpHostDeps) => useTranscriptJumpHost(deps),
            { initialProps: buildDeps(members) },
        );

        const first = hook.getCurrent();

        await hook.rerender(buildDeps(members));
        await hook.rerender(buildDeps(members));

        const second = hook.getCurrent();
        expect(second.promotePendingJumpSeqViewportSnapshot).toBe(first.promotePendingJumpSeqViewportSnapshot);
        expect(second.flushPendingJumpSeqViewportPromotionForExit).toBe(first.flushPendingJumpSeqViewportPromotionForExit);
        expect(second.shouldSuppressGenericViewportStateForProtectedJumpSeq).toBe(first.shouldSuppressGenericViewportStateForProtectedJumpSeq);
        expect(second.jumpToBottom).toBe(first.jumpToBottom);
        expect(second.jumpToTranscriptTarget).toBe(first.jumpToTranscriptTarget);
        expect(second.observeWebGenuineScrollMovement).toBe(first.observeWebGenuineScrollMovement);
        expect(second.handleTranscriptNavigationRailJump).toBe(first.handleTranscriptNavigationRailJump);
        expect(second.handleTranscriptNavigationPaneEntryPress).toBe(first.handleTranscriptNavigationPaneEntryPress);
        expect(second.onScrollToIndexFailed).toBe(first.onScrollToIndexFailed);

        await hook.unmount();
    });
});
