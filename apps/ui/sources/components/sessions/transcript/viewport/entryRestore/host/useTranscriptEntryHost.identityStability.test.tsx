import * as TranscriptTestReact from 'react';
import { createTestSessionTranscriptSource as createHostTestSource, wrapWithSessionTranscriptSource as wrapHostTestSource } from '@/dev/testkit';
import { sync as transcriptHistorySync } from '@/sync/sync';

const transcriptHostTestSource = createHostTestSource({ sessionId: 's1', history: {
    loadOlder: (options) => transcriptHistorySync.loadOlderMessages('s1', options),
    loadTargetWindow: (target, options) => transcriptHistorySync.loadTargetWindowMessages('s1', target, options),
} });
function TranscriptHostTestProvider(props: TranscriptTestReact.PropsWithChildren) {
    return wrapHostTestSource(props.children as TranscriptTestReact.ReactElement, transcriptHostTestSource);
}

/**
 * Identity-stability contract for the extracted entry host (M4 extraction regression guard).
 *
 * ChatList rebuilds the deps object literal passed to `useTranscriptEntryHost` on EVERY render.
 * The hook's internal callbacks must therefore depend on individual `deps.*` fields — never on
 * the whole `deps` object — or `runEntryRestoreAttempt` (and the layout effect keyed on it)
 * re-fires on every render. That instability was introduced by the M4 extraction (`deps` in
 * useCallback dependency arrays) and is what this test pins: with unchanged field values but a
 * fresh deps object identity per render, every returned host function must stay referentially
 * stable.
 */
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

import { createEntryRestoreOwner } from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreOwner';
import { createSessionOpenLatch } from '@/components/sessions/transcript/viewport/sessionOpen/sessionOpenLatch';
import { resolveTranscriptRenderWindowProjection } from '@/components/sessions/transcript/viewport/window/resolveTranscriptRenderWindowProjection';
import { createTranscriptWindowGapItem } from '@/components/sessions/transcript/viewport/window/transcriptWindowGapItem';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';
import { useTranscriptEntryHost } from './useTranscriptEntryHost';
import { createTranscriptUserScrollIntentOwner } from '@/components/sessions/transcript/viewport/driver/userScrollIntentOwner';

vi.mock('@/sync/sync', () => ({
    sync: {
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

function createStableMembers() {
    const items: readonly ChatTranscriptListItem[] = [];
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
        entryRestoreOwner: createEntryRestoreOwner(),
        executeViewportCommand: vi.fn(() => true),
        hasNativeContentMeasurementForCurrentSession: vi.fn(() => false),
        initialFillAbortRef: { current: null },
        invalidateViewportAnchorCapture: vi.fn(),
        isScrollable: vi.fn(() => false),
        isViewportAnchorSeqLoaded: vi.fn(() => false),
        isViewportNearOlderEdge: vi.fn(() => false),
        lastScrollOffsetForIntentRef: { current: null },
        lastUserScrollIntentAtMsRef: { current: Number.NEGATIVE_INFINITY },
        userScrollIntent: createTranscriptUserScrollIntentOwner(),
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
        resolveEntryRestoreOwnerAnchor: vi.fn(() => null),
        resolveNearestSurvivingViewportAnchorIndex: vi.fn(() => null),
        resolveNearestSurvivingViewportAnchorIndexFromItems: vi.fn(() => null),
        resolveSeqForViewportAnchor: vi.fn(() => null),
        resolveViewportCommand: vi.fn(() => ({
            kind: 'none' as const,
            sessionId: 's1',
            reason: 'test',
            mode: 'hydrating' as const,
        })),
        resolveWebScrollMetrics: vi.fn(() => null),
        restoreWebViewportAnchorThroughViewportCommand: vi.fn(() => ({
            didAdjustScroll: false,
            status: 'not_found' as const,
        })),
        scheduleNativePaintReleaseForEntryRestore: vi.fn(),
        sessionEntryViewportRef: { current: null },
        sessionOpenLatch: createSessionOpenLatch(),
        setNativeMountSettleDeadlineReached: vi.fn(),
        updateNativeInitialViewportPendingObservation: vi.fn(),
        updateNativeViewportPaintObserved: vi.fn(),
        wantsPinnedRef: { current: true },
    };
}

/** Fresh object identity per call — exactly how ChatList passes the deps literal. */
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

describe('useTranscriptEntryHost identity stability', () => {
    it('keeps host callbacks referentially stable across re-renders with fresh deps object identities', async () => {
        const members = createStableMembers();
        const hook = await renderHook(
            (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
            { wrapper: TranscriptHostTestProvider, initialProps: buildDeps(members) },
        );

        const first = hook.getCurrent();
        const firstAttempt = members.attemptEntryRestoreRef.current;

        // Two consecutive re-renders, each with a brand-new deps object built from the
        // same underlying members — mirrors ChatList re-rendering without input changes.
        await hook.rerender(buildDeps(members));
        await hook.rerender(buildDeps(members));

        const second = hook.getCurrent();
        expect(second.runEntryRestoreAttempt).toBe(first.runEntryRestoreAttempt);
        expect(second.applyEntryRestoreOwnerEffects).toBe(first.applyEntryRestoreOwnerEffects);
        expect(second.verifyWebEntryRestoreTransaction).toBe(first.verifyWebEntryRestoreTransaction);
        expect(second.observeNativeEntryRestoreHostFacts).toBe(first.observeNativeEntryRestoreHostFacts);
        expect(second.disposeEntryRestoreTransactionForExit).toBe(first.disposeEntryRestoreTransactionForExit);
        // The ref the prepend/materialization paths call back into must also stay pinned
        // to the same stable callback.
        expect(members.attemptEntryRestoreRef.current).toBe(firstAttempt);

        await hook.unmount();
    });
});

describe('useTranscriptEntryHost session-open reset plans', () => {
    it('applies the real latch arm and dispose reset plans once through the committed effects ref', async () => {
        // The session-entry resets have one owner: the latch's arm/dispose plans, applied by the
        // entry host. The lifecycle arms the latch and hands its effects to this committed ref.
        const members = createStableMembers();
        const hook = await renderHook(
            (deps: EntryHostDeps) => useTranscriptEntryHost(deps),
            { wrapper: TranscriptHostTestProvider, initialProps: buildDeps(members) },
        );
        // The fixture's ref is widened to a no-argument callback; read it through the host's own type.
        const applyLatchEffectsRef: EntryHostDeps['applySessionOpenLatchEffectsRef'] = members.applySessionOpenLatchEffectsRef;
        const arm = (sessionId: string) => applyLatchEffectsRef.current(
            members.sessionOpenLatch.arm({
                entryKind: 'bottom',
                nativeFirstPaintFallbackDelayMs: 450,
                nowMs: 1_000,
                platform: 'web',
                sessionId,
                shouldFollowBottom: true,
                webOpenPhaseDeadlineDelayMs: 30_000,
            }).effects,
        );

        arm('s1');
        expect(members.applySessionOpenArmResetPlan).toHaveBeenCalledTimes(1);
        expect(members.applySessionOpenArmResetPlan).toHaveBeenLastCalledWith({
            entryKind: 'bottom',
            sessionId: 's1',
            shouldFollowBottom: true,
        });
        expect(members.applySessionOpenDisposeResetPlan).not.toHaveBeenCalled();

        // Re-arming the same open (a re-render) applies no second reset.
        arm('s1');
        expect(members.applySessionOpenArmResetPlan).toHaveBeenCalledTimes(1);

        // A session switch disposes the previous session before arming the next one.
        arm('s2');
        expect(members.applySessionOpenDisposeResetPlan).toHaveBeenCalledTimes(1);
        expect(members.applySessionOpenDisposeResetPlan).toHaveBeenLastCalledWith({
            reason: 'session-switch',
            sessionId: 's1',
        });
        expect(members.applySessionOpenArmResetPlan).toHaveBeenCalledTimes(2);
        expect(members.applySessionOpenArmResetPlan).toHaveBeenLastCalledWith({
            entryKind: 'bottom',
            sessionId: 's2',
            shouldFollowBottom: true,
        });
        expect(members.applySessionOpenDisposeResetPlan.mock.invocationCallOrder[0])
            .toBeLessThan(members.applySessionOpenArmResetPlan.mock.invocationCallOrder[1]);

        await hook.unmount();
    });
});
