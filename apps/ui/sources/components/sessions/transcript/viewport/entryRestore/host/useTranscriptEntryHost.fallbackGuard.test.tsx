/**
 * Fallback guard regression test for the web anchor restore path.
 *
 * Defect (P2SMOKE2-P5): when switching back to a session after a jump-class restore (seq=41,
 * anchor offsetY≈26835), the entry host fired the distance-from-bottom fallback on fresh mount
 * while scrollHeight was still 0. Because listDataRef was empty (FlashList not yet rendered),
 * the hot-tail guard inside performWebDomVisibleAnchorRestoreCommand returned not_found without
 * calling scrollToIndex. The fallback then wrote scrollTop=0 via writeWebScrollTopAndObserve,
 * observeWeb({status:'aligned'}) closed the transaction with lastClosedSessionId set, and all
 * future restore attempts were permanently blocked — leaving the viewport stuck at st=0.
 *
 * Fix: gate the fallback on
 *   max(0, scrollHeight - clientHeight) >= fallbackDistancePx
 * When scrollHeight=0, maxScrollTop=0 < 26835 → skip fallback → markInitialCommandFailed
 * (no closedSessionId) → transaction retryable on next listDataLength/listContentHeight change.
 *
 * Contract pinned here: "restore-with-unmounted-anchor must materialize/wait, not no-op to top."
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';

import { createDeferred, renderHook } from '@/dev/testkit';

import { createEntryRestoreOwner } from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreOwner';
import { createSessionOpenLatch } from '@/components/sessions/transcript/viewport/sessionOpen/sessionOpenLatch';
import { resolveTranscriptRenderWindowProjection } from '@/components/sessions/transcript/viewport/window/resolveTranscriptRenderWindowProjection';
import { createTranscriptWindowGapItem } from '@/components/sessions/transcript/viewport/window/transcriptWindowGapItem';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import type { SessionEntryViewportRefValue } from './useTranscriptEntryHost';
import { useTranscriptEntryHost } from './useTranscriptEntryHost';

const syncMockState = vi.hoisted(() => ({
    loadTargetWindowMessages: vi.fn(),
    sessionViewport: null as null | {
        anchor: null | {
            capturedAtMs: number;
            itemId: string;
            itemOffsetPx: number;
            kind: 'message';
            messageId: string | null;
            seq?: number | null;
        };
        isPinned: boolean;
        lastUpdatedAt: number;
        offsetY: number;
        source: 'default' | 'observed';
    },
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        getSessionViewport: () => syncMockState.sessionViewport,
        loadTargetWindowMessages: syncMockState.loadTargetWindowMessages,
        getSyncTuning: () => ({
            transcriptInitialFillBudgetMs: 2000,
            transcriptInitialFillMaxNoProgressLoads: 3,
            transcriptViewportAnchorOlderLookupMaxLoads: 6,
        }),
    },
}));
vi.mock('@/sync/domains/state/storage', () => ({
    getStorage: () => ({ getState: () => ({}) }),
}));

type EntryHostDeps = Parameters<typeof useTranscriptEntryHost>[0];

function createStableMembers(overrides?: {
    entryRestoreOwner?: ReturnType<typeof createEntryRestoreOwner>;
    executeViewportCommand?: (command: unknown) => boolean;
    items?: readonly ChatTranscriptListItem[];
    lastScrollOffsetForIntentRef?: { current: number | null };
    restoreWebViewportAnchorThroughViewportCommand?: EntryHostDeps['restoreWebViewportAnchorThroughViewportCommand'];
    resolveWebScrollMetrics?: () => WebTranscriptScrollMetrics | null;
    sessionEntryViewportRef?: { current: SessionEntryViewportRefValue };
}) {
    const items: readonly ChatTranscriptListItem[] = overrides?.items ?? [];
    const renderWindowProjection = resolveTranscriptRenderWindowProjection<ChatTranscriptListItem>({
        createWindowGapItem: createTranscriptWindowGapItem,
        items,
        listOrientation: 'standard',
        sessionId: 's1',
        targetWindowState: {
            isWindowMode: false,
            windowId: null,
            targetSeq: null,
            windowMinSeq: null,
            windowMaxSeq: null,
            olderCursor: null,
            newerCursor: null,
            hasMoreOlder: null,
            hasMoreNewer: null,
            activatedAtMs: null,
        },
    });
    return {
        activeTargetWindowTargetRef: { current: null },
        anchorLookupExhaustedRef: { current: false },
        anchorLookupInFlightRef: { current: false },
        anchorLookupLoadCountRef: { current: 0 },
        applyEntryRestoreOwnerEffectsRef: { current: () => {} },
        applySessionOpenArmResetPlan: vi.fn(),
        applySessionOpenDisposeResetPlan: vi.fn(),
        applySessionOpenLatchEffectsRef: { current: () => {} },
        attemptEntryRestoreRef: { current: () => {} },
        closeEntryViewportOwnership: vi.fn(),
        composerInsetHeightRef: { current: 0 },
        currentSessionIdRef: { current: 's1' },
        decomposedItems: items,
        disposeEntryRestoreTransactionForExitRef: { current: () => {} },
        entryRestoreDeadlineTimeoutRef: { current: null },
        entryRestoreOwner: overrides?.entryRestoreOwner ?? createEntryRestoreOwner(),
        executeViewportCommand: overrides?.executeViewportCommand ?? vi.fn(() => true),
        hasNativeContentMeasurementForCurrentSession: vi.fn(() => false),
        initialFillAbortRef: { current: null },
        invalidateViewportAnchorCapture: vi.fn(),
        isScrollable: vi.fn(() => false),
        isViewportAnchorSeqLoaded: vi.fn(() => false),
        lastScrollOffsetForIntentRef: overrides?.lastScrollOffsetForIntentRef ?? { current: null },
        lastUserScrollIntentAtMsRef: { current: Number.NEGATIVE_INFINITY },
        latestJumpToSeqRef: { current: null },
        listContentHeightRef: { current: 0 },
        listDataRef: { current: items },
        listLayoutHeightRef: { current: 0 },
        listRef: { current: null },
        loadOlder: vi.fn(async () => null),
        markNativeInitialViewportAppliedForCurrentSession: vi.fn(),
        nativeMountSettleDeadlineReachedRef: { current: false },
        nativeMountSettleStable: false,
        observeMountSettleMetrics: vi.fn(),
        recordRestoreDecisionTelemetry: vi.fn(),
        recordEntryOwnerOutcome: vi.fn(),
        recordViewportTelemetryEvent: vi.fn(),
        renderWindowProjection,
        resolveEntryRestoreOwnerAnchor: vi.fn<EntryHostDeps['resolveEntryRestoreOwnerAnchor']>(() => null),
        resolveNearestSurvivingViewportAnchorIndex: vi.fn<EntryHostDeps['resolveNearestSurvivingViewportAnchorIndex']>(() => null),
        resolveNearestSurvivingViewportAnchorIndexFromItems: vi.fn<EntryHostDeps['resolveNearestSurvivingViewportAnchorIndexFromItems']>(() => null),
        resolveSeqForViewportAnchor: vi.fn<EntryHostDeps['resolveSeqForViewportAnchor']>(() => null),
        resolveViewportCommand: vi.fn(() => ({
            kind: 'none' as const,
            sessionId: 's1',
            reason: 'test',
            mode: 'hydrating' as const,
        })),
        resolveWebScrollMetrics: overrides?.resolveWebScrollMetrics ?? vi.fn(() => null),
        restoreWebViewportAnchorThroughViewportCommand: overrides?.restoreWebViewportAnchorThroughViewportCommand ?? vi.fn(() => ({
            didAdjustScroll: false,
            status: 'not_found' as const,
        })),
        scheduleNativePaintReleaseForEntryRestore: vi.fn(),
        // Viewport recorded for session 's1' with offsetY = 26835 (a jump-class restore target).
        sessionEntryViewportRef: overrides?.sessionEntryViewportRef ?? {
            current: null,
        },
        sessionOpenLatch: createSessionOpenLatch(),
        setNativeMountSettleDeadlineReached: vi.fn(),
        updateNativeInitialViewportPendingObservation: vi.fn(),
        updateNativeViewportPaintObserved: vi.fn(),
        wantsPinnedRef: { current: true },
    };
}

function buildDeps(members: ReturnType<typeof createStableMembers>): EntryHostDeps {
    return {
        ...members,
        committedMessagesCount: 0,
        displayItemsLength: 0,
        isLoaded: false,
        jumpToSeq: null,
        listContentHeight: 0,
        listDataLength: 0,
        listLayoutHeight: 0,
        pinThresholdPx: 32,
        sessionId: 's1',
    };
}

describe('useTranscriptEntryHost fallback guard', () => {
    beforeEach(() => {
        syncMockState.loadTargetWindowMessages.mockReset();
        syncMockState.sessionViewport = null;
    });

    it('materializes an outside-data entry anchor target before issuing its restore', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        const anchor = {
            kind: 'message' as const,
            messageId: 'message-2',
            itemId: 'row-2',
            itemOffsetPx: 95,
            capturedAtMs: 1000,
            seq: 2,
        };
        const items: readonly ChatTranscriptListItem[] = [2, 5, 6].map((seq) => ({
            kind: 'message' as const,
            id: `row-${seq}`,
            messageId: `message-${seq}`,
            createdAt: seq,
            seq,
        }));
        const projection = resolveTranscriptRenderWindowProjection<ChatTranscriptListItem>({
            createWindowGapItem: createTranscriptWindowGapItem,
            items,
            listOrientation: 'standard',
            sessionId: 's1',
            targetWindowState: {
                activatedAtMs: 1000,
                hasMoreNewer: false,
                hasMoreOlder: true,
                isWindowMode: true,
                newerCursor: null,
                olderCursor: 4,
                targetSeq: 5,
                windowId: 'window-5',
                windowMaxSeq: 6,
                windowMinSeq: 5,
            },
        });
        syncMockState.loadTargetWindowMessages.mockResolvedValue({ status: 'stale' });
        const restoreWebViewportAnchorThroughViewportCommand = vi.fn(() => ({
            didAdjustScroll: true,
            status: 'restored' as const,
        }));
        const members = createStableMembers({
            items,
            restoreWebViewportAnchorThroughViewportCommand,
            sessionEntryViewportRef: {
                current: {
                    sessionId: 's1',
                    entryKind: 'anchored',
                    shouldFollowBottom: false,
                    offsetY: 2520,
                    anchor,
                    sourceLastUpdatedAt: 1000,
                    effects: [],
                },
            },
        });
        members.renderWindowProjection = projection;
        members.listDataRef = { current: projection.listData };
        members.resolveEntryRestoreOwnerAnchor = vi.fn(() => anchor);
        members.resolveNearestSurvivingViewportAnchorIndexFromItems = vi.fn(() => 0);
        members.resolveSeqForViewportAnchor = vi.fn(() => 2);
        members.isViewportAnchorSeqLoaded = vi.fn(() => true);

        try {
            const hook = await renderHook(
                (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
                { initialProps: buildDeps({
                    ...members,
                    decomposedItems: items,
                }) },
            );
            await Promise.resolve();
            await Promise.resolve();

            expect(syncMockState.loadTargetWindowMessages).toHaveBeenCalledWith(
                's1',
                { kind: 'seq', seq: 2 },
                { direction: 'initial' },
            );
            expect(restoreWebViewportAnchorThroughViewportCommand).not.toHaveBeenCalled();

            await hook.unmount();

            syncMockState.loadTargetWindowMessages.mockClear();
            members.anchorLookupExhaustedRef.current = true;
            const exhaustedHook = await renderHook(
                (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
                { initialProps: buildDeps({
                    ...members,
                    decomposedItems: items,
                }) },
            );
            await Promise.resolve();

            expect(syncMockState.loadTargetWindowMessages).not.toHaveBeenCalled();
            expect(restoreWebViewportAnchorThroughViewportCommand).toHaveBeenCalledTimes(1);

            await exhaustedHook.unmount();
        } finally {
            Object.defineProperty(Platform, 'OS', { value: originalPlatformOS, configurable: true });
        }
    });

    it('materializes an unloaded durable entry anchor through the exact target window and retries restore once', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
        const anchor = {
            kind: 'message' as const,
            messageId: 'message-331',
            itemId: 'row-331',
            itemOffsetPx: 40,
            capturedAtMs: 1000,
            seq: 331,
        };
        const materializedItem: ChatTranscriptListItem = {
            kind: 'message',
            id: anchor.itemId,
            messageId: anchor.messageId,
            createdAt: 331,
            seq: anchor.seq,
        };
        const executeViewportCommand = vi.fn(() => true);
        const members = createStableMembers({
            executeViewportCommand,
            items: [{
                kind: 'message',
                id: 'row-400',
                messageId: 'message-400',
                createdAt: 400,
                seq: 400,
            }],
            sessionEntryViewportRef: {
                current: {
                    sessionId: 's1',
                    entryKind: 'anchored',
                    shouldFollowBottom: false,
                    offsetY: 2520,
                    anchor,
                    sourceLastUpdatedAt: 1000,
                    effects: [],
                },
            },
        });
        members.resolveEntryRestoreOwnerAnchor = vi.fn(() => anchor);
        members.resolveSeqForViewportAnchor = vi.fn(() => 331);
        members.isViewportAnchorSeqLoaded = vi.fn(
            () => members.listDataRef.current.some((item) => item.id === materializedItem.id),
        );
        syncMockState.loadTargetWindowMessages.mockImplementation(async () => {
            members.listDataRef.current = [materializedItem];
            return {
                status: 'loaded',
                targetPresent: true,
            };
        });

        try {
            const hook = await renderHook(
                (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
                { initialProps: buildDeps(members) },
            );

            await vi.waitFor(() => {
                expect(syncMockState.loadTargetWindowMessages).toHaveBeenCalledTimes(1);
                expect(executeViewportCommand).toHaveBeenCalledTimes(1);
            });
            expect(syncMockState.loadTargetWindowMessages).toHaveBeenCalledWith(
                's1',
                { kind: 'seq', seq: 331 },
                { direction: 'initial' },
            );
            expect(members.loadOlder).not.toHaveBeenCalled();
            expect(members.activeTargetWindowTargetRef.current).toEqual({
                kind: 'seq',
                seq: 331,
            });

            await hook.unmount();
        } finally {
            Object.defineProperty(Platform, 'OS', { value: originalPlatformOS, configurable: true });
        }
    });

    it.each([
        {
            name: 'stale',
            result: { status: 'stale', targetPresent: true },
        },
        {
            name: 'target absent',
            result: { status: 'not_found', targetPresent: false },
        },
    ])('does not retry durable entry restore when exact target materialization is $name', async ({ result }) => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
        const anchor = {
            kind: 'message' as const,
            messageId: 'message-331',
            itemId: 'row-331',
            itemOffsetPx: 40,
            capturedAtMs: 1000,
            seq: 331,
        };
        const executeViewportCommand = vi.fn(() => true);
        const members = createStableMembers({
            executeViewportCommand,
            items: [{
                kind: 'message',
                id: 'row-400',
                messageId: 'message-400',
                createdAt: 400,
                seq: 400,
            }],
            sessionEntryViewportRef: {
                current: {
                    sessionId: 's1',
                    entryKind: 'anchored',
                    shouldFollowBottom: false,
                    offsetY: 2520,
                    anchor,
                    sourceLastUpdatedAt: 1000,
                    effects: [],
                },
            },
        });
        members.resolveEntryRestoreOwnerAnchor = vi.fn(() => anchor);
        members.resolveSeqForViewportAnchor = vi.fn(() => 331);
        members.isViewportAnchorSeqLoaded = vi.fn(() => false);
        syncMockState.loadTargetWindowMessages.mockResolvedValue(result);

        try {
            const hook = await renderHook(
                (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
                { initialProps: buildDeps(members) },
            );

            await vi.waitFor(() => {
                expect(syncMockState.loadTargetWindowMessages).toHaveBeenCalledTimes(1);
            });
            await Promise.resolve();
            await Promise.resolve();

            expect(executeViewportCommand).not.toHaveBeenCalled();
            expect(members.loadOlder).not.toHaveBeenCalled();
            expect(members.activeTargetWindowTargetRef.current).toBeNull();
            expect(syncMockState.loadTargetWindowMessages).toHaveBeenCalledTimes(1);

            await hook.unmount();
        } finally {
            Object.defineProperty(Platform, 'OS', { value: originalPlatformOS, configurable: true });
        }
    });

    it('does not publish or retry an exact target result after the host session changes', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
        const anchor = {
            kind: 'message' as const,
            messageId: 'message-331',
            itemId: 'row-331',
            itemOffsetPx: 40,
            capturedAtMs: 1000,
            seq: 331,
        };
        const executeViewportCommand = vi.fn(() => true);
        const members = createStableMembers({
            executeViewportCommand,
            items: [{
                kind: 'message',
                id: 'row-400',
                messageId: 'message-400',
                createdAt: 400,
                seq: 400,
            }],
            sessionEntryViewportRef: {
                current: {
                    sessionId: 's1',
                    entryKind: 'anchored',
                    shouldFollowBottom: false,
                    offsetY: 2520,
                    anchor,
                    sourceLastUpdatedAt: 1000,
                    effects: [],
                },
            },
        });
        members.resolveEntryRestoreOwnerAnchor = vi.fn(() => anchor);
        members.resolveSeqForViewportAnchor = vi.fn(() => 331);
        members.isViewportAnchorSeqLoaded = vi.fn(() => false);
        const targetWindow = createDeferred<{ status: 'loaded'; targetPresent: true }>();
        syncMockState.loadTargetWindowMessages
            .mockImplementationOnce(() => targetWindow.promise)
            .mockResolvedValue({ status: 'not_found', targetPresent: false });

        try {
            const hook = await renderHook(
                (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
                { initialProps: buildDeps(members) },
            );
            await vi.waitFor(() => {
                expect(syncMockState.loadTargetWindowMessages).toHaveBeenCalledTimes(1);
            });

            members.currentSessionIdRef.current = 's2';
            targetWindow.resolve({ status: 'loaded', targetPresent: true });
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(members.activeTargetWindowTargetRef.current).toBeNull();
            expect(executeViewportCommand).not.toHaveBeenCalled();
            expect(syncMockState.loadTargetWindowMessages).toHaveBeenCalledTimes(1);

            await hook.unmount();
        } finally {
            Object.defineProperty(Platform, 'OS', { value: originalPlatformOS, configurable: true });
        }
    });

    it('keeps distance-only bounded materialization on the sequential older-load path', async () => {
        const members = createStableMembers();
        const hook = await renderHook(
            (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
            { initialProps: buildDeps(members) },
        );
        const effects = createEntryRestoreOwner().attempt({
            canMaterializeOlder: true,
            contentHeight: 2400,
            currentSessionId: 's1',
            deadlineMs: 1500,
            exactAnchorIndex: null,
            fillSettled: true,
            items: [{ id: 'row-1' }],
            jumpToSeqActive: false,
            layoutHeight: 600,
            nearestAnchorIndex: null,
            nowMs: 1000,
            platform: 'native',
            restoredViewport: {
                anchor: null,
                offsetY: 3000,
                sessionId: 's1',
                shouldFollowBottom: false,
            },
            userScrollObserved: false,
        });

        hook.getCurrent().applyEntryRestoreOwnerEffects(effects);
        await vi.waitFor(() => {
            expect(members.loadOlder).toHaveBeenCalledTimes(1);
        });
        expect(members.recordRestoreDecisionTelemetry).toHaveBeenCalledWith(
            'not-ready',
            expect.any(Object),
        );
        expect(members.recordEntryOwnerOutcome).not.toHaveBeenCalled();
        expect(syncMockState.loadTargetWindowMessages).not.toHaveBeenCalled();

        await hook.unmount();
    });

    /**
     * This test reproduces the P2SMOKE2-P5 defect and pins the fix contract:
     *
     * When restoreWebViewportAnchorThroughViewportCommand returns not_found (hot-tail guard
     * fires on fresh mount with empty listData) AND the fallback offsetY target (26835 px)
     * is beyond the current maxScrollTop (scrollHeight=0 → maxScrollTop=0), the host MUST NOT
     * issue a viewport command. Writing scrollTop=0 via the unguarded path would close the
     * transaction with lastClosedSessionId set, permanently blocking future restore retries.
     *
     * After the guard is respected (scrollHeight grows to 46080 → maxScrollTop=45532 ≥ 26835),
     * the host MUST issue the fallback viewport command exactly once.
     */
    it('does not issue executeViewportCommand when fallback offsetY exceeds maxScrollTop, then does when content is rendered', async () => {
        // Simulate session entry viewport recorded with offsetY=26835 (jump-class anchor).
        const sessionEntryViewportRef: { current: SessionEntryViewportRefValue } = {
            current: {
                sessionId: 's1',
                entryKind: 'jump',
                shouldFollowBottom: false,
                offsetY: 26835,
                anchor: null,
                sourceLastUpdatedAt: 1000,
                effects: [],
            },
        };
        const executeViewportCommand = vi.fn(() => true);
        const resolveWebScrollMetrics = vi.fn(() => null as WebTranscriptScrollMetrics | null);

        const members = createStableMembers({
            executeViewportCommand,
            resolveWebScrollMetrics,
            sessionEntryViewportRef,
        });

        const hook = await renderHook(
            (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
            { initialProps: buildDeps(members) },
        );

        const { applyEntryRestoreOwnerEffects } = hook.getCurrent();

        // Build the execute-command effect as the owner would produce it on a
        // restore-web-anchor-through-command path (anchor at seq/index 38).
        const executeCommandEffect = {
            type: 'execute-command' as const,
            command: {
                type: 'restore-web-anchor-through-command' as const,
                anchor: {
                    kind: 'message' as const,
                    itemId: 'msg-38',
                    index: 38,
                    messageId: null,
                    itemOffsetPx: 0,
                    seq: 38,
                },
                itemIndex: 38,
                sessionId: 's1',
            },
        };

        const fakeElement = {} as HTMLElement;

        // PHASE 1: scrollHeight=0 (fresh mount, content not yet rendered).
        // maxScrollTop = max(0, 0 - 548) = 0 < fallbackDistancePx=26835 → guard blocks.
        resolveWebScrollMetrics.mockReturnValue({ element: fakeElement, scrollTop: 0, scrollHeight: 0, clientHeight: 548 });
        applyEntryRestoreOwnerEffects([executeCommandEffect]);

        expect(executeViewportCommand).not.toHaveBeenCalled();

        // PHASE 2: scrollHeight=46080 (content rendered past target depth).
        // maxScrollTop = max(0, 46080 - 548) = 45532 ≥ 26835 → guard passes.
        resolveWebScrollMetrics.mockReturnValue({ element: fakeElement, scrollTop: 0, scrollHeight: 46080, clientHeight: 548 });
        applyEntryRestoreOwnerEffects([executeCommandEffect]);

        expect(executeViewportCommand).toHaveBeenCalledTimes(1);

        await hook.unmount();
    });

    it('waits for renderer facts after scroll_requested instead of retrying on the former 300ms cadence or after unmount', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        vi.useFakeTimers();

        const anchor = {
            kind: 'message' as const,
            messageId: 'message-1',
            itemId: 'msg:message-1',
            itemOffsetPx: 95,
            capturedAtMs: 1000,
            seq: 10,
        };
        const items: readonly ChatTranscriptListItem[] = [{
            kind: 'message',
            id: anchor.itemId,
            messageId: anchor.messageId,
            createdAt: 1000,
            seq: anchor.seq,
        }];
        const createRetryHarness = async () => {
            const restoreWebViewportAnchorThroughViewportCommand = vi.fn(() => ({
                didAdjustScroll: false,
                status: 'scroll_requested' as const,
            }));
            const members = createStableMembers({
                items,
                restoreWebViewportAnchorThroughViewportCommand,
                sessionEntryViewportRef: {
                    current: {
                        sessionId: 's1',
                        entryKind: 'anchored',
                        shouldFollowBottom: false,
                        offsetY: 2520,
                        anchor,
                        sourceLastUpdatedAt: 1000,
                        effects: [],
                    },
                },
            });
            members.resolveEntryRestoreOwnerAnchor = vi.fn(() => anchor);
            members.resolveNearestSurvivingViewportAnchorIndexFromItems = vi.fn(() => 0);

            const hook = await renderHook(
                (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
                {
                    initialProps: buildDeps({
                        ...members,
                        decomposedItems: items,
                        listDataRef: { current: items },
                    }),
                },
            );
            return { hook, restoreWebViewportAnchorThroughViewportCommand };
        };

        try {
            const mounted = await createRetryHarness();
            expect(mounted.restoreWebViewportAnchorThroughViewportCommand).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(299);
            expect(mounted.restoreWebViewportAnchorThroughViewportCommand).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(mounted.restoreWebViewportAnchorThroughViewportCommand).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(600);
            expect(mounted.restoreWebViewportAnchorThroughViewportCommand).toHaveBeenCalledTimes(1);
            await mounted.hook.unmount();
            vi.clearAllTimers();

            const unmounted = await createRetryHarness();
            expect(unmounted.restoreWebViewportAnchorThroughViewportCommand).toHaveBeenCalledTimes(1);
            await unmounted.hook.unmount();

            await vi.advanceTimersByTimeAsync(300);
            expect(unmounted.restoreWebViewportAnchorThroughViewportCommand).toHaveBeenCalledTimes(1);
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
            Object.defineProperty(Platform, 'OS', { value: originalPlatformOS, configurable: true });
        }
    });

    it('does not replay an anchored web entry restore after an accepted scroll observation', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        const anchor = {
            kind: 'message' as const,
            messageId: 'message-1',
            itemId: 'msg:message-1',
            itemOffsetPx: 95,
            capturedAtMs: 1000,
            seq: 10,
        };
        const items: readonly ChatTranscriptListItem[] = [{
            kind: 'message',
            id: 'msg:message-1',
            messageId: 'message-1',
            createdAt: 1000,
            seq: 10,
        }];
        const restoreWebViewportAnchorThroughViewportCommand = vi.fn(() => ({
            didAdjustScroll: true,
            status: 'restored' as const,
            strategy: 'anchor' as const,
        }));
        const members = createStableMembers({
            items,
            lastScrollOffsetForIntentRef: { current: 10_472 },
            restoreWebViewportAnchorThroughViewportCommand,
            sessionEntryViewportRef: {
                current: {
                    sessionId: 's1',
                    entryKind: 'anchored',
                    shouldFollowBottom: false,
                    offsetY: 2520,
                    anchor,
                    sourceLastUpdatedAt: 1000,
                    effects: [],
                },
            },
        });
        members.resolveEntryRestoreOwnerAnchor = vi.fn(() => anchor);
        members.resolveNearestSurvivingViewportAnchorIndexFromItems = vi.fn(() => 0);
        members.isViewportAnchorSeqLoaded = vi.fn(() => true);

        try {
            const hook = await renderHook(
                (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
                { initialProps: buildDeps({
                    ...members,
                    decomposedItems: items,
                    listDataRef: { current: items },
                }) },
            );

            expect(restoreWebViewportAnchorThroughViewportCommand).not.toHaveBeenCalled();

            await hook.unmount();
        } finally {
            Object.defineProperty(Platform, 'OS', { value: originalPlatformOS, configurable: true });
        }
    });

    it('does not replay an anchored web entry restore after sync records a newer detached viewport', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        syncMockState.sessionViewport = {
            anchor: null,
            isPinned: false,
            lastUpdatedAt: 2000,
            offsetY: 2520,
            source: 'observed',
        };
        const anchor = {
            kind: 'message' as const,
            messageId: 'message-1',
            itemId: 'msg:message-1',
            itemOffsetPx: 95,
            capturedAtMs: 1000,
            seq: 10,
        };
        const items: readonly ChatTranscriptListItem[] = [{
            kind: 'message',
            id: 'msg:message-1',
            messageId: 'message-1',
            createdAt: 1000,
            seq: 10,
        }];
        const restoreWebViewportAnchorThroughViewportCommand = vi.fn(() => ({
            didAdjustScroll: true,
            status: 'restored' as const,
            strategy: 'anchor' as const,
        }));
        const members = createStableMembers({
            items,
            restoreWebViewportAnchorThroughViewportCommand,
            sessionEntryViewportRef: {
                current: {
                    sessionId: 's1',
                    entryKind: 'anchored',
                    shouldFollowBottom: false,
                    offsetY: 2520,
                    anchor,
                    sourceLastUpdatedAt: 1000,
                    effects: [],
                },
            },
        });
        members.resolveEntryRestoreOwnerAnchor = vi.fn(() => anchor);
        members.resolveNearestSurvivingViewportAnchorIndexFromItems = vi.fn(() => 0);
        members.isViewportAnchorSeqLoaded = vi.fn(() => true);

        try {
            const hook = await renderHook(
                (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
                { initialProps: buildDeps({
                    ...members,
                    decomposedItems: items,
                    listDataRef: { current: items },
                }) },
            );

            expect(restoreWebViewportAnchorThroughViewportCommand).not.toHaveBeenCalled();

            await hook.unmount();
        } finally {
            Object.defineProperty(Platform, 'OS', { value: originalPlatformOS, configurable: true });
        }
    });

    it('does not treat an idempotent session-entry viewport echo as post-entry user movement', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        syncMockState.sessionViewport = {
            anchor: {
                kind: 'message',
                itemId: 'msg:distance-sentinel',
                messageId: 'distance-sentinel',
                itemOffsetPx: 0,
                capturedAtMs: 1000,
                seq: 9,
            },
            isPinned: false,
            lastUpdatedAt: 2000,
            offsetY: 2520,
            source: 'observed',
        };
        const items: readonly ChatTranscriptListItem[] = [{
            kind: 'message',
            id: 'msg:distance-sentinel',
            messageId: 'distance-sentinel',
            createdAt: 1000,
            seq: 9,
        }];
        const fakeElement = {} as HTMLElement;
        const executeViewportCommand = vi.fn(() => true);
        const members = createStableMembers({
            executeViewportCommand,
            items,
            resolveWebScrollMetrics: vi.fn(() => ({
                clientHeight: 670,
                element: fakeElement,
                scrollHeight: 20_000,
                scrollTop: 16_810,
            })),
            sessionEntryViewportRef: {
                current: {
                    sessionId: 's1',
                    entryKind: 'anchored',
                    shouldFollowBottom: false,
                    offsetY: 2520,
                    anchor: {
                        kind: 'message',
                        itemId: 'msg:distance-sentinel',
                        messageId: 'distance-sentinel',
                        itemOffsetPx: 0,
                        capturedAtMs: 1000,
                    },
                    sourceLastUpdatedAt: 1000,
                    effects: [],
                },
            },
        });
        members.listContentHeightRef.current = 20_000;
        members.listLayoutHeightRef.current = 670;
        members.sessionOpenLatch.arm({
            entryKind: 'anchored',
            nativeFirstPaintFallbackDelayMs: 1000,
            nowMs: 1000,
            platform: 'web',
            sessionId: 's1',
            shouldFollowBottom: false,
        webOpenPhaseDeadlineDelayMs: 30_000,
        });
        members.sessionOpenLatch.onHostFacts({
            contentHeight: 20_000,
            isLoaded: true,
            isScrollable: true,
            itemCount: items.length,
            layoutHeight: 670,
            nowMs: 1000,
            sessionId: 's1',
        });

        try {
            const hook = await renderHook(
                (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
                {
                    initialProps: {
                        ...buildDeps(members),
                        committedMessagesCount: items.length,
                        displayItemsLength: items.length,
                        isLoaded: true,
                        listContentHeight: 20_000,
                        listDataLength: items.length,
                        listLayoutHeight: 670,
                    },
                },
            );

            expect(executeViewportCommand).toHaveBeenCalledTimes(1);

            await hook.unmount();
        } finally {
            Object.defineProperty(Platform, 'OS', { value: originalPlatformOS, configurable: true });
        }
    });


    it('preempts an open web entry transaction before correction writes after an accepted scroll observation', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        const entryRestoreOwner = createEntryRestoreOwner();
        const items: readonly ChatTranscriptListItem[] = [{
            kind: 'message',
            id: 'msg:distance-sentinel',
            messageId: 'distance-sentinel',
            createdAt: 1000,
            seq: 9,
        }];
        const openEffects = entryRestoreOwner.attempt<ChatTranscriptListItem>({
            canMaterializeOlder: false,
            contentHeight: 20_000,
            currentSessionId: 's1',
            deadlineMs: 1000,
            exactAnchorIndex: null,
            fillSettled: true,
            items,
            jumpToSeqActive: false,
            layoutHeight: 670,
            nearestAnchorIndex: null,
            nowMs: 1000,
            platform: 'web',
            restoredViewport: {
                anchor: null,
                offsetY: 2520,
                sessionId: 's1',
                shouldFollowBottom: false,
            },
            userScrollObserved: false,
        });
        expect(openEffects.some((effect) => effect.type === 'execute-command')).toBe(true);

        const executeViewportCommand = vi.fn(() => true);
        const fakeElement = {} as HTMLElement;
        const members = createStableMembers({
            entryRestoreOwner,
            executeViewportCommand,
            items,
            lastScrollOffsetForIntentRef: { current: 15_996 },
            resolveWebScrollMetrics: vi.fn(() => ({
                clientHeight: 670,
                element: fakeElement,
                scrollHeight: 20_544,
                scrollTop: 15_996,
            })),
            sessionEntryViewportRef: {
                current: {
                    sessionId: 's1',
                    entryKind: 'anchored',
                    shouldFollowBottom: false,
                    offsetY: 2520,
                    anchor: null,
                    sourceLastUpdatedAt: 1000,
                    effects: [],
                },
            },
        });

        try {
            const hook = await renderHook(
                (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
                { initialProps: buildDeps(members) },
            );

            expect(executeViewportCommand).not.toHaveBeenCalled();

            await hook.unmount();
        } finally {
            Object.defineProperty(Platform, 'OS', { value: originalPlatformOS, configurable: true });
        }
    });
});
