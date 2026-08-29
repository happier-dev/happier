/**
 * Identity-stability contract for the M7 jump/navigation host.
 *
 * ChatList passes a fresh deps object literal on normal renders. The host's jump,
 * route, navigation, and promotion callbacks must therefore depend on individual
 * fields rather than the whole deps object.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import { useCommittedTranscriptRef } from '@/components/sessions/transcript/viewport/lifecycle/host/useCommittedTranscriptRef';

import type { ScrollableChatListRef } from '../../transcriptScrollableListTypes';
import { useTranscriptJumpHost } from './useTranscriptJumpHost';

const loadTargetWindowMessagesMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/sync', () => ({
    sync: {
        loadOlderMessages: vi.fn(async () => ({ status: 'no_more' })),
        loadOlderMessagesForkAware: vi.fn(async () => ({ status: 'no_more' })),
        loadTargetWindowMessages: loadTargetWindowMessagesMock,
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
    } as unknown as JumpHostDeps;
}

function useJumpHostWithCommittedPinThreshold(deps: JumpHostDeps) {
    const host = useTranscriptJumpHost(deps);
    useCommittedTranscriptRef(
        deps.pinThresholdPxRef,
        (deps as JumpHostDeps & { pinThresholdPx: number }).pinThresholdPx,
    );
    return host;
}

describe('useTranscriptJumpHost identity stability', () => {
    beforeEach(() => {
        loadTargetWindowMessagesMock.mockReset();
    });

    it('settles a successful current route jump only after its explicit barrier closes', async () => {
        const members = createStableMembers();
        members.onRouteJumpSettled.mockImplementation(() => {
            expect(members.endExplicitJumpWriteBarrier).toHaveBeenCalledTimes(1);
        });
        loadTargetWindowMessagesMock.mockResolvedValue({
            appliedSeqs: [50],
            hasMoreNewer: true,
            hasMoreOlder: true,
            newerCursor: 60,
            olderCursor: 40,
            rawSeqs: [50],
            status: 'loaded',
            targetPresent: true,
            targetSeq: 50,
            windowId: 'window-50',
        });

        const hook = await renderHook(
            (deps: JumpHostDeps) => useTranscriptJumpHost(deps),
            {
                initialProps: {
                    ...buildDeps(members),
                    jumpToSeq: 50,
                    platformOS: 'ios',
                } as JumpHostDeps,
            },
        );
        await flushHookEffects();

        expect(members.onRouteJumpSettled).toHaveBeenCalledTimes(1);
        expect(members.onRouteJumpSettled).toHaveBeenCalledWith('s1');
        await hook.unmount();
    });

    it('does not let a superseded route command settle the replacement attempt', async () => {
        const members = createStableMembers();
        const staleLoad = createDeferred<{ status: 'stale' }>();
        loadTargetWindowMessagesMock
            .mockReturnValueOnce(staleLoad.promise)
            .mockResolvedValueOnce(null);
        const initial = {
            ...buildDeps(members),
            jumpToSeq: 50,
            platformOS: 'ios',
        } as JumpHostDeps;
        const hook = await renderHook(
            (deps: JumpHostDeps) => useTranscriptJumpHost(deps),
            { initialProps: initial },
        );
        expect(loadTargetWindowMessagesMock).toHaveBeenCalledTimes(1);

        await hook.rerender({ ...initial, jumpToSeq: 51 } as JumpHostDeps);
        await flushHookEffects();
        expect(loadTargetWindowMessagesMock).toHaveBeenCalledTimes(2);

        staleLoad.resolve({ status: 'stale' });
        await flushHookEffects();
        expect(members.onRouteJumpSettled).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('retries a temporarily unavailable route jump after relevant layout changes', async () => {
        const members = createStableMembers();
        loadTargetWindowMessagesMock.mockResolvedValue(null);
        const initial = {
            ...buildDeps(members),
            jumpToSeq: 50,
            platformOS: 'web',
        } as JumpHostDeps;
        const hook = await renderHook(
            (deps: JumpHostDeps) => useTranscriptJumpHost(deps),
            { initialProps: initial },
        );
        await flushHookEffects();
        expect(loadTargetWindowMessagesMock).toHaveBeenCalledTimes(1);

        await hook.rerender({
            ...initial,
            committedMessagesCount: 2,
            listContentHeight: 1_100,
        } as JumpHostDeps);
        await flushHookEffects();

        expect(loadTargetWindowMessagesMock).toHaveBeenCalledTimes(2);
        expect(members.onRouteJumpSettled).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('preempts the active explicit jump and discards its pending durable promotion on user takeover', async () => {
        const members = createStableMembers();
        const load = createDeferred<null>();
        loadTargetWindowMessagesMock.mockReturnValue(load.promise);
        const hook = await renderHook(
            (deps: JumpHostDeps) => useTranscriptJumpHost(deps),
            {
                initialProps: {
                    ...buildDeps(members),
                    jumpToSeq: 50,
                } as JumpHostDeps,
            },
        );
        expect(loadTargetWindowMessagesMock).toHaveBeenCalledTimes(1);
        members.pendingJumpSeqViewportPromotionRef.current = {
            emitViewportChange: vi.fn(),
            seq: 50,
            sessionId: 's1',
        };
        members.promotedJumpSeqViewportProtectionRef.current = {
            promotedAtMs: Date.now(),
            seq: 50,
            sessionId: 's1',
        };

        hook.getCurrent().preemptExplicitJumpForUserTakeover();
        expect(members.pendingJumpSeqViewportPromotionRef.current).toBeNull();
        expect(members.promotedJumpSeqViewportProtectionRef.current).toBeNull();
        expect(members.onRouteJumpSettled).toHaveBeenCalledTimes(1);

        load.resolve(null);
        await flushHookEffects();
        expect(members.executeViewportCommandWithAnimation).not.toHaveBeenCalled();
        expect(members.onRouteJumpSettled).toHaveBeenCalledTimes(1);

        await hook.rerender({
            ...buildDeps(members),
            committedMessagesCount: 2,
            jumpToSeq: 50,
            listContentHeight: 1_100,
        } as JumpHostDeps);
        await flushHookEffects();
        expect(loadTargetWindowMessagesMock).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });

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
        expect(second.handleTranscriptNavigationRailJump).toBe(first.handleTranscriptNavigationRailJump);
        expect(second.handleTranscriptNavigationPaneEntryPress).toBe(first.handleTranscriptNavigationPaneEntryPress);
        expect(second.onScrollToIndexFailed).toBe(first.onScrollToIndexFailed);

        await hook.unmount();
    });

    it('returns the coherent jump-promotion snapshot it selected before deferred publication', async () => {
        const members = createStableMembers();
        const emitViewportChange = vi.fn();
        members.pendingJumpSeqViewportPromotionRef.current = {
            emitViewportChange,
            seq: 42,
            sessionId: 's1',
        };
        members.resolveWebScrollMetrics.mockReturnValue({
            clientHeight: 600,
            element: {
                getBoundingClientRect: () => ({
                    bottom: 600,
                    height: 600,
                    left: 0,
                    right: 320,
                    top: 0,
                    width: 320,
                    x: 0,
                    y: 0,
                    toJSON: () => ({}),
                }),
                querySelector: () => null,
                querySelectorAll: () => [],
            } as unknown as HTMLElement,
            scrollHeight: 4_000,
            scrollTop: 3_350,
        });
        const hook = await renderHook(
            (deps: JumpHostDeps) => useTranscriptJumpHost(deps),
            { initialProps: buildDeps(members) },
        );

        expect(hook.getCurrent().flushPendingJumpSeqViewportPromotionForExit()).toEqual({
            source: 'jump-promotion',
            viewport: {
                anchor: null,
                capturedAtMs: expect.any(Number),
                isPinned: true,
                offsetY: 0,
                shouldRestoreViewport: false,
            },
        });
        expect(members.pendingJumpSeqViewportPromotionRef.current).toBeNull();
        expect(emitViewportChange).not.toHaveBeenCalled();
        await Promise.resolve();
        expect(emitViewportChange).toHaveBeenCalledWith({
            anchor: null,
            isPinned: true,
            offsetY: 50,
            shouldRestoreViewport: false,
        });

        await hook.unmount();
    });

    it('uses the latest committed message seq resolver after async target-window materialization', async () => {
        const members = createStableMembers();
        const targetWindowLoad = createDeferred<{
            status: 'loaded';
            targetPresent: true;
            windowId: string;
            targetSeq: number;
            newerCursor: null;
            hasMoreNewer: false;
        }>();
        loadTargetWindowMessagesMock.mockReturnValue(targetWindowLoad.promise);
        const targetElement = {
            getBoundingClientRect: () => ({
                bottom: 300,
                height: 100,
                left: 0,
                right: 800,
                top: 200,
                width: 800,
                x: 0,
                y: 200,
                toJSON: () => ({}),
            }),
        } as Element;
        const element = {
            getBoundingClientRect: () => ({
                bottom: 500,
                height: 500,
                left: 0,
                right: 800,
                top: 0,
                width: 800,
                x: 0,
                y: 0,
                toJSON: () => ({}),
            }),
            querySelector: (selector: string) => (
                selector === '[data-testid="transcript-item-target-row"]'
                    ? targetElement
                    : null
            ),
            querySelectorAll: () => [],
        } as unknown as HTMLElement;
        members.resolveWebScrollMetrics.mockReturnValue({
            clientHeight: 500,
            element,
            scrollHeight: 2_000,
            scrollTop: 200,
        });
        const hook = await renderHook(
            (deps: JumpHostDeps) => useTranscriptJumpHost(deps),
            { initialProps: buildDeps(members) },
        );
        const stableJumpToTarget = hook.getCurrent().jumpToTranscriptTarget;
        const jump = stableJumpToTarget(
            { kind: 'seq', seq: 500 },
            { align: { kind: 'center' }, preferTargetWindow: true },
        );
        expect(loadTargetWindowMessagesMock).toHaveBeenCalledTimes(1);

        members.canonicalWindowedItemsRef.current = [{
            id: 'target-row',
            kind: 'message',
            messageId: 'target-message',
        }];
        const latestResolveSeqForMessageId = vi.fn((messageId: string) => (
            messageId === 'target-message' ? 500 : null
        ));
        await hook.rerender({
            ...buildDeps(members),
            resolveSeqForMessageId: latestResolveSeqForMessageId,
        } as JumpHostDeps);

        expect(hook.getCurrent().jumpToTranscriptTarget).toBe(stableJumpToTarget);
        targetWindowLoad.resolve({
            status: 'loaded',
            targetPresent: true,
            windowId: 'window-500',
            targetSeq: 500,
            newerCursor: null,
            hasMoreNewer: false,
        });

        let result: unknown;
        await act(async () => {
            result = await jump;
        });
        expect(result).toEqual({
            status: 'window-rendered',
            target: { kind: 'seq', seq: 500 },
            windowId: 'window-500',
        });
        expect(latestResolveSeqForMessageId).toHaveBeenCalledWith('target-message');
        await hook.unmount();
    });

    it('derives the reveal threshold from the current committed render instead of the previous ref value', async () => {
        const members = createStableMembers();
        const initialDeps = {
            ...buildDeps(members),
            listLayoutHeight: 100,
            pinThresholdPx: 72,
            scrollPin: { isPinned: false, lastActivityKey: 'm1', newActivityCount: 0 },
        } as JumpHostDeps;
        const hook = await renderHook(
            (deps: JumpHostDeps) => useJumpHostWithCommittedPinThreshold(deps),
            { initialProps: initialDeps },
        );

        await act(async () => {
            hook.getCurrent().commitJumpToBottomDistanceForVisibility(100);
        });
        expect(hook.getCurrent().jumpToBottomAffordance.isVisible).toBe(true);

        await hook.rerender({
            ...initialDeps,
            pinThresholdPx: 120,
        } as JumpHostDeps);

        expect(members.pinThresholdPxRef.current).toBe(120);
        expect(hook.getCurrent().jumpToBottomAffordance.isVisible).toBe(false);
        await hook.unmount();
    });

    it('offers the return to the live tail on unreached newer content, not on target-window presence', async () => {
        // A deep-linked session stays in target-window mode until an explicit live-tail intent
        // resets it — reaching the window's newer edge loads pages but never exits it. Once the
        // window has caught up, the rendered bottom IS the session's live tail, the window
        // renders no newer gap row, and a pinned reader sitting there must see no pill. Window
        // PRESENCE cannot answer "is the live tail below what I rendered"; the newer-content
        // fact — the same one that decides whether a newer gap row is rendered — can.
        const members = createStableMembers();
        const caughtUpWindowDeps = {
            ...buildDeps(members),
            scrollPin: { isPinned: true, lastActivityKey: null, newActivityCount: 0 },
            targetWindowHasMoreNewer: false,
            targetWindowHasNewerBeyondRenderedWindow: false,
        } as JumpHostDeps;
        const hook = await renderHook(
            (deps: JumpHostDeps) => useTranscriptJumpHost(deps),
            { initialProps: caughtUpWindowDeps },
        );

        expect(hook.getCurrent().jumpToBottomAffordance.isVisible).toBe(false);

        // Loaded rows newer than the window's range are omitted from the render, so the live
        // tail is below the rendered bottom while the server-side cursor reports nothing more.
        // `hasMoreNewer` alone would hide the reader's only way back here.
        await hook.rerender({
            ...caughtUpWindowDeps,
            targetWindowHasNewerBeyondRenderedWindow: true,
        } as JumpHostDeps);

        expect(hook.getCurrent().jumpToBottomAffordance).toEqual({
            count: 0,
            isVisible: true,
            presentation: 'standard',
        });
        await hook.unmount();
    });

    it('enters explicit takeover synchronously before starting a target-window load', async () => {
        const members = createStableMembers();
        const releaseExplicitJumpTakeover = vi.fn();
        const beginExplicitJumpTakeover = vi.fn(() => releaseExplicitJumpTakeover);
        members.listRef.current = {
            beginExplicitJumpTakeover,
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
        };
        loadTargetWindowMessagesMock.mockImplementation(async () => {
            expect(members.lifecycleHost.planExplicitJumpTakeover).toHaveBeenCalledWith({
                reason: 'jump-to-seq',
                sessionId: 's1',
            });
            expect(beginExplicitJumpTakeover).toHaveBeenCalledTimes(1);
            return null;
        });
        const hook = await renderHook(
            (deps: JumpHostDeps) => useTranscriptJumpHost(deps),
            { initialProps: buildDeps(members) },
        );

        const result = await hook.getCurrent().jumpToTranscriptTarget(
            { kind: 'seq', seq: 500 },
            { preferTargetWindow: true },
        );

        expect(result).toEqual({ status: 'not-found', reason: 'unavailable' });
        expect(loadTargetWindowMessagesMock).toHaveBeenCalledTimes(1);
        expect(releaseExplicitJumpTakeover).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });

    it('loads a target window for a forked transcript, whose own segment is an ordinary seq range', async () => {
        const members = createStableMembers();
        members.listRef.current = {
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
        };
        loadTargetWindowMessagesMock.mockResolvedValue(null);
        const hook = await renderHook(
            (deps: JumpHostDeps) => useTranscriptJumpHost(deps),
            { initialProps: { ...buildDeps(members), forkedTranscriptEnabled: true } as JumpHostDeps },
        );

        await hook.getCurrent().jumpToTranscriptTarget(
            { kind: 'seq', seq: 500 },
            { preferTargetWindow: true },
        );

        // A fork used to be refused the window outright and fell straight through to
        // `not-found`, which is why every navigation entry outside the loaded window was
        // unreachable. Its own segment is numbered like any other session's.
        expect(loadTargetWindowMessagesMock).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });

    it('publishes a measured detached viewport after a successful native Legend jump to an older target', async () => {
        const members = createStableMembers();
        members.canonicalWindowedItemsRef.current = [{
            id: 'older-row',
            kind: 'message',
            seq: 100,
        }];
        members.readCurrentNativeDistanceFromBottom.mockReturnValue(5_000);
        members.commitScrollPinState.mockImplementation((nextState) => {
            members.scrollPinRef.current = nextState;
        });
        const initialDeps = {
            ...buildDeps(members),
            platformOS: 'ios',
            scrollPin: members.scrollPinRef.current,
        } as JumpHostDeps;
        const hook = await renderHook(
            (deps: JumpHostDeps) => useTranscriptJumpHost(deps),
            { initialProps: initialDeps },
        );
        members.commitExplicitReturnToLiveTailState.mockImplementation(() => {
            members.wantsPinnedRef.current = true;
            members.isPinnedRef.current = true;
            members.lastPinOffsetForIntentRef.current = 0;
            members.scrollPinRef.current = {
                ...members.scrollPinRef.current,
                isPinned: true,
                newActivityCount: 0,
            };
            hook.getCurrent().commitJumpToBottomDistanceForVisibility(0);
        });

        let result: unknown;
        await act(async () => {
            result = await hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 100 });
        });

        expect(result).toEqual({
            status: 'scrolled',
            target: { kind: 'seq', seq: 100 },
        });
        expect(members.readCurrentNativeDistanceFromBottom).toHaveBeenCalledTimes(1);
        expect(members.wantsPinnedRef.current).toBe(false);
        expect(members.isPinnedRef.current).toBe(false);
        expect(members.lastPinOffsetForIntentRef.current).toBe(5_000);
        expect(members.commitBottomFollowModeState).toHaveBeenLastCalledWith({
            dragSession: null,
            mode: 'released',
        });
        expect(members.commitScrollPinState).toHaveBeenLastCalledWith({
            isPinned: false,
            lastActivityKey: null,
            newActivityCount: 0,
        });
        expect(members.emitViewportChange).toHaveBeenCalledWith({
            isPinned: false,
            offsetY: 5_000,
            shouldRestoreViewport: true,
        });
        expect(members.invalidateViewportAnchorCapture).toHaveBeenCalledTimes(1);

        await hook.rerender({
            ...initialDeps,
            scrollPin: members.scrollPinRef.current,
        } as JumpHostDeps);
        expect(hook.getCurrent().jumpToBottomAffordance.isVisible).toBe(true);

        await act(async () => {
            hook.getCurrent().jumpToBottom();
        });
        expect(members.commitExplicitReturnToLiveTailState).toHaveBeenCalledWith('jump-to-bottom');
        expect(members.wantsPinnedRef.current).toBe(true);
        expect(members.isPinnedRef.current).toBe(true);
        expect(members.lastPinOffsetForIntentRef.current).toBe(0);
        await hook.rerender({
            ...initialDeps,
            scrollPin: members.scrollPinRef.current,
        } as JumpHostDeps);
        expect(hook.getCurrent().jumpToBottomAffordance.isVisible).toBe(false);

        members.readCurrentNativeDistanceFromBottom.mockReturnValue(8_000);
        let repeatResult: unknown;
        await act(async () => {
            repeatResult = await hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 100 });
        });

        expect(repeatResult).toEqual({
            status: 'scrolled',
            target: { kind: 'seq', seq: 100 },
        });
        expect(members.readCurrentNativeDistanceFromBottom).toHaveBeenCalledTimes(2);
        expect(members.wantsPinnedRef.current).toBe(false);
        expect(members.isPinnedRef.current).toBe(false);
        expect(members.lastPinOffsetForIntentRef.current).toBe(8_000);
        expect(members.emitViewportChange).toHaveBeenLastCalledWith({
            isPinned: false,
            offsetY: 8_000,
            shouldRestoreViewport: true,
        });
        await hook.rerender({
            ...initialDeps,
            scrollPin: members.scrollPinRef.current,
        } as JumpHostDeps);
        expect(hook.getCurrent().jumpToBottomAffordance.isVisible).toBe(true);

        await hook.unmount();
    });

    it('does not detach a successful native jump without a measured older landing', async () => {
        const members = createStableMembers();
        members.canonicalWindowedItemsRef.current = [{
            id: 'older-row',
            kind: 'message',
            seq: 100,
        }];
        const hook = await renderHook(
            (deps: JumpHostDeps) => useTranscriptJumpHost(deps),
            {
                initialProps: {
                    ...buildDeps(members),
                    platformOS: 'android',
                } as JumpHostDeps,
            },
        );

        await expect(
            hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 100 }),
        ).resolves.toEqual({
            status: 'scrolled',
            target: { kind: 'seq', seq: 100 },
        });

        expect(members.readCurrentNativeDistanceFromBottom).toHaveBeenCalledTimes(1);
        expect(members.wantsPinnedRef.current).toBe(true);
        expect(members.isPinnedRef.current).toBe(true);
        expect(members.commitScrollPinState).not.toHaveBeenCalled();
        expect(members.emitViewportChange).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('does not detach when a native jump command fails', async () => {
        const members = createStableMembers();
        members.canonicalWindowedItemsRef.current = [{
            id: 'older-row',
            kind: 'message',
            seq: 100,
        }];
        members.executeViewportCommandWithAnimation.mockReturnValue(false);
        members.readCurrentNativeDistanceFromBottom.mockReturnValue(5_000);
        const hook = await renderHook(
            (deps: JumpHostDeps) => useTranscriptJumpHost(deps),
            {
                initialProps: {
                    ...buildDeps(members),
                    platformOS: 'ios',
                } as JumpHostDeps,
            },
        );

        await expect(
            hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 100 }),
        ).resolves.toEqual({ status: 'not-found', reason: 'unavailable' });

        expect(members.readCurrentNativeDistanceFromBottom).not.toHaveBeenCalled();
        expect(members.wantsPinnedRef.current).toBe(true);
        expect(members.isPinnedRef.current).toBe(true);
        expect(members.commitScrollPinState).not.toHaveBeenCalled();
        expect(members.emitViewportChange).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('keeps the newer same-target jump takeover suspended when the stale load completes', async () => {
        const members = createStableMembers();
        const firstLoad = createDeferred<{ status: 'stale' }>();
        const secondLoad = createDeferred<null>();
        let loadCount = 0;
        loadTargetWindowMessagesMock.mockImplementation(() => {
            loadCount += 1;
            return loadCount === 1 ? firstLoad.promise : secondLoad.promise;
        });

        let activeOperation: unknown = null;
        const releases: Array<ReturnType<typeof vi.fn>> = [];
        const beginExplicitJumpTakeover = vi.fn((operation: unknown) => {
            activeOperation = operation;
            const release = vi.fn(() => {
                if (activeOperation === operation) activeOperation = null;
            });
            releases.push(release);
            return release;
        });
        members.listRef.current = {
            beginExplicitJumpTakeover,
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
        };
        const hook = await renderHook(
            (deps: JumpHostDeps) => useTranscriptJumpHost(deps),
            { initialProps: buildDeps(members) },
        );
        const target = { kind: 'seq' as const, seq: 500 };

        const firstJump = hook.getCurrent().jumpToTranscriptTarget(target, { preferTargetWindow: true });
        const secondJump = hook.getCurrent().jumpToTranscriptTarget(target, { preferTargetWindow: true });

        expect(beginExplicitJumpTakeover).toHaveBeenCalledTimes(2);
        const firstOperation = beginExplicitJumpTakeover.mock.calls[0]?.[0];
        const secondOperation = beginExplicitJumpTakeover.mock.calls[1]?.[0];
        expect(firstOperation).toBeDefined();
        expect(secondOperation).toBeDefined();
        expect(secondOperation).not.toBe(firstOperation);
        expect(activeOperation).toBe(secondOperation);
        expect(members.beginExplicitJumpWriteBarrier).toHaveBeenCalledTimes(2);

        firstLoad.resolve({ status: 'stale' });
        await expect(firstJump).resolves.toEqual({ status: 'aborted' });

        expect(releases[0]).toHaveBeenCalledTimes(1);
        expect(activeOperation).toBe(secondOperation);
        expect(members.endExplicitJumpWriteBarrier).toHaveBeenCalledTimes(1);
        expect(members.readCurrentNativeDistanceFromBottom).not.toHaveBeenCalled();
        expect(members.emitViewportChange).not.toHaveBeenCalled();

        secondLoad.resolve(null);
        await expect(secondJump).resolves.toEqual({ status: 'not-found', reason: 'unavailable' });
        expect(releases[1]).toHaveBeenCalledTimes(1);
        expect(activeOperation).toBeNull();
        expect(members.endExplicitJumpWriteBarrier).toHaveBeenCalledTimes(2);
        expect(members.readCurrentNativeDistanceFromBottom).not.toHaveBeenCalled();
        expect(members.emitViewportChange).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('releases the captured old-session renderer without ending the replacement renderer takeover', async () => {
        const members = createStableMembers();
        const sessionALoad = createDeferred<{ status: 'stale' }>();
        const sessionBLoad = createDeferred<null>();
        loadTargetWindowMessagesMock.mockImplementation((loadSessionId: string) => (
            loadSessionId === 's1' ? sessionALoad.promise : sessionBLoad.promise
        ));

        let sessionAActiveOperation: unknown = null;
        const releaseSessionA = vi.fn((operation: unknown) => {
            if (sessionAActiveOperation === operation) sessionAActiveOperation = null;
        });
        const sessionARenderer = {
            beginExplicitJumpTakeover: vi.fn((operation: unknown) => {
                sessionAActiveOperation = operation;
                return () => releaseSessionA(operation);
            }),
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
        };
        let sessionBActiveOperation: unknown = null;
        const releaseSessionB = vi.fn((operation: unknown) => {
            if (sessionBActiveOperation === operation) sessionBActiveOperation = null;
        });
        const sessionBRenderer = {
            beginExplicitJumpTakeover: vi.fn((operation: unknown) => {
                sessionBActiveOperation = operation;
                return () => releaseSessionB(operation);
            }),
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
        };
        members.listRef.current = sessionARenderer;
        const hook = await renderHook(
            (deps: JumpHostDeps) => useTranscriptJumpHost(deps),
            { initialProps: buildDeps(members) },
        );

        const sessionAJump = hook.getCurrent().jumpToTranscriptTarget(
            { kind: 'seq', seq: 100 },
            { preferTargetWindow: true },
        );
        members.listRef.current = sessionBRenderer;
        const sessionBDeps = {
            ...buildDeps(members),
            sessionId: 's2',
        } as JumpHostDeps;
        members.currentSessionIdRef.current = 's2';
        await hook.rerender(sessionBDeps);
        const sessionBJump = hook.getCurrent().jumpToTranscriptTarget(
            { kind: 'seq', seq: 200 },
            { preferTargetWindow: true },
        );
        const sessionBOperation = sessionBRenderer.beginExplicitJumpTakeover.mock.calls[0]?.[0];
        expect(sessionBActiveOperation).toBe(sessionBOperation);

        sessionALoad.resolve({ status: 'stale' });
        await expect(sessionAJump).resolves.toEqual({ status: 'aborted' });

        expect(releaseSessionA).toHaveBeenCalledTimes(1);
        expect(sessionBActiveOperation).toBe(sessionBOperation);

        sessionBLoad.resolve(null);
        await expect(sessionBJump).resolves.toEqual({ status: 'not-found', reason: 'unavailable' });
        expect(releaseSessionB).toHaveBeenCalledTimes(1);
        expect(sessionBActiveOperation).toBeNull();
        await hook.unmount();
    });

    it('attests the exact route-resolved row identity instead of any row sharing its seq', async () => {
        const members = createStableMembers();
        const target = {
            kind: 'route-message-id' as const,
            routeMessageId: 'server:target',
            seqHint: 500,
        };
        members.canonicalWindowedItemsRef.current = [
            {
                id: 'same-seq-wrong-route',
                kind: 'message',
                messageId: 'wrong',
                routeMessageId: 'server:other',
                seq: 500,
            },
            {
                id: 'exact-route-row',
                kind: 'message',
                messageId: 'target',
                routeMessageId: target.routeMessageId,
                seq: 500,
            },
        ];
        const queriedSelectors: string[] = [];
        const targetElement = {
            getBoundingClientRect: () => ({
                bottom: 300,
                height: 100,
                left: 0,
                right: 800,
                top: 200,
                width: 800,
                x: 0,
                y: 200,
                toJSON: () => ({}),
            }),
        } as Element;
        const element = {
            getBoundingClientRect: () => ({
                bottom: 500,
                height: 500,
                left: 0,
                right: 800,
                top: 0,
                width: 800,
                x: 0,
                y: 0,
                toJSON: () => ({}),
            }),
            querySelector: (selector: string) => {
                queriedSelectors.push(selector);
                return selector === '[data-testid="transcript-item-exact-route-row"]'
                    ? targetElement
                    : null;
            },
            querySelectorAll: () => [],
        } as unknown as HTMLElement;
        members.resolveWebScrollMetrics.mockReturnValue({
            clientHeight: 500,
            element,
            scrollHeight: 2_000,
            scrollTop: 200,
        });
        const hook = await renderHook(
            (deps: JumpHostDeps) => useTranscriptJumpHost(deps),
            { initialProps: buildDeps(members) },
        );

        let result: unknown;
        await act(async () => {
            result = await hook.getCurrent().jumpToTranscriptTarget(target, {
                align: { kind: 'center' },
            });
        });

        expect(queriedSelectors).toContain('[data-testid="transcript-item-exact-route-row"]');
        expect(queriedSelectors).not.toContain('[data-testid="transcript-item-same-seq-wrong-route"]');
        expect(result).toEqual({ status: 'scrolled', target });
        await hook.unmount();
    });
});
