import * as React from 'react';
import {
    getStorage,
    useSetting,
} from '@/sync/domains/state/storage';
import { Dimensions, Platform, View } from 'react-native';
import { useCallback } from 'react';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { sync, type SessionViewportAnchorSnapshot } from '@/sync/sync';
import { useSessionCatchingUpNewer, useSessionTailContiguousFloorSeq } from '@/sync/store/hooks';
import { useSessionScreenIsFocused } from '@/components/sessions/shell/useSessionScreenIsFocused';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useTranscriptMotionConfig } from '@/components/sessions/transcript/motion/useTranscriptMotionConfig';
import { TranscriptMotionProvider } from '@/components/sessions/transcript/motion/TranscriptMotionProvider';
import { InitialPresentationReadinessProvider } from '@/components/ui/presentation/InitialPresentationReadinessContext';
import {
    createInitialRichContentPresentationController,
    type InitialRichContentPresentationController,
} from '@/components/sessions/transcript/paint/initialRichContentPresentation';
import {
    type TranscriptViewportTelemetryEvent,
    type TranscriptViewportTelemetryObservationReason,
    type TranscriptViewportTelemetryScrollReason,
    type TranscriptViewportTelemetryTransactionState,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import {
    type NativeVisibleWindowSnapshot,
} from '@/components/sessions/transcript/viewport/telemetryHost/nativeVisibleWindow';
import { useTranscriptTelemetryHost } from '@/components/sessions/transcript/viewport/telemetryHost/useTranscriptTelemetryHost';
import { useTranscriptViewportTelemetryEvents } from '@/components/sessions/transcript/viewport/telemetryHost/useTranscriptViewportTelemetryEvents';
import { useTranscriptPaintTelemetry, useTranscriptPaintTelemetryEffects } from '@/components/sessions/transcript/viewport/telemetryHost/paintTelemetry';
import { useTranscriptWebViewportTelemetryDiagnostics } from '@/components/sessions/transcript/viewport/telemetryHost/useTranscriptWebViewportTelemetryDiagnostics';
import {
    createTranscriptViewportCommandController,
    type TranscriptViewportCommandController,
} from '@/components/sessions/transcript/viewport/createTranscriptViewportCommandController';
import {
    createTranscriptViewportLifecycle,
    type TranscriptViewportLifecycle,
    type TranscriptViewportLifecycleEvent,
} from '@/components/sessions/transcript/viewport/lifecycle/lifecycle';
import {
    createTranscriptLifecycleHost,
    type TranscriptLifecycleHost,
    type TranscriptLifecycleHostExplicitJumpPlan,
    type TranscriptLifecycleHostFollowBottomIntentPlan,
    type TranscriptLifecycleHostSessionEntryPlan,
    type NativeExplicitJumpConfirmationEffect,
} from '@/components/sessions/transcript/viewport/lifecycle/lifecycleHost';
import { useTranscriptNativeViewportLifecycle } from '@/components/sessions/transcript/viewport/lifecycle/host/useTranscriptNativeViewportLifecycle';
import { useTranscriptNativeMountSettleLifecycle } from '@/components/sessions/transcript/viewport/lifecycle/host/useTranscriptNativeMountSettleLifecycle';
import type {
    BottomFollowAutomaticWriter,
} from '@/components/sessions/transcript/viewport/bottomFollow/writeScheduler';
import {
    type NativeDragActiveMirrorApplyEffect,
} from '@/components/sessions/transcript/viewport/lifecycle/nativeActiveMirror';
import {
    type TranscriptViewportTransactionOutcome,
} from '@/components/sessions/transcript/viewport/transcriptViewportOwnership';
import type {
    TranscriptViewportAnchorIdentity,
    TranscriptViewportCommand,
    TranscriptViewportMode,
} from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import { useNativeFactSource } from '@/components/sessions/transcript/viewport/driver/useNativeFactSource';
import {
    type TranscriptViewportCommandHost,
} from '@/components/sessions/transcript/viewport/driver/commandHost';
import { useTranscriptViewportCommandHostWiring } from '@/components/sessions/transcript/viewport/driver/useTranscriptViewportCommandHostWiring';
import type { TranscriptViewportDriverDeps } from '@/components/sessions/transcript/viewport/driver/types';
import {
    createSessionOpenLatch,
    type SessionOpenLatch,
} from '@/components/sessions/transcript/viewport/sessionOpen/sessionOpenLatch';
import type {
    SessionOpenEntryKind,
    SessionOpenLatchEffect,
} from '@/components/sessions/transcript/viewport/sessionOpen/types';
import { resolveSessionEntryViewportState } from '@/components/sessions/transcript/scroll/resolveSessionEntryBottomFollow';
import type { LastNativeRestoreIndexCommand, ScrollableChatListRef } from '@/components/sessions/transcript/viewport/transcriptScrollableListTypes';
import { createWebDomScrollObservation, type WebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import {
    createTranscriptUserScrollIntentOwner,
    type TranscriptUserScrollIntentOwner,
} from '@/components/sessions/transcript/viewport/driver/userScrollIntentOwner';
import {
    resolveTranscriptScrollPinStateUpdate,
    type TranscriptBottomFollowModeState,
    type TranscriptScrollPinEvent,
    type TranscriptScrollPinState,
} from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';
import { useMainTranscriptRendererFrameHost } from '@/components/sessions/transcript/viewport/shell/useMainTranscriptRendererFrameHost';
import {
    resolveTranscriptListPresentation,
    type TranscriptListOrientation,
} from '@/components/sessions/transcript/listOrientation';
import {
    resolveTranscriptEdgePrefetchThresholdPx,
    TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO,
    TRANSCRIPT_EDGE_PREFETCH_MAX_PX,
    TRANSCRIPT_EDGE_PREFETCH_MIN_PX,
} from '@/components/sessions/transcript/scroll/resolveTranscriptEdgePrefetchThresholdPx';
import { buildChatListNativeId } from './chatListNativeId';
import { requestSessionOpenInitialFill } from '@/components/sessions/transcript/useChatListRootState';
import type {
    ChatListInternalProps,
    ChatTranscriptListItem,
    PendingJumpSeqViewportPromotion,
    PromotedJumpSeqViewportProtection,
    TranscriptViewportChangeState,
} from '@/components/sessions/transcript/chatListTypes';
import {
    useOptionalTranscriptSelectionState,
} from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';
import {
    isWebTranscriptScrollable,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import type {
    TranscriptJumpTarget,
    TranscriptJumpTargetRole,
} from '@/components/sessions/transcript/viewport/jump/transcriptJumpTargetTypes';
import {
    type TranscriptRendererDataTarget,
    type TranscriptRenderWindowProjection,
} from '@/components/sessions/transcript/viewport/window/resolveTranscriptRenderWindowProjection';
import {
    clearStreamingSessionUiTelemetryMarks,
} from '@/sync/runtime/performance/sessionUiTelemetry';
import {
    useTranscriptOlderPagination,
    type TranscriptOlderPaginationSnapshot,
} from '@/components/sessions/transcript/pagination/useTranscriptOlderPagination';
import {
    resolveItemsToNewerEdge,
    resolveItemsToOlderEdge,
} from '@/components/sessions/transcript/pagination/olderPaginationMachine';
import { waitForNextTranscriptVisualUpdate } from '@/components/sessions/transcript/pagination/waitForNextTranscriptVisualUpdate';
import { TranscriptFirstPaintPlaceholder } from '@/components/sessions/transcript/TranscriptFirstPaintPlaceholder';
import { JumpToBottomButton } from '@/components/sessions/transcript/scroll/JumpToBottomButton';
import { ComposerKeyboardFloatingInset } from '@/components/sessions/keyboardAvoidance';
import { TranscriptNavigationRail } from '@/components/sessions/transcript/navigation/TranscriptNavigationRail';
import {
    TranscriptListShell,
    type TranscriptListShellRef,
} from '@/components/sessions/transcript/viewport/shell/TranscriptListShell';
import { resolveRowLayoutMutationViewportOwnershipAction } from '@/components/sessions/transcript/viewport/shell/rowLayoutMutationViewportOwnership';
import type { TranscriptBlankRecoveryEffect } from '@/components/sessions/transcript/viewport/visibility/blankRecoveryOwner';
import {
    deriveTranscriptNavigationRuntimeAnchors,
    type TranscriptNavigationRuntimeAnchor,
} from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationRuntimeAnchors';
import { clearTranscriptNavigationVisibilityStore } from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationVisibilityStore';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { useTranscriptPrependHost } from '@/components/sessions/transcript/viewport/prepend/host/useTranscriptPrependHost';
import {
    useTranscriptViewportAnchorCaptureHost,
    type ScheduledViewportAnchorCapture,
} from '@/components/sessions/transcript/viewport/prepend/host/useTranscriptViewportAnchorCaptureHost';
import { useTranscriptEntryHost } from '@/components/sessions/transcript/viewport/entryRestore/host/useTranscriptEntryHost';
import {
    useTranscriptSessionEntryLifecycle,
    type SessionEntryViewportRefValue,
} from '@/components/sessions/transcript/viewport/entryRestore/host/useTranscriptSessionEntryLifecycle';
import { useTranscriptNativeEntryRestorePaintRelease } from '@/components/sessions/transcript/viewport/entryRestore/host/useTranscriptNativeEntryRestorePaintRelease';
import { useTranscriptBottomFollowHost } from '@/components/sessions/transcript/viewport/bottomFollow/host/useTranscriptBottomFollowHost';
import { useTranscriptLiveTailIntentHost } from '@/components/sessions/transcript/viewport/bottomFollow/host/useTranscriptLiveTailIntentHost';
import { useTranscriptSessionExitHandoff } from '@/components/sessions/transcript/viewport/lifecycle/host/useTranscriptSessionExitHandoff';
import { useCommittedTranscriptRef } from '@/components/sessions/transcript/viewport/lifecycle/host/useCommittedTranscriptRef';
import { selectTranscriptExitSnapshot } from '@/components/sessions/transcript/viewport/lifecycle/selectTranscriptExitSnapshot';
import {
    useTranscriptSameSessionHandoff,
    type TranscriptExitSnapshotSelection,
} from '@/components/sessions/transcript/viewport/lifecycle/transcriptSameSessionHandoff';
import { useTranscriptScrollObservationHost } from '@/components/sessions/transcript/viewport/lifecycle/host/useTranscriptScrollObservationHost';
import { useTranscriptJumpHost } from '@/components/sessions/transcript/viewport/jump/host/useTranscriptJumpHost';
import {
    runTranscriptPrependOlderLoad,
    type TranscriptPrependOlderLoadOptions,
    type TranscriptPrependOlderLoadResult,
    type TranscriptPrependOlderLoadSyncOptions,
} from '@/components/sessions/transcript/viewport/prepend/host/runTranscriptPrependOlderLoad';
import type { TranscriptMeasurementReconciler } from '@/components/sessions/transcript/measurement/transcriptMeasurementReconciler';
import type { TranscriptRowLayoutMutation } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';
import {
    createTranscriptMeasurementHost,
} from '@/components/sessions/transcript/measurement/transcriptMeasurementHost';
import { estimateTranscriptRowHeightFromCache, estimateTranscriptRowHeightFromContent } from '@/components/sessions/transcript/measurement/estimateTranscriptRowHeightFromCache';
import { resolveToolCallsGroupChromeVariant } from '@/components/sessions/transcript/toolCalls/units/toolCallsGroupChrome';
import { buildTranscriptItemHeightSignatureKey } from '@/components/sessions/transcript/measurement/transcriptItemHeightCache';
import { useTranscriptMeasurementHostWiring } from '@/components/sessions/transcript/measurement/useTranscriptMeasurementHostWiring';
import {
    resolveFontScaleKey,
    resolveInitialTranscriptRowWidthBucket,
    resolveTranscriptRowWidthBucket,
} from '@/components/sessions/transcript/measurement/rowRenderKeys';
import type { TranscriptLiveTailAnchorReason } from '@/components/sessions/transcript/viewport/lifecycle/transcriptRowClassification';
import {
    createEntryRestoreOwner,
    type EntryRestoreOwner,
    type EntryRestoreOwnerEffect,
} from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreOwner';
import { stampViewportAnchorForEmit as stampViewportAnchorForEmitState } from '@/components/sessions/transcript/viewport/entryRestore/stampViewportAnchorForEmit';
import { readSessionViewportForEntry } from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreAnchorUtilities';
import { resolveTranscriptMountSettleTuning } from '@/components/sessions/transcript/viewport/lifecycle/mountSettleTuning';
import { useTranscriptFirstPaintState, useTranscriptItemsPipeline, useTranscriptToolAutoExpandEffect } from '@/components/sessions/transcript/items/useTranscriptItemsPipeline';
import { useTranscriptItemRenderer, useTranscriptItemsEdgeSlots } from '@/components/sessions/transcript/rowHost/useTranscriptRowHost';
import { useTranscriptExpansionState } from '@/components/sessions/transcript/rowHost/useTranscriptExpansionState';
export type { TranscriptViewportChangeState } from '@/components/sessions/transcript/chatListTypes';
type ExplicitJumpTakeoverApplyEffect = TranscriptLifecycleHostExplicitJumpPlan['explicitJumpTakeoverEffects'][number];
type FollowBottomIntentTakeoverApplyEffect = TranscriptLifecycleHostFollowBottomIntentPlan['followBottomIntentTakeoverEffects'][number];
const TRANSCRIPT_SCROLL_USER_INTENT_RECENT_MS = 500;
export const ChatListInternal = React.memo((props: ChatListInternalProps) => {
    const transcriptMessageSelection = useOptionalTranscriptSelectionState();
    const transcriptContentMaxWidth = useLayoutMaxWidth();
    const [isLoadingOlder, setIsLoadingOlder] = React.useState(false);
    const [hasMoreOlder, setHasMoreOlder] = React.useState<boolean | null>(null);
    const [listLayoutHeight, setListLayoutHeight] = React.useState(0);
    const [listLayoutWidthPx, setListLayoutWidthPx] = React.useState(() => {
        const width = Dimensions.get('window')?.width;
        return typeof width === 'number' && Number.isFinite(width) && width > 0 ? Math.round(width) : 0;
    });
    const [listLayoutWidthBucket, setListLayoutWidthBucket] = React.useState(resolveInitialTranscriptRowWidthBucket);
    const [listContentHeight, setListContentHeight] = React.useState(0);
    const [nativeMountSettleStable, setNativeMountSettleStable] = React.useState(false);
    const [nativeMountSettleDeadlineReached, setNativeMountSettleDeadlineReached] = React.useState(false);
    const [nativeInitialViewportPendingObservation, setNativeInitialViewportPendingObservation] = React.useState(false);
    const nativeMountSettleDeadlineReachedRef = React.useRef(false);
    const loadOlderInFlight = React.useRef(false);
    const hasMoreOlderRef = React.useRef<boolean | null>(null);
    const olderLoadSpinnerDelayTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const nativeFirstPaintFallbackReleaseTimeoutRef = React.useRef<{
        sessionId: string;
        timeoutId: ReturnType<typeof setTimeout>;
    } | null>(null);
    const nativeEntryRestorePaintReleaseTimeoutRef = React.useRef<{
        issuedAtMs: number;
        sessionId: string;
        timeoutId: ReturnType<typeof setTimeout>;
    } | null>(null);
    const listRef = React.useRef<ScrollableChatListRef | null>(null);
    const revalidateViewportAfterReveal = React.useCallback(() => {
        listRef.current?.revalidateViewportAfterReveal?.();
    }, []);
    const pendingJumpSeqViewportPromotionRef = React.useRef<PendingJumpSeqViewportPromotion | null>(null);
    const promotedJumpSeqViewportProtectionRef = React.useRef<PromotedJumpSeqViewportProtection | null>(null);
    const lastRouteJumpProtectionClearingWebMovementAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    const flushPendingJumpSeqViewportPromotionForExitRef =
        React.useRef<() => TranscriptExitSnapshotSelection | null>(() => null);
    const flushViewportAnchorCaptureRef = React.useRef<(options?: Readonly<{ deferEmit?: boolean }>) => void>(() => {});
    const captureViewportAtExitRef = React.useRef<(
        options?: Readonly<{ deferEmit?: boolean }>,
    ) => TranscriptExitSnapshotSelection | null>(() => null);
    const disposeEntryRestoreTransactionForExitRef = React.useRef<() => void>(() => {});
    const currentSessionIdRef = React.useRef(props.sessionId);
    const viewportCommandControllerRef = React.useRef<TranscriptViewportCommandController | null>(null);
    if (viewportCommandControllerRef.current === null) {
        viewportCommandControllerRef.current = createTranscriptViewportCommandController();
    }
    const viewportCommandController = viewportCommandControllerRef.current;
    const isEntryViewportCommandActive = React.useCallback(
        () => viewportCommandController.activeOwner() === 'entry',
        [viewportCommandController],
    );
    const selectCurrentExitSnapshot = React.useCallback((
        options?: Readonly<{ deferEmit?: boolean }>,
    ): TranscriptExitSnapshotSelection | null => selectTranscriptExitSnapshot({
        capturePhysicalExit: () => captureViewportAtExitRef.current({
            deferEmit: options?.deferEmit ?? true,
        }),
        flushJumpPromotion: () => flushPendingJumpSeqViewportPromotionForExitRef.current(),
    }), []);
    const sameSessionHandoff = useTranscriptSameSessionHandoff({
        captureForHandoff: selectCurrentExitSnapshot,
        explicitJump: props.jumpToSeq != null,
        sessionId: props.sessionId,
    });
    const exitCurrentSession = React.useCallback((options?: Readonly<{ deferEmit?: boolean }>) => {
        const selection = selectCurrentExitSnapshot(options);
        pendingJumpSeqViewportPromotionRef.current = null;
        promotedJumpSeqViewportProtectionRef.current = null;
        lastRouteJumpProtectionClearingWebMovementAtMsRef.current = Number.NEGATIVE_INFINITY;
        sameSessionHandoff.refreshForDeletion(selection);
    }, [sameSessionHandoff.refreshForDeletion, selectCurrentExitSnapshot]);
    const commitSessionId = React.useCallback((sessionId: string) => {
        currentSessionIdRef.current = sessionId;
        viewportCommandController.setCurrentSessionId(sessionId);
    }, [viewportCommandController]);
    useTranscriptSessionExitHandoff({
        commitSessionId,
        exitCurrentSession,
        revalidateAfterLifecycleResume: revalidateViewportAfterReveal,
        sessionId: props.sessionId,
    });
    const commandHostRef = React.useRef<TranscriptViewportCommandHost | null>(null);
    const viewportLifecycleRef = React.useRef<TranscriptViewportLifecycle | null>(null);
    if (viewportLifecycleRef.current === null) {
        viewportLifecycleRef.current = createTranscriptViewportLifecycle();
    }
    const viewportLifecycle = viewportLifecycleRef.current;
    const viewportLifecycleHostRef = React.useRef<TranscriptLifecycleHost | null>(null);
    if (viewportLifecycleHostRef.current === null) {
        viewportLifecycleHostRef.current = createTranscriptLifecycleHost({
            lifecycle: viewportLifecycle,
            mountSettleTuning: resolveTranscriptMountSettleTuning(),
        });
    }
    const lifecycleHost = viewportLifecycleHostRef.current;
    const entryRestoreOwnerRef = React.useRef<EntryRestoreOwner | null>(null);
    if (entryRestoreOwnerRef.current === null) {
        entryRestoreOwnerRef.current = createEntryRestoreOwner();
    }
    const entryRestoreOwner = entryRestoreOwnerRef.current;
    const applyEntryRestoreOwnerEffectsRef = React.useRef<(effects: readonly EntryRestoreOwnerEffect[]) => void>(() => {});
    const sessionOpenLatchRef = React.useRef<SessionOpenLatch | null>(null);
    if (sessionOpenLatchRef.current === null) {
        sessionOpenLatchRef.current = createSessionOpenLatch();
    }
    const sessionOpenLatch = sessionOpenLatchRef.current;
    const applySessionOpenLatchEffectsRef = React.useRef<(effects: readonly SessionOpenLatchEffect[]) => void>(() => {});
    React.useLayoutEffect(() => {
        viewportCommandController.setActive(true);
        return () => {
            viewportCommandController.setActive(false);
        };
    }, [viewportCommandController]);
    const closeViewportOwnershipTransaction = React.useCallback((
        owner: 'entry' | 'prepend',
        outcome: TranscriptViewportTransactionOutcome,
    ) => {
        if (viewportCommandController.activeOwner() !== owner) return;
        viewportCommandController.closeTransaction(owner, outcome);
    }, [viewportCommandController]);
    const closeEntryViewportOwnership = React.useCallback((outcome: TranscriptViewportTransactionOutcome) => {
        closeViewportOwnershipTransaction('entry', outcome);
    }, [closeViewportOwnershipTransaction]);
    const preemptEntryRestoreTransaction = React.useCallback(() => {
        applyEntryRestoreOwnerEffectsRef.current(entryRestoreOwner.preempt({
            reason: 'trusted-scroll',
            sessionId: props.sessionId,
        }));
    }, [entryRestoreOwner, props.sessionId]);
    const itemsRef = React.useRef<readonly ChatTranscriptListItem[]>(props.items);
    const listDataRef = React.useRef<readonly ChatTranscriptListItem[]>(props.items);
    const canonicalWindowedItemsRef = React.useRef<readonly ChatTranscriptListItem[]>(props.items);
    const renderWindowIndexMapRef = React.useRef<TranscriptRenderWindowProjection<ChatTranscriptListItem>['indexMap'] | null>(null);
    // Pre-decomposition source (turn / tool-calls-group shapes) for visitors that must
    // not see per-unit rows (auto-expand policy scan).
    const preDecompositionItemsRef = React.useRef<ChatTranscriptListItem[]>(props.items);
    const commitListRef = React.useCallback((node: TranscriptListShellRef<ChatTranscriptListItem> | null) => {
        listRef.current = node as unknown as ScrollableChatListRef | null;
    }, []);
    const listLayoutHeightRef = React.useRef<number>(0);
    const listLayoutWidthPxRef = React.useRef<number>(listLayoutWidthPx);
    const listLayoutWidthBucketRef = React.useRef<string>(listLayoutWidthBucket);
    const listContentHeightRef = React.useRef<number>(0);
    const measurementHost = React.useMemo(
        () => createTranscriptMeasurementHost(),
        [],
    );
    const measurementReconciler = measurementHost.reconciler;
    const recordListLayoutWidth = React.useCallback((width: unknown) => {
        if (typeof width !== 'number' || !Number.isFinite(width)) return;
        if (width > 0) {
            const nextWidthPx = Math.round(width);
            if (listLayoutWidthPxRef.current !== nextWidthPx) {
                listLayoutWidthPxRef.current = nextWidthPx;
                setListLayoutWidthPx(nextWidthPx);
            }
        }
        const nextBucket = resolveTranscriptRowWidthBucket(width);
        if (listLayoutWidthBucketRef.current === nextBucket) return;
        listLayoutWidthBucketRef.current = nextBucket;
        setListLayoutWidthBucket(nextBucket);
    }, []);
    const initialFillAbortRef = React.useRef<AbortController | null>(null);
    const chatListReactId = React.useId();
    const chatListNativeId = React.useMemo(() => buildChatListNativeId(props.sessionId, chatListReactId), [props.sessionId, chatListReactId]);
    const webScrollContainerRef = React.useRef<HTMLElement | null>(null);
    const transcriptNavigationRuntimeAnchorsRef = React.useRef<readonly TranscriptNavigationRuntimeAnchor[]>([]);
    // Forward handle to the jump host's single navigation-visibility publication
    // owner: the telemetry host mounts first and only ever TRIGGERS a re-derive.
    const observeTranscriptNavigationVisibilityRef = React.useRef<() => void>(() => {});
    const shouldSuppressGenericViewportStateForProtectedJumpSeqRef = React.useRef<() => boolean>(() => false);
    const commitJumpToBottomDistanceForVisibilityRef = React.useRef<(distanceFromBottom: number) => void>(() => {});
    const shouldSuppressGenericViewportStateForAnchorCapture = React.useCallback((): boolean => shouldSuppressGenericViewportStateForProtectedJumpSeqRef.current(), []);
    const olderPaginationSnapshotRef = React.useRef<TranscriptOlderPaginationSnapshot>({
        phase: 'idle',
        suspendedReasons: [],
        hasMore: true,
        insideThreshold: false,
    });
    const observeNativePrependOwnerRef = React.useRef<() => void>(() => {});
    const invalidateNativePrependOwnerRef = React.useRef<() => void>(() => {});
    const hasOpenNativePrependTransactionForSessionRef = React.useRef<() => boolean>(() => false);
    const closeNativePrependForTrustedScrollRef = React.useRef<() => void>(() => {});
    const nativePrependTelemetryStateRef = React.useRef<() => TranscriptViewportTelemetryTransactionState>(() => 'none');
    // Plan P2: lets the momentum-settle handler (defined before the scheduler) arm a capture
    // for the dwelled position when every momentum frame was swallowed (open transactions).
    const scheduleViewportAnchorCaptureRef = React.useRef<(
        state: TranscriptViewportChangeState,
        options?: Readonly<{ suppressAnchorCapture?: boolean }>,
    ) => void>(() => {});
    const resetOlderPaginationRef = React.useRef<() => void>(() => {});
    const observeCommittedProjectionLayoutRef = React.useRef<() => void>(() => {});
    const wantsPinnedRef = React.useRef(true);
    const pinThresholdPxRef = React.useRef(72);
    const lastExplicitWebScrollIntentAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    const nativeTranscriptTouchStartYRef = React.useRef<number | null>(null);
    const resolveJumpToSeqIndexForCommandRef = React.useRef<(
        seq: number,
        routeMessageId?: string | null,
        transcriptBlockIndex?: number | null,
        role?: TranscriptJumpTargetRole | null,
    ) => number | null>(() => null);
    // ONE owner of "is the reader scrolling / does the reader still want the live tail", shared
    // with the renderer through the same observation object. `timestampRef` IS the ref every host
    // consumer below reads — the renderer no longer keeps a same-named second copy, and the
    // renderer's drag/momentum liveness is now visible to the host's pin guards (a web scrollbar
    // drag used to be invisible to them entirely).
    const userScrollIntentRef = React.useRef<TranscriptUserScrollIntentOwner | null>(null);
    if (userScrollIntentRef.current === null) {
        userScrollIntentRef.current = createTranscriptUserScrollIntentOwner();
    }
    const userScrollIntent = userScrollIntentRef.current;
    const lastUserScrollIntentAtMsRef = userScrollIntent.timestampRef;
    const webDomObservationRef = React.useRef<WebDomScrollObservation | null>(null);
    if (webDomObservationRef.current === null) {
        webDomObservationRef.current = createWebDomScrollObservation({ userScrollIntent });
    }
    const webDomObservation = webDomObservationRef.current;
    const lastPinOffsetForIntentRef = React.useRef<number | null>(null);
    const lastScrollOffsetForIntentRef = React.useRef<number | null>(null);
    const bottomFollowModeStateRef = React.useRef<TranscriptBottomFollowModeState>({
        dragSession: null,
        mode: resolveSessionEntryViewportState(readSessionViewportForEntry(props.sessionId)).bottomFollowMode,
    });
    const [bottomFollowModeRevision, bumpBottomFollowModeRevision] = React.useReducer((value: number) => (value + 1) % 1_000_000, 0);
    const commitBottomFollowModeState = React.useCallback((next: TranscriptBottomFollowModeState) => {
        const previous = bottomFollowModeStateRef.current;
        bottomFollowModeStateRef.current = next;
        if (previous.mode !== next.mode) {
            bumpBottomFollowModeRevision();
        }
    }, []);
    const dispatchViewportLifecycleEvent = React.useCallback((event: TranscriptViewportLifecycleEvent) => {
        const transition = viewportLifecycle.dispatch(event);
        commitBottomFollowModeState(transition.state.bottomFollowState);
        return transition;
    }, [commitBottomFollowModeState, viewportLifecycle]);
    const applyNativeDragActiveMirrorEffectsRef = React.useRef<(effects: readonly NativeDragActiveMirrorApplyEffect[]) => void>(() => {});
    const getBottomFollowGestureActiveRef = React.useRef<() => boolean>(() => false);
    const recordLocalTranscriptInteractionIntentRef = React.useRef<() => void>(() => {});
    const adoptNativeFollowingForTrustedBottomArrivalRef = React.useRef<(distanceFromBottom: number | null) => void>(() => {});
    const lastNativeRestoreIndexCommandRef = React.useRef<LastNativeRestoreIndexCommand | null>(null);
    const nativeListDragActiveRef = React.useRef(false);
    const nativeBottomFollowRearmedAfterDragRef = React.useRef(false);
    // Plan B9: true between onMomentumScrollBegin and onMomentumScrollEnd. Combined with the
    // mode machine's retained trusted drag session it forms the post-drag release attribution
    // window: momentum frames may release follow, height-churn frames without a drag never can.
    const nativeMomentumScrollActiveRef = React.useRef(false);
    const nativeVisibleWindowSnapshotRef = React.useRef<NativeVisibleWindowSnapshot | null>(null);
    const lastNativeVisibleRowsSnapshotRef = React.useRef<NativeVisibleWindowSnapshot | null>(null);
    const nativeInitialViewportPendingObservationRef = React.useRef(false);
    // Entry-restore owner state lives in viewport/entryRestore; ChatList applies its effects.
    const entryRestoreDeadlineTimeoutRef = React.useRef<{
        sessionId: string;
        timeoutId: ReturnType<typeof setTimeout>;
    } | null>(null);
    const composerInsetHeightRef = React.useRef(0);
    // Render-visible mirror of `composerInsetHeightRef` (the single source of truth). Bottom-anchored
    // overlays that live OUTSIDE the scroll geometry (e.g. the catch-up overlay) must re-position when
    // the composer inset changes, which a ref alone cannot drive. Committed from
    // `handleComposerInsetHeightChange` so it stays in lockstep with the ref.
    const [composerInsetHeight, setComposerInsetHeight] = React.useState(0);
    const authorizeImmediateBottomFollowWriteRef = React.useRef<(
        (writer: BottomFollowAutomaticWriter, reason: TranscriptViewportTelemetryScrollReason) => boolean
    )>(() => false);
    const latestJumpToSeqRef = React.useRef<number | null>(props.jumpToSeq ?? null);
    useCommittedTranscriptRef(latestJumpToSeqRef, props.jumpToSeq ?? null);
    const scheduledViewportAnchorCaptureRef = React.useRef<ScheduledViewportAnchorCapture | null>(null);
    const viewportAnchorCaptureGenerationRef = React.useRef(0);
    const attemptEntryRestoreRef = React.useRef<() => void>(() => {});
    const anchorLookupLoadCountRef = React.useRef(0);
    const anchorLookupInFlightRef = React.useRef(false);
    const anchorLookupExhaustedRef = React.useRef(false);
    const {
        resolveWebScrollMetrics,
        resolveWebViewportTelemetryDiagnostics,
    } = useTranscriptWebViewportTelemetryDiagnostics({
        chatListNativeId,
        listContentHeightRef,
        listLayoutHeightRef,
        olderPaginationSnapshotRef,
        transcriptNavigationRuntimeAnchorsRef,
        webScrollContainerRef,
    });
    const resolveBackwardPrefetchThresholdPx = React.useCallback((viewportPx: number): number => {
        const tuning = sync.getSyncTuning();
        return resolveTranscriptEdgePrefetchThresholdPx({
            configuredPx: tuning.transcriptBackwardPrefetchThresholdPx,
            viewportPx,
            fallbackViewportRatio: TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO,
            minPx: TRANSCRIPT_EDGE_PREFETCH_MIN_PX,
            maxPx: TRANSCRIPT_EDGE_PREFETCH_MAX_PX,
        });
    }, []);
    const waitForNextVisualUpdate = React.useCallback(waitForNextTranscriptVisualUpdate, []);
    const { motionConfig, reducedMotionPreferred } = useTranscriptMotionConfig();
    const transcriptScrollPinEnabled = useSetting('transcriptScrollPinEnabled');
    const transcriptScrollPinOffsetThresholdPx = useSetting('transcriptScrollPinOffsetThresholdPx');
    const transcriptToolCallsCollapsedPreviewCountSetting = useSetting('transcriptToolCallsCollapsedPreviewCount');
    const [scrollPin, setScrollPin] = React.useState<TranscriptScrollPinState>(() => ({
        isPinned: resolveSessionEntryViewportState(readSessionViewportForEntry(props.sessionId)).shouldFollowBottom,
        newActivityCount: 0,
        lastActivityKey: null,
    }));
    const scrollPinRef = React.useRef(scrollPin);
    const commitScrollPinState = React.useCallback((next: TranscriptScrollPinState) => {
        const current = scrollPinRef.current;
        if (
            current === next ||
            (
                current.isPinned === next.isPinned &&
                current.newActivityCount === next.newActivityCount &&
                current.lastActivityKey === next.lastActivityKey
            )
        ) {
            return;
        }
        scrollPinRef.current = next;
        setScrollPin(next);
    }, []);
    const commitScrollPinEvent = React.useCallback((event: TranscriptScrollPinEvent) => {
        const next = resolveTranscriptScrollPinStateUpdate(scrollPinRef.current, event);
        if (!next) return;
        commitScrollPinState(next);
    }, [commitScrollPinState]);
    const commitScrollPinEventFromScrollObservation = React.useCallback((event: TranscriptScrollPinEvent) => {
        // Legend owns continuous follow; raw scroll events never drive the pin state machine.
        if (event.type === 'scroll') return;
        commitScrollPinEvent(event);
    }, [
        commitScrollPinEvent,
    ]);
    const commitJumpToBottomDistanceFromScrollObservation = React.useCallback((_distanceFromBottom: number) => {
        // Renderer-owned follow: jump-to-bottom visibility is driven by renderer at-end state.
    }, []);
    const isPinnedRef = React.useRef(true);
    const resetOlderPaginationForSessionEntry = React.useCallback(() => {
        hasMoreOlderRef.current = null;
        resetOlderPaginationRef.current();
    }, []);
    const sessionEntryViewportRef = React.useRef<SessionEntryViewportRefValue>(null);
    const consumedSessionEntryViewportRef = React.useRef<{
        entryKind: SessionOpenEntryKind;
        sessionId: string;
    } | null>(null);
    const clearOlderLoadSpinnerDelay = React.useCallback(() => {
        const timeoutId = olderLoadSpinnerDelayTimeoutRef.current;
        if (!timeoutId) return;
        olderLoadSpinnerDelayTimeoutRef.current = null;
        clearTimeout(timeoutId);
    }, []);
    const hideOlderLoadSpinner = React.useCallback(() => {
        clearOlderLoadSpinnerDelay();
        setIsLoadingOlder(false);
    }, [clearOlderLoadSpinnerDelay]);
    const showOlderLoadSpinner = React.useCallback(() => {
        clearOlderLoadSpinnerDelay();
        setIsLoadingOlder(true);
    }, [clearOlderLoadSpinnerDelay]);
    const applyExplicitJumpTakeoverApplyEffects = React.useCallback((
        effects: readonly ExplicitJumpTakeoverApplyEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            switch (effect.type) {
                case 'explicit-jump-suppress-entry-restore':
                    applyEntryRestoreOwnerEffectsRef.current(entryRestoreOwner.preempt({
                        reason: 'jump',
                        sessionId: props.sessionId,
                    }));
                    break;
                case 'explicit-jump-preempt-entry-restore':
                    preemptEntryRestoreTransaction();
                    break;
                case 'explicit-jump-clear-native-entry-restore-paint-release-timeout': {
                    const nativeEntryRestorePaintReleaseTimeout = nativeEntryRestorePaintReleaseTimeoutRef.current;
                    if (nativeEntryRestorePaintReleaseTimeout) {
                        nativeEntryRestorePaintReleaseTimeoutRef.current = null;
                        clearTimeout(nativeEntryRestorePaintReleaseTimeout.timeoutId);
                    }
                    break;
                }
                case 'explicit-jump-invalidate-native-prepend-transaction':
                    invalidateNativePrependOwnerRef.current();
                    break;
                case 'explicit-jump-clear-native-restore-index-command-cache':
                    lastNativeRestoreIndexCommandRef.current = null;
                    break;
                case 'explicit-jump-close-native-prepend-transaction':
                    closeNativePrependForTrustedScrollRef.current();
                    break;
            }
        }
    }, [
        entryRestoreOwner,
        preemptEntryRestoreTransaction,
        props.sessionId,
        viewportCommandController,
    ]);
    React.useEffect(() => {
        if (props.jumpToSeq == null) return;
        const plan = lifecycleHost.planExplicitJumpTakeover({
            reason: 'jump-to-seq',
            sessionId: props.sessionId,
        });
        commitBottomFollowModeState(plan.state.bottomFollowState);
        applyExplicitJumpTakeoverApplyEffects(plan.explicitJumpTakeoverEffects);
    }, [
        applyExplicitJumpTakeoverApplyEffects,
        commitBottomFollowModeState,
        lifecycleHost,
        props.jumpToSeq,
        props.sessionId,
    ]);
    const recordLocalTranscriptInteractionIntent = React.useCallback(() => {
        recordLocalTranscriptInteractionIntentRef.current();
    }, []);
    const prepareLocalHeightChange = React.useCallback((
        mutation: TranscriptRowLayoutMutation,
    ): 'anchor' | 'bottom' | 'none' => {
        const ownershipAction = resolveRowLayoutMutationViewportOwnershipAction({
            reason: mutation.reason,
        });
        if (ownershipAction === 'arm-visible-anchor-hold') {
            // Renderer-owned local height changes (Legend): arm the renderer's ONE keyed
            // visible-anchor hold before the expansion commit. Legend MVCP alone re-anchors
            // its mounted window across the expansion item replacement (live S-C, web +
            // native 2026-07-11); the armed hold keeps the visible row still and the
            // tail-follow/pinned case stays owned by the held-'end' machinery inside the arm.
            listRef.current?.armVisibleAnchorHold?.();
        }
        return 'none';
    }, []);
    const {
        applyToolCallsGroupExpanded,
        expandedToolCallsAnchorMessageIds,
        resolveThinkingExpanded,
        setExpandedToolCallsAnchorMessageIds,
        setThinkingExpanded,
        setToolCallsGroupExpanded,
    } = useTranscriptExpansionState({
        recordLocalTranscriptInteractionIntent,
        prepareLocalHeightChange,
    });
    const onViewportChangeRef = React.useRef(props.onViewportChange);
    useCommittedTranscriptRef(onViewportChangeRef, props.onViewportChange);
    const stampViewportAnchorForEmit = React.useCallback((
        anchor: SessionViewportAnchorSnapshot | null | undefined,
    ): SessionViewportAnchorSnapshot | null | undefined => {
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[props.sessionId];
        return stampViewportAnchorForEmitState({
            anchor,
            items: listDataRef.current,
            messagesById: props.messagesById,
            stateMessagesById: (session?.messagesById ?? session?.messagesMap ?? {}) as Readonly<Record<string, Message | undefined>>,
        });
    }, [
        props.messagesById,
        props.sessionId,
    ]);
    const emitViewportChange = React.useCallback((state: TranscriptViewportChangeState): boolean => {
        const emit = props.onViewportChange;
        if (!emit) return false;
        emit({
            ...state,
            anchor: stampViewportAnchorForEmit(state.anchor),
        });
        return true;
    }, [props.onViewportChange, stampViewportAnchorForEmit]);
    const { commitExplicitReturnToLiveTailState, handleRendererAtEndChange } = useTranscriptLiveTailIntentHost({
        commitBottomFollowModeState,
        commitJumpToBottomDistanceForVisibilityRef,
        commitScrollPinEvent,
        commitScrollPinState,
        emitViewportChange,
        isPinnedRef,
        lastPinOffsetForIntentRef,
        lifecycleHost,
        scrollPinRef,
        sessionId: props.sessionId,
        transcriptScrollPinEnabled,
        userScrollIntent,
        wantsPinnedRef,
    });
    const cancelScheduledViewportAnchorCapture = React.useCallback(() => {
        const scheduled = scheduledViewportAnchorCaptureRef.current;
        if (!scheduled) return;
        scheduledViewportAnchorCaptureRef.current = null;
        clearTimeout(scheduled.timeoutId);
    }, []);
    const invalidateViewportAnchorCapture = React.useCallback(() => {
        viewportAnchorCaptureGenerationRef.current += 1;
        cancelScheduledViewportAnchorCapture();
    }, [cancelScheduledViewportAnchorCapture]);
    const resetViewportAnchorCaptureForSessionEntry = React.useCallback(() => {
        flushViewportAnchorCaptureRef.current();
        invalidateViewportAnchorCapture();
    }, [invalidateViewportAnchorCapture]);
    const resetNativeMountSettleFlagsForSessionEntry = React.useCallback(() => {
        setNativeMountSettleStable(false);
        nativeMountSettleDeadlineReachedRef.current = false;
        setNativeMountSettleDeadlineReached(false);
    }, []);
    const {
        applyNativeBottomFollowCompletionHostEffects,
        applyNativeUserScrollTakeoverHostEffects,
        hasNativeContentMeasurementForCurrentSession,
        hasNativeInitialViewportAppliedForCurrentSession,
        markNativeInitialViewportAppliedForCurrentSession,
        recordNativeUserScrollIntent,
        resetNativeSessionViewportLifecycle,
        shouldIgnoreNativeInvalidScrollObservation,
        updateNativeInitialViewportPendingObservation,
    } = useTranscriptNativeViewportLifecycle({
        closeEntryViewportOwnership,
        consumedSessionEntryViewportRef,
        entryRestoreOwner,
        lifecycleHost,
        measurementHost,
        nativeInitialViewportPendingObservationRef,
        platformOS: Platform.OS,
        userScrollIntent,
        preemptEntryRestoreTransaction,
        sessionEntryViewportRef,
        sessionId: props.sessionId,
        sessionOpenLatch,
        setNativeInitialViewportPendingObservation,
    });
    const {
        applySessionOpenArmResetPlan,
        applySessionOpenDisposeResetPlan,
        entryAnchorForRender,
        entryShouldFollowBottomForRender,
    } = useTranscriptSessionEntryLifecycle({
        anchorLookupExhaustedRef,
        anchorLookupInFlightRef,
        anchorLookupLoadCountRef,
        applyEntryRestoreOwnerEffectsRef,
        applySessionOpenLatchEffectsRef,
        closeEntryViewportOwnership,
        commitBottomFollowModeState,
        commitJumpToBottomDistanceForVisibility: (distanceFromBottom) => {
            commitJumpToBottomDistanceForVisibilityRef.current(distanceFromBottom);
        },
        commitScrollPinState,
        consumedSessionEntryViewportRef,
        disposeEntryRestoreTransactionForExitRef,
        emitViewportChange,
        entryRestoreDeadlineTimeoutRef,
        entryRestoreOwner,
        flushViewportAnchorCaptureRef,
        getItemCount: () => itemsRef.current.length,
        hideOlderLoadSpinner,
        initialFillAbortRef,
        resetNativeFirstPaintRevealStateForSessionEntry: () => {
            updateNativeViewportPaintObserved(false);
            updateNativeEntryRestorePaintReleased(false);
            // The first-paint policy's own record of this session's previous reveal belongs to
            // the entry that just ended, exactly like the two native facts above it. Leaving it
            // behind would permanently suppress the next entry's cover on an unchanged session id.
            resetFirstPaintRevealRecordForSessionEntry();
        },
        invalidateNativePrependOwner: () => invalidateNativePrependOwnerRef.current(),
        invalidateViewportAnchorCapture,
        isLoaded: props.isLoaded,
        isPinnedRef,
        jumpToSeq: props.jumpToSeq,
        lastExplicitWebScrollIntentAtMsRef,
        lastNativeRestoreIndexCommandRef,
        lastPinOffsetForIntentRef,
        lastRouteJumpProtectionClearingWebMovementAtMsRef,
        lastScrollOffsetForIntentRef,
        lifecycleHost,
        listContentHeightRef,
        listLayoutHeightRef,
        measurementHost,
        userScrollIntent,
        nativeBottomFollowRearmedAfterDragRef,
        nativeEntryRestorePaintReleaseTimeoutRef,
        nativeFirstPaintFallbackReleaseTimeoutRef,
        nativeMomentumScrollActiveRef,
        resetNativeMountSettleFlagsForSessionEntry,
        resetNativeSessionViewportLifecycle,
        resetOlderPaginationForSessionEntry,
        resetViewportAnchorCaptureForSessionEntry,
        sameSessionHandoffClaimedViewportRef: sameSessionHandoff.claimedViewportRef,
        sameSessionHandoffViewportForRender: sameSessionHandoff.renderViewport,
        sessionEntryViewportRef,
        sessionId: props.sessionId,
        sessionOpenLatch,
        setExpandedToolCallsAnchorMessageIds,
        setListContentHeight,
        viewportCommandController,
        wantsPinnedRef,
        webDomObservation,
    });
    const applyFollowBottomIntentTakeoverApplyEffects = React.useCallback((
        effects: readonly FollowBottomIntentTakeoverApplyEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            switch (effect.type) {
                case 'follow-bottom-intent-preempt-entry-restore':
                    preemptEntryRestoreTransaction();
                    break;
                case 'follow-bottom-intent-clear-user-scroll-intent':
                    userScrollIntent.revokeInputEvidence();
                    // Follow-bottom intent is a deliberate return to the live tail, so it also
                    // releases the parked position (the revoke covers input recency only).
                    userScrollIntent.releaseLiveTailParking();
                    break;
                case 'follow-bottom-intent-record-live-tail-pin-offset':
                    lastPinOffsetForIntentRef.current = effect.distanceFromLiveTailPx;
                    break;
            }
        }
    }, [
        preemptEntryRestoreTransaction,
        props.sessionId,
    ]);
    const applyUnmountCleanup = React.useCallback(() => {
        flushPendingJumpSeqViewportPromotionForExitRef.current();
        flushViewportAnchorCaptureRef.current();
        // An entry transaction still open at unmount closes with an attributable
        // outcome (mirror of the prepend invalidation below) — never a silent drop.
        disposeEntryRestoreTransactionForExitRef.current();
        const entryRestoreDeadlineTimeout = entryRestoreDeadlineTimeoutRef.current;
        if (entryRestoreDeadlineTimeout) {
            entryRestoreDeadlineTimeoutRef.current = null;
            clearTimeout(entryRestoreDeadlineTimeout.timeoutId);
        }
        initialFillAbortRef.current?.abort();
        initialFillAbortRef.current = null;
        const timeoutId = olderLoadSpinnerDelayTimeoutRef.current;
        if (timeoutId) {
            olderLoadSpinnerDelayTimeoutRef.current = null;
            clearTimeout(timeoutId);
        }
        const nativeFirstPaintFallbackReleaseTimeout = nativeFirstPaintFallbackReleaseTimeoutRef.current;
        if (nativeFirstPaintFallbackReleaseTimeout) {
            nativeFirstPaintFallbackReleaseTimeoutRef.current = null;
            clearTimeout(nativeFirstPaintFallbackReleaseTimeout.timeoutId);
        }
        const nativeEntryRestorePaintReleaseTimeout = nativeEntryRestorePaintReleaseTimeoutRef.current;
        if (nativeEntryRestorePaintReleaseTimeout) {
            nativeEntryRestorePaintReleaseTimeoutRef.current = null;
            clearTimeout(nativeEntryRestorePaintReleaseTimeout.timeoutId);
        }
        lifecycleHost.resetMountSettle({ reason: 'unmount' });
        invalidateNativePrependOwnerRef.current();
        lastNativeRestoreIndexCommandRef.current = null;
    }, []);
    React.useEffect(() => {
        return () => {
            applyUnmountCleanup();
        };
    }, [applyUnmountCleanup]);
    // Web unmount detaches the DOM before passive cleanup; route-jump promotion
    // needs one last metrics read while the exiting scroller still exists.
    React.useLayoutEffect(() => {
        return () => {
            flushPendingJumpSeqViewportPromotionForExitRef.current();
        };
    }, []);
    const pinEnabled = transcriptScrollPinEnabled !== false;
    const pinThresholdPx =
        typeof transcriptScrollPinOffsetThresholdPx === 'number' && Number.isFinite(transcriptScrollPinOffsetThresholdPx)
            ? Math.max(0, Math.trunc(transcriptScrollPinOffsetThresholdPx))
            : 72;
    const pinEnabledRef = React.useRef(pinEnabled);
    useCommittedTranscriptRef(pinThresholdPxRef, pinThresholdPx);
    useCommittedTranscriptRef(pinEnabledRef, pinEnabled);
    const targetWindowActiveRef = React.useRef(false);
    const activeTargetWindowTargetRef = React.useRef<TranscriptJumpTarget | null>(null);
    const targetWindowEdgeLoadInFlightRef = React.useRef<'older' | 'newer' | null>(null);
    const {
        readCurrentNativeDistanceFromBottom,
        readViewportContentMetrics,
        readViewportVisibleSourceRange,
        resolveNativeObservedScrollOffset,
        resolveViewportReachedEdge,
    } = useNativeFactSource({
        canonicalWindowedItemsRef,
        listContentHeightRef,
        listDataRef,
        listLayoutHeightRef,
        listRef,
        platformOS: Platform.OS,
        renderWindowIndexMapRef,
    });
    const isCatchingUpNewer = useSessionCatchingUpNewer(props.sessionId);
    // Tail-reset discontinuity floor: bounds the tail display to content contiguous with
    // the live tail while an older-page walk is filling a catch-up hole.
    const tailContiguousFloorSeq = useSessionTailContiguousFloorSeq(props.sessionId);
    const listOrientation: TranscriptListOrientation = resolveTranscriptListPresentation({
        platformIsWeb: Platform.OS === 'web',
    }).orientation;
    const resolveSyncLoadOlderOptions = React.useCallback((): TranscriptPrependOlderLoadSyncOptions | undefined => {
        if (Platform.OS === 'web') return undefined;
        const configuredLimit = sync.getSyncTuning().transcriptNativeOlderMessagesPageSize;
        if (typeof configuredLimit !== 'number' || !Number.isFinite(configuredLimit)) return undefined;
        return { limit: Math.max(1, Math.trunc(configuredLimit)) };
    }, []);
    const [firstListPaintObserved, setFirstListPaintObserved] = React.useState(false);
    const [nativeViewportPaintObserved, setNativeViewportPaintObservedState] = React.useState(false);
    const nativeViewportPaintObservedRef = React.useRef(false);
    const updateNativeViewportPaintObserved = React.useCallback((observed: boolean) => {
        if (Platform.OS === 'web') return;
        nativeViewportPaintObservedRef.current = observed;
        setNativeViewportPaintObservedState(observed);
    }, []);
    const {
        nativeEntryRestorePaintReleased,
        releaseNativePaintForIssuedEntryRestore,
        scheduleNativePaintReleaseForEntryRestore,
        updateNativeEntryRestorePaintReleased,
    } = useTranscriptNativeEntryRestorePaintRelease({
        currentSessionIdRef,
        entryRestoreOwner,
        nativeEntryRestorePaintReleaseTimeoutRef,
        nativeViewportPaintObservedRef,
        platformOS: Platform.OS,
        readViewportContentMetrics,
        sessionActive: props.sessionActive,
        sessionEntryViewportRef,
        sessionId: props.sessionId,
    });
    const telemetryHost = useTranscriptTelemetryHost({
        platformOS: Platform.OS,
        sessionId: props.sessionId,
    });
    const {
        clearWebStablePaintRetry,
        firstPaintTelemetryRef,
        scheduleWebStablePaintRetry,
        stablePaintTelemetryRef,
        webStablePaintRetryTick,
    } = telemetryHost;
    const tuning = sync.getSyncTuning();
    const itemsPipeline = useTranscriptItemsPipeline({
        activeTargetWindowTargetRef,
        activeThinkingMessageId: props.activeThinkingMessageId,
        canonicalWindowedItemsRef,
        committedMessagesCount: props.committedMessagesCount,
        expandedToolCallsAnchorMessageIds,
        forkMessageMetadataById: props.forkMessageMetadataById,
        groupingMode: props.groupingMode,
        isLoaded: props.isLoaded,
        items: props.items,
        itemsRef,
        latestCommittedActivityKey: props.latestCommittedActivityKey,
        listDataRef,
        listOrientation,
        messagesById: props.messagesById,
        preDecompositionItemsRef,
        renderWindowIndexMapRef,
        resolveThinkingExpanded,
        rowFontScaleKey: resolveFontScaleKey(),
        rowWidthBucket: listLayoutWidthBucket,
        sessionActive: props.sessionActive,
        sessionId: props.sessionId,
        sessionThinking: props.sessionThinking,
        tailContiguousFloorSeq,
        targetWindowActiveRef,
        transcriptToolCallsCollapsedPreviewCountSetting,
    });
    const {
        buildRowShellSignature,
        decomposedItems,
        displayItems,
        getItemType,
        getTurnMessageById,
        getTurnMessageRevisionById,
        isViewportAnchorSeqLoaded,
        keyExtractor,
        listData,
        renderWindowProjection,
        resolveEntryRestoreOwnerAnchor,
        resolveKindForMessageId,
        resolveNearestSurvivingViewportAnchorIndex,
        resolveNearestSurvivingViewportAnchorIndexFromItems,
        resolveRestoreAnchorRendererTargetFromLoadedItems,
        resolveSeqForMessageId,
        resolveSeqForViewportAnchor,
        resolveTargetWindowItemSeq,
        resolveToolCallMessagesForIds,
        targetWindowActive,
        targetWindowHostFacts,
    } = itemsPipeline;
    const resolveRendererDataTarget = React.useCallback((
        command: Extract<TranscriptViewportCommand, Readonly<{ kind: 'restore-anchor' | 'jump-to-seq' }>>,
    ): TranscriptRendererDataTarget | null => {
        if (command.kind === 'restore-anchor') {
            return resolveRestoreAnchorRendererTargetFromLoadedItems(command.target.anchor);
        }
        const displayIndex = command.routeMessageId
            ? resolveJumpToSeqIndexForCommandRef.current(
                command.seq,
                command.routeMessageId,
                command.transcriptBlockIndex,
                command.role,
            )
            : resolveJumpToSeqIndexForCommandRef.current(command.seq);
        return displayIndex == null
            ? null
            : renderWindowIndexMapRef.current?.resolveRendererTargetForDisplayIndex(displayIndex) ?? null;
    }, [resolveRestoreAnchorRendererTargetFromLoadedItems]);
    React.useEffect(() => {
        setFirstListPaintObserved(false);
        updateNativeViewportPaintObserved(false);
        updateNativeEntryRestorePaintReleased(false);
        nativeVisibleWindowSnapshotRef.current = null;
        lastNativeVisibleRowsSnapshotRef.current = null;
    }, [
        props.sessionId,
        updateNativeEntryRestorePaintReleased,
        updateNativeViewportPaintObserved,
    ]);
    React.useEffect(() => {
        return () => {
            clearStreamingSessionUiTelemetryMarks(props.sessionId);
            clearTranscriptNavigationVisibilityStore(props.sessionId);
        };
    }, [props.sessionId]);
    const applyBlankRecoveryEffects = React.useCallback((effects: readonly TranscriptBlankRecoveryEffect[]): void => {
        for (const effect of effects) {
            if (effect.type === 'request-bottom-follow-write') {
                authorizeImmediateBottomFollowWriteRef.current(effect.writer, effect.reason);
                continue;
            }
            if (effect.type === 'request-anchor-restore') {
                attemptEntryRestoreRef.current();
            }
        }
    }, []);
    const {
        handleNativeViewableItemsChanged,
        nativeViewabilityConfig,
        observeNativeBlankRecovery,
        recordNativeVisibleWindowTelemetry,
        recordRestoreDecisionTelemetry,
        recordScrollObservedTelemetry,
        recordViewportTelemetryEvent,
        resolveNativeTelemetryDiagnostics,
        resolveNativeVisibleWindowSnapshot,
        resolveViewportTelemetryMode,
        shouldAttachNativeViewability,
        telemetryPlatform,
    } = useTranscriptViewportTelemetryEvents({
        applyBlankRecoveryEffects,
        bottomFollowModeStateRef,
        entryRestoreOwner,
        getBottomFollowGestureActiveRef,
        items: displayItems,
        lastNativeVisibleRowsSnapshotRef,
        listContentHeightRef,
        listData,
        listLayoutHeightRef,
        listRef,
        nativeMomentumScrollActiveRef,
        nativePrependTelemetryStateRef,
        nativeVisibleWindowSnapshotRef,
        platformOS: Platform.OS,
        readViewportVisibleSourceRange,
        resolveNativeObservedScrollOffset,
        resolveWebScrollMetrics,
        resolveWebViewportTelemetryDiagnostics,
        observeTranscriptNavigationVisibilityRef,
        sessionId: props.sessionId,
        wantsPinnedRef,
    });
    const hasOpenEntryRestoreTransactionForSession = React.useCallback(() => (
        entryRestoreOwner.hasOpenTransaction(props.sessionId)
    ), [entryRestoreOwner, props.sessionId]);
    const hasOpenNativePrependTransactionForSession = React.useCallback((): boolean => (
        hasOpenNativePrependTransactionForSessionRef.current()
    ), []);
    const {
        handleRowShellMeasured,
    } = useTranscriptMeasurementHostWiring({
        getItemType,
        listData,
        listDataRef,
        listLayoutHeightRef,
        listRef,
        recordViewportTelemetryEvent,
        resolveViewportTelemetryMode,
        sessionId: props.sessionId,
    });
    // Which chrome the tool rows paint. Resolved through the ROW RENDERERS' own owner
    // (`resolveToolCallsGroupChromeVariant`, the same call every tool-group unit row makes) so
    // the estimate below consumes one decision instead of re-deriving a second one from the
    // underlying settings: in `cards` mode a tool row paints a whole ToolView card, not the
    // single-line timeline row the flat estimate was calibrated on.
    const toolCallsGroupChromeVariant = React.useMemo(
        () => resolveToolCallsGroupChromeVariant(props.toolChromeCommon),
        [props.toolChromeCommon],
    );
    // Renderer size estimates come from the app's own measured-height cache: a prior
    // exact measurement beats the renderer's average-size learning for rows it has
    // not mounted yet (legend-list#492; live reopen/switch-back oscillation captures
    // 2026-07-22/23). Unknown rows return undefined and keep the renderer fallback.
    const getEstimatedItemSize = React.useCallback((item: ChatTranscriptListItem): number | undefined => (
        estimateTranscriptRowHeightFromCache({
            reconciler: measurementReconciler,
            signature: buildRowShellSignature(item),
        }) ?? estimateTranscriptRowHeightFromContent({
            getMessageById: getTurnMessageById,
            item,
            toolCallsGroupChromeVariant,
        })
    ), [buildRowShellSignature, getTurnMessageById, measurementReconciler, toolCallsGroupChromeVariant]);
    const getItemSizeVersion = React.useCallback((item: ChatTranscriptListItem): React.Key => (
        buildTranscriptItemHeightSignatureKey(buildRowShellSignature(item))
    ), [buildRowShellSignature]);
    const prependHostDeps = React.useMemo(() => ({
        commandHostRef,
        currentSessionId: props.sessionId,
        listContentHeight,
        listContentHeightRef,
        listDataLength: listData.length,
        listDataRef,
        listLayoutHeightRef,
        listRef,
        preemptEntryRestoreTransaction,
        recordViewportTelemetryEvent,
        viewportCommandController,
        wantsPinnedRef,
    }), [
        listContentHeight,
        listData.length,
        preemptEntryRestoreTransaction,
        props.sessionId,
        recordViewportTelemetryEvent,
        viewportCommandController,
    ]);
    const prependHost = useTranscriptPrependHost(prependHostDeps);
    const invalidateNativePrependOwner = React.useCallback(
        () => prependHost.invalidateNativeTransaction(),
        [prependHost],
    );
    const hasOpenNativePrependTransactionForSessionBridge = React.useCallback(
        () => prependHost.hasOpenNativeTransaction(),
        [prependHost],
    );
    const resolveNativePrependTelemetryState = React.useCallback(
        () => prependHost.nativeTelemetryState(),
        [prependHost],
    );
    const closeNativePrependForTrustedScroll = React.useCallback(() => {
        prependHost.applyNativeEffects(prependHost.trustedNativeScroll({
            activeOwner: viewportCommandController.activeOwner(),
            sessionId: props.sessionId,
        }));
    }, [prependHost, props.sessionId, viewportCommandController]);
    useCommittedTranscriptRef(observeNativePrependOwnerRef, prependHost.observeNative);
    useCommittedTranscriptRef(invalidateNativePrependOwnerRef, invalidateNativePrependOwner);
    useCommittedTranscriptRef(
        hasOpenNativePrependTransactionForSessionRef,
        hasOpenNativePrependTransactionForSessionBridge,
    );
    useCommittedTranscriptRef(nativePrependTelemetryStateRef, resolveNativePrependTelemetryState);
    useCommittedTranscriptRef(
        closeNativePrependForTrustedScrollRef,
        closeNativePrependForTrustedScroll,
    );
    const nativePrependTransactionRevision = prependHost.getNativeTransactionRevision();
    const viewportDriverDeps = React.useMemo<TranscriptViewportDriverDeps>(() => ({
            listRef,
            listContentHeightRef,
            listLayoutHeightRef,
            listDataRef,
            lastPinOffsetForIntentRef,
            webDomObservation,
            lastNativeRestoreIndexCommandRef,
            nativeMountSettleStable,
            telemetryPlatform,
            resolveRendererDataTarget,
            resolveWebScrollMetrics,
            recordViewportTelemetryEvent,
            recordRestoreDecisionTelemetry,
            resolveWebViewportTelemetryDiagnostics,
        }), [
            nativeMountSettleStable,
            recordRestoreDecisionTelemetry,
            recordViewportTelemetryEvent,
            resolveRendererDataTarget,
            resolveWebViewportTelemetryDiagnostics,
            resolveWebScrollMetrics,
            telemetryPlatform,
            webDomObservation,
        ]);
    const {
        executeViewportCommand,
        executeViewportCommandWithAnimation,
        resolveViewportCommand,
        restoreWebViewportAnchorThroughViewportCommand,
    } = useTranscriptViewportCommandHostWiring({
        commandHostRef,
        driverDeps: viewportDriverDeps,
        platformOS: Platform.OS,
        sessionId: props.sessionId,
        viewportCommandController,
    });
    const adoptNativeFollowingForTrustedBottomArrival = React.useCallback((distanceFromBottom: number | null) => {
        adoptNativeFollowingForTrustedBottomArrivalRef.current(distanceFromBottom);
    }, []);
    const applyNativeExplicitJumpConfirmationEffects = React.useCallback((
        effects: readonly NativeExplicitJumpConfirmationEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) {
                continue;
            }
            if (effect.type === 'adopt-live-tail-arrival') {
                adoptNativeFollowingForTrustedBottomArrival(effect.distanceFromBottom);
                continue;
            }
            if (effect.type === 'issue-reconfirm-jump-to-bottom') {
                executeViewportCommandWithAnimation(resolveViewportCommand({
                    type: 'jump-to-bottom',
                    sessionId: props.sessionId,
                }), false);
            }
        }
    }, [
        adoptNativeFollowingForTrustedBottomArrival,
        executeViewportCommandWithAnimation,
        props.sessionId,
        resolveViewportCommand,
    ]);
    const {
        observeMountSettleMetrics,
        recordLayoutCommitObserved,
        shouldCommitContentHeightState,
    } = useTranscriptNativeMountSettleLifecycle({
        composerInsetHeightRef,
        jumpToSeqActive: props.jumpToSeq != null,
        lastPinOffsetForIntentRef,
        lifecycleHost,
        listContentHeightRef,
        listLayoutHeightRef,
        nativeMountSettleDeadlineReachedRef,
        platformOS: Platform.OS,
        scheduleNativePaintReleaseForEntryRestore,
        sessionId: props.sessionId,
        sessionOpenLatch,
        setNativeMountSettleDeadlineReached,
        setNativeMountSettleStable,
    });
    const paintTelemetry = useTranscriptPaintTelemetry({
        clearWebStablePaintRetry,
        committedMessagesCount: props.committedMessagesCount,
        firstListPaintObserved,
        firstPaintTelemetryRef,
        isWarmKeepAliveInstanceProp: props.isWarmKeepAliveInstance === true,
        itemCount: listData.length,
        lastPinOffsetForIntentRef,
        latestCommittedActivityKey: props.latestCommittedActivityKey,
        listDataRef,
        nativeMountSettleDeadlineReached,
        nativeMountSettleStable,
        observeMountSettleMetrics,
        platformOS: Platform.OS,
        readViewportContentMetrics,
        recordMountSettleFirstListPaint: lifecycleHost.recordMountSettleFirstListPaint,
        recordNativeVisibleWindowTelemetry,
        releaseNativePaintForIssuedEntryRestore,
        resolveWebScrollMetrics,
        routeHydrationPending: props.routeHydrationPending === true,
        sessionId: props.sessionId,
        setFirstListPaintObserved,
        stablePaintTelemetryRef,
        telemetryPlatform,
    });
    const {
        handleListLoad,
        isWarmKeepAliveInstance,
        recordFirstListPaint,
        recordStablePaintTelemetry,
        resolveEffectiveListPaintMetrics,
    } = paintTelemetry;
    const mainTranscriptListShellFrame = useMainTranscriptRendererFrameHost({
        chatListNativeId,
        layoutHeight: listLayoutHeight,
        pinThresholdPx,
        platformOS: Platform.OS,
        sessionEntryShouldFollowBottom: entryShouldFollowBottomForRender,
    });
    const toolTimelineChromeMode = useSetting('toolViewTimelineChromeMode');
    const initialRichContentPresentationEnabled =
        Platform.OS === 'web' &&
        props.isLoaded &&
        listData.length > 0;
    const initialRichContentPresentationIdentity =
        `${props.sessionId}\0${initialRichContentPresentationEnabled ? 'enabled' : 'disabled'}`;
    const initialRichContentPresentationControllerRef = React.useRef<Readonly<{
        controller: InitialRichContentPresentationController;
        identity: string;
    }> | null>(null);
    if (
        initialRichContentPresentationControllerRef.current == null
        || initialRichContentPresentationControllerRef.current.identity
            !== initialRichContentPresentationIdentity
    ) {
        initialRichContentPresentationControllerRef.current = {
            controller: createInitialRichContentPresentationController({
                enabled: initialRichContentPresentationEnabled,
                generation: props.sessionId,
            }),
            identity: initialRichContentPresentationIdentity,
        };
    }
    const initialRichContentPresentationController =
        initialRichContentPresentationControllerRef.current.controller;
    const initialRichContentPresentationSnapshot = React.useSyncExternalStore(
        initialRichContentPresentationController.subscribe,
        initialRichContentPresentationController.getSnapshot,
        initialRichContentPresentationController.getSnapshot,
    );
    const firstPaintState = useTranscriptFirstPaintState({
        applySessionOpenLatchEffectsRef,
        currentSessionIdRef,
        entryAnchorForRender,
        entryRestoreOwner,
        firstListPaintObserved,
        initialRichContentPresentationReady:
            initialRichContentPresentationSnapshot.phase === 'released',
        isLoaded: props.isLoaded,
        isWarmKeepAliveInstance,
        itemCount: listData.length,
        jumpToSeqActive: props.jumpToSeq != null,
        lastPinOffsetForIntentRef,
        nativeEntryRestorePaintReleased,
        nativeFirstPaintFallbackReleaseTimeoutRef,
        nativeInitialViewportPendingObservation,
        nativeMountSettleDeadlineReached,
        nativeMountSettleStable,
        nativeViewportPaintObserved,
        nativeViewportPaintObservedRef,
        pinThresholdPx,
        platformOS: Platform.OS,
        routeHydrationPending: props.routeHydrationPending === true,
        sessionId: props.sessionId,
        sessionOpenLatch,
        transcriptInitialFillBudgetMs: sync.getSyncTuning().transcriptInitialFillBudgetMs,
        transcriptMountSettleQuiescentWindowMs: sync.getSyncTuning().transcriptMountSettleQuiescentWindowMs,
    });
    const {
        canCloseInitialRichContentDiscovery,
        nativeFirstPaintReleasedWithoutListLoad,
        onEntryPlacementEvent,
        recordEntryOwnerOutcome,
        resetFirstPaintRevealRecordForSessionEntry,
        showFirstPaintPlaceholder,
        showRouteHydrationFirstPaintPlaceholder,
    } = firstPaintState;
    React.useLayoutEffect(() => {
        if (!canCloseInitialRichContentDiscovery) return;
        initialRichContentPresentationController.closeDiscovery();
    }, [
        canCloseInitialRichContentDiscovery,
        initialRichContentPresentationController,
    ]);
    React.useEffect(() => {
        if (initialRichContentPresentationSnapshot.phase !== 'waiting-renderer') return undefined;
        const observeSettlement = listRef.current?.observeInitialPresentationSettlement;
        if (typeof observeSettlement !== 'function') return undefined;
        const request = {
            dataKey: initialRichContentPresentationSnapshot.generation,
            revision: initialRichContentPresentationSnapshot.revision,
        };
        return observeSettlement({
            ...request,
            onSettled: () => {
                initialRichContentPresentationController.releaseAfterRendererSettlement({
                    generation: request.dataKey,
                    revision: request.revision,
                });
            },
        });
    }, [
        initialRichContentPresentationController,
        initialRichContentPresentationSnapshot,
    ]);
    useTranscriptPaintTelemetryEffects({
        firstListPaintObserved,
        isWarmKeepAliveInstance,
        isLoaded: props.isLoaded,
        itemCount: listData.length,
        listContentHeight,
        listLayoutHeight,
        nativeFirstPaintReleasedWithoutListLoad,
        nativeEntryRestorePaintReleased,
        nativeMountSettleDeadlineReached,
        nativeMountSettleStable,
        nativeViewportPaintObserved,
        nativeViewportPaintObservedRef,
        pinThresholdPx,
        recordFirstListPaint,
        recordStablePaintTelemetry,
        resolveEffectiveListPaintMetrics,
        routeHydrationPending: props.routeHydrationPending === true,
        scheduleWebStablePaintRetry,
        sessionEntryViewportRef,
        sessionId: props.sessionId,
        showFirstPaintPlaceholder,
        showRouteHydrationFirstPaintPlaceholder,
        webStablePaintRetryTick,
    });
    // S-E route-pop blank (live native capture 2026-07-11): a pushed route (tool details)
    // covers the transcript screen; a scroll write settled while covered can fail to become
    // native truth, and no scroll event arrives on reveal, so the renderer keeps computing
    // its mounted window for a believed offset the native view is not displaying — a
    // persistent blank region only the user's first swipe healed. On focus-return, ask the
    // renderer to re-observe the natively displayed offset (Legend-only seam; FlashList and
    // web never implement it).
    const sessionScreenFocused = useSessionScreenIsFocused();
    const sessionScreenWasBlurredRef = React.useRef(false);
    React.useEffect(() => {
        if (!sessionScreenFocused) {
            sessionScreenWasBlurredRef.current = true;
            return;
        }
        if (!sessionScreenWasBlurredRef.current) return;
        sessionScreenWasBlurredRef.current = false;
        revalidateViewportAfterReveal();
    }, [revalidateViewportAfterReveal, sessionScreenFocused]);
    // Row-local toggles (tool ROW inline expand/collapse, thinking) commit giant in-viewport
    // height changes without passing the group-toggle choke point. Under renderer-owned
    // local height restore (default Legend) this notification is the pre-commit seam that
    // covers them all: arm the renderer's ONE keyed visible-anchor hold before delegating to
    // the measurement host (live native S-C continuation 2026-07-11: a row expansion parked
    // the viewport hours away with no hold armed).
    const handleRowLayoutMutationWithViewportOwnership = React.useCallback((rowMutation: Readonly<{
        itemId: string;
        mutation: TranscriptRowLayoutMutation;
        rowKind: string;
    }>) => {
        const ownershipAction = resolveRowLayoutMutationViewportOwnershipAction({
            reason: rowMutation.mutation.reason,
        });
        if (ownershipAction === 'arm-visible-anchor-hold') {
            listRef.current?.armVisibleAnchorHold?.();
        }
    }, []);
    const itemRenderer = useTranscriptItemRenderer({
        buildRowShellSignature,
        expandedToolCallsAnchorMessageIds,
        getMessageById: getTurnMessageById,
        getMessageRevisionById: getTurnMessageRevisionById,
        handleRowLayoutMutation: handleRowLayoutMutationWithViewportOwnership,
        handleRowShellMeasured,
        itemsRef,
        listData,
        listOrientation,
        measurementReconciler,
        props,
        resolveKindForMessageId,
        resolveThinkingExpanded,
        resolveToolCallMessagesForIds,
        setThinkingExpanded,
        setToolCallsGroupExpanded,
        toolRouteCommon: props.toolRouteCommon,
        toolTimelineChromeMode,
    });
    const { renderItem, renderTranscriptItemAtIndex } = itemRenderer;
    const transcriptListExtraData = React.useMemo(
        () => [renderItem, transcriptMessageSelection.selectionVersion] as const,
        [renderItem, transcriptMessageSelection.selectionVersion],
    );
    const viewportAnchorCaptureHost = useTranscriptViewportAnchorCaptureHost({
        cancelScheduledViewportAnchorCapture,
        currentSessionIdRef,
        debounceMs: sync.getSyncTuning().transcriptViewportAnchorCaptureDebounceMs,
        emitViewportChange,
        isEntryViewportCommandActive,
        listDataRef,
        listLayoutHeightRef,
        listRef,
        pinThresholdPx,
        readCurrentNativeDistanceFromBottom,
        recordViewportTelemetryEvent,
        resolveWebScrollMetrics,
        scheduledViewportAnchorCaptureRef,
        shouldSuppressGenericViewportStateForProtectedJumpSeq: shouldSuppressGenericViewportStateForAnchorCapture,
        viewportAnchorCaptureGenerationRef,
        wantsPinnedRef,
    });
    useCommittedTranscriptRef(
        scheduleViewportAnchorCaptureRef,
        viewportAnchorCaptureHost.schedule,
    );
    React.useLayoutEffect(() => {
        flushViewportAnchorCaptureRef.current = viewportAnchorCaptureHost.flush;
    }, [viewportAnchorCaptureHost.flush]);
    React.useLayoutEffect(() => {
        captureViewportAtExitRef.current = viewportAnchorCaptureHost.captureAtExit;
    }, [viewportAnchorCaptureHost.captureAtExit]);
    const observeNativePrependOwner = prependHost.observeNative;
    const loadOlder = useCallback(async (options: TranscriptPrependOlderLoadOptions = {}): Promise<TranscriptPrependOlderLoadResult | null> => {
        const loadOlderOptions = options.preservePrependViewport === undefined
            ? { ...options, preservePrependViewport: false }
            : options;
        return await runTranscriptPrependOlderLoad({
            clearOlderLoadSpinnerDelay,
            hasMoreOlder,
            hasMoreOlderRef,
            hideOlderLoadSpinner,
            isReady: props.isLoaded || props.forkedTranscriptEnabled === true,
            loadOlderInFlight,
            loadOlderMessages: async (syncLoadOlderOptions) => props.forkedTranscriptEnabled
                ? (syncLoadOlderOptions
                    ? await sync.loadOlderMessagesForkAware(props.sessionId, syncLoadOlderOptions)
                    : await sync.loadOlderMessagesForkAware(props.sessionId))
                : (syncLoadOlderOptions
                    ? await sync.loadOlderMessages(props.sessionId, syncLoadOlderOptions)
                    : await sync.loadOlderMessages(props.sessionId)),
            olderLoadSpinnerDelayTimeoutRef,
            options: loadOlderOptions,
            prependHost,
            resolveSyncLoadOlderOptions: () => resolveSyncLoadOlderOptions() ?? null,
            setHasMoreOlder,
            setIsLoadingOlder,
            showOlderLoadSpinner,
        });
    }, [
        clearOlderLoadSpinnerDelay,
        hasMoreOlder,
        hideOlderLoadSpinner,
        pinThresholdPx,
        prependHost,
        props.committedMessagesCount,
        props.forkedTranscriptEnabled,
        props.isLoaded,
        props.sessionId,
        resolveSyncLoadOlderOptions,
        showOlderLoadSpinner,
    ]);
    const paginationLoadOlder = React.useCallback(async () => {
        if (hasMoreOlderRef.current === false) {
            return { loaded: 0, hasMore: false, status: 'no_more' as const };
        }
        // The hook owns pacing and the loading indicator (plan D2/D3).
        return await loadOlder({ showLoadingIndicator: false });
    }, [loadOlder]);
    const olderPagination = useTranscriptOlderPagination({
        enabled: true,
        loadOlder: paginationLoadOlder,
        thresholdPx: resolveBackwardPrefetchThresholdPx(listLayoutHeight),
        thresholdItems: sync.getSyncTuning().transcriptBackwardPrefetchThresholdItems,
        cooldownMs: sync.getSyncTuning().transcriptOlderLoadCooldownMs,
        spinnerDelayMs: sync.getSyncTuning().transcriptOlderLoadSpinnerDelayMs,
        isFillDone: () => sessionOpenLatch.initialFillStatus() === 'done',
        isTransactionOpen: () => viewportCommandController.activeOwner() !== 'follow',
    });
    useCommittedTranscriptRef(
        olderPaginationSnapshotRef,
        olderPagination.getSnapshot(),
    );
    useCommittedTranscriptRef(resetOlderPaginationRef, olderPagination.reset);
    const tryPinToBottomDom = React.useCallback((): boolean => {
        return executeViewportCommand(resolveViewportCommand({
            type: 'jump-to-bottom',
            sessionId: props.sessionId,
        }));
    }, [
        executeViewportCommand,
        props.sessionId,
        resolveViewportCommand,
    ]);
    const bottomFollowHost = useTranscriptBottomFollowHost({
        applyFollowBottomIntentTakeoverApplyEffects,
        applyNativeExplicitJumpConfirmationEffects,
        authorizeImmediateBottomFollowWriteRef,
        commitBottomFollowModeState,
        commitExplicitReturnToLiveTailState,
        commitScrollPinState,
        currentBottomFollowModeStateRef: bottomFollowModeStateRef,
        executeViewportCommand,
        followBottomIntentKey: props.followBottomIntentKey,
        invalidateViewportAnchorCapture,
        isPinnedRef,
        latestCommittedActivityKey: props.latestCommittedActivityKey,
        lifecycleHost,
        nativeMountSettleDeadlineReachedRef,
        pinEnabled,
        pinThresholdPx,
        resolveViewportCommand,
        scrollPinRef,
        sessionId: props.sessionId,
        tryPinToBottomDom,
        userScrollIntent,
        wantsPinnedRef,
    });
    const {
        beginExplicitJumpWriteBarrier,
        endExplicitJumpWriteBarrier,
        observeNativeConfirmation,
        pinToBottom,
    } = bottomFollowHost;
    useCommittedTranscriptRef(
        applyNativeDragActiveMirrorEffectsRef,
        bottomFollowHost.applyNativeDragActiveMirrorEffects,
    );
    useCommittedTranscriptRef(
        getBottomFollowGestureActiveRef,
        bottomFollowHost.getGestureActive,
    );
    // Stable identity wrapper: `isScrollable` is declared later in this component (TDZ), and an
    // inline arrow here would churn the entry host's session-open effect deps on every render.
    const isScrollableRef = React.useRef<() => boolean>(() => false);
    const isScrollableForEntryHost = React.useCallback((): boolean => isScrollableRef.current(), []);
    const entryHost = useTranscriptEntryHost({
        activeTargetWindowTargetRef,
        anchorLookupExhaustedRef,
        anchorLookupInFlightRef,
        anchorLookupLoadCountRef,
        applyEntryRestoreOwnerEffectsRef,
        applySessionOpenArmResetPlan,
        applySessionOpenDisposeResetPlan,
        applySessionOpenLatchEffectsRef,
        attemptEntryRestoreRef,
        closeEntryViewportOwnership,
        committedMessagesCount: props.committedMessagesCount,
        composerInsetHeightRef,
        currentSessionIdRef,
        decomposedItems,
        displayItemsLength: displayItems.length,
        disposeEntryRestoreTransactionForExitRef,
        entryRestoreDeadlineTimeoutRef,
        entryRestoreOwner,
        executeViewportCommand,
        hasNativeContentMeasurementForCurrentSession,
        initialFillAbortRef,
        invalidateViewportAnchorCapture,
        isLoaded: props.isLoaded,
        isScrollable: isScrollableForEntryHost,
        isViewportAnchorSeqLoaded,
        jumpToSeq: props.jumpToSeq,
        lastScrollOffsetForIntentRef,
        lastUserScrollIntentAtMsRef,
        latestJumpToSeqRef,
        userScrollIntent,
        listContentHeight,
        listContentHeightRef,
        listDataLength: listData.length,
        listDataRef,
        listLayoutHeight,
        listLayoutHeightRef,
        listRef,
        loadOlder,
        markNativeInitialViewportAppliedForCurrentSession,
        nativeMountSettleDeadlineReachedRef,
        nativeMountSettleStable,
        observeMountSettleMetrics,
        pinThresholdPx,
        recordEntryOwnerOutcome,
        recordRestoreDecisionTelemetry,
        recordViewportTelemetryEvent,
        renderWindowProjection,
        resolveEntryRestoreOwnerAnchor,
        resolveNearestSurvivingViewportAnchorIndex,
        resolveNearestSurvivingViewportAnchorIndexFromItems,
        resolveSeqForViewportAnchor,
        resolveViewportCommand,
        resolveWebScrollMetrics,
        restoreWebViewportAnchorThroughViewportCommand,
        scheduleNativePaintReleaseForEntryRestore,
        sessionEntryViewportRef,
        sessionId: props.sessionId,
        sessionOpenLatch,
        setNativeMountSettleDeadlineReached,
        updateNativeInitialViewportPendingObservation,
        updateNativeViewportPaintObserved,
        wantsPinnedRef,
    });
    const {
        applyEntryRestoreOwnerEffects,
        applySessionOpenLatchEffects,
        observeNativeEntryRestoreHostFacts,
        runEntryRestoreAttempt,
        verifyWebEntryRestoreTransaction,
    } = entryHost;
    const onSuccessfulRouteJumpSettled = React.useCallback((settledSessionId: string): void => {
        if (!sessionOpenLatch.onJumpEntrySettled({ sessionId: settledSessionId })) return;
        observeCommittedProjectionLayoutRef.current();
    }, [sessionOpenLatch]);
    const jumpHost = useTranscriptJumpHost({
        activeTargetWindowTargetRef,
        applyExplicitJumpTakeoverApplyEffects,
        beginExplicitJumpWriteBarrier,
        canonicalWindowedItemsRef,
        committedMessagesCount: props.committedMessagesCount,
        commitBottomFollowModeState,
        commitExplicitReturnToLiveTailState,
        commitScrollPinState,
        currentSessionIdRef,
        emitViewportChange,
        endExplicitJumpWriteBarrier,
        executeViewportCommand,
        executeViewportCommandWithAnimation,
        forkedTranscriptEnabled: props.forkedTranscriptEnabled,
        hasMoreOlderRef,
        invalidateViewportAnchorCapture,
        isLoaded: props.isLoaded,
        isPinnedRef,
        itemsRef,
        jumpToSeq: props.jumpToSeq,
        lastPinOffsetForIntentRef,
        lastNativeRestoreIndexCommandRef,
        lastRouteJumpProtectionClearingWebMovementAtMsRef,
        lastScrollOffsetForIntentRef,
        lifecycleHost,
        listContentHeight,
        listContentHeightRef,
        listData,
        listLayoutHeight,
        listRef,
        messagesById: props.messagesById,
        onJumpLanded: props.onJumpLanded,
        onSuccessfulRouteJumpSettled,
        onViewportChangeRef,
        pendingJumpSeqViewportPromotionRef,
        pinThresholdPx,
        pinThresholdPxRef,
        pinToBottom,
        platformOS: Platform.OS,
        promotedJumpSeqViewportProtectionRef,
        readCurrentNativeDistanceFromBottom,
        resolveJumpToSeqIndexForCommandRef,
        resolveSeqForMessageId,
        resolveSyncLoadOlderOptions,
        resolveTargetWindowItemSeq,
        resolveViewportCommand,
        resolveWebScrollMetrics,
        scrollPin,
        scrollPinRef,
        sessionId: props.sessionId,
        stampViewportAnchorForEmit,
        targetWindowHasMoreNewer: targetWindowHostFacts.hasMoreNewer,
        // The newer gap descriptor IS the adapter's answer to "is the live tail below what we
        // rendered" — an unexhausted newer cursor OR loaded rows the window range leaves out —
        // and it is the same fact that decides whether a newer gap row is rendered. The jump
        // affordance reads it so the pill and the gap row cannot disagree.
        targetWindowHasNewerBeyondRenderedWindow: targetWindowHostFacts.gaps.newer !== null,
        transcriptNavigationEntries: props.transcriptNavigationEntries,
        transcriptNavigationRuntimeAnchorsRef,
        waitForNextVisualUpdate,
        wantsPinnedRef,
    });
    const {
        commitJumpToBottomDistanceForVisibility,
        flushPendingJumpSeqViewportPromotionForExit,
        handleTranscriptNavigationPaneEntryPress,
        handleTranscriptNavigationRailJump,
        jumpToBottom,
        jumpToBottomAffordance,
        jumpToTranscriptTarget,
        observeTranscriptNavigationVisibilityForSession,
        onScrollToIndexFailed,
        promotePendingJumpSeqViewportSnapshot,
        shouldSuppressGenericViewportStateForProtectedJumpSeq,
    } = jumpHost;
    useCommittedTranscriptRef(
        shouldSuppressGenericViewportStateForProtectedJumpSeqRef,
        shouldSuppressGenericViewportStateForProtectedJumpSeq,
    );
    useCommittedTranscriptRef(
        commitJumpToBottomDistanceForVisibilityRef,
        commitJumpToBottomDistanceForVisibility,
    );
    useCommittedTranscriptRef(
        observeTranscriptNavigationVisibilityRef,
        observeTranscriptNavigationVisibilityForSession,
    );
    React.useLayoutEffect(() => {
        flushPendingJumpSeqViewportPromotionForExitRef.current = flushPendingJumpSeqViewportPromotionForExit;
    }, [flushPendingJumpSeqViewportPromotionForExit]);
    const isScrollable = React.useCallback((): boolean => {
        // On web, list content height can include collapsed/offscreen subtrees (e.g. tool-call group bodies),
        // which can cause false positives. Prefer DOM scroll metrics when available.
        if (Platform.OS === 'web') {
            try {
                const metrics = resolveWebScrollMetrics();
                if (metrics) {
                    return isWebTranscriptScrollable(metrics, 1);
                }
            } catch {
                // fall through to measurement-based heuristic
            }
        }
        const layout = listLayoutHeight;
        const content = listContentHeight;
        if (!Number.isFinite(layout) || layout <= 0) return false;
        if (!Number.isFinite(content) || content <= 0) return false;
        return content > layout + 16;
    }, [listContentHeight, listLayoutHeight, resolveWebScrollMetrics]);
    useCommittedTranscriptRef(isScrollableRef, isScrollable);
    const edgeReachedThresholdRatio = React.useMemo(() => {
        if (!Number.isFinite(listLayoutHeight) || listLayoutHeight <= 0) {
            return TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO;
        }
        const thresholdPx = resolveBackwardPrefetchThresholdPx(listLayoutHeight);
        if (thresholdPx <= 0) return 0;
        return thresholdPx / listLayoutHeight;
    }, [listLayoutHeight, resolveBackwardPrefetchThresholdPx]);
    useTranscriptToolAutoExpandEffect({
        applyToolCallsGroupExpanded,
        expandedToolCallsAnchorMessageIds,
        hasAutoExpandedToolCallsGroups: (sessionId) => sessionOpenLatch.hasAutoExpandedToolCallsGroups(sessionId),
        isScrollable,
        jumpToSeq: props.jumpToSeq,
        markAutoExpandedToolCallsGroups: (sessionId) => sessionOpenLatch.markAutoExpandedToolCallsGroups(sessionId),
        maxTurnEntriesPerListItem: props.maxTurnEntriesPerListItem,
        preDecompositionItemsRef,
        sessionId: props.sessionId,
        transcriptToolCallsCollapsedPreviewCountSetting,
    });
    const handleComposerInsetHeightChange = React.useCallback((height: number) => {
        const nextHeight = typeof height === 'number' && Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0;
        const previousHeight = composerInsetHeightRef.current;
        if (previousHeight === nextHeight) return;
        composerInsetHeightRef.current = nextHeight;
        setComposerInsetHeight(nextHeight);
        observeMountSettleMetrics();
        // Composer/keyboard inset resize is a write-authority event (S3): Legend remains the
        // sole continuous-follow writer. The host only reports that its usable viewport
        // geometry changed; the adapter re-targets iff its held-tail intent is still active,
        // and stays inert for a genuinely detached viewport.
        listRef.current?.notifyViewportGeometryChanged?.();
    }, [observeMountSettleMetrics]);
    const transcriptItemsEdgeSlots = useTranscriptItemsEdgeSlots({
        bottomNotice: props.bottomNotice,
        composerInsetHeight,
        controlSwitchTo: props.controlSwitchTo,
        controlledByUserOverride: props.controlledByUserOverride,
        externalControlFooter: props.externalControlFooter,
        handleComposerInsetHeightChange,
        isLoadingOlder,
        mainTranscriptListShellFrame,
        olderPaginationIsLoadingOlder: olderPagination.isLoadingOlder,
        onRequestSwitchToRemote: props.onRequestSwitchToRemote,
        renderTranscriptItemAtIndex,
        sessionId: props.sessionId,
        showCatchUpOverlay: isCatchingUpNewer,
        showFirstPaintPlaceholder,
        transcriptOlderLoadSpinnerDelayMs: sync.getSyncTuning().transcriptOlderLoadSpinnerDelayMs,
    });
    const scrollObservationHost = useTranscriptScrollObservationHost({
        activeTargetWindowTargetRef,
        applyBlankRecoveryEffects,
        applyEntryRestoreOwnerEffects,
        applyNativeBottomFollowCompletionHostEffects,
        applyNativeDragActiveMirrorEffectsRef,
        applyNativeUserScrollTakeoverHostEffects,
        bottomFollowModeStateRef,
        commitBottomFollowModeState,
        commitJumpToBottomDistanceForVisibility: commitJumpToBottomDistanceFromScrollObservation,
        commitScrollPinEvent: commitScrollPinEventFromScrollObservation,
        commitScrollPinState,
        composerInsetHeightRef,
        currentSessionIdRef,
        dispatchViewportLifecycleEvent,
        emitViewportChange,
        entryRestoreOwner,
        firstPaintTelemetryRef,
        getBottomFollowGestureActiveRef,
        hasNativeContentMeasurementForCurrentSession,
        hasNativeInitialViewportAppliedForCurrentSession,
        deferViewportAnchorCapture: viewportAnchorCaptureHost.defer,
        invalidateViewportAnchorCapture,
        isLoaded: props.isLoaded,
        isWarmKeepAliveInstance,
        lastExplicitWebScrollIntentAtMsRef,
        lastPinOffsetForIntentRef,
        lastRouteJumpProtectionClearingWebMovementAtMsRef,
        lastScrollOffsetForIntentRef,
        lastUserScrollIntentAtMsRef,
        latestCommittedActivityKey: props.latestCommittedActivityKey,
        lifecycleHost,
        listContentHeightRef,
        listDataRef,
        userScrollIntent,
        listLayoutHeightRef,
        listRef,
        loadOlderInFlightRef: loadOlderInFlight,
        markNativeInitialViewportAppliedForCurrentSession,
        measurementHost,
        nativeBottomFollowRearmedAfterDragRef,
        nativeListDragActiveRef,
        nativeMomentumScrollActiveRef,
        nativeMountSettleDeadlineReachedRef,
        nativeMountSettleStable,
        nativePrependTelemetryStateRef,
        nativeTranscriptTouchStartYRef,
        observeNativeBlankRecovery,
        observeNativeConfirmation,
        observeNativeEntryRestoreHostFacts,
        observeNativePrependOwner,
        observeMountSettleMetrics,
        observeTranscriptNavigationVisibility: observeTranscriptNavigationVisibilityForSession,
        olderPagination,
        pendingJumpSeqViewportPromotionRef,
        pinEnabled,
        pinEnabledRef,
        pinThresholdPx,
        pinThresholdPxRef,
        platformOS: Platform.OS,
        preemptEntryRestoreTransaction,
        prependHost,
        promotedJumpSeqViewportProtectionRef,
        promotePendingJumpSeqViewportSnapshot,
        readCurrentNativeDistanceFromBottom,
        recordFirstListPaint,
        recordListLayoutWidth,
        recordNativeVisibleWindowTelemetry,
        recordScrollObservedTelemetry,
        recordStablePaintTelemetry,
        recordViewportTelemetryEvent,
        resolveEffectiveListPaintMetrics,
        readItemsToOlderEdge: () => resolveItemsToOlderEdge(
            readViewportVisibleSourceRange(),
            renderWindowProjection.indexMap.windowContentItemCount,
        ),
        readItemsToNewerEdge: () => resolveItemsToNewerEdge(
            readViewportVisibleSourceRange(),
            renderWindowProjection.indexMap.windowContentItemCount,
        ),
        resolveNativeObservedScrollOffset,
        resolveTranscriptMountSettleBottomDistanceNoiseFloorPx: () =>
            resolveTranscriptMountSettleTuning().bottomDistanceNoiseFloorPx,
        resolveViewportReachedEdge,
        resolveViewportTelemetryMode,
        resolveWebScrollMetrics,
        resolveWebViewportTelemetryDiagnostics,
        routeJumpSeq: typeof props.jumpToSeq === 'number' && Number.isFinite(props.jumpToSeq)
            ? Math.trunc(props.jumpToSeq)
            : null,
        runEntryRestoreAttempt,
        scheduleViewportAnchorCaptureRef,
        scrollPinRef,
        sessionActive: props.sessionActive,
        sessionEntryViewportRef,
        sessionId: props.sessionId,
        shouldCommitContentHeightState,
        shouldIgnoreNativeInvalidScrollObservation,
        shouldSuppressGenericViewportStateForProtectedJumpSeq,
        showFirstPaintPlaceholder,
        targetWindowActiveRef,
        targetWindowEdgeLoadInFlightRef,
        targetWindowHostFacts,
        updateNativeViewportPaintObserved,
        updateNativeInitialViewportPendingObservation,
        userIntentRecentMs: TRANSCRIPT_SCROLL_USER_INTENT_RECENT_MS,
        verifyWebEntryRestoreTransaction,
        viewportCommandController,
        wantsPinnedRef,
        setListContentHeight,
        setListLayoutHeight,
    });
    useCommittedTranscriptRef(
        observeCommittedProjectionLayoutRef,
        scrollObservationHost.observeCommittedProjectionLayout,
    );
    const observeTranscriptListCommittedLayout = React.useCallback(() => {
        recordLayoutCommitObserved();
        scrollObservationHost.observeCommittedProjectionLayout();
    }, [
        recordLayoutCommitObserved,
        scrollObservationHost.observeCommittedProjectionLayout,
    ]);
    useCommittedTranscriptRef(
        recordLocalTranscriptInteractionIntentRef,
        scrollObservationHost.recordLocalTranscriptInteractionIntent,
    );
    useCommittedTranscriptRef(
        adoptNativeFollowingForTrustedBottomArrivalRef,
        scrollObservationHost.adoptNativeFollowingForTrustedBottomArrival,
    );
    const webViewInteractionProps = Platform.OS === 'web'
        ? scrollObservationHost.platformInteractionProps as Partial<React.ComponentProps<typeof View>>
        : undefined;
    return (
        <TranscriptMotionProvider sessionKey={props.sessionId} config={motionConfig}>
            <InitialPresentationReadinessProvider value={initialRichContentPresentationController.boundary}>
              <View
                style={{ flex: 1 }}
                {...webViewInteractionProps}
              >
                <TranscriptListShell<ChatTranscriptListItem>
                    ref={commitListRef}
                    frame={mainTranscriptListShellFrame}
                    webDomObservation={webDomObservation}
                    onCommitLayoutEffect={observeTranscriptListCommittedLayout}
                    platformInteractionProps={scrollObservationHost.platformInteractionProps}
                    data={listData}
                    dataKey={props.sessionId}
                    extraData={transcriptListExtraData}
                    key={props.sessionId}
                    keyExtractor={keyExtractor}
                    getItemType={getItemType}
                    getEstimatedItemSize={getEstimatedItemSize}
                    getItemSizeVersion={getItemSizeVersion}
                    onLoad={handleListLoad}
                    onViewableItemsChanged={shouldAttachNativeViewability ? handleNativeViewableItemsChanged : undefined}
                    viewabilityConfig={nativeViewabilityConfig}
                    onLayout={scrollObservationHost.onLayout}
                    onContentSizeChange={scrollObservationHost.onContentSizeChange}
                    onScroll={scrollObservationHost.onScroll}
                    onScrollBeginDrag={scrollObservationHost.onScrollBeginDrag}
                    onScrollEndDrag={scrollObservationHost.onScrollEndDrag}
                    onMomentumScrollBegin={scrollObservationHost.onMomentumScrollBegin}
                    onMomentumScrollEnd={scrollObservationHost.onMomentumScrollEnd}
                    onRendererAtEndChange={handleRendererAtEndChange}
                    onEntryPlacementEvent={onEntryPlacementEvent}
                    renderItem={renderItem}
                    onStartReachedThreshold={edgeReachedThresholdRatio}
                    onStartReached={scrollObservationHost.onStartReached}
                    onEndReachedThreshold={edgeReachedThresholdRatio}
                    onEndReached={scrollObservationHost.onEndReached}
                    onScrollToIndexFailed={onScrollToIndexFailed}
                    header={transcriptItemsEdgeSlots.edgeSlots.listHeaderNode}
                    footer={transcriptItemsEdgeSlots.edgeSlots.listFooterNode}
                    olderLoadOverlay={transcriptItemsEdgeSlots.olderLoadOverlay}
                    catchUpOverlay={transcriptItemsEdgeSlots.catchUpOverlay}
                />
                <TranscriptNavigationRail
                    entries={props.transcriptNavigationEntries}
                    onJumpToEntry={handleTranscriptNavigationRailJump}
                    paneHeightPx={listLayoutHeight}
                    paneWidthPx={listLayoutWidthPx}
                    reducedMotion={reducedMotionPreferred}
                    sessionId={props.sessionId}
                    transcriptContentWidthPx={Math.min(listLayoutWidthPx, transcriptContentMaxWidth)}
                    transcriptMaxWidthPx={transcriptContentMaxWidth}
                />
                {showFirstPaintPlaceholder ? (
                    <TranscriptFirstPaintPlaceholder reducedMotion={reducedMotionPreferred} />
                ) : null}
                {jumpToBottomAffordance.isVisible ? (
                    <ComposerKeyboardFloatingInset
                        testID="transcript-jump-to-bottom-keyboard-offset"
                        baseBottom={12}
                        style={{ position: 'absolute', right: 12 }}
                    >
                        <JumpToBottomButton
                            testID="transcript-jump-to-bottom"
                            count={jumpToBottomAffordance.count}
                            onPress={jumpToBottom}
                            presentation={jumpToBottomAffordance.presentation}
                        />
                    </ComposerKeyboardFloatingInset>
                ) : null}
              </View>
            </InitialPresentationReadinessProvider>
        </TranscriptMotionProvider>
    );
});
