import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

import { useTranscriptMeasurementHostWiring } from '@/components/sessions/transcript/measurement/useTranscriptMeasurementHostWiring';
import { useTranscriptExpansionState } from '@/components/sessions/transcript/rowHost/useTranscriptExpansionState';
import { useNativeFactSource } from '@/components/sessions/transcript/viewport/driver/useNativeFactSource';
import { useTranscriptViewportCommandHostWiring } from '@/components/sessions/transcript/viewport/driver/useTranscriptViewportCommandHostWiring';
import type { TranscriptViewportDriverDeps } from '@/components/sessions/transcript/viewport/driver/types';
import { useTranscriptNativeEntryRestorePaintRelease } from '@/components/sessions/transcript/viewport/entryRestore/host/useTranscriptNativeEntryRestorePaintRelease';
import { useTranscriptSessionEntryLifecycle } from '@/components/sessions/transcript/viewport/entryRestore/host/useTranscriptSessionEntryLifecycle';
import { useTranscriptNativeMountSettleLifecycle } from '@/components/sessions/transcript/viewport/lifecycle/host/useTranscriptNativeMountSettleLifecycle';
import { useTranscriptNativeViewportLifecycle } from '@/components/sessions/transcript/viewport/lifecycle/host/useTranscriptNativeViewportLifecycle';
import { useMainTranscriptRendererFrameHost } from '@/components/sessions/transcript/viewport/shell/useMainTranscriptRendererFrameHost';
import { useTranscriptViewportTelemetryEvents } from '@/components/sessions/transcript/viewport/telemetryHost/useTranscriptViewportTelemetryEvents';
import { useTranscriptWebViewportTelemetryDiagnostics } from '@/components/sessions/transcript/viewport/telemetryHost/useTranscriptWebViewportTelemetryDiagnostics';

function createRef<T>(current: T): { current: T } {
    return { current };
}

describe('phase2 M10 hook identity stability', () => {
    it('keeps measurement host wiring callbacks stable across fresh params identities', async () => {
        const members = {
            getItemType: vi.fn(() => 'message:agent'),
            listData: [],
            listDataRef: createRef([]),
            listLayoutHeightRef: createRef(0),
            listRef: createRef(null),
            recordViewportTelemetryEvent: vi.fn(),
            resolveViewportTelemetryMode: vi.fn(() => 'follow-bottom'),
            sessionId: 's1',
        };
        const buildParams = () => ({ ...members }) as unknown as Parameters<typeof useTranscriptMeasurementHostWiring>[0];
        const hook = await renderHook(
            (params: Parameters<typeof useTranscriptMeasurementHostWiring>[0]) =>
                useTranscriptMeasurementHostWiring(params),
            { initialProps: buildParams() },
        );
        const first = hook.getCurrent();

        await hook.rerender(buildParams());
        const second = hook.getCurrent();

        expect(second.handleRowShellMeasured).toBe(first.handleRowShellMeasured);

        await hook.unmount();
    });

    it('keeps expansion callbacks stable when expansion state is unchanged', async () => {
        const members = {
            recordLocalTranscriptInteractionIntent: vi.fn(),
            prepareLocalHeightChange: vi.fn(() => 'none' as const),
        };
        const buildParams = () => ({ ...members });
        const hook = await renderHook(
            (params: Parameters<typeof useTranscriptExpansionState>[0]) =>
                useTranscriptExpansionState(params),
            { initialProps: buildParams() },
        );
        const first = hook.getCurrent();

        await hook.rerender(buildParams());
        const second = hook.getCurrent();

        expect(second.applyToolCallsGroupExpanded).toBe(first.applyToolCallsGroupExpanded);
        expect(second.resolveThinkingExpanded).toBe(first.resolveThinkingExpanded);
        expect(second.setThinkingExpanded).toBe(first.setThinkingExpanded);
        expect(second.setToolCallsGroupExpanded).toBe(first.setToolCallsGroupExpanded);

        await hook.unmount();
    });

    it('keeps native fact readers stable across fresh params identities', async () => {
        const members = {
            canonicalWindowedItemsRef: createRef([]),
            listContentHeightRef: createRef(1200),
            listDataRef: createRef([]),
            listLayoutHeightRef: createRef(600),
            listRef: createRef(null),
            platformOS: 'web',
            renderWindowIndexMapRef: createRef(null),
        };
        const buildParams = () => ({ ...members }) as Parameters<typeof useNativeFactSource>[0];
        const hook = await renderHook(
            (params: Parameters<typeof useNativeFactSource>[0]) =>
                useNativeFactSource(params),
            { initialProps: buildParams() },
        );
        const first = hook.getCurrent();

        await hook.rerender(buildParams());
        const second = hook.getCurrent();

        expect(second.readCurrentNativeDistanceFromBottom).toBe(first.readCurrentNativeDistanceFromBottom);
        expect(second.readViewportContentMetrics).toBe(first.readViewportContentMetrics);
        expect(second.readViewportVisibleSourceRange).toBe(first.readViewportVisibleSourceRange);
        expect(second.resolveNativeObservedScrollOffset).toBe(first.resolveNativeObservedScrollOffset);
        expect(second.resolveViewportReachedEdge).toBe(first.resolveViewportReachedEdge);

        await hook.unmount();
    });

    it('keeps viewport command host callbacks stable across fresh params identities', async () => {
        const commandHostRef = createRef(null);
        const controller = {
            activeOwner: vi.fn(() => 'follow'),
            closeTransaction: vi.fn(),
            openTransaction: vi.fn(),
            resetForSession: vi.fn(),
            setActive: vi.fn(),
            setCurrentSessionId: vi.fn(),
        };
        const driverDeps = {} as unknown as TranscriptViewportDriverDeps;
        const members = {
            commandHostRef,
            driverDeps,
            platformOS: 'native',
            sessionId: 's1',
            viewportCommandController: controller,
        } as unknown as Parameters<typeof useTranscriptViewportCommandHostWiring>[0];
        const buildParams = () => ({ ...members });
        const hook = await renderHook(
            (params: Parameters<typeof useTranscriptViewportCommandHostWiring>[0]) =>
                useTranscriptViewportCommandHostWiring(params),
            { initialProps: buildParams() },
        );
        const first = hook.getCurrent();

        await hook.rerender(buildParams());
        const second = hook.getCurrent();

        expect(second.executeViewportCommand).toBe(first.executeViewportCommand);
        expect(second.executeViewportCommandWithAnimation).toBe(first.executeViewportCommandWithAnimation);
        expect(second.resolveViewportCommand).toBe(first.resolveViewportCommand);
        expect(second.restoreWebViewportAnchorThroughViewportCommand).toBe(first.restoreWebViewportAnchorThroughViewportCommand);

        await hook.unmount();
    });

    it('keeps native entry paint release callbacks stable across fresh params identities', async () => {
        const members = {
            currentSessionIdRef: createRef('s1'),
            entryRestoreOwner: {
                hasOpenTransaction: vi.fn(() => false),
                matchesNativePaintReleaseHandle: vi.fn(() => false),
                nativePaintReleaseHandle: vi.fn(() => null),
            },
            nativeEntryRestorePaintReleaseTimeoutRef: createRef(null),
            nativeViewportPaintObservedRef: createRef(false),
            platformOS: 'ios',
            readViewportContentMetrics: vi.fn(() => ({ contentHeight: 1200, layoutHeight: 600 })),
            sessionActive: true,
            sessionEntryViewportRef: createRef(null),
            sessionId: 's1',
        } as unknown as Parameters<typeof useTranscriptNativeEntryRestorePaintRelease>[0];
        const buildParams = () => ({ ...members });
        const hook = await renderHook(
            (params: Parameters<typeof useTranscriptNativeEntryRestorePaintRelease>[0]) =>
                useTranscriptNativeEntryRestorePaintRelease(params),
            { initialProps: buildParams() },
        );
        const first = hook.getCurrent();

        await hook.rerender(buildParams());
        const second = hook.getCurrent();

        expect(second.releaseNativePaintForIssuedEntryRestore).toBe(first.releaseNativePaintForIssuedEntryRestore);
        expect(second.scheduleNativePaintReleaseForEntryRestore).toBe(first.scheduleNativePaintReleaseForEntryRestore);
        expect(second.updateNativeEntryRestorePaintReleased).toBe(first.updateNativeEntryRestorePaintReleased);

        await hook.unmount();
    });

    it('keeps session-entry lifecycle callbacks stable across fresh deps identities', async () => {
        const lifecycleHost = {
            clearNativeExplicitJumpConfirmation: vi.fn(),
            enterSession: vi.fn(() => ({
                renderResetEffects: {
                    commandControllerReset: { openEntryTransaction: false },
                    measurementReset: { sessionId: 's1' },
                    nativeEntrySettleReset: { sessionId: 's1', shouldArmConfirmation: false },
                    nativeExplicitJumpReset: { sessionId: 's1' },
                    nativeSessionViewportReset: { sessionId: 's1' },
                    platform: 'web',
                },
                state: { bottomFollowState: { dragSession: null, mode: 'following' } },
                viewportEffects: [],
            })),
            resetNativeEntrySettleConfirmation: vi.fn(),
        };
        const sessionOpenLatch = {
            arm: vi.fn(() => ({ effects: [] })),
            onHostFacts: vi.fn(() => ({ effects: [] })),
        };
        const members = {
            anchorLookupExhaustedRef: createRef(false),
            anchorLookupInFlightRef: createRef(false),
            anchorLookupLoadCountRef: createRef(0),
            applyEntryRestoreOwnerEffectsRef: createRef(vi.fn()),
            applySessionOpenLatchEffectsRef: createRef(vi.fn()),
            closeEntryViewportOwnership: vi.fn(),
            commitBottomFollowModeState: vi.fn(),
            commitJumpToBottomDistanceForVisibility: vi.fn(),
            commitScrollPinState: vi.fn(),
            consumedSessionEntryViewportRef: createRef(null),
            disposeEntryRestoreTransactionForExitRef: createRef(vi.fn()),
            emitViewportChange: vi.fn(() => true),
            entryRestoreDeadlineTimeoutRef: createRef(null),
            entryRestoreOwner: { resetForSession: vi.fn(() => []) },
            flushViewportAnchorCaptureRef: createRef(vi.fn()),
            getItemCount: vi.fn(() => 0),
            hideOlderLoadSpinner: vi.fn(),
            initialFillAbortRef: createRef(null),
            invalidateNativePrependOwner: vi.fn(),
            invalidateViewportAnchorCapture: vi.fn(),
            isLoaded: true,
            isPinnedRef: createRef(true),
            jumpToSeq: null,
            lastExplicitWebScrollIntentAtMsRef: createRef(Number.NEGATIVE_INFINITY),
            lastNativeRestoreIndexCommandRef: createRef(null),
            lastPinOffsetForIntentRef: createRef(null),
            lastRouteJumpProtectionClearingWebMovementAtMsRef: createRef(Number.NEGATIVE_INFINITY),
            lastScrollOffsetForIntentRef: createRef(null),
            lastUserScrollIntentAtMsRef: createRef(Number.NEGATIVE_INFINITY),
            lifecycleHost,
            listContentHeightRef: createRef(0),
            listLayoutHeightRef: createRef(0),
            measurementHost: { resetForSession: vi.fn() },
            nativeBottomFollowRearmedAfterDragRef: createRef(false),
            nativeEntryRestorePaintReleaseTimeoutRef: createRef(null),
            nativeFirstPaintFallbackReleaseTimeoutRef: createRef(null),
            nativeMomentumScrollActiveRef: createRef(false),
            resetNativeMountSettleFlagsForSessionEntry: vi.fn(),
            resetNativeSessionViewportLifecycle: vi.fn(),
            resetOlderPaginationForSessionEntry: vi.fn(),
            resetViewportAnchorCaptureForSessionEntry: vi.fn(),
            sameSessionHandoffClaimedViewportRef: createRef(null),
            sameSessionHandoffViewportForRender: null,
            sessionEntryViewportRef: createRef(null),
            sessionId: 's1',
            sessionOpenLatch,
            setExpandedToolCallsAnchorMessageIds: vi.fn(),
            setListContentHeight: vi.fn(),
            viewportCommandController: { resetForSession: vi.fn() },
            wantsPinnedRef: createRef(true),
            webDomObservation: { reset: vi.fn() },
        } as unknown as Parameters<typeof useTranscriptSessionEntryLifecycle>[0];
        const buildParams = () => ({ ...members });
        const hook = await renderHook(
            (params: Parameters<typeof useTranscriptSessionEntryLifecycle>[0]) =>
                useTranscriptSessionEntryLifecycle(params),
            { initialProps: buildParams() },
        );
        const first = hook.getCurrent();

        await hook.rerender(buildParams());
        const second = hook.getCurrent();

        expect(second.applySessionEntryViewportApplyEffects).toBe(first.applySessionEntryViewportApplyEffects);
        expect(second.applySessionOpenArmResetPlan).toBe(first.applySessionOpenArmResetPlan);
        expect(second.applySessionOpenDisposeResetPlan).toBe(first.applySessionOpenDisposeResetPlan);

        await hook.unmount();
    });

    it('keeps native mount-settle lifecycle callbacks stable across fresh params identities', async () => {
        const members = {
            closeEntryViewportOwnership: vi.fn(),
            composerInsetHeightRef: createRef(0),
            jumpToSeqActive: false,
            lastPinOffsetForIntentRef: createRef(null),
            lifecycleHost: {
                observeMountSettleMetrics: vi.fn(),
                recordMountSettleLayoutCommitObserved: vi.fn(),
            },
            listContentHeightRef: createRef(0),
            listLayoutHeightRef: createRef(0),
            nativeMountSettleDeadlineReachedRef: createRef(false),
            platformOS: 'web',
            scheduleNativePaintReleaseForEntryRestore: vi.fn(),
            sessionId: 's1',
            sessionOpenLatch: { initialFillStatus: vi.fn(() => 'done') },
            setNativeMountSettleDeadlineReached: vi.fn(),
            setNativeMountSettleStable: vi.fn(),
        } as unknown as Parameters<typeof useTranscriptNativeMountSettleLifecycle>[0];
        const buildParams = () => ({ ...members });
        const hook = await renderHook(
            (params: Parameters<typeof useTranscriptNativeMountSettleLifecycle>[0]) =>
                useTranscriptNativeMountSettleLifecycle(params),
            { initialProps: buildParams() },
        );
        const first = hook.getCurrent();

        await hook.rerender(buildParams());
        const second = hook.getCurrent();

        expect(second.observeMountSettleMetrics).toBe(first.observeMountSettleMetrics);
        expect(second.recordLayoutCommitObserved).toBe(first.recordLayoutCommitObserved);
        expect(second.shouldCommitContentHeightState).toBe(first.shouldCommitContentHeightState);

        await hook.unmount();
    });

    it('keeps native viewport lifecycle callbacks stable across fresh params identities', async () => {
        const members = {
            closeEntryViewportOwnership: vi.fn(),
            consumedSessionEntryViewportRef: createRef(null),
            entryRestoreOwner: { hasOpenTransaction: vi.fn(() => false) },
            lifecycleHost: {
                armNativeEntrySettleConfirmation: vi.fn(),
                planNativeUserScrollTakeover: vi.fn(() => ({
                    nativeUserScrollTakeoverEffects: [],
                })),
            },
            lastUserScrollIntentAtMsRef: createRef(Number.NEGATIVE_INFINITY),
            measurementHost: { hasNativeContentMeasurementForSession: vi.fn(() => false) },
            nativeInitialViewportPendingObservationRef: createRef(false),
            platformOS: 'web',
            preemptEntryRestoreTransaction: vi.fn(),
            sessionEntryViewportRef: createRef(null),
            sessionId: 's1',
            sessionOpenLatch: {
                hasNativeInitialViewportApplied: vi.fn(() => false),
                markNativeInitialViewportApplied: vi.fn(() => ({ wasApplied: false })),
                resetNativeInitialViewport: vi.fn(),
            },
            setNativeInitialViewportPendingObservation: vi.fn(),
        } as unknown as Parameters<typeof useTranscriptNativeViewportLifecycle>[0];
        const buildParams = () => ({ ...members });
        const hook = await renderHook(
            (params: Parameters<typeof useTranscriptNativeViewportLifecycle>[0]) =>
                useTranscriptNativeViewportLifecycle(params),
            { initialProps: buildParams() },
        );
        const first = hook.getCurrent();

        await hook.rerender(buildParams());
        const second = hook.getCurrent();

        expect(second.applyNativeBottomFollowCompletionHostEffects).toBe(first.applyNativeBottomFollowCompletionHostEffects);
        expect(second.applyNativeUserScrollTakeoverHostEffects).toBe(first.applyNativeUserScrollTakeoverHostEffects);
        expect(second.hasNativeContentMeasurementForCurrentSession).toBe(first.hasNativeContentMeasurementForCurrentSession);
        expect(second.hasNativeInitialViewportAppliedForCurrentSession).toBe(first.hasNativeInitialViewportAppliedForCurrentSession);
        expect(second.markNativeInitialViewportAppliedForCurrentSession).toBe(first.markNativeInitialViewportAppliedForCurrentSession);
        expect(second.recordNativeUserScrollIntent).toBe(first.recordNativeUserScrollIntent);
        expect(second.resetNativeSessionViewportLifecycle).toBe(first.resetNativeSessionViewportLifecycle);
        expect(second.shouldIgnoreNativeInvalidScrollObservation).toBe(first.shouldIgnoreNativeInvalidScrollObservation);
        expect(second.updateNativeInitialViewportPendingObservation).toBe(first.updateNativeInitialViewportPendingObservation);

        await hook.unmount();
    });

    it('keeps main transcript renderer frame stable across fresh params identities', async () => {
        const members = {
            chatListNativeId: 'chat-list:s1',
            layoutHeight: 600,
            pinThresholdPx: 72,
            platformOS: 'web',
            sessionEntryShouldFollowBottom: true,
        } as unknown as Parameters<typeof useMainTranscriptRendererFrameHost>[0];
        const buildParams = () => ({ ...members });
        const hook = await renderHook(
            (params: Parameters<typeof useMainTranscriptRendererFrameHost>[0]) =>
                useMainTranscriptRendererFrameHost(params),
            { initialProps: buildParams() },
        );
        const first = hook.getCurrent();

        await hook.rerender(buildParams());
        const second = hook.getCurrent();

        expect(second).toBe(first);

        await hook.unmount();
    });

    it('keeps viewport telemetry callbacks stable across fresh deps identities', async () => {
        const members = {
            applyBlankRecoveryEffects: vi.fn(),
            bottomFollowModeStateRef: createRef({ dragSession: null, mode: 'following' }),
            entryRestoreOwner: { telemetryState: vi.fn(() => 'none') },
            getBottomFollowGestureActiveRef: createRef(() => false),
            itemsRef: createRef([]),
            lastNativeVisibleRowsSnapshotRef: createRef(null),
            listContentHeightRef: createRef(0),
            listDataRef: createRef([]),
            listLayoutHeightRef: createRef(0),
            listOrientation: 'normal',
            listRef: createRef(null),
            nativeMomentumScrollActiveRef: createRef(false),
            nativePrependTelemetryStateRef: createRef(() => 'none'),
            nativeVisibleWindowSnapshotRef: createRef(null),
            platformOS: 'web',
            readViewportVisibleSourceRange: vi.fn(() => null),
            resolveNativeObservedScrollOffset: vi.fn(() => null),
            resolveWebScrollMetrics: vi.fn(() => null),
            resolveWebViewportTelemetryDiagnostics: vi.fn(() => ({})),
            runtimeAnchorsRef: createRef([]),
            sessionId: 's1',
            wantsPinnedRef: createRef(true),
        } as unknown as Parameters<typeof useTranscriptViewportTelemetryEvents>[0];
        const buildParams = () => ({ ...members });
        const hook = await renderHook(
            (params: Parameters<typeof useTranscriptViewportTelemetryEvents>[0]) =>
                useTranscriptViewportTelemetryEvents(params),
            { initialProps: buildParams() },
        );
        const first = hook.getCurrent();

        await hook.rerender(buildParams());
        const second = hook.getCurrent();

        expect(second.handleNativeViewableItemsChanged).toBe(first.handleNativeViewableItemsChanged);
        expect(second.observeNativeBlankRecovery).toBe(first.observeNativeBlankRecovery);
        expect(second.recordNativeVisibleWindowTelemetry).toBe(first.recordNativeVisibleWindowTelemetry);
        expect(second.recordRestoreDecisionTelemetry).toBe(first.recordRestoreDecisionTelemetry);
        expect(second.recordScrollObservedTelemetry).toBe(first.recordScrollObservedTelemetry);
        expect(second.recordViewportTelemetryEvent).toBe(first.recordViewportTelemetryEvent);
        expect(second.resolveNativeTelemetryDiagnostics).toBe(first.resolveNativeTelemetryDiagnostics);
        expect(second.resolveNativeVisibleWindowSnapshot).toBe(first.resolveNativeVisibleWindowSnapshot);
        expect(second.resolveViewportTelemetryMode).toBe(first.resolveViewportTelemetryMode);
        expect(second.nativeViewabilityConfig).toBe(first.nativeViewabilityConfig);

        await hook.unmount();
    });

    it('keeps web viewport diagnostics callbacks stable across fresh params identities', async () => {
        const members = {
            chatListNativeId: 'chat-list:s1',
            listContentHeightRef: createRef(0),
            listLayoutHeightRef: createRef(0),
            olderPaginationSnapshotRef: createRef({ phase: 'idle', suspendedReasons: [] }),
            transcriptNavigationRuntimeAnchorsRef: createRef([]),
            webScrollContainerRef: createRef(null),
        } as unknown as Parameters<typeof useTranscriptWebViewportTelemetryDiagnostics>[0];
        const buildParams = () => ({ ...members });
        const hook = await renderHook(
            (params: Parameters<typeof useTranscriptWebViewportTelemetryDiagnostics>[0]) =>
                useTranscriptWebViewportTelemetryDiagnostics(params),
            { initialProps: buildParams() },
        );
        const first = hook.getCurrent();

        await hook.rerender(buildParams());
        const second = hook.getCurrent();

        expect(second.resolveWebScrollMetrics).toBe(first.resolveWebScrollMetrics);
        expect(second.resolveWebViewportTelemetryDiagnostics).toBe(first.resolveWebViewportTelemetryDiagnostics);

        await hook.unmount();
    });
});
