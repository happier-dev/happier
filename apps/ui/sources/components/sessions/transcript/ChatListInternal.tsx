import * as React from 'react';
import {
    getStorage,
    useSetting,
} from '@/sync/domains/state/storage';
import { Dimensions, Platform, View } from 'react-native';
import { useCallback } from 'react';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { sync, type SessionViewportAnchorSnapshot } from '@/sync/sync';
import { useSessionCatchingUpNewer } from '@/sync/store/hooks';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useTranscriptMotionConfig } from '@/components/sessions/transcript/motion/useTranscriptMotionConfig';
import { TranscriptMotionProvider } from '@/components/sessions/transcript/motion/TranscriptMotionProvider';
import {
    type TranscriptViewportTelemetryEvent,
    type TranscriptViewportTelemetryObservationReason,
    type TranscriptViewportTelemetryMvcpPolicy,
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
    type TranscriptLifecycleHostContentGrowthLiveTailCommandPlan,
    type TranscriptLifecycleHostExplicitJumpPlan,
    type TranscriptLifecycleHostExplicitReturnPlan,
    type TranscriptLifecycleHostFollowBottomIntentPlan,
    type TranscriptLifecycleHostMeasuredNativePinPlan,
    type TranscriptLifecycleHostNativeMountSettlePendingPinFlushPlan,
    type TranscriptLifecycleHostSessionEntryPlan,
    type TranscriptLifecycleHostScrollObservationPlan,
    type NativeEntrySettleConfirmationEffect,
    type NativeExplicitJumpConfirmationEffect,
} from '@/components/sessions/transcript/viewport/lifecycle/lifecycleHost';
import { useTranscriptNativeViewportLifecycle } from '@/components/sessions/transcript/viewport/lifecycle/host/useTranscriptNativeViewportLifecycle';
import { useTranscriptNativeMountSettleLifecycle } from '@/components/sessions/transcript/viewport/lifecycle/host/useTranscriptNativeMountSettleLifecycle';
import {
    planBottomFollowWriteSchedulerEvent,
    type BottomFollowAutomaticWriter,
    type BottomFollowScheduledWrite,
    type BottomFollowWriteSchedulerEffect,
    type BottomFollowWriteSchedulerState,
} from '@/components/sessions/transcript/viewport/bottomFollow/writeScheduler';
import {
    type NativeDragActiveMirrorApplyEffect,
} from '@/components/sessions/transcript/viewport/lifecycle/nativeActiveMirror';
import {
    type TranscriptViewportTransactionOutcome,
} from '@/components/sessions/transcript/viewport/transcriptViewportOwnership';
import type {
    TranscriptViewportAnchorIdentity,
    TranscriptViewportMode,
} from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import { useNativeInvertedFactSource } from '@/components/sessions/transcript/viewport/driver/useNativeInvertedFactSource';
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
    canAutoFollowTranscriptBottom,
    isExplicitTranscriptBottomFollowCommand,
    resolveTranscriptAutoFollowPinWaitMs,
} from '@/components/sessions/transcript/scroll/transcriptAutoFollowGate';
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
import { resolveNativeInvertedColdScrollIndex } from '@/components/sessions/transcript/segments/resolveWebHotColdScrollDecision';
import {
    isMessageRolledBack,
    type TranscriptRollbackAction,
} from '@/sync/domains/sessionRollback/rollbackUiSupport';
import {
    getWebTranscriptDistanceFromBottom,
    isWebTranscriptScrollable,
    type WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import {
    captureWebTranscriptViewportAnchor,
    TRANSCRIPT_WEB_TOOL_CALL_PREPEND_ANCHOR_TEST_ID_PREFIX,
    TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX,
    type WebTranscriptViewportAnchor,
} from '@/components/sessions/transcript/viewport/prepend/webTranscriptPrependAnchor';
import {
    captureNativeTranscriptViewportAnchor,
} from '@/components/sessions/transcript/viewport/driver/transcriptNativeViewportAnchor';
import {
    resolveTranscriptViewportAnchorFocusOffsetPx,
} from '@/components/sessions/transcript/viewport/entryRestore/transcriptViewportAnchorResolution';
import type {
    TranscriptJumpTarget,
    TranscriptJumpTargetRole,
} from '@/components/sessions/transcript/viewport/jump/transcriptJumpTargetTypes';
import {
    type TranscriptRenderWindowProjection,
} from '@/components/sessions/transcript/viewport/window/resolveTranscriptRenderWindowProjection';
import {
    clearStreamingSessionUiTelemetryMarks,
} from '@/sync/runtime/performance/sessionUiTelemetry';
import {
    useTranscriptOlderPagination,
    type TranscriptOlderPaginationSnapshot,
} from '@/components/sessions/transcript/pagination/useTranscriptOlderPagination';
import { waitForNextTranscriptVisualUpdate } from '@/components/sessions/transcript/pagination/waitForNextTranscriptVisualUpdate';
import { TranscriptFirstPaintPlaceholder } from '@/components/sessions/transcript/TranscriptFirstPaintPlaceholder';
import { JumpToBottomButton } from '@/components/sessions/transcript/scroll/JumpToBottomButton';
import { ComposerKeyboardFloatingInset } from '@/components/sessions/keyboardAvoidance';
import { TranscriptNavigationRail } from '@/components/sessions/transcript/navigation/TranscriptNavigationRail';
import {
    TranscriptListShell,
    type TranscriptListShellRef,
} from '@/components/sessions/transcript/viewport/shell/TranscriptListShell';
import { resolveTranscriptListRendererKind } from '@/components/sessions/transcript/viewport/shell/renderer/resolveTranscriptListRenderer';
import type { TranscriptBlankRecoveryEffect } from '@/components/sessions/transcript/viewport/visibility/blankRecoveryOwner';
import {
    deriveTranscriptNavigationRuntimeAnchors,
    type TranscriptNavigationRuntimeAnchor,
} from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationRuntimeAnchors';
import { clearTranscriptNavigationVisibilityStore } from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationVisibilityStore';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { useTranscriptPrependHost } from '@/components/sessions/transcript/viewport/prepend/host/useTranscriptPrependHost';
import { useTranscriptViewportAnchorCaptureHost } from '@/components/sessions/transcript/viewport/prepend/host/useTranscriptViewportAnchorCaptureHost';
import { useTranscriptEntryHost } from '@/components/sessions/transcript/viewport/entryRestore/host/useTranscriptEntryHost';
import {
    useTranscriptSessionEntryLifecycle,
    type SessionEntryViewportRefValue,
} from '@/components/sessions/transcript/viewport/entryRestore/host/useTranscriptSessionEntryLifecycle';
import { useTranscriptNativeEntryRestorePaintRelease } from '@/components/sessions/transcript/viewport/entryRestore/host/useTranscriptNativeEntryRestorePaintRelease';
import { useTranscriptBottomFollowHost } from '@/components/sessions/transcript/viewport/bottomFollow/host/useTranscriptBottomFollowHost';
import { useTranscriptScrollObservationHost } from '@/components/sessions/transcript/viewport/lifecycle/host/useTranscriptScrollObservationHost';
import { useTranscriptJumpHost } from '@/components/sessions/transcript/viewport/jump/host/useTranscriptJumpHost';
import {
    runTranscriptPrependOlderLoad,
    type TranscriptPrependOlderLoadOptions,
    type TranscriptPrependOlderLoadResult,
    type TranscriptPrependOlderLoadSyncOptions,
} from '@/components/sessions/transcript/viewport/prepend/host/runTranscriptPrependOlderLoad';
import type {
    WebPrependTelemetryFacts,
    WebPrependTelemetryFactsInput,
} from '@/components/sessions/transcript/viewport/prepend/webPrependOwner';
import type { TranscriptMeasurementReconciler } from '@/components/sessions/transcript/measurement/transcriptMeasurementReconciler';
import {
    createTranscriptMeasurementHost,
} from '@/components/sessions/transcript/measurement/transcriptMeasurementHost';
import { useTranscriptMeasurementHostWiring } from '@/components/sessions/transcript/measurement/useTranscriptMeasurementHostWiring';
import {
    resolveFontScaleKey,
    resolveInitialTranscriptRowWidthBucket,
    resolveTranscriptRowWidthBucket,
} from '@/components/sessions/transcript/measurement/rowRenderKeys';
import type { TranscriptLiveTailAnchorReason } from '@/components/sessions/transcript/viewport/lifecycle/transcriptRowClassification';
import {
    resolveNativeBottomFollowPreviousFollow,
    resolveNativeContentMaterializationAutoPin,
    resolveNativeInitialFollowBottomDecision,
    resolveNativeMountSettleBottomPinRetention,
    resolveNativeMountSettlePassiveDriftRepinDistanceDecision,
    resolveNativeMountSettlePassiveDriftRepinEffects,
    resolveNativeMountSettlePassiveDriftRepinPreflightDecision,
    resolveNativeMountSettlePendingFlushTriggerDecision,
    type NativeContentMaterializationAutoPin,
    type NativeContentMaterializationAutoPinPostSuccessDecision,
    type NativeInitialFollowBottomDecision,
    type NativeMountSettlePassiveDriftRepinEffect,
    type NativeMountSettlePendingFlushTriggerDecision,
    type NativeStreamAppendPinContentVersion,
    type NativeSuccessfulBottomPinRecords,
    type NativeSuccessfulBottomPinInitialViewportEffects,
} from '@/components/sessions/transcript/viewport/nativeBottomFollowObservationPolicy';
import {
    createEntryRestoreOwner,
    type EntryRestoreOwner,
    type EntryRestoreOwnerEffect,
} from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreOwner';
import { stampViewportAnchorForEmit as stampViewportAnchorForEmitState } from '@/components/sessions/transcript/viewport/entryRestore/stampViewportAnchorForEmit';
import { readSessionViewportForEntry } from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreAnchorUtilities';
import { resolveTranscriptMountSettleTuning } from '@/components/sessions/transcript/viewport/lifecycle/mountSettleTuning';
import { useTranscriptEntrySliceReveal, useTranscriptFirstPaintState, useTranscriptItemsPipeline, useTranscriptToolAutoExpandEffect } from '@/components/sessions/transcript/items/useTranscriptItemsPipeline';
import { useTranscriptItemRenderer, useTranscriptItemsEdgeSlots } from '@/components/sessions/transcript/rowHost/useTranscriptRowHost';
import { useTranscriptExpansionState } from '@/components/sessions/transcript/rowHost/useTranscriptExpansionState';
export type { TranscriptViewportChangeState } from '@/components/sessions/transcript/chatListTypes';
type ContentGrowthLiveTailCommandApplyEffect = NonNullable<TranscriptLifecycleHostContentGrowthLiveTailCommandPlan['contentGrowthLiveTailCommandEffect']>;
type ExplicitJumpTakeoverApplyEffect = TranscriptLifecycleHostExplicitJumpPlan['explicitJumpTakeoverEffects'][number];
type ExplicitReturnToLiveTailApplyEffect = TranscriptLifecycleHostExplicitReturnPlan['explicitReturnEffects'][number];
type FollowBottomIntentTakeoverApplyEffect = TranscriptLifecycleHostFollowBottomIntentPlan['followBottomIntentTakeoverEffects'][number];
type NativeMeasuredPinPlan = TranscriptLifecycleHostMeasuredNativePinPlan;
type NativeMeasuredPinIssuePlan = Extract<NativeMeasuredPinPlan, { type: 'issue-command' }>;
type NativeMeasuredBottomPinCommandResultPlan = NativeMeasuredPinIssuePlan['commandPlan'];
type NativeMeasuredBottomPinCommandResultPostSuccessPlan = NativeMeasuredBottomPinCommandResultPlan['postSuccess'];
type NativeInvertedFollowBottomPinDecision =
    NativeMeasuredPinIssuePlan['invertedFollowBottomDecision'];
type NativeMeasuredBottomPinPreAutoFollowDecision =
    NativeMeasuredPinIssuePlan['preAutoFollowDecision'];
type NativeAutomaticPinSameOffsetDecision =
    NativeMeasuredPinIssuePlan['sameOffsetDecision'];
type NativeStreamAppendContentVersionDecision =
    NativeMeasuredPinIssuePlan['streamAppendDecision'];
type NativeMountSettlePendingPinFlushPlan =
    TranscriptLifecycleHostNativeMountSettlePendingPinFlushPlan;
type ScrollObservationPlan = TranscriptLifecycleHostScrollObservationPlan;
type WebPassiveLiveTailCorrectionEffect =
    NonNullable<ScrollObservationPlan['webPassiveLiveTailCorrectionEffect']>;
type ScheduledPinToBottom = BottomFollowScheduledWrite<WebTranscriptScrollMetrics> & {
    id: any;
};
const TRANSCRIPT_SCROLL_AUTO_REPIN_THROTTLE_MS = 200;
const TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS = 250;
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
    const nativeMountSettleAutoPinSuppressedRef = React.useRef(false);
    const loadOlderInFlight = React.useRef(false);
    const hasMoreOlderRef = React.useRef<boolean | null>(null);
    const olderLoadSpinnerDelayTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const nativeFirstPaintFallbackReleaseTimeoutRef = React.useRef<{
        sessionId: string;
        timeoutId: ReturnType<typeof setTimeout>;
    } | null>(null);
    const sessionOpenWebInitialPinRetryTimeoutRef = React.useRef<{
        deadlineAtMs: number;
        retryIndex: number;
        sessionId: string;
        timeoutId: ReturnType<typeof setTimeout>;
    } | null>(null);
    const sessionOpenWebInitialPinRetryArmAtMsRef = React.useRef(Date.now());
    const scheduleFirstSessionOpenWebInitialPinRetryRef = React.useRef<(() => void) | null>(null);
    const nativeEntryRestorePaintReleaseTimeoutRef = React.useRef<{
        issuedAtMs: number;
        sessionId: string;
        timeoutId: ReturnType<typeof setTimeout>;
    } | null>(null);
    const listRef = React.useRef<ScrollableChatListRef | null>(null);
    const pendingJumpSeqViewportPromotionRef = React.useRef<PendingJumpSeqViewportPromotion | null>(null);
    const promotedJumpSeqViewportProtectionRef = React.useRef<PromotedJumpSeqViewportProtection | null>(null);
    const lastRouteJumpProtectionClearingWebMovementAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    const flushPendingJumpSeqViewportPromotionForExitRef = React.useRef<() => void>(() => {});
    const flushViewportAnchorCaptureRef = React.useRef<(options?: Readonly<{ deferEmit?: boolean }>) => void>(() => {});
    const flushExitLiveTailIntentRef = React.useRef<(options?: Readonly<{ deferEmit?: boolean }>) => void>(() => {});
    const disposeEntryRestoreTransactionForExitRef = React.useRef<() => void>(() => {});
    const currentSessionIdRef = React.useRef(props.sessionId);
    if (currentSessionIdRef.current !== props.sessionId) {
        flushPendingJumpSeqViewportPromotionForExitRef.current();
        pendingJumpSeqViewportPromotionRef.current = null;
        promotedJumpSeqViewportProtectionRef.current = null;
        lastRouteJumpProtectionClearingWebMovementAtMsRef.current = Number.NEGATIVE_INFINITY;
        flushViewportAnchorCaptureRef.current({ deferEmit: true });
        flushExitLiveTailIntentRef.current({ deferEmit: true });
    }
    currentSessionIdRef.current = props.sessionId;
    const viewportCommandControllerRef = React.useRef<TranscriptViewportCommandController | null>(null);
    if (viewportCommandControllerRef.current === null) {
        viewportCommandControllerRef.current = createTranscriptViewportCommandController();
    }
    const viewportCommandController = viewportCommandControllerRef.current;
    viewportCommandController.setCurrentSessionId(props.sessionId);
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
    const transcriptLegendListSpikeSurface = sync.getSyncTuning().transcriptLegendListSpikeSurface;
    const mainTranscriptRendererKind = resolveTranscriptListRendererKind({
        frameSurface: 'main',
        transcriptLegendListSpikeSurface,
    });
    const appOwnsContinuousFollow = mainTranscriptRendererKind === 'flashList';
    const appOwnsInitialBottomPosition = mainTranscriptRendererKind === 'flashList';
    const appOwnsPrependRestore = mainTranscriptRendererKind === 'flashList';
    const appOwnsLocalHeightChangeRestore = mainTranscriptRendererKind === 'flashList';
    const usesNativeFlashListBottomMaintenance =
        Platform.OS !== 'web' && appOwnsContinuousFollow;
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
    const nativeHotEdgeVisibleRowsRef = React.useRef<{
        firstItemId: string | null;
        firstSourceIndex: number | null;
        lastItemId: string | null;
        lastSourceIndex: number | null;
    } | null>(null);
    // Pre-decomposition source (turn / tool-calls-group shapes) for visitors that must
    // not see per-unit rows (auto-expand policy scan).
    const preDecompositionItemsRef = React.useRef<ChatTranscriptListItem[]>(props.items);
    const toolRouteCommonRef = React.useRef(props.toolRouteCommon);
    toolRouteCommonRef.current = props.toolRouteCommon;
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
    const shouldSuppressGenericViewportStateForProtectedJumpSeqRef = React.useRef<() => boolean>(() => false);
    const commitJumpToBottomDistanceForVisibilityRef = React.useRef<(distanceFromBottom: number) => void>(() => {});
    const shouldSuppressGenericViewportStateForAnchorCapture = React.useCallback((): boolean => shouldSuppressGenericViewportStateForProtectedJumpSeqRef.current(), []);
    const webHotColdCountsRef = React.useRef<{ coldCount: number; hotCount: number }>({
        coldCount: props.items.length,
        hotCount: 0,
    });
    const olderPaginationSnapshotRef = React.useRef<TranscriptOlderPaginationSnapshot>({
        phase: 'idle',
        suspendedReasons: [],
        hasMore: true,
        insideThreshold: false,
    });
    const observeNativePrependOwnerRef = React.useRef<() => void>(() => {});
    const invalidateNativePrependOwnerRef = React.useRef<() => void>(() => {});
    const clearWebPrependRestoreWindowRef = React.useRef<(outcome: TranscriptViewportTransactionOutcome) => void>(() => {});
    const hasOpenNativePrependTransactionForSessionRef = React.useRef<() => boolean>(() => false);
    const closeNativePrependForTrustedScrollRef = React.useRef<() => void>(() => {});
    const nativePrependTelemetryStateRef = React.useRef<() => TranscriptViewportTelemetryTransactionState>(() => 'none');
    const resolveWebPrependTelemetryFactsRef = React.useRef<(
        params: WebPrependTelemetryFactsInput,
    ) => WebPrependTelemetryFacts>(() => ({
        pendingWebPrependAnchorIndex: undefined,
        pendingWebPrependAnchorKind: 'none',
        pendingWebPrependAnchorId: undefined,
    }));
    // Plan P2: lets the momentum-settle handler (defined before the scheduler) arm a capture
    // for the dwelled position when every momentum frame was swallowed (open transactions).
    const scheduleViewportAnchorCaptureRef = React.useRef<(
        state: TranscriptViewportChangeState,
        options?: Readonly<{ suppressAnchorCapture?: boolean }>,
    ) => void>(() => {});
    const resetOlderPaginationRef = React.useRef<() => void>(() => {});
    const wantsPinnedRef = React.useRef(true);
    const pinThresholdPxRef = React.useRef(72);
    const lastUserScrollIntentAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    const lastExplicitWebScrollIntentAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    const nativeTranscriptTouchStartYRef = React.useRef<number | null>(null);
    const resolveRestoreAnchorIndexForCommandRef = React.useRef<(anchor: TranscriptViewportAnchorIdentity) => number | null>(() => null);
    const resolveJumpToSeqIndexForCommandRef = React.useRef<(
        seq: number,
        routeMessageId?: string | null,
        transcriptBlockIndex?: number | null,
        role?: TranscriptJumpTargetRole | null,
    ) => number | null>(() => null);
    const webDomObservationRef = React.useRef<WebDomScrollObservation | null>(null);
    if (webDomObservationRef.current === null) {
        webDomObservationRef.current = createWebDomScrollObservation();
    }
    const webDomObservation = webDomObservationRef.current;
    const applyWebPassiveLiveTailCorrectionEffectRef = React.useRef<(
        effect: WebPassiveLiveTailCorrectionEffect,
    ) => boolean>(() => false);
    const lastAutoRepinAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
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
    const observeNativeStreamAppendOffsetEscapeHostRef = React.useRef<(params: {
        contentHeight: number;
        layoutHeight: number;
    }) => boolean>(() => false);
    const deferAutoPinAfterLocalTranscriptInteractionRef = React.useRef<() => void>(() => {});
    const adoptNativeFollowingForTrustedBottomArrivalRef = React.useRef<(distanceFromBottom: number | null) => void>(() => {});
    const lastNativePinOffsetRef = React.useRef<number | null>(null);
    const nativeHotTailHeightRef = React.useRef(0);
    const resetBottomFollowPinRecordsForSessionEntryRef = React.useRef<(latestActivityKey: string | null | undefined) => void>(() => {});
    const resetBottomFollowPinStateForSessionOpenArmRef = React.useRef<(latestActivityKey: string | null | undefined) => void>(() => {});
    const lastNativeRestoreIndexCommandRef = React.useRef<LastNativeRestoreIndexCommand | null>(null);
    const nativeListDragActiveRef = React.useRef(false);
    const nativeBottomFollowRearmedAfterDragRef = React.useRef(false);
    // Plan B9: true between onMomentumScrollBegin and onMomentumScrollEnd. Combined with the
    // mode machine's retained trusted drag session it forms the post-drag release attribution
    // window: momentum frames may release follow, height-churn frames without a drag never can.
    const nativeMomentumScrollActiveRef = React.useRef(false);
    const nativeVisibleWindowSnapshotRef = React.useRef<NativeVisibleWindowSnapshot | null>(null);
    const lastNativeVisibleRowsSnapshotRef = React.useRef<NativeVisibleWindowSnapshot | null>(null);
    const nativeFlashListMvcpPolicyRef = React.useRef<TranscriptViewportTelemetryMvcpPolicy>('none');
    const nativeFlashListPauseOffsetCorrectionRef = React.useRef(false);
    const nativeInitialViewportPendingObservationRef = React.useRef(false);
    // Entry-restore owner state lives in viewport/entryRestore; ChatList applies its effects.
    // N2b.2 slice-from-anchor entry window (native flash_v2 anchored entries).
    const [entrySliceWindow, setEntrySliceWindow] = React.useState<{
        sessionId: string;
        anchorRowId: string;
    } | null>(null);
    const entrySliceWindowRef = React.useRef<{ sessionId: string; anchorRowId: string } | null>(null);
    const entrySliceWithheldCountRef = React.useRef(0);
    const revealEntrySliceWindowRef = React.useRef<() => number>(() => 0);
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
    const requestBottomFollowScheduledWriteRef = React.useRef<(previousWebMetrics?: WebTranscriptScrollMetrics | null, reason?: TranscriptViewportTelemetryScrollReason, nativePrevFollowAtBottom?: boolean, writer?: BottomFollowAutomaticWriter) => void>(() => {});
    const cancelScheduledPinToBottomRef = React.useRef<() => void>(() => {});
    const cancelScheduledPinToBottom = React.useCallback(() => {
        cancelScheduledPinToBottomRef.current();
    }, []);
    const flushPendingNativeMountSettleBottomPinRef = React.useRef<() => void>(() => {});
    const flushPendingNativeMountSettleBottomPin = React.useCallback(() => {
        flushPendingNativeMountSettleBottomPinRef.current();
    }, []);
    const resolveInvertedBottomPinCarveTelemetryFieldsRef = React.useRef<() => Record<string, unknown>>(() => ({}));
    const resolveInvertedBottomPinCarveTelemetryFields = React.useCallback((): Record<string, unknown> => (
        resolveInvertedBottomPinCarveTelemetryFieldsRef.current()
    ), []);
    const latestJumpToSeqRef = React.useRef<number | null>(props.jumpToSeq ?? null);
    latestJumpToSeqRef.current = props.jumpToSeq ?? null;
    const initialWebPinStabilizingRef = React.useRef(false);
    const scheduledViewportAnchorCaptureRef = React.useRef<{
        captureAnchor: () => SessionViewportAnchorSnapshot | null;
        dueAtMs: number;
        emit: ((state: TranscriptViewportChangeState) => void) | undefined;
        generation: number;
        sessionId: string;
        state: TranscriptViewportChangeState;
        timeoutId: ReturnType<typeof setTimeout>;
        wantsPinned: boolean;
    } | null>(null);
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
        itemsRef,
        listContentHeightRef,
        listLayoutHeightRef,
        olderPaginationSnapshotRef,
        resolveWebPrependTelemetryFactsRef,
        transcriptNavigationRuntimeAnchorsRef,
        webHotColdCountsRef,
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
    const transcriptScrollAutoFollowWhenPinned = useSetting('transcriptScrollAutoFollowWhenPinned');
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
                case 'explicit-jump-cancel-native-mount-settle-bottom-pin':
                    pendingNativeMountSettleBottomPinRef.current = false;
                    break;
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
    const deferAutoPinAfterLocalTranscriptInteraction = React.useCallback(() => {
        deferAutoPinAfterLocalTranscriptInteractionRef.current();
    }, []);
    const prepareWebToolGroupLocalHeightChange = React.useCallback((): 'anchor' | 'bottom' | 'none' => {
        if (!appOwnsLocalHeightChangeRestore) {
            pendingWebLocalHeightChangeAnchorRef.current = null;
            return 'none';
        }
        if (Platform.OS !== 'web') return 'none';
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return 'none';
        const distanceFromBottom = getWebTranscriptDistanceFromBottom(metrics);
        if (wantsPinnedRef.current && distanceFromBottom <= pinThresholdPxRef.current) {
            pendingWebLocalHeightChangeAnchorRef.current = null;
            return 'bottom';
        }
        if (!isWebTranscriptScrollable(metrics, 1)) {
            pendingWebLocalHeightChangeAnchorRef.current = null;
            return 'none';
        }
        const anchor = captureWebTranscriptViewportAnchor({ container: metrics.element });
        if (!anchor) {
            pendingWebLocalHeightChangeAnchorRef.current = null;
            return 'none';
        }
        pendingWebLocalHeightChangeAnchorRef.current = {
            sessionId: props.sessionId,
            anchor,
        };
        return 'anchor';
    }, [appOwnsLocalHeightChangeRestore, props.sessionId, resolveWebScrollMetrics]);
    const {
        applyToolCallsGroupExpanded,
        expandedToolCallsAnchorMessageIds,
        resolveThinkingExpanded,
        setExpandedToolCallsAnchorMessageIds,
        setThinkingExpanded,
        setToolCallsGroupExpanded,
    } = useTranscriptExpansionState({
        deferAutoPinAfterLocalTranscriptInteraction,
        prepareWebToolGroupLocalHeightChange,
    });
    const onViewportChangeRef = React.useRef(props.onViewportChange);
    React.useEffect(() => {
        onViewportChangeRef.current = props.onViewportChange;
    }, [props.onViewportChange]);
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
        const emit = onViewportChangeRef.current;
        if (!emit) return false;
        emit({
            ...state,
            anchor: stampViewportAnchorForEmit(state.anchor),
        });
        return true;
    }, [stampViewportAnchorForEmit]);
    const applyExplicitReturnToLiveTailEffects = React.useCallback((
        effects: readonly ExplicitReturnToLiveTailApplyEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            switch (effect.type) {
                case 'apply-explicit-return-clear-user-scroll-intent':
                    lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
                    break;
                case 'apply-explicit-return-to-live-tail-viewport': {
                    commitScrollPinState({ ...scrollPinRef.current, isPinned: effect.isPinned, newActivityCount: 0 });
                    const emitted = emitViewportChange({
                        isPinned: effect.isPinned,
                        offsetY: effect.distanceFromLiveTailPx,
                        shouldRestoreViewport: false,
                    });
                    if (!emitted) {
                        sync.markSessionLiveTailIntent(props.sessionId);
                    }
                    break;
                }
            }
        }
    }, [
        commitScrollPinState,
        emitViewportChange,
        props.sessionId,
    ]);
    const commitExplicitReturnToLiveTailState = React.useCallback((
        intent: Extract<TranscriptViewportLifecycleEvent, { type: 'return-to-live-tail-intent' }>['intent'],
    ) => {
        wantsPinnedRef.current = true;
        isPinnedRef.current = true;
        const plan = lifecycleHost.planExplicitReturnToLiveTail({
            intent,
            sessionId: props.sessionId,
        });
        commitBottomFollowModeState(plan.state.bottomFollowState);
        applyExplicitReturnToLiveTailEffects(plan.explicitReturnEffects);
    }, [
        applyExplicitReturnToLiveTailEffects,
        commitBottomFollowModeState,
        lifecycleHost,
        props.sessionId,
    ]);
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
    const resetInitialFillForSessionEntry = React.useCallback(() => {
        initialFillAbortRef.current?.abort();
        initialFillAbortRef.current = null;
    }, []);
    const resetNativeMountSettleFlagsForSessionEntry = React.useCallback(() => {
        setNativeMountSettleStable(false);
        nativeMountSettleDeadlineReachedRef.current = false;
        nativeMountSettleAutoPinSuppressedRef.current = false;
        setNativeMountSettleDeadlineReached(false);
    }, []);
    const clearNativePaintReleaseTimeoutsForSessionEntry = React.useCallback(() => {
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
    }, []);
    const pendingNativeMountSettleBottomPinHostRef = React.useRef<{ current: boolean } | null>(null);
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
        entrySliceWindowRef,
        lifecycleHost,
        lastUserScrollIntentAtMsRef,
        measurementHost,
        nativeInitialViewportPendingObservationRef,
        nativeMountSettleAutoPinSuppressedRef,
        pendingNativeMountSettleBottomPinHostRef,
        platformOS: Platform.OS,
        preemptEntryRestoreTransaction,
        sessionEntryViewportRef,
        sessionId: props.sessionId,
        sessionOpenLatch,
        setEntrySliceWindow,
        setNativeInitialViewportPendingObservation,
    });
    const {
        applySessionOpenArmResetPlan,
        applySessionOpenDisposeResetPlan,
    } = useTranscriptSessionEntryLifecycle({
        anchorLookupExhaustedRef,
        anchorLookupInFlightRef,
        anchorLookupLoadCountRef,
        applyEntryRestoreOwnerEffectsRef,
        applySessionOpenLatchEffectsRef,
        cancelScheduledPinToBottom,
        clearNativePaintReleaseTimeoutsForSessionEntry,
        clearWebPrependRestoreWindow: (outcome) => clearWebPrependRestoreWindowRef.current(outcome),
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
        entrySliceWindowRef,
        flushViewportAnchorCaptureRef,
        getItemCount: () => itemsRef.current.length,
        hideOlderLoadSpinner,
        initialBottomPositionOwner: appOwnsInitialBottomPosition ? 'app' : 'renderer',
        initialFillAbortRef,
        invalidateNativePrependOwner: () => invalidateNativePrependOwnerRef.current(),
        invalidateViewportAnchorCapture,
        isLoaded: props.isLoaded,
        isPinnedRef,
        jumpToSeq: props.jumpToSeq,
        lastAutoRepinAtMsRef,
        lastExplicitWebScrollIntentAtMsRef,
        lastNativeRestoreIndexCommandRef,
        lastPinOffsetForIntentRef,
        lastRouteJumpProtectionClearingWebMovementAtMsRef,
        lastScrollOffsetForIntentRef,
        lastUserScrollIntentAtMsRef,
        latestCommittedActivityKey: props.latestCommittedActivityKey,
        lifecycleHost,
        listContentHeightRef,
        listLayoutHeightRef,
        measurementHost,
        nativeBottomFollowRearmedAfterDragRef,
        nativeEntryRestorePaintReleaseTimeoutRef,
        nativeFirstPaintFallbackReleaseTimeoutRef,
        nativeMomentumScrollActiveRef,
        nativeMountSettleAutoPinSuppressedRef,
        pendingNativeMountSettleBottomPinHostRef,
        resetBottomFollowPinRecordsForSessionEntry: (latestActivityKey) => {
            resetBottomFollowPinRecordsForSessionEntryRef.current(latestActivityKey);
        },
        resetBottomFollowPinStateForSessionOpenArm: (latestActivityKey) => {
            resetBottomFollowPinStateForSessionOpenArmRef.current(latestActivityKey);
        },
        resetInitialFillForSessionEntry,
        resetNativeMountSettleFlagsForSessionEntry,
        resetNativeSessionViewportLifecycle,
        resetOlderPaginationForSessionEntry,
        resetTransientSessionEntryUiState: () => {},
        resetViewportAnchorCaptureForSessionEntry,
        scheduleFirstSessionOpenWebInitialPinRetryRef,
        sessionEntryViewportRef,
        sessionId: props.sessionId,
        sessionOpenLatch,
        sessionOpenWebInitialPinRetryArmAtMsRef,
        setEntrySliceWindow,
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
                    lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
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
    const lastFollowBottomIntentKeyRef = React.useRef<string | number | null>(props.followBottomIntentKey ?? null);
    const applyUnmountCleanup = React.useCallback(() => {
        flushPendingJumpSeqViewportPromotionForExitRef.current();
        flushViewportAnchorCaptureRef.current();
        flushExitLiveTailIntentRef.current();
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
        pendingNativeMountSettleBottomPinRef.current = false;
        invalidateNativePrependOwnerRef.current();
        lastNativeRestoreIndexCommandRef.current = null;
        nativeMountSettleAutoPinSuppressedRef.current = false;
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
    pinThresholdPxRef.current = pinThresholdPx;
    const autoFollowWhenPinned = transcriptScrollAutoFollowWhenPinned !== false;
    const pinEnabledRef = React.useRef(pinEnabled);
    const autoFollowWhenPinnedRef = React.useRef(autoFollowWhenPinned);
    const jumpToSeqActiveRef = React.useRef(props.jumpToSeq != null);
    pinEnabledRef.current = pinEnabled;
    autoFollowWhenPinnedRef.current = autoFollowWhenPinned;
    jumpToSeqActiveRef.current = props.jumpToSeq != null;
    const targetWindowActiveRef = React.useRef(false);
    const activeTargetWindowTargetRef = React.useRef<TranscriptJumpTarget | null>(null);
    const targetWindowEdgeLoadInFlightRef = React.useRef({ older: false, newer: false });
    const canAutoFollowForReason = React.useCallback((
        reason: TranscriptViewportTelemetryScrollReason,
        options?: Readonly<{ explicit?: boolean }>,
    ): boolean => canAutoFollowTranscriptBottom({
        autoFollowWhenPinned: autoFollowWhenPinnedRef.current,
        bottomFollowMode: bottomFollowModeStateRef.current.mode,
        isExplicitUserCommand: options?.explicit === true || isExplicitTranscriptBottomFollowCommand(reason),
        jumpToSeqActive: jumpToSeqActiveRef.current && reason !== 'jump-to-seq',
        pinEnabled: pinEnabledRef.current,
        reason,
        targetWindowActive: targetWindowActiveRef.current,
        wantsPinned: wantsPinnedRef.current,
    }), []);
    const {
        readCurrentNativeDistanceFromBottom,
        readViewportContentMetrics,
        readViewportVisibleSourceRange,
        resolveNativeObservedScrollOffset,
        resolveViewportReachedEdge,
    } = useNativeInvertedFactSource({
        canonicalWindowedItemsRef,
        listContentHeightRef,
        listDataRef,
        listLayoutHeightRef,
        listRef,
        platformOS: Platform.OS,
        renderWindowIndexMapRef,
    });
    const observeNativeStreamAppendOffsetEscape = React.useCallback((params: {
        contentHeight: number;
        layoutHeight: number;
    }): boolean => {
        return observeNativeStreamAppendOffsetEscapeHostRef.current(params);
    }, []);
    const isCatchingUpNewer = useSessionCatchingUpNewer(props.sessionId);
    const transcriptListExtraData = React.useMemo(() => ({
        messagePins: props.messagePins,
        selectionVersion: transcriptMessageSelection.selectionVersion,
    }), [props.messagePins, transcriptMessageSelection.selectionVersion]);
    const listOrientation: TranscriptListOrientation = resolveTranscriptListPresentation({
        platformIsWeb: Platform.OS === 'web',
    }).orientation;
    const pendingWebLocalHeightChangeAnchorRef = React.useRef<Readonly<{
        sessionId: string;
        anchor: WebTranscriptViewportAnchor;
    }> | null>(null);
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
        entrySliceWindow,
        entrySliceWindowRef,
        entrySliceWithheldCountRef,
        expandedToolCallsAnchorMessageIds,
        forkMessageMetadataById: props.forkMessageMetadataById,
        groupingMode: props.groupingMode,
        isLoaded: props.isLoaded,
        items: props.items,
        itemsRef,
        jumpToSeq: props.jumpToSeq,
        latestCommittedActivityKey: props.latestCommittedActivityKey,
        listDataRef,
        listOrientation,
        messagesById: props.messagesById,
        nativeHotEdgeVisibleRowsRef,
        platformOS: Platform.OS,
        preDecompositionItemsRef,
        renderWindowIndexMapRef,
        resolveThinkingExpanded,
        rowFontScaleKey: resolveFontScaleKey(),
        rowWidthBucket: listLayoutWidthBucket,
        sessionActive: props.sessionActive,
        sessionId: props.sessionId,
        sessionThinking: props.sessionThinking,
        setEntrySliceWindow,
        targetWindowActiveRef,
        transcriptNativeHotTailItemCount: tuning.transcriptNativeHotTailItemCount,
        transcriptToolCallsCollapsedPreviewCountSetting,
        transcriptWebHotTailItemCount: tuning.transcriptWebHotTailItemCount,
        webHotColdCountsRef,
    });
    const {
        buildRowShellSignature,
        decomposedItems,
        displayItems,
        entrySliceSourceBounds,
        getItemType,
        getTurnMessageById,
        getTurnMessageRevisionById,
        isViewportAnchorSeqLoaded,
        keyExtractor,
        listData,
        liveTailAnchor,
        renderWindowProjection,
        resolveCreatedAtForMessageId,
        resolveEntryRestoreOwnerAnchor,
        resolveKindForMessageId,
        resolveNearestSurvivingViewportAnchorIndex,
        resolveNearestSurvivingViewportAnchorIndexFromItems,
        resolveRestoreAnchorIdentityFromSourceIndex,
        resolveRestoreAnchorSourceIndexFromLoadedItems,
        resolveSeqForMessageId,
        resolveSeqForViewportAnchor,
        resolveTargetWindowItemSeq,
        resolveToolCallMessagesForIds,
        shouldUseNativeHotColdSplit,
        shouldUseWebHotColdSplit,
        targetWindowActive,
        targetWindowHostFacts,
        transcriptHotColdSegments,
    } = itemsPipeline;
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
    const hasRearmedNativeBottomFollow = React.useCallback((): boolean => (
        usesNativeFlashListBottomMaintenance &&
        bottomFollowModeStateRef.current.mode === 'following' &&
        wantsPinnedRef.current &&
        isPinnedRef.current
    ), [usesNativeFlashListBottomMaintenance]);
    const nativeEntryShouldUseBottomMaintenance =
        sessionEntryViewportRef.current?.shouldFollowBottom !== false;
    const configuredFlashListDrawDistance = sync.getSyncTuning().transcriptFlashListDrawDistance;
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
        itemsRef,
        lastNativeVisibleRowsSnapshotRef,
        listContentHeightRef,
        listDataRef,
        listLayoutHeightRef,
        listOrientation,
        listRef,
        nativeFlashListMvcpPolicyRef,
        nativeFlashListPauseOffsetCorrectionRef,
        nativeHotEdgeVisibleRowsRef,
        nativeMomentumScrollActiveRef,
        nativePrependTelemetryStateRef,
        nativeVisibleWindowSnapshotRef,
        pinThresholdPxRef,
        platformOS: Platform.OS,
        readCurrentNativeDistanceFromBottom,
        readViewportVisibleSourceRange,
        resolveNativeObservedScrollOffset,
        resolveWebPrependTelemetryFactsRef,
        resolveWebScrollMetrics,
        resolveWebViewportTelemetryDiagnostics,
        runtimeAnchorsRef: transcriptNavigationRuntimeAnchorsRef,
        sessionId: props.sessionId,
        shouldUseNativeHotColdSplit,
        transcriptHotColdSegments,
        usesNativeFlashListBottomMaintenance,
        wantsPinnedRef,
        webHotColdCountsRef,
    });
    const hasOpenEntryRestoreTransactionForSession = React.useCallback(() => (
        entryRestoreOwner.hasOpenTransaction(props.sessionId)
    ), [entryRestoreOwner, props.sessionId]);
    const hasOpenNativePrependTransactionForSession = React.useCallback((): boolean => (
        hasOpenNativePrependTransactionForSessionRef.current()
    ), []);
    const {
        handleRowLayoutMutation,
        handleRowShellMeasured,
    } = useTranscriptMeasurementHostWiring({
        getItemType,
        hasOpenEntryRestoreTransactionForSession,
        hasOpenNativePrependTransactionForSession,
        listData,
        listDataRef,
        listLayoutHeightRef,
        listRef,
        measurementHost,
        recordViewportTelemetryEvent,
        resolveViewportTelemetryMode,
        sessionId: props.sessionId,
    });
    const prependHostDeps = React.useMemo(() => ({
        commandHostRef,
        currentSessionId: props.sessionId,
        itemsRef,
        lastUserScrollIntentAtMsRef,
        listContentHeightRef,
        listDataRef,
        listLayoutHeightRef,
        listRef,
        pinThresholdPx,
        preemptEntryRestoreTransaction,
        recordRestoreDecisionTelemetry,
        recordViewportTelemetryEvent,
        resolveWebScrollMetrics,
        viewportCommandController,
        wantsPinnedRef,
        webPrependRestoreOwner: appOwnsPrependRestore ? 'app' as const : 'renderer' as const,
    }), [
        appOwnsPrependRestore,
        pinThresholdPx,
        preemptEntryRestoreTransaction,
        props.sessionId,
        recordRestoreDecisionTelemetry,
        recordViewportTelemetryEvent,
        resolveWebScrollMetrics,
        viewportCommandController,
    ]);
    const prependHost = useTranscriptPrependHost(prependHostDeps);
    observeNativePrependOwnerRef.current = prependHost.observeNative;
    invalidateNativePrependOwnerRef.current = () => prependHost.invalidateNativeTransaction();
    clearWebPrependRestoreWindowRef.current = prependHost.clearWebRestoreWindow;
    hasOpenNativePrependTransactionForSessionRef.current = () => prependHost.hasOpenNativeTransaction();
    resolveWebPrependTelemetryFactsRef.current = () => prependHost.telemetryFacts();
    nativePrependTelemetryStateRef.current = () => prependHost.nativeTelemetryState();
    closeNativePrependForTrustedScrollRef.current = () => {
        prependHost.applyNativeEffects(prependHost.trustedNativeScroll({
            activeOwner: viewportCommandController.activeOwner(),
            sessionId: props.sessionId,
        }));
    };
    const nativePrependTransactionRevision = prependHost.getNativeTransactionRevision();
    const viewportDriverDeps = React.useMemo<TranscriptViewportDriverDeps>(() => ({
            listRef,
            listContentHeightRef,
            listLayoutHeightRef,
            listDataRef,
            itemsRef,
            composerInsetHeightRef,
            nativeHotTailHeightRef,
            lastPinOffsetForIntentRef,
            lastNativePinOffsetRef,
            webDomObservation,
            lastNativeRestoreIndexCommandRef,
            nativeMountSettleStable,
            telemetryPlatform,
            shouldUseNativeHotColdSplit,
            webHotColdCountsRef,
            clearWebPrependRangeReserve: prependHost.clearWebRangeReserve,
            resolveRestoreAnchorIndex: (anchor) => resolveRestoreAnchorIndexForCommandRef.current(anchor),
            resolveJumpToSeqIndex: (seq, routeMessageId, transcriptBlockIndex, role) => (
                resolveJumpToSeqIndexForCommandRef.current(seq, routeMessageId, transcriptBlockIndex, role)
            ),
            resolveWebScrollMetrics,
            recordViewportTelemetryEvent,
            recordRestoreDecisionTelemetry,
            resolveWebViewportTelemetryDiagnostics,
            resolveInvertedBottomPinCarveTelemetryFields,
        }), [
            nativeMountSettleStable,
            prependHost.clearWebRangeReserve,
            recordRestoreDecisionTelemetry,
            recordViewportTelemetryEvent,
            resolveInvertedBottomPinCarveTelemetryFields,
            resolveWebViewportTelemetryDiagnostics,
            resolveWebScrollMetrics,
            shouldUseNativeHotColdSplit,
            telemetryPlatform,
            webDomObservation,
        ]);
    // Chokepoint clear for explicit viewport writes (jump-to-bottom / jump-to-seq / nav-rail and
    // panel jumps): the command controller clears any live web prepend restore window when an
    // explicit write executes, so a stale content-growth restore cannot drag the viewport off
    // the jump landing. Stable identity via ref read (the prepend host wires the ref below).
    const clearWebPrependRestoreWindowForExplicitWrite = React.useCallback((
        outcome: TranscriptViewportTransactionOutcome,
    ) => {
        clearWebPrependRestoreWindowRef.current(outcome);
    }, []);
    const {
        executeViewportCommand,
        executeViewportCommandWithAnimation,
        resolveViewportCommand,
        restoreWebViewportAnchorThroughViewportCommand,
    } = useTranscriptViewportCommandHostWiring({
        clearWebPrependRestoreWindow: clearWebPrependRestoreWindowForExplicitWrite,
        commandHostRef,
        driverDeps: viewportDriverDeps,
        expandedToolCallsAnchorMessageIds,
        hasWebPrependRestoreWindow: prependHost.hasWebRestoreWindow,
        listContentHeight,
        listDataLength: listData.length,
        localHeightChangeRestoreOwner: appOwnsLocalHeightChangeRestore ? 'app' : 'renderer',
        pendingWebLocalHeightChangeAnchorRef,
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
        closeEntryViewportOwnership,
        composerInsetHeightRef,
        flushPendingNativeMountSettleBottomPin,
        jumpToSeqActive: props.jumpToSeq != null,
        lastPinOffsetForIntentRef,
        lifecycleHost,
        listContentHeightRef,
        listLayoutHeightRef,
        nativeMountSettleAutoPinSuppressedRef,
        nativeMountSettleDeadlineReachedRef,
        pendingNativeMountSettleBottomPinHostRef,
        platformOS: Platform.OS,
        scheduleNativePaintReleaseForEntryRestore,
        sessionId: props.sessionId,
        sessionOpenLatch,
        setNativeMountSettleDeadlineReached,
        setNativeMountSettleStable,
        usesNativeFlashListBottomMaintenance,
    });
    const paintTelemetry = useTranscriptPaintTelemetry({
        clearWebStablePaintRetry,
        coldItemCount: transcriptHotColdSegments.coldItems.length,
        committedMessagesCount: props.committedMessagesCount,
        firstListPaintObserved,
        firstPaintTelemetryRef,
        hotItemCount: transcriptHotColdSegments.hotItems.length,
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
        webHotColdSplit: shouldUseWebHotColdSplit,
    });
    const {
        handleFlashListLoad,
        isWarmKeepAliveInstance,
        recordFirstListPaint,
        recordStablePaintTelemetry,
        resolveEffectiveListPaintMetrics,
    } = paintTelemetry;
    const mainTranscriptListShellFrame = useMainTranscriptRendererFrameHost({
        autoFollowWhenPinned,
        bottomFollowModeRevision,
        bottomFollowModeStateRef,
        chatListNativeId,
        configuredFlashListDrawDistance,
        hasOpenEntryRestoreTransactionForSession,
        hasOpenNativePrependTransactionForSession,
        layoutHeight: listLayoutHeight,
        nativeEntryShouldUseBottomMaintenance,
        nativeFlashListMvcpPolicyRef,
        nativeFlashListPauseOffsetCorrectionRef,
        nativeInitialViewportPendingObservation,
        nativePrependTransactionRevision,
        pinEnabled,
        pinThresholdPx,
        platformOS: Platform.OS,
        shouldUseNativeHotColdSplit,
        targetWindowActive,
    });
    resolveRestoreAnchorIndexForCommandRef.current = resolveRestoreAnchorSourceIndexFromLoadedItems;
    const resolveForkedTurnMessageOrigin = React.useCallback((messageId: string) => {
        const metadata = props.forkMessageMetadataById?.[messageId] ?? null;
        if (!metadata) return null;
        return {
            sessionId: metadata.originSessionId,
            isReadOnlyContext: metadata.isReadOnlyContext,
        };
    }, [props.forkMessageMetadataById]);
    const getTurnMessageOrigin = props.forkedTranscriptEnabled ? resolveForkedTurnMessageOrigin : undefined;
    const toolTimelineChromeMode = useSetting('toolViewTimelineChromeMode');
    const resolveRollbackActionForMessage = React.useCallback((messageId: string): TranscriptRollbackAction | null => {
        return props.rollbackActionsByMessageId[messageId] ?? null;
    }, [props.rollbackActionsByMessageId]);
    const firstPaintState = useTranscriptFirstPaintState({
        applySessionOpenLatchEffectsRef,
        currentSessionIdRef,
        entryRestoreOwner,
        firstListPaintObserved,
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
        usesNativeFlashListBottomMaintenance,
    });
    const {
        nativeFirstPaintReleasedWithoutListLoad,
        showFirstPaintPlaceholder,
        showRouteHydrationFirstPaintPlaceholder,
    } = firstPaintState;
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
    const itemRenderer = useTranscriptItemRenderer({
        buildRowShellSignature,
        expandedToolCallsAnchorMessageIds,
        getMessageById: getTurnMessageById,
        getMessageOrigin: getTurnMessageOrigin,
        getMessageRevisionById: getTurnMessageRevisionById,
        handleRowLayoutMutation,
        handleRowShellMeasured,
        itemsRef,
        listDataRef,
        listOrientation,
        measurementReconciler,
        props,
        resolveCreatedAtForMessageId,
        resolveKindForMessageId,
        resolveRollbackActionForMessage,
        resolveThinkingExpanded,
        resolveToolCallMessagesForIds,
        setThinkingExpanded,
        setToolCallsGroupExpanded,
        toolRouteCommonRef,
        toolTimelineChromeMode,
    });
    const { renderItem, renderTranscriptItemAtIndex } = itemRenderer;
    const revealEntrySliceWindow = useTranscriptEntrySliceReveal({
        armNativeCommit: prependHost.armNativeCommit,
        beginNativeTransaction: prependHost.beginNativeTransaction,
        entrySliceWindowRef,
        entrySliceWithheldCountRef,
        sessionId: props.sessionId,
        setEntrySliceWindow,
        transcriptInitialFillBudgetMs: sync.getSyncTuning().transcriptInitialFillBudgetMs,
        transcriptInitialFillMaxNoProgressLoads: sync.getSyncTuning().transcriptInitialFillMaxNoProgressLoads,
    });
    revealEntrySliceWindowRef.current = revealEntrySliceWindow;
    const viewportAnchorCaptureHost = useTranscriptViewportAnchorCaptureHost({
        cancelScheduledViewportAnchorCapture,
        currentSessionIdRef,
        debounceMs: sync.getSyncTuning().transcriptViewportAnchorCaptureDebounceMs,
        emitViewportChange,
        listDataRef,
        listLayoutHeightRef,
        listRef,
        recordViewportTelemetryEvent,
        resolveWebScrollMetrics,
        scheduledViewportAnchorCaptureRef,
        shouldSuppressGenericViewportStateForProtectedJumpSeq: shouldSuppressGenericViewportStateForAnchorCapture,
        viewportAnchorCaptureGenerationRef,
        wantsPinnedRef,
    });
    scheduleViewportAnchorCaptureRef.current = viewportAnchorCaptureHost.schedule;
    React.useLayoutEffect(() => {
        flushViewportAnchorCaptureRef.current = viewportAnchorCaptureHost.flush;
    }, [viewportAnchorCaptureHost.flush]);
    const flushExitLiveTailIntent = React.useCallback((options?: Readonly<{ deferEmit?: boolean }>) => {
        if (Platform.OS === 'web') return;
        const distanceFromBottom = readCurrentNativeDistanceFromBottom() ?? lastPinOffsetForIntentRef.current;
        if (distanceFromBottom == null || distanceFromBottom > pinThresholdPx) return;
        const emit = onViewportChangeRef.current;
        if (!emit) return;
        const liveTailState = { isPinned: true, offsetY: 0, shouldRestoreViewport: false };
        if (options?.deferEmit === true) {
            queueMicrotask(() => {
                emit(liveTailState);
            });
            return;
        }
        emit(liveTailState);
    }, [pinThresholdPx, readCurrentNativeDistanceFromBottom]);
    React.useLayoutEffect(() => {
        flushExitLiveTailIntentRef.current = flushExitLiveTailIntent;
    }, [flushExitLiveTailIntent]);
    const observeNativePrependOwner = prependHost.observeNative;
    const observeWebPrependOwner = prependHost.observeWeb;
    const refreshInFlightWebPrependAnchor = prependHost.refreshInFlightWebAnchor;
    const retargetPendingWebPrependAnchorForUserScroll = prependHost.retargetPendingWebAnchorForUserScroll;
    const loadOlder = useCallback(async (options: TranscriptPrependOlderLoadOptions = {}): Promise<TranscriptPrependOlderLoadResult | null> => {
        const loadOlderOptions = options.preservePrependViewport === undefined
            ? { ...options, preservePrependViewport: appOwnsPrependRestore }
            : options;
        return await runTranscriptPrependOlderLoad({
            clearOlderLoadSpinnerDelay,
            hasActiveEntrySliceWindow: () => entrySliceWindowRef.current?.sessionId === props.sessionId,
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
            revealEntrySliceWindow: () => revealEntrySliceWindowRef.current(),
            resolveSyncLoadOlderOptions: () => resolveSyncLoadOlderOptions() ?? null,
            setHasMoreOlder,
            setIsLoadingOlder,
            showOlderLoadSpinner,
        });
    }, [
        appOwnsPrependRestore,
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
        cooldownMs: sync.getSyncTuning().transcriptOlderLoadCooldownMs,
        spinnerDelayMs: sync.getSyncTuning().transcriptOlderLoadSpinnerDelayMs,
        isFillDone: () => sessionOpenLatch.initialFillStatus() === 'done',
        isTransactionOpen: () => viewportCommandController.activeOwner() !== 'follow',
    });
    olderPaginationSnapshotRef.current = olderPagination.getSnapshot();
    resetOlderPaginationRef.current = olderPagination.reset;
        const tryPinToBottomDom = React.useCallback((reason: TranscriptViewportTelemetryScrollReason = 'initial-open'): boolean => {
            if (reason === 'jump-to-bottom') {
                return executeViewportCommand(resolveViewportCommand({
                    type: 'jump-to-bottom',
                    sessionId: props.sessionId,
                }));
            }
            if (reason === 'initial-open') {
                return executeViewportCommand(resolveViewportCommand({
                    type: 'first-paint',
                    sessionId: props.sessionId,
                    shouldFollowBottom: true,
                    entrySnapshot: null,
                    jumpToSeq: null,
                }));
            }
            if (reason === 'jump-to-seq') {
                return executeViewportCommand(resolveViewportCommand({
                    type: 'pin-bottom',
                    sessionId: props.sessionId,
                    reason,
                    mode: 'jump-to-seq',
                }));
            }
            return executeViewportCommand(resolveViewportCommand({
                type: 'auto-follow',
                sessionId: props.sessionId,
                distanceFromBottom: Number.MAX_SAFE_INTEGER,
                pinThresholdPx,
                recentUserIntent: false,
                wantsPinned: true,
                reason,
            }));
        }, [
            executeViewportCommand,
            pinThresholdPx,
            props.sessionId,
            resolveViewportCommand,
            telemetryPlatform,
        ]);
	    const bottomFollowHost = useTranscriptBottomFollowHost({
        applyFollowBottomIntentTakeoverApplyEffects,
        applyNativeExplicitJumpConfirmationEffects,
        authorizeImmediateBottomFollowWriteRef,
        canAutoFollowForReason,
        commitBottomFollowModeState,
        commitExplicitReturnToLiveTailState,
        commitScrollPinState,
        currentBottomFollowModeStateRef: bottomFollowModeStateRef,
        executeViewportCommand,
        followBottomIntentKey: props.followBottomIntentKey,
        hasNativeContentMeasurementForCurrentSession,
        hasNativeInitialViewportAppliedForCurrentSession,
        hasRearmedNativeBottomFollow,
        invalidateViewportAnchorCapture,
        isPinnedRef,
        jumpToSeq: props.jumpToSeq,
        lastNativePinOffsetRef,
        lastUserScrollIntentAtMsRef,
        latestCommittedActivityKey: props.latestCommittedActivityKey,
        lifecycleHost,
        liveTailCarveTelemetry: {
            active: shouldUseNativeHotColdSplit,
            anchorId: liveTailAnchor?.messageId ?? null,
            anchorKind: liveTailAnchor?.reason ?? null,
            coldCount: transcriptHotColdSegments.coldCount,
            hotCount: transcriptHotColdSegments.hotCount,
        },
        listContentHeightRef,
        listLayoutHeightRef,
        listRef,
        markNativeInitialViewportAppliedForCurrentSession,
        nativeMountSettleAutoPinSuppressedRef,
        nativeMountSettleDeadlineReached,
        nativeMountSettleDeadlineReachedRef,
        nativeHotTailResetRequired: renderWindowProjection.nativeHotTailResetRequired,
        nativeHotTailHeightRef,
        nativeMountSettleStable,
        observeNativeStreamAppendOffsetEscape,
        pinEnabled,
        pinThresholdPx,
        pinThresholdPxRef,
        readCurrentNativeDistanceFromBottom,
        readViewportContentMetrics,
        recordViewportTelemetryEvent,
        requestBottomFollowScheduledWriteRef,
        resolveViewportCommand,
        resolveViewportTelemetryMode,
        resolveWebScrollMetrics,
        scrollPinRef,
        sessionId: props.sessionId,
        tryPinToBottomDom,
        updateNativeInitialViewportPendingObservation,
        usesNativeFlashListBottomMaintenance,
        wantsPinnedRef,
    });
    const {
        applyNativeMountSettlePassiveDriftRepinObservation,
        applyWebPassiveLiveTailCorrectionEffect,
        beginExplicitJumpWriteBarrier,
        cancelScheduledPinToBottom: cancelScheduledPinToBottomFromHost,
        captureNativeBottomFollowPreviousFollow,
        captureWebBottomFollowPreviousMetrics,
        deferPinToBottomAfterScroll,
        endExplicitJumpWriteBarrier,
        flushPendingNativeMountSettleBottomPin: flushPendingNativeMountSettleBottomPinFromHost,
        handleNativeHotTailHeightChange,
        observeNativeConfirmation,
        pendingNativeMountSettleBottomPinRef,
        pinNativeFlashListToBottomIfMeasured,
        pinNativeInitialFollowBottomViewportIfReady,
        pinToBottom,
        pinToBottomRespectingNativeMountSettle,
        prepareNativeContentMaterializationAutoPin,
        requestAutomaticLiveTailPin,
        requestMeasuredNativeAutomaticLiveTailPin,
        resetPinRecordsForSessionEntry,
        resetPinStateForSessionOpenArm,
        resolveInvertedBottomPinCarveTelemetryFields: resolveInvertedBottomPinCarveTelemetryFieldsFromHost,
    } = bottomFollowHost;
    applyWebPassiveLiveTailCorrectionEffectRef.current = applyWebPassiveLiveTailCorrectionEffect;
    cancelScheduledPinToBottomRef.current = cancelScheduledPinToBottomFromHost;
    flushPendingNativeMountSettleBottomPinRef.current = flushPendingNativeMountSettleBottomPinFromHost;
    resolveInvertedBottomPinCarveTelemetryFieldsRef.current = resolveInvertedBottomPinCarveTelemetryFieldsFromHost;
	    applyNativeDragActiveMirrorEffectsRef.current = bottomFollowHost.applyNativeDragActiveMirrorEffects;
	    getBottomFollowGestureActiveRef.current = bottomFollowHost.getGestureActive;
	    resetBottomFollowPinRecordsForSessionEntryRef.current = resetPinRecordsForSessionEntry;
	    resetBottomFollowPinStateForSessionOpenArmRef.current = resetPinStateForSessionOpenArm;
	    pendingNativeMountSettleBottomPinHostRef.current = pendingNativeMountSettleBottomPinRef;

    // Stable identity wrapper: `isScrollable` is declared later in this component (TDZ), and an
    // inline arrow here would churn the entry host's session-open effect deps on every render.
    const isScrollableRef = React.useRef<() => boolean>(() => false);
    const isScrollableForEntryHost = React.useCallback((): boolean => isScrollableRef.current(), []);
    const entryHost = useTranscriptEntryHost({
        anchorLookupExhaustedRef,
        anchorLookupInFlightRef,
        anchorLookupLoadCountRef,
        applyEntryRestoreOwnerEffectsRef,
        applySessionOpenArmResetPlan,
        applySessionOpenDisposeResetPlan,
        applySessionOpenLatchEffectsRef,
        attemptEntryRestoreRef,
        autoPinDelayMs: TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS,
        closeEntryViewportOwnership,
        committedMessagesCount: props.committedMessagesCount,
        composerInsetHeightRef,
        currentSessionIdRef,
        decomposedItems,
        displayItemsLength: displayItems.length,
        disposeEntryRestoreTransactionForExitRef,
        entryRestoreDeadlineTimeoutRef,
        entryRestoreOwner,
        entrySliceWindowRef,
        executeViewportCommand,
        hasNativeContentMeasurementForCurrentSession,
        initialFillAbortRef,
        initialWebPinStabilizingRef,
        invalidateViewportAnchorCapture,
        isLoaded: props.isLoaded,
        isScrollable: isScrollableForEntryHost,
        isViewportAnchorSeqLoaded,
        jumpToSeq: props.jumpToSeq,
        jumpToSeqActiveRef,
        lastScrollOffsetForIntentRef,
        lastUserScrollIntentAtMsRef,
        latestJumpToSeqRef,
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
        observeMountSettleMetrics,
        pinThresholdPx,
        pinToBottom,
        pinToBottomRespectingNativeMountSettle,
        recordRestoreDecisionTelemetry,
        recordViewportTelemetryEvent,
        renderWindowProjection,
        requestBottomFollowScheduledWriteRef,
        resolveEntryRestoreOwnerAnchor,
        resolveNearestSurvivingViewportAnchorIndex,
        resolveNearestSurvivingViewportAnchorIndexFromItems,
        resolveSeqForViewportAnchor,
        resolveViewportCommand,
        resolveWebScrollMetrics,
        restoreWebViewportAnchorThroughViewportCommand,
        revealEntrySliceWindow,
        scheduleNativePaintReleaseForEntryRestore,
        scheduleFirstSessionOpenWebInitialPinRetryRef,
        sessionEntryViewportRef,
        sessionId: props.sessionId,
        sessionOpenLatch,
        sessionOpenWebInitialPinRetryArmAtMsRef,
        sessionOpenWebInitialPinRetryTimeoutRef,
        setEntrySliceWindow,
        setNativeMountSettleDeadlineReached,
        updateNativeInitialViewportPendingObservation,
        updateNativeViewportPaintObserved,
        waitForNextVisualUpdate,
        wantsPinnedRef,
    });
    const {
        applyEntryRestoreOwnerEffects,
        applySessionOpenLatchEffects,
        observeNativeEntryRestoreHostFacts,
        runEntryRestoreAttempt,
        verifyNativeSliceEntryRestoreTransaction,
        verifyWebEntryRestoreTransaction,
    } = entryHost;
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
        listLayoutWidthPx,
        listRef,
        messagesById: props.messagesById,
        onJumpLanded: props.onJumpLanded,
        onViewportChangeRef,
        pendingJumpSeqViewportPromotionRef,
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
        targetWindowIsWindowMode: targetWindowHostFacts.targetWindowActive,
        transcriptContentMaxWidth,
        transcriptNavigationEntries: props.transcriptNavigationEntries,
        transcriptNavigationRuntimeAnchorsRef,
        usesNativeFlashListBottomMaintenance,
        waitForNextVisualUpdate,
        webDomObservation,
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
        observeWebGenuineScrollMovement,
        observeWebTranscriptNavigationVisibilityForSession,
        onScrollToIndexFailed,
        promotePendingJumpSeqViewportSnapshot,
        shouldSuppressGenericViewportStateForProtectedJumpSeq,
        transcriptNavigationRailVisibilitySnapshot,
    } = jumpHost;
    shouldSuppressGenericViewportStateForProtectedJumpSeqRef.current = shouldSuppressGenericViewportStateForProtectedJumpSeq; commitJumpToBottomDistanceForVisibilityRef.current = commitJumpToBottomDistanceForVisibility;
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
    isScrollableRef.current = isScrollable;
    const skipRendererOwnedContentSizePin = React.useCallback(() => false, []);
    const flashListStartReachedThreshold = React.useMemo(() => {
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
        pinToBottom: appOwnsContinuousFollow ? pinToBottom : skipRendererOwnedContentSizePin,
        preDecompositionItemsRef,
        sessionEntryViewportRef,
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
        // Composer/keyboard inset resize is a write-authority event (S3): a held follow intent
        // must re-pin because the usable viewport height changed with no content change.
        if (appOwnsContinuousFollow) {
            requestAutomaticLiveTailPin(null, 'viewport-resized');
        }
    }, [appOwnsContinuousFollow, observeMountSettleMetrics, requestAutomaticLiveTailPin]);
    const transcriptItemsEdgeSlots = useTranscriptItemsEdgeSlots({
        bottomNotice: props.bottomNotice,
        composerInsetHeight,
        controlSwitchTo: props.controlSwitchTo,
        controlledByUserOverride: props.controlledByUserOverride,
        directControlFooter: props.directControlFooter,
        handleComposerInsetHeightChange,
        handleNativeHotTailHeightChange,
        isLoadingOlder,
        mainTranscriptListShellFrame,
        olderPaginationIsLoadingOlder: olderPagination.isLoadingOlder,
        onRequestSwitchToRemote: props.onRequestSwitchToRemote,
        prependRangeReservePx: prependHost.slots.rangeReservePx,
        renderTranscriptItemAtIndex,
        sessionId: props.sessionId,
        shouldUseNativeHotColdSplit,
        shouldUseWebHotColdSplit,
        showCatchUpOverlay: isCatchingUpNewer,
        showFirstPaintPlaceholder,
        transcriptHotColdSegments,
        transcriptOlderLoadSpinnerDelayMs: sync.getSyncTuning().transcriptOlderLoadSpinnerDelayMs,
    });
    const scrollObservationHost = useTranscriptScrollObservationHost({
        activeTargetWindowTargetRef,
        applyBlankRecoveryEffects,
        applyEntryRestoreOwnerEffects,
        applyNativeBottomFollowCompletionHostEffects,
        applyNativeDragActiveMirrorEffectsRef,
        applyNativeMountSettlePassiveDriftRepinObservation,
        applyNativeUserScrollTakeoverHostEffects,
        applyWebPassiveLiveTailCorrectionEffectRef,
        bottomFollowModeStateRef,
        cancelScheduledPinToBottom,
        captureNativeBottomFollowPreviousFollow,
        captureWebBottomFollowPreviousMetrics,
        commitBottomFollowModeState,
        commitJumpToBottomDistanceForVisibility,
        commitScrollPinEvent,
        commitScrollPinState,
        composerInsetHeightRef,
        continuousFollowOwner: appOwnsContinuousFollow ? 'app' : 'renderer',
        currentSessionIdRef,
        dispatchViewportLifecycleEvent,
        emitViewportChange,
        entryRestoreOwner,
        firstPaintTelemetryRef,
        getBottomFollowGestureActiveRef,
        hasNativeContentMeasurementForCurrentSession,
        hasNativeInitialViewportAppliedForCurrentSession,
        invalidateViewportAnchorCapture,
        isLoaded: props.isLoaded,
        isWarmKeepAliveInstance,
        lastExplicitWebScrollIntentAtMsRef,
        lastNativePinOffsetRef,
        lastPinOffsetForIntentRef,
        lastRouteJumpProtectionClearingWebMovementAtMsRef,
        lastScrollOffsetForIntentRef,
        lastUserScrollIntentAtMsRef,
        latestCommittedActivityKey: props.latestCommittedActivityKey,
        lifecycleHost,
        listContentHeightRef,
        listDataRef,
        listLayoutHeightRef,
        listRef,
        loadOlderInFlightRef: loadOlderInFlight,
        markNativeInitialViewportAppliedForCurrentSession,
        measurementHost,
        nativeBottomFollowRearmedAfterDragRef,
        nativeListDragActiveRef,
        nativeMomentumScrollActiveRef,
        nativeMountSettleAutoPinSuppressedRef,
        nativeMountSettleDeadlineReachedRef,
        nativeMountSettleStable,
        nativePrependTelemetryStateRef,
        nativeTranscriptTouchStartYRef,
        observeNativeBlankRecovery,
        observeNativeConfirmation,
        observeNativeEntryRestoreHostFacts,
        observeNativePrependOwner,
        observeMountSettleMetrics,
        observeWebGenuineScrollMovement,
        observeWebTranscriptNavigationVisibilityForSession,
        olderPagination,
        pendingJumpSeqViewportPromotionRef,
        pendingNativeMountSettleBottomPinRef,
        pinEnabled,
        pinEnabledRef,
        pinNativeInitialFollowBottomViewportIfReady,
        pinThresholdPx,
        pinThresholdPxRef,
        platformOS: Platform.OS,
        preemptEntryRestoreTransaction,
        prepareNativeContentMaterializationAutoPin,
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
        requestAutomaticLiveTailPin,
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
        usesNativeFlashListBottomMaintenance,
        verifyWebEntryRestoreTransaction,
        viewportCommandController,
        wantsPinnedRef,
        setListContentHeight,
        setListLayoutHeight,
        verifyNativeSliceEntryRestoreTransaction,
    });
    observeNativeStreamAppendOffsetEscapeHostRef.current =
        scrollObservationHost.observeNativeStreamAppendOffsetEscape;
    deferAutoPinAfterLocalTranscriptInteractionRef.current =
        scrollObservationHost.deferAutoPinAfterLocalTranscriptInteraction;
    adoptNativeFollowingForTrustedBottomArrivalRef.current =
        scrollObservationHost.adoptNativeFollowingForTrustedBottomArrival;
    const webViewInteractionProps = Platform.OS === 'web'
        ? scrollObservationHost.platformInteractionProps as Partial<React.ComponentProps<typeof View>>
        : undefined;
    return (
        <TranscriptMotionProvider sessionKey={props.sessionId} config={motionConfig}>
            <View
              style={{ flex: 1 }}
              {...webViewInteractionProps}
            >
                <TranscriptListShell<ChatTranscriptListItem>
                    ref={(node: TranscriptListShellRef<ChatTranscriptListItem> | null) => {
                        listRef.current = node as unknown as ScrollableChatListRef | null;
                    }}
                    frame={mainTranscriptListShellFrame}
                    transcriptLegendListSpikeSurface={transcriptLegendListSpikeSurface}
                    onCommitLayoutEffect={recordLayoutCommitObserved}
                    platformInteractionProps={scrollObservationHost.platformInteractionProps}
                    data={listData}
                    extraData={transcriptListExtraData}
                    key={props.sessionId}
                    keyExtractor={keyExtractor}
                    overrideProps={scrollObservationHost.nativeFlashListScrollOverrideProps}
                    getItemType={getItemType}
                    onLoad={handleFlashListLoad}
                    onViewableItemsChanged={shouldAttachNativeViewability ? handleNativeViewableItemsChanged : undefined}
                    viewabilityConfig={nativeViewabilityConfig}
                    onLayout={scrollObservationHost.onLayout}
                    onContentSizeChange={scrollObservationHost.onContentSizeChange}
                    onScroll={scrollObservationHost.onScroll}
                    onScrollBeginDrag={scrollObservationHost.onScrollBeginDrag}
                    onScrollEndDrag={scrollObservationHost.onScrollEndDrag}
                    onMomentumScrollBegin={scrollObservationHost.onMomentumScrollBegin}
                    onMomentumScrollEnd={scrollObservationHost.onMomentumScrollEnd}
                    renderItem={renderItem}
                    onStartReachedThreshold={flashListStartReachedThreshold}
                    onStartReached={scrollObservationHost.onStartReached}
                    onEndReachedThreshold={flashListStartReachedThreshold}
                    onEndReached={scrollObservationHost.onEndReached}
                    onScrollToIndexFailed={onScrollToIndexFailed}
                    header={transcriptItemsEdgeSlots.edgeSlots.listHeaderNode}
                    footer={transcriptItemsEdgeSlots.edgeSlots.listFooterNode}
                    olderLoadOverlay={transcriptItemsEdgeSlots.olderLoadOverlay}
                    catchUpOverlay={transcriptItemsEdgeSlots.catchUpOverlay}
                />
                <TranscriptNavigationRail
                    currentAnchorId={transcriptNavigationRailVisibilitySnapshot.currentAnchorId}
                    entries={props.transcriptNavigationEntries}
                    onJumpToEntry={handleTranscriptNavigationRailJump}
                    paneHeightPx={listLayoutHeight}
                    paneWidthPx={listLayoutWidthPx}
                    transcriptContentWidthPx={Math.min(listLayoutWidthPx, transcriptContentMaxWidth)}
                    transcriptMaxWidthPx={transcriptContentMaxWidth}
                    visibleAnchorIds={transcriptNavigationRailVisibilitySnapshot.visibleAnchorIds}
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
        </TranscriptMotionProvider>
    );
});
