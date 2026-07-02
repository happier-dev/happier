import * as React from 'react';
import { getStorage, useForkedTranscriptSnapshot, useMessage, useSessionActionDrafts, useSessionChatFooterState, useSessionLatestThinkingMessageId, useSessionLatestThinkingMessageActivityAtMs, useSessionMessages, useSessionMessagesById, useSessionPendingMessages, useSessionTranscriptIds, useSetting, } from '@/sync/domains/state/storage';
import { Dimensions, FlatList, PixelRatio, Platform, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { FlashList, LayoutCommitObserver, useRecyclingState } from '@/components/ui/lists/flashListCompat/FlashListCompat';
import { useCallback } from 'react';
import { MessageView, MessageViewWithSessionCommon } from './MessageView';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Metadata, Session } from '@/sync/domains/state/storageTypes';
import { buildSessionMetadataStabilitySignatureValue, buildStableJsonSignature } from '@/sync/domains/session/metadata/sessionMetadataStability';
import { buildTranscriptRenderSignature } from '@/sync/domains/session/transcriptRenderSignature';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { ChatFooter, type ChatFooterDirectControlState } from './ChatFooter';
import { buildChatListItems, buildChatListItemsCached, type ChatListItem, type ChatListItemsBuildCache } from '@/components/sessions/chatListItems';
import { injectForkContextRows } from '@/components/sessions/transcript/forkContext/injectForkContextRows';
import { ForkDividerRow } from '@/components/sessions/transcript/forkContext/ForkDividerRow';
import {
    PendingMessagesTranscriptBlock,
    type PendingMessageEditRequest,
} from '@/components/sessions/pending/PendingMessagesTranscriptBlock';
import { SessionActionDraftCard } from '@/components/sessions/actions/SessionActionDraftCard';
import { sync, type SessionViewportAnchorSnapshot } from '@/sync/sync';
import { jumpToTranscriptSeq } from '@/utils/sessions/jumpToTranscriptSeq';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { buildTranscriptTurnsCached, type TranscriptTurn, type TranscriptTurnsBuildCache } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import { splitOversizedTranscriptTurnItems } from '@/components/sessions/transcript/turnGrouping/splitOversizedTranscriptTurnItems';
import { TurnViewWithSessionCommon } from '@/components/sessions/transcript/turns/TurnView';
import { ToolCallsGroupRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/ToolCallsGroupRow';
import { shouldAutoExpandToolCallsGroupForShortTranscript } from '@/components/sessions/transcript/toolCalls/resolveToolCallsGroupAutoExpandPolicy';
import { TranscriptMotionProvider } from '@/components/sessions/transcript/motion/TranscriptMotionProvider';
import { resolveTranscriptMotionConfig } from '@/components/sessions/transcript/motion/resolveTranscriptMotionConfig';
import { TranscriptEnterWrapper } from '@/components/sessions/transcript/motion/TranscriptEnterWrapper';
import { resolveTranscriptToolCallsCollapsedPreviewCount } from '@/sync/domains/settings/transcriptToolCallsCollapsedPreviewCount';
import { JumpToBottomButton } from '@/components/sessions/transcript/scroll/JumpToBottomButton';
import { resolveNextJumpToBottomDistanceVisibilityState } from '@/components/sessions/transcript/scroll/jumpToBottomVisibilityDistanceState';
import { reduceTranscriptScrollPinState, type TranscriptScrollPinState } from '@/components/sessions/transcript/scroll/transcriptScrollPinController';
import {
    recordTranscriptViewportTelemetryEvent,
    resolveTranscriptViewportTelemetryListImplementation,
    resolveTranscriptViewportTelemetryPlatform,
    transcriptViewportTelemetry,
    type TranscriptViewportTelemetryEvent,
    type TranscriptViewportTelemetryObservationReason,
    type TranscriptViewportTelemetryScrollReason,
    type TranscriptViewportTelemetryScrollWriter,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import {
    createTranscriptViewportController,
    type TranscriptViewportController,
} from '@/components/sessions/transcript/viewport/createTranscriptViewportController';
import type {
    TranscriptViewportCommand,
    TranscriptViewportControllerInput,
    TranscriptViewportMode,
    TranscriptViewportScrollReason,
} from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import type { TranscriptViewportTransactionOutcome } from '@/components/sessions/transcript/viewport/transcriptViewportOwnership';
import {
    createEntryRestoreTransaction,
    type EntryRestoreTransaction,
} from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreTransaction';
import { resolveEntryRestoreTarget } from '@/components/sessions/transcript/viewport/entryRestore/resolveEntryRestoreTarget';
import {
    observePrependOutcome,
    type PrependCapturedAnchor,
    type PrependOutcome,
} from '@/components/sessions/transcript/viewport/prepend/observePrependOutcome';
import {
    createPrependFallbackQuietGate,
    type PrependFallbackQuietGate,
} from '@/components/sessions/transcript/viewport/prepend/prependFallbackQuietGate';
import {
    createPrependTransaction,
    type PrependTransaction,
} from '@/components/sessions/transcript/viewport/prepend/prependTransaction';
import { nativeEntryRestoreObservationMatches } from '@/components/sessions/transcript/viewport/nativeEntryRestoreObservationPolicy';
import {
    resolveNativePassiveBottomDriftNoiseFloorPx,
    shouldIgnoreNativeInvalidScrollObservation as resolveShouldIgnoreNativeInvalidScrollObservation,
} from '@/components/sessions/transcript/viewport/nativePassiveScrollPolicy';
import { resolveTranscriptInitialFillTuning } from '@/components/sessions/transcript/scroll/resolveTranscriptInitialFillTuning';
import { resolveWebPinRetryTimeoutMs } from '@/components/sessions/transcript/scroll/resolveWebPinRetryTimeoutMs';
import { resolveInitialWebPinRetryDelays } from '@/components/sessions/transcript/scroll/resolveInitialWebPinRetryDelays';
import { resolveSessionEntryBottomFollow } from '@/components/sessions/transcript/scroll/resolveSessionEntryBottomFollow';
import { resolveTranscriptBottomFollowIntent } from '@/components/sessions/transcript/scroll/resolveTranscriptBottomFollowIntent';
import {
    resolveTranscriptBottomFollowMode,
    type TranscriptBottomFollowModeEvent,
    type TranscriptBottomFollowModeState,
} from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';
import {
    canAutoFollowTranscriptBottom,
    isExplicitTranscriptBottomFollowCommand,
} from '@/components/sessions/transcript/scroll/transcriptAutoFollowGate';
import { resolveTranscriptFlashListBottomMaintenance } from '@/components/sessions/transcript/scroll/transcriptFlashListBottomMaintenance';
import {
    resolveTranscriptEdgePrefetchThresholdPx,
    TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO,
    TRANSCRIPT_EDGE_PREFETCH_MAX_PX,
    TRANSCRIPT_EDGE_PREFETCH_MIN_PX,
} from '@/components/sessions/transcript/scroll/resolveTranscriptEdgePrefetchThresholdPx';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { isEnrichedMarkdownRuntimePreloaded, preloadEnrichedMarkdownRuntime } from '@/components/markdown/enriched/preloadEnrichedMarkdownRuntime';
import { resolveActiveThinkingMessageId } from '@/components/sessions/transcript/thinking/resolveActiveThinkingMessageId';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { deriveTranscriptInteractionFromSession, type TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { buildChatListNativeId } from './chatListNativeId';
import { useWebFlashListCrashFallback } from '@/components/ui/lists/useWebFlashListCrashFallback';
import { buildTranscriptHotColdSegments } from '@/components/sessions/transcript/segments/buildTranscriptHotColdSegments';
import { resolveWebHotColdScrollDecision } from '@/components/sessions/transcript/segments/resolveWebHotColdScrollDecision';
import {
    isMessageRolledBack,
    readSessionRollbackRangesV1,
    resolveTranscriptRollbackActions,
    type TranscriptRollbackAction,
    type SessionRollbackRangeV1,
} from '@/sync/domains/sessionRollback/rollbackUiSupport';
import { deriveTurnChangeSetsFromMessages } from '@/sync/domains/session/changes/derivation/deriveTurnChangeSetsFromMessages';
import {
    getWebTranscriptDistanceFromBottom,
    isWebTranscriptScrollable,
    resolveWebTranscriptMaxScrollTop,
    resolveWebTranscriptScrollMetrics,
    type WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import { resolveWebBottomFollowAdjustment } from '@/components/sessions/transcript/scroll/resolveWebBottomFollowAdjustment';
import { WebTranscriptSplitFooter } from '@/components/sessions/transcript/web/WebTranscriptSplitFooter';
import {
    ComposerKeyboardFloatingInset,
    ComposerKeyboardScrollInset,
} from '@/components/sessions/keyboardAvoidance';
import {
    hasTranscriptSessionCommonProps,
    type TranscriptSessionCommonProps,
    useTranscriptSessionCommon,
} from '@/components/sessions/transcript/transcriptSessionCommon';
import {
    hasTranscriptWarmStablePaint,
    rememberTranscriptWarmStablePaint,
} from '@/components/sessions/transcript/paint/transcriptWarmPaintCache';
import {
    nativeBottomFollowCanApplyCompletion,
    nativeBottomFollowCanCompletePendingPin,
    nativeBottomFollowPinTargetObserved,
} from '@/components/sessions/transcript/viewport/nativeBottomFollowObservationPolicy';
import {
    TranscriptMessageSelectionBoundary,
    useOptionalTranscriptSelectionState,
} from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';
import {
    captureWebTranscriptPrependAnchor,
    captureWebTranscriptViewportAnchor,
    refreshWebTranscriptPrependAnchor,
    resolveWebTranscriptViewportAnchorAlignment,
    restoreWebTranscriptPrependAnchor,
    restoreWebTranscriptViewportAnchor,
    TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX,
    TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX,
    TRANSCRIPT_WEB_TOOL_CALL_PREPEND_ANCHOR_TEST_ID_PREFIX,
    TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX,
    type WebTranscriptPrependAnchor,
    type WebTranscriptPrependRestoreResult,
} from '@/components/sessions/transcript/webTranscriptPrependAnchor';
import { resolveWebTranscriptPrependRangeReservePx } from '@/components/sessions/transcript/webTranscriptPrependRangeReserve';
import {
    captureNativeTranscriptViewportAnchor,
    planNativeTranscriptViewportAnchorRestore,
    resolveNativeTranscriptViewportAnchorRestoreObservation,
} from '@/components/sessions/transcript/transcriptNativeViewportAnchor';
import {
    resolveTranscriptViewportAnchorDescriptor,
    resolveTranscriptViewportAnchorFocusOffsetPx,
    resolveTranscriptViewportAnchorIndex,
} from '@/components/sessions/transcript/transcriptViewportAnchorResolution';
import {
    clearStreamingSessionUiTelemetryMarks,
    readSessionUiTelemetryNowMs,
    recordSessionOpenPaintForSessionUiTelemetry,
    recordStreamingVisibleUpdateForSessionUiTelemetry,
} from '@/sync/runtime/performance/sessionUiTelemetry';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SyncPerformanceReactProfiler } from '@/components/ui/performance/SyncPerformanceReactProfiler';
import { TranscriptFirstPaintPlaceholder } from '@/components/sessions/transcript/TranscriptFirstPaintPlaceholder';
import {
    TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS,
    TRANSCRIPT_TOP_GUTTER_PX,
    TRANSCRIPT_VISUAL_UPDATE_FALLBACK_TIMEOUT_MS,
    TRANSCRIPT_WEB_FLASH_LIST_SCROLL_EVENT_THROTTLE_MS,
} from '@/components/sessions/transcript/_constants';
import { OlderLoadProgressOverlay } from '@/components/sessions/transcript/OlderLoadProgressOverlay';
import { useTranscriptOlderPagination } from '@/components/sessions/transcript/pagination/useTranscriptOlderPagination';
import { waitForVisualUpdateWithTimeout } from '@/components/sessions/transcript/pagination/waitForVisualUpdateWithTimeout';
import { LruMap } from '@/utils/cache/lruMap';
import { buildTranscriptItemHeightSignatureKey, getDefaultTranscriptItemHeightCache, type TranscriptItemHeightCache, type TranscriptItemHeightValiditySignature } from '@/components/sessions/transcript/measurement/transcriptItemHeightCache';
import { resolveTranscriptRowShellHeight } from '@/components/sessions/transcript/measurement/resolveTranscriptRowShellHeight';
import { buildTranscriptRowShellSignature, resolveTranscriptRowItemType, type TranscriptRowShellItem } from '@/components/sessions/transcript/measurement/transcriptRowShellSignature';
import { createTranscriptMountSettlePinCoordinator, type TranscriptMountSettlePinCoordinator, type TranscriptMountSettleTuning } from '@/components/sessions/transcript/scroll/transcriptMountSettlePinCoordinator';

type ScrollableChatListRef = Readonly<{
    scrollToIndex: (params: { index: number; animated?: boolean; viewOffset?: number; viewPosition?: number }) => void;
    scrollToOffset: (params: { offset: number; animated?: boolean }) => void;
    scrollToEnd?: (params?: { animated?: boolean }) => void;
    computeVisibleIndices?: () => { startIndex: number; endIndex: number };
    getAbsoluteLastScrollOffset?: () => number;
    getFirstVisibleIndex?: () => number;
    getLayout?: (index: number) => { x: number; y: number; width: number; height: number } | undefined;
}>;

type ChatTranscriptListItem = TranscriptRowShellItem;

function measureTranscriptDerivation<T>(
    name: string,
    buildFields: () => Record<string, number>,
    fn: () => T,
): T {
    if (!syncPerformanceTelemetry.isEnabled()) return fn();
    return syncPerformanceTelemetry.measure(name, buildFields(), fn);
}

/**
 * Host-side context for the single entry-restore write (plan F2 / W2.2): everything the
 * alignment predicate and the one allowed correction need to re-derive targets.
 * The transaction itself (`entryRestoreTransaction.ts`) owns the write budget.
 */
type EntryRestoreWriteContext = Readonly<{
    anchor: SessionViewportAnchorSnapshot | null;
    createdAtMs: number;
    /** Remembered distance from the bottom of the transcript, in px. */
    distanceFromBottom: number;
    /** Canonical content height (scroll-event contentSize basis, A6) at issue time. */
    issuedContentHeight: number;
    issuedLayoutHeight: number;
    kind: 'anchor' | 'distance' | 'bottom';
    sessionId: string;
    targetOffsetY: number | null;
    targetOffsetYWasClamped: boolean;
}>;

type LastNativeRestoreIndexCommand = Readonly<{
    index: number;
    issuedAtMs: number;
    reason: TranscriptViewportTelemetryScrollReason;
    sessionId: string;
    viewOffset?: number;
}>;

const EMPTY_MESSAGES_BY_ID: Readonly<Record<string, Message>> = Object.freeze({});
const TRANSCRIPT_SCROLL_AUTO_REPIN_THROTTLE_MS = 200;
const TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS = 250;
const TRANSCRIPT_SCROLL_USER_INTENT_RECENT_MS = 500;
// Plan E3: scrollbar/keyboard scrolling fires no wheel/pointer/touch handler — sustained
// (>= this many same-direction frames) non-programmatic movement counts as user intent.
const TRANSCRIPT_WEB_NON_PROGRAMMATIC_SCROLL_SUSTAIN_FRAMES = 2;
// Plan C4: when the drawDistance tuning is unset, native FlashList draws about one viewport
// height ahead (clamped) so rows above the viewport are measured before prepends land there.
const TRANSCRIPT_NATIVE_DRAW_DISTANCE_DEFAULT_MIN_PX = 600;
const TRANSCRIPT_NATIVE_DRAW_DISTANCE_DEFAULT_MAX_PX = 1200;
const TRANSCRIPT_NATIVE_ENTRY_RESTORE_PAINT_RELEASE_DELAY_MS = 32;
const TRANSCRIPT_NATIVE_TOUCH_ESCAPE_MOVE_THRESHOLD_PX = 12;
const TRANSCRIPT_SCROLL_JUMP_TO_BOTTOM_REVEAL_VIEWPORT_RATIO_FALLBACK = 0.75;
const TRANSCRIPT_SCROLL_JUMP_TO_BOTTOM_REVEAL_VIEWPORT_RATIO_MAX = 4;
const TRANSCRIPT_DERIVED_ITEMS_CACHE_FALLBACK_MAX_SESSIONS = 16;
const TRANSCRIPT_WIDTH_BUCKET_PX = 80;
const TRANSCRIPT_FONT_SCALE_BUCKET_FACTOR = 100;

function resolveIndexScrollWriter(params: Readonly<{
    platform: ReturnType<typeof resolveTranscriptViewportTelemetryPlatform>;
    listImplementation: string;
}>): TranscriptViewportTelemetryScrollWriter {
    if (params.platform === 'web') return 'web-scroll-to-index';
    if (params.listImplementation === 'flatlist_legacy') return 'legacy-scroll-to-index';
    return 'native-scroll-to-index';
}

function resolveNativeScrollEventMetric(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}

function readNativeTouchPageY(event: unknown): number | null {
    if (event == null || typeof event !== 'object') return null;
    const nativeEvent = (event as { nativeEvent?: unknown }).nativeEvent;
    if (nativeEvent == null || typeof nativeEvent !== 'object') return null;
    const directPageY = (nativeEvent as { pageY?: unknown }).pageY;
    if (typeof directPageY === 'number' && Number.isFinite(directPageY)) return directPageY;
    const locationY = (nativeEvent as { locationY?: unknown }).locationY;
    if (typeof locationY === 'number' && Number.isFinite(locationY)) return locationY;
    const touches = (nativeEvent as { touches?: unknown }).touches;
    if (Array.isArray(touches)) {
        const touchPageY = (touches[0] as { pageY?: unknown } | undefined)?.pageY;
        if (typeof touchPageY === 'number' && Number.isFinite(touchPageY)) return touchPageY;
    }
    const changedTouches = (nativeEvent as { changedTouches?: unknown }).changedTouches;
    if (Array.isArray(changedTouches)) {
        const touchPageY = (changedTouches[0] as { pageY?: unknown } | undefined)?.pageY;
        if (typeof touchPageY === 'number' && Number.isFinite(touchPageY)) return touchPageY;
    }
    return null;
}

function withTranscriptViewportCommandAnimation(
    command: TranscriptViewportCommand,
    animated: boolean,
): TranscriptViewportCommand {
    switch (command.kind) {
        case 'pin-bottom':
        case 'scroll-offset':
        case 'restore-offset':
        case 'restore-index':
        case 'jump-to-seq':
            return { ...command, animated };
        case 'skip-native-js-pin':
        case 'none':
            return command;
    }
}

type TranscriptDerivedItemsCacheEntry = {
    linearItemsCache: ChatListItemsBuildCache | null;
    turnsCache: TranscriptTurnsBuildCache | null;
};

const transcriptDerivedItemsCacheBySessionId = new LruMap<string, TranscriptDerivedItemsCacheEntry>({
    maxEntries: TRANSCRIPT_DERIVED_ITEMS_CACHE_FALLBACK_MAX_SESSIONS,
});

function resolveTranscriptDerivedItemsCacheMaxSessions(): number {
    const configured = sync.getSyncTuning().transcriptDerivedItemsCacheMaxSessions;
    return typeof configured === 'number' && Number.isFinite(configured)
        ? Math.max(1, Math.trunc(configured))
        : TRANSCRIPT_DERIVED_ITEMS_CACHE_FALLBACK_MAX_SESSIONS;
}

function readTranscriptDerivedItemsCacheEntry(sessionId: string): TranscriptDerivedItemsCacheEntry {
    transcriptDerivedItemsCacheBySessionId.setMaxEntries(resolveTranscriptDerivedItemsCacheMaxSessions());
    const existing = transcriptDerivedItemsCacheBySessionId.get(sessionId);
    if (existing) return existing;
    const created: TranscriptDerivedItemsCacheEntry = {
        linearItemsCache: null,
        turnsCache: null,
    };
    transcriptDerivedItemsCacheBySessionId.set(sessionId, created);
    return created;
}

function resolveTranscriptWidthBucket(width: number): string {
    const fallbackWidth = Dimensions.get('window')?.width ?? 0;
    const measured = typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : fallbackWidth;
    return String(Math.max(0, Math.round(measured / TRANSCRIPT_WIDTH_BUCKET_PX)));
}

function resolveTranscriptFontScaleKey(): string {
    const scale = PixelRatio.getFontScale();
    const normalized = typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : 1;
    return String(Math.max(1, Math.round(normalized * TRANSCRIPT_FONT_SCALE_BUCKET_FACTOR)));
}

function resolveTranscriptMountSettleTuning(): TranscriptMountSettleTuning {
    const tuning = sync.getSyncTuning();
    return {
        quiescentWindowMs: tuning.transcriptMountSettleQuiescentWindowMs,
        dimensionNoiseFloorPx: tuning.transcriptMountSettleDimensionNoiseFloorPx,
        bottomDistanceNoiseFloorPx: tuning.transcriptMountSettleBottomDistanceNoiseFloorPx,
    };
}

function resolvePendingQueueActivityKey(item: Extract<ChatListItem, { kind: 'pending-queue' }>): string {
    const tail = item.pendingMessages[item.pendingMessages.length - 1] ?? item.discardedMessages[item.discardedMessages.length - 1] ?? null;
    const tailIdentity =
        tail == null
            ? 'none'
            : [
                tail.id,
                tail.localId,
                Number.isFinite(tail.updatedAt) ? String(Math.trunc(tail.updatedAt)) : null,
                Number.isFinite(tail.createdAt) ? String(Math.trunc(tail.createdAt)) : null,
            ].find((value) => typeof value === 'string' && value.length > 0) ?? 'tail';

    return `pending-queue:${item.pendingMessages.length}:${item.discardedMessages.length}:${tailIdentity}`;
}

function resolveLatestVisibleTailActivityKey(items: readonly ChatTranscriptListItem[]): string | null {
    const latestItem = items[items.length - 1] ?? null;
    if (!latestItem) return null;

    switch (latestItem.kind) {
        case 'pending-queue':
            return resolvePendingQueueActivityKey(latestItem);
        case 'message':
        case 'tool-calls-group':
        case 'fork-divider':
        case 'action-draft':
        case 'turn':
            return latestItem.id;
        default:
            return null;
    }
}

export type ChatListBottomNotice = {
    title: string;
    body: string;
};

type LoadOlderOptions = Readonly<{
    showLoadingIndicator?: boolean;
    loadingIndicatorDelayMs?: number;
    preservePrependViewport?: boolean;
}>;

type SyncLoadOlderOptions = Readonly<{
    limit: number;
}>;

function readSessionViewportForEntry(sessionId: string) {
    return typeof sync.getSessionViewport === 'function' ? sync.getSessionViewport(sessionId) : null;
}

function buildRollbackActionsInputSignature(params: Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
}>): string {
    let signature = '';
    for (const messageId of params.messageIdsOldestFirst) {
        const message = params.messagesById[messageId];
        if (!message) {
            signature += `${messageId}:missing|`;
            continue;
        }
        const seq = typeof message.seq === 'number' && Number.isFinite(message.seq) ? Math.trunc(message.seq) : '';
        signature += `${message.id}:${message.kind}:${seq}`;
        if (message.kind === 'user-text') {
            signature += `:${message.text}`;
        }
        signature += '|';
    }
    return signature;
}

function useStableValueBySignature<T>(value: T, signature: string): T {
    const ref = React.useRef<{ signature: string; value: T }>({ signature, value });
    if (ref.current.signature !== signature) {
        ref.current = { signature, value };
    }
    return ref.current.value;
}

export type TranscriptViewportChangeState = Readonly<{
    isPinned: boolean;
    offsetY: number;
    shouldRestoreViewport: boolean;
    anchor?: SessionViewportAnchorSnapshot | null;
}>;

type ChatListProps = Readonly<{
    session: Session;
    bottomNotice?: ChatListBottomNotice | null;
    controlledByUserOverride?: boolean;
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void;
    directControlFooter?: ChatFooterDirectControlState;
    jumpToSeq?: number | null;
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
    followBottomIntentKey?: string | number | null;
    isWarmKeepAliveInstance?: boolean;
    onViewportChange?: (state: TranscriptViewportChangeState) => void;
    onEditPendingMessage?: (request: PendingMessageEditRequest) => void | Promise<void>;
    routeHydrationPending?: boolean;
}>;

function areChatListNonSessionPropsEqual(left: ChatListProps, right: ChatListProps): boolean {
    return left.bottomNotice === right.bottomNotice
        && left.controlledByUserOverride === right.controlledByUserOverride
        && left.controlSwitchTo === right.controlSwitchTo
        && left.onRequestSwitchToRemote === right.onRequestSwitchToRemote
        && left.directControlFooter === right.directControlFooter
        && left.approvalRequests === right.approvalRequests
        && left.jumpToSeq === right.jumpToSeq
        && left.followBottomIntentKey === right.followBottomIntentKey
        && left.onEditPendingMessage === right.onEditPendingMessage
        && left.onViewportChange === right.onViewportChange
        && left.isWarmKeepAliveInstance === right.isWarmKeepAliveInstance
        && left.routeHydrationPending === right.routeHydrationPending;
}

function areChatListPropsEqual(left: ChatListProps, right: ChatListProps): boolean {
    if (!areChatListNonSessionPropsEqual(left, right)) return false;
    if (left.session === right.session) return true;
    return buildTranscriptRenderSignature(left.session) === buildTranscriptRenderSignature(right.session);
}

export const ChatList = React.memo(function ChatList(props: ChatListProps) {
    React.useEffect(() => {
        fireAndForget(preloadEnrichedMarkdownRuntime(), { tag: 'ChatList.preloadEnrichedMarkdownRuntime' });
    }, []);

    const fork = useForkedTranscriptSnapshot(props.session.id);
    const { ids: childMessageIdsOldestFirst, isLoaded } = useSessionTranscriptIds(props.session.id);
    const childMessagesById = useSessionMessagesById(props.session.id);
    const forkedTranscriptEnabled = fork != null;
    const swrFallbackCandidateEnabled = !forkedTranscriptEnabled && childMessageIdsOldestFirst.length === 0;
    const { messages: swrCommittedMessages } = useSessionMessages(props.session.id, { enabled: swrFallbackCandidateEnabled });
    const { messages: pendingMessages, discarded: discardedPendingMessages } = useSessionPendingMessages(props.session.id);
    const actionDrafts = useSessionActionDrafts(props.session.id);

    const transcriptGroupingMode = useSetting('transcriptGroupingMode');
    const transcriptGroupToolCalls = useSetting('transcriptGroupToolCalls');
    const transcriptTurnToolCallsGroupStrategy = useSetting('transcriptTurnToolCallsGroupStrategy');
    const transcriptListImplementation = useSetting('transcriptListImplementation');
    const transcriptSessionCommon = useTranscriptSessionCommon(props.session.id);
    const toolViewTimelineChromeMode = transcriptSessionCommon.toolChrome.toolViewTimelineChromeMode;

    const swrFallbackEnabled = !forkedTranscriptEnabled
        && childMessageIdsOldestFirst.length === 0
        && swrCommittedMessages.length > 0;
    const swrFallbackMessageIdsOldestFirst = React.useMemo(() => {
        if (!swrFallbackEnabled) return childMessageIdsOldestFirst;
        return swrCommittedMessages.map((message) => message.id);
    }, [childMessageIdsOldestFirst, swrCommittedMessages, swrFallbackEnabled]);
    const swrFallbackMessagesById = React.useMemo(() => {
        if (!swrFallbackEnabled) return childMessagesById;
        const out: Record<string, Message> = {};
        for (const message of swrCommittedMessages) {
            out[message.id] = message;
        }
        return out;
    }, [childMessagesById, swrCommittedMessages, swrFallbackEnabled]);

    const forkContextNeedsPrefetch = React.useMemo(() => {
        if (!fork) return false;
        return fork.segments.some((seg) =>
            seg.isReadOnlyContext === true &&
            typeof seg.cutoffSeqInclusive === 'number' &&
            Number.isFinite(seg.cutoffSeqInclusive) &&
            seg.cutoffSeqInclusive >= 0 &&
            (seg.messageIdsOldestFirst?.length ?? 0) === 0
        );
    }, [fork]);

    React.useEffect(() => {
        if (!forkContextNeedsPrefetch) return;
        fireAndForget(sync.prefetchForkedTranscriptContext(props.session.id), { tag: 'ChatList.prefetchForkedTranscriptContext' });
    }, [forkContextNeedsPrefetch, props.session.id]);

    const messageIdsOldestFirst = React.useMemo(() => {
        if (forkedTranscriptEnabled) {
            return fork!.combinedMessageIdsOldestFirst as any as string[];
        }
        return swrFallbackMessageIdsOldestFirst;
    }, [fork, forkedTranscriptEnabled, swrFallbackMessageIdsOldestFirst]);
    const messagesById = React.useMemo(() => {
        if (forkedTranscriptEnabled) {
            return fork!.combinedMessagesById as any;
        }
        return swrFallbackMessagesById;
    }, [fork, forkedTranscriptEnabled, swrFallbackMessagesById]);
    const sessionMetadataSignature = React.useMemo(
        () => buildStableJsonSignature(buildSessionMetadataStabilitySignatureValue(props.session.metadata ?? null)),
        [props.session.metadata],
    );
    const stableSessionMetadata = useStableValueBySignature(props.session.metadata, sessionMetadataSignature);

    const groupingMode = forkedTranscriptEnabled ? 'linear' : (transcriptGroupingMode === 'turns' ? 'turns' : 'linear');
    const groupToolCalls =
        transcriptGroupToolCalls === true &&
        (toolViewTimelineChromeMode === 'activity_feed') &&
        forkedTranscriptEnabled !== true;
    const toolCallsGroupStrategy =
        transcriptTurnToolCallsGroupStrategy === 'all_tools_in_turn' ? 'all_tools_in_turn' : 'consecutive_tools';
    const transcriptMaxTurnEntriesPerListItem = sync.getSyncTuning().transcriptMaxTurnEntriesPerListItem;

    const derivedItemsCacheEntry = readTranscriptDerivedItemsCacheEntry(props.session.id);
    const derivedItemsCacheSessionIdRef = React.useRef(props.session.id);
    const linearItemsCacheRef = React.useRef<ChatListItemsBuildCache | null>(derivedItemsCacheEntry.linearItemsCache);
    const turnsCacheRef = React.useRef<TranscriptTurnsBuildCache | null>(derivedItemsCacheEntry.turnsCache);
    if (derivedItemsCacheSessionIdRef.current !== props.session.id) {
        const nextEntry = readTranscriptDerivedItemsCacheEntry(props.session.id);
        derivedItemsCacheSessionIdRef.current = props.session.id;
        linearItemsCacheRef.current = nextEntry.linearItemsCache;
        turnsCacheRef.current = nextEntry.turnsCache;
    }
    const turnsCache = React.useMemo(() => {
        if (groupingMode !== 'turns') return null;
        return measureTranscriptDerivation('ui.sessions.transcript.derived.turns', () => ({
            cacheProvided: turnsCacheRef.current ? 1 : 0,
            groupToolCalls: groupToolCalls ? 1 : 0,
            messageCount: messageIdsOldestFirst.length,
        }), () => {
            return buildTranscriptTurnsCached({
                cache: turnsCacheRef.current,
                messageIdsOldestFirst,
                messagesById,
                groupToolCalls,
                toolCallsGroupStrategy,
            });
        });
    }, [groupingMode, messageIdsOldestFirst, messagesById, groupToolCalls, toolCallsGroupStrategy]);

    React.useEffect(() => {
        turnsCacheRef.current = turnsCache;
        readTranscriptDerivedItemsCacheEntry(props.session.id).turnsCache = turnsCache;
    }, [props.session.id, turnsCache]);

    const linearCache = React.useMemo(() => {
        if (groupingMode === 'turns') return null;
        return measureTranscriptDerivation('ui.sessions.transcript.derived.linearItems', () => ({
            actionDraftCount: actionDrafts.length,
            cacheProvided: linearItemsCacheRef.current ? 1 : 0,
            discardedPendingCount: discardedPendingMessages?.length ?? 0,
            groupToolCalls: groupToolCalls ? 1 : 0,
            messageCount: messageIdsOldestFirst.length,
            pendingCount: pendingMessages.length,
        }), () => {
            return buildChatListItemsCached({
                cache: linearItemsCacheRef.current,
                messageIdsOldestFirst,
                messagesById,
                pendingMessages,
                discardedMessages: discardedPendingMessages,
                actionDrafts,
                groupConsecutiveToolCalls: groupToolCalls,
            });
        });
    }, [actionDrafts, groupingMode, groupToolCalls, messageIdsOldestFirst, messagesById, pendingMessages, discardedPendingMessages]);

    React.useEffect(() => {
        if (groupingMode === 'turns') {
            linearItemsCacheRef.current = null;
            readTranscriptDerivedItemsCacheEntry(props.session.id).linearItemsCache = null;
            return;
        }
        linearItemsCacheRef.current = linearCache?.cache ?? null;
        readTranscriptDerivedItemsCacheEntry(props.session.id).linearItemsCache = linearItemsCacheRef.current;
    }, [groupingMode, linearCache, props.session.id]);

    const forkMessageMetadataById = React.useMemo(() => {
        if (!fork) return null;
        const out: Record<string, { originSessionId: string; isReadOnlyContext: boolean }> = {};
        for (const [messageId, metadata] of Object.entries(fork.messageOriginById)) {
            out[messageId] = {
                originSessionId: metadata.sessionId,
                isReadOnlyContext: metadata.isReadOnlyContext,
            };
        }
        return out;
    }, [fork]);

    const groupedItems = React.useMemo<ChatTranscriptListItem[]>(() => {
        return measureTranscriptDerivation('ui.sessions.transcript.derived.groupedItems', () => ({
            actionDraftCount: actionDrafts.length,
            forked: forkedTranscriptEnabled && fork ? 1 : 0,
            messageCount: messageIdsOldestFirst.length,
            modeTurns: groupingMode === 'turns' ? 1 : 0,
            pendingCount: pendingMessages.length + (discardedPendingMessages?.length ?? 0),
        }), () => {
            if (groupingMode !== 'turns') {
                const base = linearCache?.items ?? buildChatListItems({ messageIdsOldestFirst, messagesById, pendingMessages, discardedMessages: discardedPendingMessages, actionDrafts });
                if (!forkedTranscriptEnabled || !fork) return base;
                return injectForkContextRows({ baseItems: base, fork });
            }

            const trailing = buildChatListItems({
                messageIdsOldestFirst,
                messagesById,
                pendingMessages,
                discardedMessages: discardedPendingMessages,
                actionDrafts,
                includeCommittedMessages: false,
            });

            const turns = turnsCache?.turns ?? [];
            const turnItems: ChatTranscriptListItem[] = turns.map((t) => ({ kind: 'turn', id: t.id, turn: t }));
            const base = [...turnItems, ...trailing];
            return transcriptListImplementation === 'flash_v2'
                ? splitOversizedTranscriptTurnItems({
                    items: base,
                    maxTurnEntriesPerListItem: transcriptMaxTurnEntriesPerListItem,
                    messagesById,
                    metadataByMessageId: forkMessageMetadataById ?? undefined,
                }) as ChatTranscriptListItem[]
                : base;
        });
    }, [actionDrafts, fork, forkedTranscriptEnabled, forkMessageMetadataById, groupingMode, linearCache, messageIdsOldestFirst, messagesById, pendingMessages, discardedPendingMessages, transcriptListImplementation, transcriptMaxTurnEntriesPerListItem, turnsCache]);

    const latestCommittedActivityKey =
        messageIdsOldestFirst.length > 0 ? messageIdsOldestFirst[messageIdsOldestFirst.length - 1]! : null;
    const latestVisibleTailActivityKey = React.useMemo(() => {
        return resolveLatestVisibleTailActivityKey(groupedItems);
    }, [groupedItems]);
    const rollbackRanges = React.useMemo(
        () => readSessionRollbackRangesV1((stableSessionMetadata as Record<string, unknown> | null | undefined) ?? null),
        [sessionMetadataSignature, stableSessionMetadata],
    );
    const computedTurnChangeSets = React.useMemo(
        () => deriveTurnChangeSetsFromMessages(
            messageIdsOldestFirst
                .map((messageId) => messagesById[messageId])
                .filter((message): message is Message => message != null),
        ),
        [messageIdsOldestFirst, messagesById],
    );
    const turnChangeSetsSignature = React.useMemo(
        () => buildStableJsonSignature(computedTurnChangeSets),
        [computedTurnChangeSets],
    );
    const turnChangeSets = useStableValueBySignature(computedTurnChangeSets, turnChangeSetsSignature);
    const rollbackActionsInputSignature = React.useMemo(
        () => buildRollbackActionsInputSignature({ messageIdsOldestFirst, messagesById }),
        [messageIdsOldestFirst, messagesById],
    );
    const rollbackActionsByMessageId = React.useMemo(
        () => resolveTranscriptRollbackActions({
            session: props.session,
            messageIdsOldestFirst,
            messagesById,
            rollbackRanges,
            turnChangeSets,
        }),
        [
            props.session.accessLevel,
            props.session.active,
            sessionMetadataSignature,
            rollbackActionsInputSignature,
            rollbackRanges,
            turnChangeSets,
        ],
    );

    const latestThinkingMessageId = useSessionLatestThinkingMessageId(props.session.id);
    const latestThinkingMessageActivityAtMs = useSessionLatestThinkingMessageActivityAtMs(props.session.id);
    const transcriptThinkingPulseStaleMs = useSetting('transcriptThinkingPulseStaleMs');
    const staleMs = typeof transcriptThinkingPulseStaleMs === 'number' && Number.isFinite(transcriptThinkingPulseStaleMs)
        ? transcriptThinkingPulseStaleMs
        : settingsDefaults.transcriptThinkingPulseStaleMs;
    const [thinkingPulseNow, setThinkingPulseNow] = React.useState(() => Date.now());

    React.useEffect(() => {
        if (props.session.thinking !== true) return;
        if (typeof latestThinkingMessageActivityAtMs !== 'number') return;
        if (typeof staleMs !== 'number' || !Number.isFinite(staleMs) || staleMs <= 0) return;

        const staleAt = latestThinkingMessageActivityAtMs + staleMs;
        const delayMs = staleAt - Date.now();
        if (delayMs <= 0) return;

        const t = setTimeout(() => setThinkingPulseNow(Date.now()), delayMs);
        return () => clearTimeout(t);
    }, [latestThinkingMessageActivityAtMs, props.session.thinking, staleMs]);

    const activeThinkingMessageId = React.useMemo(() => {
        return resolveActiveThinkingMessageId({
            sessionThinking: props.session.thinking === true,
            latestThinkingMessageId,
            latestCommittedMessageId: latestCommittedActivityKey,
            latestThinkingMessageActivityAtMs,
            nowMs: thinkingPulseNow,
            staleMs,
        });
    }, [latestCommittedActivityKey, latestThinkingMessageActivityAtMs, latestThinkingMessageId, props.session.thinking, staleMs, thinkingPulseNow]);

    const interaction = React.useMemo(() => {
        return deriveTranscriptInteractionFromSession({
            accessLevel: props.session.accessLevel,
            canApprovePermissions: props.session.canApprovePermissions,
            active: props.session.active,
            presence: props.session.presence,
        });
    }, [props.session.accessLevel, props.session.canApprovePermissions, props.session.active, props.session.presence]);
    const internalMessagesById = forkedTranscriptEnabled || groupingMode === 'turns' ? messagesById : EMPTY_MESSAGES_BY_ID;

    return (
        <SyncPerformanceReactProfiler id="sessions.transcript.chatList">
            <TranscriptMessageSelectionBoundary
                key={props.session.id}
                sessionId={props.session.id}
                eligibleMessageIdsInOrder={messageIdsOldestFirst}
                enabled={transcriptSessionCommon.messageDisplay.transcriptMessageSelectionEnabled === true}
            >
                <ChatListInternal
                    key={props.session.id}
                    metadata={stableSessionMetadata}
                    sessionId={props.session.id}
                    sessionActive={props.session.active === true}
                groupingMode={groupingMode}
                forkedTranscriptEnabled={forkedTranscriptEnabled}
                forkMessageMetadataById={forkMessageMetadataById}
                items={groupedItems}
                maxTurnEntriesPerListItem={transcriptMaxTurnEntriesPerListItem}
                messagesById={internalMessagesById}
                rowTypeMessagesById={messagesById}
                committedMessagesCount={messageIdsOldestFirst.length}
                latestCommittedActivityKey={latestCommittedActivityKey}
                latestVisibleTailActivityKey={latestVisibleTailActivityKey}
                activeThinkingMessageId={activeThinkingMessageId}
                approvalRequests={props.approvalRequests}
                rollbackRanges={rollbackRanges}
                rollbackActionsByMessageId={rollbackActionsByMessageId}
                isLoaded={isLoaded}
                bottomNotice={props.bottomNotice}
                controlledByUserOverride={props.controlledByUserOverride}
                controlSwitchTo={props.controlSwitchTo ?? null}
                onRequestSwitchToRemote={props.onRequestSwitchToRemote}
                directControlFooter={props.directControlFooter}
                interaction={interaction}
                jumpToSeq={props.jumpToSeq ?? null}
                followBottomIntentKey={props.followBottomIntentKey ?? null}
                isWarmKeepAliveInstance={props.isWarmKeepAliveInstance === true}
                onViewportChange={props.onViewportChange}
                onEditPendingMessage={props.onEditPendingMessage}
                routeHydrationPending={props.routeHydrationPending === true}
                forkCommon={transcriptSessionCommon.fork}
                messageDisplayCommon={transcriptSessionCommon.messageDisplay}
                toolChromeCommon={transcriptSessionCommon.toolChrome}
                toolRouteCommon={transcriptSessionCommon.toolRoute}
                />
            </TranscriptMessageSelectionBoundary>
        </SyncPerformanceReactProfiler>
    );
}, areChatListPropsEqual);

const ListHeader = React.memo(() => {
    return (
        <View>
            <View style={{ height: TRANSCRIPT_TOP_GUTTER_PX }} />
        </View>
    );
});

const ListFooter = React.memo((props: {
    sessionId: string;
    bottomNotice?: ChatListBottomNotice | null;
    controlledByUserOverride?: boolean;
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void;
    directControl?: ChatFooterDirectControlState;
}) => {
    const footerState = useSessionChatFooterState(props.sessionId);
    if (!footerState) {
        return null;
    }
    return (
        <ChatFooter
            controlledByUser={props.controlledByUserOverride ?? footerState.controlledByUser}
            localControl={footerState.localControl}
            permissionsInUiWhileLocal={footerState.permissionsInUiWhileLocal}
            notice={props.bottomNotice ?? null}
            controlSwitchTo={props.controlSwitchTo ?? null}
            onRequestSwitchToRemote={props.onRequestSwitchToRemote}
            directControl={props.directControl ?? null}
        />
    )
});

const ChatListFooterWithKeyboardInset = React.memo((props: {
    sessionId: string;
    bottomNotice?: ChatListBottomNotice | null;
    controlledByUserOverride?: boolean;
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void;
    directControl?: ChatFooterDirectControlState;
    onComposerInsetHeightChange?: (height: number) => void;
}) => {
    return (
        <View>
            <ListFooter
                sessionId={props.sessionId}
                bottomNotice={props.bottomNotice}
                controlledByUserOverride={props.controlledByUserOverride}
                controlSwitchTo={props.controlSwitchTo ?? null}
                onRequestSwitchToRemote={props.onRequestSwitchToRemote}
                directControl={props.directControl ?? null}
            />
            <ComposerKeyboardScrollInset
                testID="transcript-composer-keyboard-inset"
                onHeightChange={props.onComposerInsetHeightChange}
            />
        </View>
    );
});

const ChatListMessageRow = React.memo(function ChatListMessageRow(props: {
    sessionId: string;
    messageId: string;
    messageOverride?: Message | null;
    originSessionId?: string;
    isReadOnlyContext?: boolean;
    metadata: Metadata | null;
    activeThinkingMessageId: string | null;
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
    resolveThinkingExpanded: (messageId: string) => boolean;
    setThinkingExpanded: (messageId: string, expanded: boolean) => void;
    interaction: TranscriptInteraction;
    rollbackAction?: TranscriptRollbackAction | null;
    rollbackRanges: readonly SessionRollbackRangeV1[];
} & Partial<TranscriptSessionCommonProps>) {
    const originSessionId = props.originSessionId ?? props.sessionId;
    const committedMessage = useMessage(originSessionId, props.messageId);
    const message = props.messageOverride ?? committedMessage;
    if (!message) return null;

    const isThinking = message.kind === 'agent-text' && message.isThinking === true;
    const readOnlyInteraction = props.isReadOnlyContext
        ? {
            ...props.interaction,
            canSendMessages: false,
            canApprovePermissions: false,
            permissionDisabledReason: 'readOnly' as const,
            disableToolNavigation: true,
        }
        : props.interaction;
    const historical = isMessageRolledBack({ message, rollbackRanges: props.rollbackRanges });
    const canUseParentCommon = originSessionId === props.sessionId && hasTranscriptSessionCommonProps(props);
    const messageView = canUseParentCommon ? (
        <MessageViewWithSessionCommon
            message={message}
            metadata={props.metadata}
            sessionId={originSessionId}
            activeThinkingMessageId={props.activeThinkingMessageId}
            approvalRequests={props.approvalRequests}
            thinkingExpanded={isThinking ? props.resolveThinkingExpanded(message.id) : undefined}
            onThinkingExpandedChange={isThinking ? (next) => props.setThinkingExpanded(message.id, next) : undefined}
            interaction={readOnlyInteraction}
            rollbackAction={props.rollbackAction ?? null}
            historical={historical}
            forkCommon={props.forkCommon}
            messageDisplayCommon={props.messageDisplayCommon}
            toolChromeCommon={props.toolChromeCommon}
            toolRouteCommon={props.toolRouteCommon}
        />
    ) : (
        <MessageView
            message={message}
            metadata={props.metadata}
            sessionId={originSessionId}
            activeThinkingMessageId={props.activeThinkingMessageId}
            approvalRequests={props.approvalRequests}
            thinkingExpanded={isThinking ? props.resolveThinkingExpanded(message.id) : undefined}
            onThinkingExpandedChange={isThinking ? (next) => props.setThinkingExpanded(message.id, next) : undefined}
            interaction={readOnlyInteraction}
            rollbackAction={props.rollbackAction ?? null}
            historical={historical}
        />
    );
    return (
        <View testID={`${TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX}${props.messageId}`}>
            <View testID={`transcript-message-${props.messageId}`}>
                {messageView}
            </View>
        </View>
    );
});

const TranscriptRowShell = React.memo(function TranscriptRowShell(props: {
    cache: TranscriptItemHeightCache;
    children: React.ReactNode;
    item: ChatTranscriptListItem;
    signature: TranscriptItemHeightValiditySignature;
}) {
    const signatureKey = React.useMemo(
        () => buildTranscriptItemHeightSignatureKey(props.signature),
        [props.signature],
    );
    // This is recycle identity state, not layout state: FlashList may reuse this cell for
    // another row, so reset the row-shell measured marker when the row signature changes.
    const [measured, setMeasured] = useRecyclingState(false, [signatureKey]);
    const heightHint = measured
        ? undefined
        : resolveTranscriptRowShellHeight({
            cache: props.cache,
            signature: props.signature,
        });

    return (
        <View
            testID={`${TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX}${props.item.id}`}
            style={heightHint}
            onLayout={(event) => {
                const height = event.nativeEvent.layout.height;
                if (props.cache.set(props.signature, { heightPx: height })) {
                    setMeasured(true);
                }
            }}
        >
            {props.children}
        </View>
    );
});

const ChatListInternal = React.memo((props: {
    metadata: Metadata | null,
    sessionId: string,
    sessionActive: boolean,
    groupingMode: string,
    forkedTranscriptEnabled: boolean,
    forkMessageMetadataById: Readonly<Record<string, { originSessionId: string; isReadOnlyContext: boolean }>> | null,
    items: ChatTranscriptListItem[],
    maxTurnEntriesPerListItem: number,
    messagesById: Readonly<Record<string, Message>>,
    rowTypeMessagesById: Readonly<Record<string, Message>>,
    committedMessagesCount: number,
    latestCommittedActivityKey: string | null,
    latestVisibleTailActivityKey: string | null,
    activeThinkingMessageId: string | null,
    approvalRequests?: readonly OpenApprovalArtifactForSession[],
    rollbackRanges: readonly SessionRollbackRangeV1[],
    rollbackActionsByMessageId: Readonly<Record<string, TranscriptRollbackAction>>,
    isLoaded: boolean,
    bottomNotice?: ChatListBottomNotice | null,
    controlledByUserOverride?: boolean;
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void,
    directControlFooter?: ChatFooterDirectControlState;
    interaction: TranscriptInteraction;
    jumpToSeq?: number | null;
    followBottomIntentKey?: string | number | null;
    isWarmKeepAliveInstance?: boolean;
    onViewportChange?: (state: TranscriptViewportChangeState) => void;
    onEditPendingMessage?: (request: PendingMessageEditRequest) => void | Promise<void>;
    routeHydrationPending?: boolean;
} & TranscriptSessionCommonProps) => {
    const transcriptMessageSelection = useOptionalTranscriptSelectionState();
    const [isLoadingOlder, setIsLoadingOlder] = React.useState(false);
    // Bumped whenever the native prepend transaction opens/closes so memos that consult the
    // open-transaction query (MVCP threshold gate, plan B3) recompute.
    const [nativePrependTransactionRevision, bumpNativePrependTransactionRevision] = React.useReducer(
        (value: number) => value + 1,
        0,
    );
    const [hasMoreOlder, setHasMoreOlder] = React.useState<boolean | null>(null);
    const [listLayoutHeight, setListLayoutHeight] = React.useState(0);
    const [listLayoutWidth, setListLayoutWidth] = React.useState(0);
    const [listContentHeight, setListContentHeight] = React.useState(0);
    const [webMarkdownRuntimeReady, setWebMarkdownRuntimeReady] = React.useState(isEnrichedMarkdownRuntimePreloaded);
    const [nativeMountSettleStable, setNativeMountSettleStable] = React.useState(false);
    const [nativeMountSettleDeadlineReached, setNativeMountSettleDeadlineReached] = React.useState(false);
    const [nativeInitialViewportPendingObservation, setNativeInitialViewportPendingObservation] = React.useState(false);
    const nativeMountSettleDeadlineReachedRef = React.useRef(false);
    const nativeMountSettleAutoPinSuppressedRef = React.useRef(false);
    const loadOlderInFlight = React.useRef(false);
    const listRef = React.useRef<ScrollableChatListRef | null>(null);
    const nativeEntryRestorePaintReleaseTimeoutRef = React.useRef<{
        issuedAtMs: number;
        sessionId: string;
        timeoutId: ReturnType<typeof setTimeout>;
    } | null>(null);
    const itemsRef = React.useRef<ChatTranscriptListItem[]>(props.items);
    const listDataRef = React.useRef<ChatTranscriptListItem[]>(props.items);
    const toolRouteCommonRef = React.useRef(props.toolRouteCommon);
    toolRouteCommonRef.current = props.toolRouteCommon;
    const viewportControllerRef = React.useRef<TranscriptViewportController | null>(null);
    if (viewportControllerRef.current === null) {
        viewportControllerRef.current = createTranscriptViewportController();
    }
    const flushViewportAnchorCaptureRef = React.useRef<(options?: Readonly<{ deferEmit?: boolean }>) => void>(() => {});
    const flushExitLiveTailIntentRef = React.useRef<(options?: Readonly<{ deferEmit?: boolean }>) => void>(() => {});
    const currentSessionIdRef = React.useRef(props.sessionId);
    if (currentSessionIdRef.current !== props.sessionId) {
        // Session exit (plan A3): capture the debounced anchor synchronously while the previous
        // session's list/data refs are still mounted and the current-session ref still points at
        // the exiting session; the emit itself is deferred off the render phase.
        flushViewportAnchorCaptureRef.current({ deferEmit: true });
        // Session exit (plan P3): if the viewport visibly sits at the bottom, persist live-tail
        // intent deterministically — the B8 arrival emission may not have fired (passive
        // arrival / swallowed momentum frames). Runs AFTER the anchor flush so the live-tail
        // report is the final persisted state for the exiting session.
        flushExitLiveTailIntentRef.current({ deferEmit: true });
    }
    currentSessionIdRef.current = props.sessionId;
    const lastJumpSeqRef = React.useRef<number | null>(null);
    const listLayoutHeightRef = React.useRef<number>(0);
    const listLayoutWidthRef = React.useRef<number>(0);
    const listContentHeightRef = React.useRef<number>(0);
    const lastMeasuredContentActivityKeyRef = React.useRef<string | null>(null);
    const initialFillStatusRef = React.useRef<'idle' | 'in_progress' | 'done'>('idle');
    const initialPinSessionIdRef = React.useRef<string | null>(null);
    const didAutoExpandToolCallsGroupsForSessionRef = React.useRef<string | null>(null);
    const initialFillAbortRef = React.useRef<AbortController | null>(null);
    const chatListReactId = React.useId();
    const chatListNativeId = React.useMemo(() => buildChatListNativeId(props.sessionId, chatListReactId), [props.sessionId, chatListReactId]);
    const loadNewerInFlight = React.useRef(false);
    const hasMoreOlderRef = React.useRef<boolean | null>(null);
    const webScrollContainerRef = React.useRef<HTMLElement | null>(null);
    const pendingWebPrependAnchorRef = React.useRef<ReturnType<typeof captureWebTranscriptPrependAnchor> | null>(null);
    const inFlightWebPrependAnchorRef = React.useRef<ReturnType<typeof captureWebTranscriptPrependAnchor> | null>(null);
    // Native prepend transaction (plan F4 / Lane C): exactly one transaction per older-page
    // prepend; commit opens the prepend ownership phase; one post-commit layout timeout.
    const nativePrependTransactionRef = React.useRef<PrependTransaction | null>(null);
    const nativePrependCommitArmedRef = React.useRef(false);
    const nativePrependLayoutTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    // Layout-quiet gate (plan P1): the single fallback write is withheld until the anchor
    // row's observed offset is stable across one quiet window, so FlashList's asynchronous
    // MVCP correction can land first (mvcp-preserved, zero writes) instead of double-shifting.
    const nativePrependQuietGateRef = React.useRef<PrependFallbackQuietGate | null>(null);
    const nativePrependQuietTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const observeNativePrependTransactionRef = React.useRef<() => void>(() => {});
    const invalidateNativePrependTransactionRef = React.useRef<() => void>(() => {});
    // Plan P2: lets the momentum-settle handler (defined before the scheduler) arm a capture
    // for the dwelled position when every momentum frame was swallowed (open transactions).
    const scheduleViewportAnchorCaptureRef = React.useRef<(state: TranscriptViewportChangeState) => void>(() => {});
    // Pending explicit jump-to-bottom confirmation (plan B7): armed when a native flash
    // explicit jump write is issued; spent on ONE bounded re-confirm if the content height
    // churns before the bottom is observed; cleared on bottom arrival / trusted scroll /
    // session change. Never a correction loop.
    const pendingNativeExplicitJumpConfirmRef = React.useRef<{
        sessionId: string;
        issuedContentHeight: number;
    } | null>(null);
    // Pending entry-bottom settle confirmation (plan P3, mirror of B7): armed when a
    // follow-bottom entry first marks the initial viewport applied. The baseline content
    // height comes from the SCROLL-EVENT source only (never mixed with the measured ref —
    // the two disagree by the composer inset, E7) and refreshes on every bottom-confirmed
    // frame. Spent on ONE bounded re-confirm when late content settle GROWS the event
    // content height while the viewport is left above the bottom and the mode machine still
    // says 'following'; cleared on trusted scroll / release / session change. Never a loop.
    const pendingNativeEntrySettleConfirmRef = React.useRef<{
        sessionId: string;
        issuedContentHeight: number | null;
    } | null>(null);
    const pendingWebPrependIndexRecoveryRef = React.useRef(false);
    const scheduledWebPrependIndexRecoveryRef = React.useRef<{ kind: 'raf' | 'timeout'; ids: any[] } | null>(null);
    const [webPrependRangeReservePx, setWebPrependRangeReservePx] = React.useState(0);
    const clearWebPrependRangeReserve = React.useCallback(() => {
        setWebPrependRangeReservePx((previous) => previous === 0 ? previous : 0);
    }, []);
    const olderLoadSpinnerDelayTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const resetOlderPaginationRef = React.useRef<() => void>(() => {});
      const wantsPinnedRef = React.useRef(true);
      const bottomFollowModeStateRef = React.useRef<TranscriptBottomFollowModeState>({
          dragSession: null,
          mode: 'following',
      });
      const [bottomFollowModeRevision, bumpBottomFollowModeRevision] = React.useReducer(
          (value: number) => (value + 1) % 1_000_000,
          0,
      );
      const lastUserScrollIntentAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
      const nativeTranscriptTouchStartYRef = React.useRef<number | null>(null);
      // Last web scroll-container `scrollTop` we observed or wrote programmatically. Used to detect a
      // genuine web user scroll-up (movement toward the top) without relying on `isTrusted`, which RNW
      // does not reliably set, while excluding our own programmatic pin/restore scroll writes.
      const lastObservedWebScrollTopRef = React.useRef<number | null>(null);
      // Plan E3: direction + consecutive-frame count of non-programmatic web scroll movement.
      const webNonProgrammaticScrollStreakRef = React.useRef<{ direction: -1 | 1; count: number } | null>(null);
      const lastAutoRepinAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    const lastPinOffsetForIntentRef = React.useRef<number | null>(null);
    const lastScrollOffsetForIntentRef = React.useRef<number | null>(null);
    const lastNativePinOffsetRef = React.useRef<number | null>(null);
    const lastNativeBottomFollowPinCommandRef = React.useRef<{
        sessionId: string;
        offsetY: number;
        writtenAtMs: number;
    } | null>(null);
    const lastNativeRestoreIndexCommandRef = React.useRef<LastNativeRestoreIndexCommand | null>(null);
    const lastNativeStreamAppendPinRef = React.useRef<{ contentHeight: number; sessionId: string } | null>(null);
    const nativeContentMaterializationAutoPinRef = React.useRef<{ contentHeight: number; sessionId: string } | null>(null);
    const nativeBottomFollowRearmedAfterDragRef = React.useRef(false);
    // Plan B9: true between onMomentumScrollBegin and onMomentumScrollEnd. Combined with the
    // mode machine's retained trusted drag session it forms the post-drag release attribution
    // window: momentum frames may release follow, height-churn frames without a drag never can.
    const nativeMomentumScrollActiveRef = React.useRef(false);
    const lastProactiveAutoFollowActivityKeyRef = React.useRef<string | null>(props.latestCommittedActivityKey);
    const lastProactiveAutoFollowVisibleTailKeyRef = React.useRef<string | null>(props.latestVisibleTailActivityKey);
    const pendingNativeMountSettleBottomPinRef = React.useRef(false);
    const flushPendingNativeMountSettleBottomPinRef = React.useRef<(() => void) | null>(null);
    const nativeInitialFollowBottomAppliedSessionRef = React.useRef<{ sessionId: string; applied: boolean }>({
        sessionId: props.sessionId,
        applied: false,
    });
    const nativeInitialViewportPendingObservationRef = React.useRef(false);
    // Entry-restore single owner (plan F2 / Lane A, W2.2): one transaction per session entry.
    const entryRestoreTransactionRef = React.useRef<EntryRestoreTransaction | null>(null);
    const entryRestoreWriteContextRef = React.useRef<EntryRestoreWriteContext | null>(null);
    const entryRestoreDeadlineTimeoutRef = React.useRef<{
        sessionId: string;
        timeoutId: ReturnType<typeof setTimeout>;
    } | null>(null);
    // Set when the user (or jump-to-seq) took over before any transaction was created:
    // this entry will never open one.
    const entryRestoreSuppressedRef = React.useRef(false);
    const finishEntryRestoreTransactionRef = React.useRef<(transaction: EntryRestoreTransaction) => void>(() => {});
    const attemptEntryRestoreRef = React.useRef<() => void>(() => {});
    const legacyEntryRestoreAppliedRef = React.useRef<{ sessionId: string; offsetY: number } | null>(null);
    // A6: canonical native content basis is the scroll-event contentSize; the measurement flag
    // distinguishes "never measured this session" (wait verdict) from a genuine zero.
    const nativeContentMeasurementSessionRef = React.useRef<{ sessionId: string; measured: boolean }>({
        sessionId: props.sessionId,
        measured: false,
    });
    const composerInsetHeightRef = React.useRef(0);
    const scheduledPinRef = React.useRef<{
        kind: 'raf' | 'timeout';
        id: any;
        previousWebMetrics: WebTranscriptScrollMetrics | null;
        reason: TranscriptViewportTelemetryScrollReason;
    } | null>(null);
    const latestJumpToSeqRef = React.useRef<number | null>(props.jumpToSeq ?? null);
    latestJumpToSeqRef.current = props.jumpToSeq ?? null;
    const scheduleWebHotTailBottomFollowRef = React.useRef<(() => void) | null>(null);
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
    const anchorLookupLoadCountRef = React.useRef(0);
    const anchorLookupInFlightRef = React.useRef(false);
    const anchorLookupExhaustedRef = React.useRef(false);
    const loadOlderForAnchorLookupRef = React.useRef<((options?: LoadOlderOptions) => Promise<{
        loaded: number;
        hasMore: boolean;
        status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
    } | null>) | null>(null);
    const rowShellHeightCache = React.useMemo(() => getDefaultTranscriptItemHeightCache(), []);
    const mountSettleCoordinatorRef = React.useRef<TranscriptMountSettlePinCoordinator | null>(null);
    if (mountSettleCoordinatorRef.current === null) {
        mountSettleCoordinatorRef.current = createTranscriptMountSettlePinCoordinator({
            tuning: resolveTranscriptMountSettleTuning(),
        });
    }



    /**
     * Trusted user takeover during entry (plan A2: touch-escape semantics). Closes the
     * entry-restore transaction as preempted when one is open; when none was created yet,
     * suppresses this entry permanently and releases the entry ownership phase.
     */
    const closeEntryViewportOwnership = React.useCallback((outcome: TranscriptViewportTransactionOutcome) => {
        const controller = viewportControllerRef.current;
        if (!controller || controller.activeOwner() !== 'entry') return;
        controller.closeTransaction('entry', outcome);
    }, []);
    const preemptEntryRestoreTransaction = React.useCallback(() => {
        const transaction = entryRestoreTransactionRef.current;
        if (transaction && !transaction.isClosed()) {
            transaction.onTrustedUserScroll();
            finishEntryRestoreTransactionRef.current(transaction);
            return;
        }
        if (!transaction) {
            entryRestoreSuppressedRef.current = true;
        }
        closeEntryViewportOwnership('preempted');
    }, [closeEntryViewportOwnership]);

    const clearEntryRestoreDeadlineTimeout = React.useCallback(() => {
        const scheduled = entryRestoreDeadlineTimeoutRef.current;
        if (!scheduled) return;
        entryRestoreDeadlineTimeoutRef.current = null;
        clearTimeout(scheduled.timeoutId);
    }, []);

    React.useEffect(() => {
        if (props.jumpToSeq == null) return;
        pendingNativeMountSettleBottomPinRef.current = false;
        // Jump-to-seq takes over the viewport: the entry-restore transaction (if any) is
        // preempted and this entry never opens another one.
        entryRestoreSuppressedRef.current = true;
        preemptEntryRestoreTransaction();
        const nativeEntryRestorePaintReleaseTimeout = nativeEntryRestorePaintReleaseTimeoutRef.current;
        if (nativeEntryRestorePaintReleaseTimeout) {
            nativeEntryRestorePaintReleaseTimeoutRef.current = null;
            clearTimeout(nativeEntryRestorePaintReleaseTimeout.timeoutId);
        }
        invalidateNativePrependTransactionRef.current();
        lastNativeRestoreIndexCommandRef.current = null;
    }, [
        preemptEntryRestoreTransaction,
        props.jumpToSeq,
    ]);

    const cancelScheduledPinToBottom = React.useCallback(() => {
        pendingNativeMountSettleBottomPinRef.current = false;
        const scheduled = scheduledPinRef.current;
        if (!scheduled) return;
        scheduledPinRef.current = null;
        if (scheduled.kind === 'raf') {
            const caf = (globalThis as any)?.cancelAnimationFrame as undefined | ((id: any) => void);
            if (typeof caf === 'function') {
                caf(scheduled.id);
            }
            return;
        }
        clearTimeout(scheduled.id);
    }, []);

    const commitBottomFollowModeEvent = React.useCallback((event: TranscriptBottomFollowModeEvent) => {
        const previousMode = bottomFollowModeStateRef.current.mode;
        const nextState = resolveTranscriptBottomFollowMode(bottomFollowModeStateRef.current, event);
        bottomFollowModeStateRef.current = nextState;
        if (nextState.mode !== previousMode) {
            bumpBottomFollowModeRevision();
        }
        return nextState;
    }, []);

    const clearOlderLoadSpinnerDelay = React.useCallback(() => {
        const timeoutId = olderLoadSpinnerDelayTimeoutRef.current;
        if (!timeoutId) return;
        olderLoadSpinnerDelayTimeoutRef.current = null;
        clearTimeout(timeoutId);
    }, []);

    React.useEffect(() => {
        viewportControllerRef.current?.setActive(true);
        return () => {
            viewportControllerRef.current?.setActive(false);
        };
    }, []);

    const hideOlderLoadSpinner = React.useCallback(() => {
        clearOlderLoadSpinnerDelay();
        setIsLoadingOlder(false);
    }, [clearOlderLoadSpinnerDelay]);

    const showOlderLoadSpinner = React.useCallback(() => {
        clearOlderLoadSpinnerDelay();
        setIsLoadingOlder(true);
    }, [clearOlderLoadSpinnerDelay]);

    const deferAutoPinAfterLocalTranscriptInteraction = React.useCallback(() => {
        lastUserScrollIntentAtMsRef.current = Date.now();
        nativeMountSettleAutoPinSuppressedRef.current = true;
        cancelScheduledPinToBottom();
    }, [cancelScheduledPinToBottom]);

    const transcriptMotionPreset = useSetting('transcriptMotionPreset');
    const transcriptMotionFreshnessMs = useSetting('transcriptMotionFreshnessMs');
    const transcriptAnimateNewItemsEnabled = useSetting('transcriptAnimateNewItemsEnabled');
    const transcriptAnimateToolExpandCollapseEnabled = useSetting('transcriptAnimateToolExpandCollapseEnabled');
    const transcriptAnimateToolExpandCollapseFreshOnly = useSetting('transcriptAnimateToolExpandCollapseFreshOnly');
    const transcriptAnimateThinkingEnabled = useSetting('transcriptAnimateThinkingEnabled');
    const reducedMotionPreferred = useReducedMotionPreference();
    const sessionThinkingDisplayMode = props.messageDisplayCommon.sessionThinkingDisplayMode;
    const sessionThinkingInlinePresentation = props.messageDisplayCommon.sessionThinkingInlinePresentation;
    const sessionThinkingInlineChrome = props.messageDisplayCommon.sessionThinkingInlineChrome;

      const stopScrollEventPropagationOnWeb = React.useCallback((event: any) => {
      // Expo Router (Vaul/Radix) modals on web often install document-level scroll-lock listeners
      // that `preventDefault()` wheel/touch scroll, which breaks scrolling inside nested scroll views.
      // Stopping propagation here keeps the event within the transcript subtree so native scrolling works.
      if (Platform.OS !== 'web') return;
          preemptEntryRestoreTransaction();
          const nowMs = Date.now();
          lastUserScrollIntentAtMsRef.current = nowMs;
        // If the user scrolls upward (away from the bottom), treat that as explicit intent to unpin
        // immediately, even if they remain within the pinned threshold. This prevents mount-time
        // stabilization retries from fighting the user for several seconds after entering a session.
        const deltaY = (event as any)?.deltaY;
        if (typeof deltaY === 'number' && Number.isFinite(deltaY) && deltaY < 0) {
            wantsPinnedRef.current = false;
        }
      if (typeof event?.stopPropagation === 'function') event.stopPropagation();
      }, [preemptEntryRestoreTransaction]);

        const markUserScrollIntentOnWeb = React.useCallback(() => {
            if (Platform.OS !== 'web') return;
            preemptEntryRestoreTransaction();
            lastUserScrollIntentAtMsRef.current = Date.now();
        }, [preemptEntryRestoreTransaction]);

        const updateNativeInitialViewportPendingObservation = React.useCallback((pending: boolean) => {
            if (Platform.OS === 'web') return;
            if (nativeInitialViewportPendingObservationRef.current === pending) return;
            nativeInitialViewportPendingObservationRef.current = pending;
            setNativeInitialViewportPendingObservation(pending);
        }, []);

        const hasNativeInitialViewportAppliedForCurrentSession = React.useCallback((): boolean => {
            if (Platform.OS === 'web') return true;
            const applied = nativeInitialFollowBottomAppliedSessionRef.current;
            return applied.sessionId === props.sessionId && applied.applied === true;
        }, [props.sessionId]);

        const markNativeInitialViewportAppliedForCurrentSession = React.useCallback((options?: Readonly<{
            entrySettleBaselineContentHeight?: number;
        }>) => {
            if (Platform.OS === 'web') return;
            const previousAppliedState = nativeInitialFollowBottomAppliedSessionRef.current;
            const wasApplied = previousAppliedState.sessionId === props.sessionId && previousAppliedState.applied === true;
            nativeInitialFollowBottomAppliedSessionRef.current = { sessionId: props.sessionId, applied: true };
            updateNativeInitialViewportPendingObservation(false);
            if (!wasApplied && sessionEntryViewportRef.current?.shouldFollowBottom !== false) {
                // Plan P3: arm the one-shot settle re-confirm for follow-bottom entries — late
                // content settle after the entry pin must still end at the TRUE bottom. The
                // baseline stays event-source-only; callers without an event content height
                // arm with null and the first bottom-confirmed frame fills it.
                const baseline = options?.entrySettleBaselineContentHeight;
                pendingNativeEntrySettleConfirmRef.current = {
                    sessionId: props.sessionId,
                    issuedContentHeight: typeof baseline === 'number' && Number.isFinite(baseline)
                        ? baseline
                        : null,
                };
            }
            if (entryRestoreTransactionRef.current === null) {
                // Cold-open entry phase (plan B1, no entry-restore transaction):
                // applied = confirmed. Restore entries close their phase through
                // finishEntryRestoreTransaction.
                closeEntryViewportOwnership('confirmed');
            }
        }, [
            closeEntryViewportOwnership,
            props.sessionId,
            updateNativeInitialViewportPendingObservation,
        ]);

        const hasNativeContentMeasurementForCurrentSession = React.useCallback((): boolean => {
            if (Platform.OS === 'web') return true;
            const state = nativeContentMeasurementSessionRef.current;
            return state.sessionId === props.sessionId && state.measured === true;
        }, [props.sessionId]);

        const markNativeContentMeasurementForCurrentSession = React.useCallback(() => {
            if (Platform.OS === 'web') return;
            nativeContentMeasurementSessionRef.current = { sessionId: props.sessionId, measured: true };
        }, [props.sessionId]);

        const recordNativeUserScrollIntent = React.useCallback((nowMs: number = Date.now()) => {
            if (Platform.OS === 'web') return;
            preemptEntryRestoreTransaction();
            lastUserScrollIntentAtMsRef.current = nowMs;
            pendingNativeMountSettleBottomPinRef.current = false;
            nativeMountSettleAutoPinSuppressedRef.current = true;
            updateNativeInitialViewportPendingObservation(false);
        }, [
            preemptEntryRestoreTransaction,
            updateNativeInitialViewportPendingObservation,
        ]);

	        const releaseNativeBottomFollowForGestureIntent = React.useCallback(() => {
		            if (Platform.OS === 'web') return;
		            recordNativeUserScrollIntent();
		            markNativeInitialViewportAppliedForCurrentSession();
	            nativeBottomFollowRearmedAfterDragRef.current = false;
	            // A finger down catches any in-flight fling: its momentum window ends here (plan B9).
	            nativeMomentumScrollActiveRef.current = false;
			            cancelScheduledPinToBottom();
			            wantsPinnedRef.current = false;
			            isPinnedRef.current = false;
		            commitBottomFollowModeEvent({ type: 'list-drag-start' });
	        }, [
	            cancelScheduledPinToBottom,
	            commitBottomFollowModeEvent,
	            markNativeInitialViewportAppliedForCurrentSession,
	            recordNativeUserScrollIntent,
	        ]);

        const hasOpenEntryRestoreTransactionForSession = React.useCallback(() => {
            const transaction = entryRestoreTransactionRef.current;
            return transaction != null && transaction.sessionId === props.sessionId && !transaction.isClosed();
        }, [props.sessionId]);

        const hasOpenNativePrependTransactionForSession = React.useCallback((): boolean => {
            const transaction = nativePrependTransactionRef.current;
            return transaction != null && transaction.sessionId === props.sessionId && !transaction.isClosed();
        }, [props.sessionId]);

        const hasActiveNativeViewportRestore = React.useCallback(() => (
            hasOpenEntryRestoreTransactionForSession() ||
            hasOpenNativePrependTransactionForSession()
        ), [hasOpenEntryRestoreTransactionForSession, hasOpenNativePrependTransactionForSession]);

        const recordNativeTranscriptTouchStartIntent = React.useCallback((event?: unknown) => {
            if (Platform.OS === 'web') return;
            nativeTranscriptTouchStartYRef.current = readNativeTouchPageY(event);
        }, []);

        const recordNativeTranscriptTouchEndIntent = React.useCallback(() => {
            if (Platform.OS === 'web') return;
            nativeTranscriptTouchStartYRef.current = null;
        }, []);

        const recordNativeTranscriptTouchIntent = React.useCallback((event?: unknown) => {
            if (Platform.OS === 'web') return;
            const hasActiveNativeRestore = hasActiveNativeViewportRestore();
            const currentY = readNativeTouchPageY(event);
            const startY = nativeTranscriptTouchStartYRef.current;
            if (startY == null && currentY != null) {
                nativeTranscriptTouchStartYRef.current = currentY;
            }
            const movedVertically =
                startY != null &&
                currentY != null &&
                Math.abs(currentY - startY) >= TRANSCRIPT_NATIVE_TOUCH_ESCAPE_MOVE_THRESHOLD_PX;
            if (movedVertically && !hasActiveNativeRestore && wantsPinnedRef.current) {
                nativeTranscriptTouchStartYRef.current = currentY;
                releaseNativeBottomFollowForGestureIntent();
                return;
            }
            if (!hasActiveNativeRestore) {
                lastUserScrollIntentAtMsRef.current = Date.now();
            }
            nativeMountSettleAutoPinSuppressedRef.current = true;
            pendingNativeMountSettleBottomPinRef.current = false;
            cancelScheduledPinToBottom();
        }, [
            cancelScheduledPinToBottom,
            hasActiveNativeViewportRestore,
            releaseNativeBottomFollowForGestureIntent,
        ]);

        const recordNativeListDragEscapeIntent = React.useCallback(() => {
            releaseNativeBottomFollowForGestureIntent();
        }, [releaseNativeBottomFollowForGestureIntent]);

        const recordNativeTranscriptResponderStartIntent = React.useCallback((event?: unknown) => {
            recordNativeTranscriptTouchStartIntent(event);
            return false;
        }, [recordNativeTranscriptTouchStartIntent]);

        const recordNativeTranscriptResponderMoveIntent = React.useCallback((event?: unknown) => {
            recordNativeTranscriptTouchIntent(event);
            return false;
        }, [recordNativeTranscriptTouchIntent]);

        const nativeFlashListScrollOverrideProps = React.useMemo(() => {
            if (Platform.OS === 'web') return undefined;
            return {
                onMoveShouldSetResponderCapture: recordNativeTranscriptResponderMoveIntent,
                onStartShouldSetResponderCapture: recordNativeTranscriptResponderStartIntent,
                onTouchCancel: recordNativeTranscriptTouchEndIntent,
                onTouchEnd: recordNativeTranscriptTouchEndIntent,
                onTouchMove: recordNativeTranscriptTouchIntent,
                onTouchStart: recordNativeTranscriptTouchStartIntent,
            };
        }, [
            recordNativeTranscriptResponderMoveIntent,
            recordNativeTranscriptResponderStartIntent,
            recordNativeTranscriptTouchEndIntent,
            recordNativeTranscriptTouchIntent,
            recordNativeTranscriptTouchStartIntent,
        ]);

    const resolveWebScrollMetrics = React.useCallback(() => {
        if (Platform.OS !== 'web') return null;
        if (typeof document === 'undefined') return null;
        if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return null;

        const root = (document as any)?.getElementById?.(chatListNativeId) as HTMLElement | null | undefined;
        const metrics = resolveWebTranscriptScrollMetrics({
            root,
            cachedElement: webScrollContainerRef.current,
            win: window,
            minOverflowPx: 50,
            maxDescendants: 1800,
            maxAncestors: 30,
            pick: 'best',
            allowRootFallback: true,
            score: (el) => {
                const sh = (el as any).scrollHeight;
                return typeof sh === 'number' && Number.isFinite(sh) ? sh : 0;
            },
        });
        if (metrics) {
            webScrollContainerRef.current = metrics.element;
        }
        return metrics;
    }, [chatListNativeId]);

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

    const waitForNextVisualUpdate = React.useCallback(async () => {
        await Promise.resolve();
        await Promise.resolve();
        const raf = (globalThis as any)?.requestAnimationFrame as undefined | ((cb: () => void) => any);
        if (typeof raf === 'function') {
            await new Promise<void>((resolve) => {
                raf(() => resolve());
            });
        }
    }, []);

  const motionConfig = React.useMemo(() => {
    return resolveTranscriptMotionConfig({
      reducedMotionPreferred,
      transcriptMotionPreset,
            transcriptMotionFreshnessMs,
            transcriptAnimateNewItemsEnabled,
            transcriptAnimateToolExpandCollapseEnabled,
            transcriptAnimateToolExpandCollapseFreshOnly,
            transcriptAnimateThinkingEnabled,
        });
    }, [
        reducedMotionPreferred,
        transcriptAnimateNewItemsEnabled,
        transcriptAnimateThinkingEnabled,
        transcriptAnimateToolExpandCollapseEnabled,
        transcriptAnimateToolExpandCollapseFreshOnly,
        transcriptMotionFreshnessMs,
        transcriptMotionPreset,
    ]);

    const transcriptScrollPinEnabled = useSetting('transcriptScrollPinEnabled');
    const transcriptScrollPinOffsetThresholdPx = useSetting('transcriptScrollPinOffsetThresholdPx');
    const transcriptScrollAutoFollowWhenPinned = useSetting('transcriptScrollAutoFollowWhenPinned');
    const transcriptScrollJumpToBottomEnabled = useSetting('transcriptScrollJumpToBottomEnabled');
    const transcriptScrollJumpToBottomMinNewCount = useSetting('transcriptScrollJumpToBottomMinNewCount');
    const transcriptScrollJumpToBottomRevealViewportRatio = useSetting('transcriptScrollJumpToBottomRevealViewportRatio');
    const transcriptScrollJumpToBottomAnimateScroll = useSetting('transcriptScrollJumpToBottomAnimateScroll');
    const transcriptListImplementation = useSetting('transcriptListImplementation');
    const transcriptToolCallsCollapsedPreviewCountSetting = props.toolChromeCommon.transcriptToolCallsCollapsedPreviewCount;

      const [scrollPin, setScrollPin] = React.useState<TranscriptScrollPinState>(() => ({
          isPinned: resolveSessionEntryBottomFollow(readSessionViewportForEntry(props.sessionId)),
          newActivityCount: 0,
          lastActivityKey: null,
      }));
      const [jumpToBottomDistanceFromBottom, setJumpToBottomDistanceFromBottom] = React.useState(0);
      const jumpToBottomDistanceFromBottomRef = React.useRef(0);
      const isPinnedRef = React.useRef(true);
      const sessionEntryViewportRef = React.useRef<{
          sessionId: string;
          shouldFollowBottom: boolean;
          offsetY: number;
          anchor: SessionViewportAnchorSnapshot | null;
      } | null>(null);
      if (sessionEntryViewportRef.current?.sessionId !== props.sessionId) {
          const sessionViewport = readSessionViewportForEntry(props.sessionId);
          const shouldFollowBottom = resolveSessionEntryBottomFollow(sessionViewport);
          sessionEntryViewportRef.current = {
              sessionId: props.sessionId,
              shouldFollowBottom,
              offsetY: sessionViewport?.offsetY ?? 0,
              anchor: sessionViewport?.anchor ?? null,
	          };
	          wantsPinnedRef.current = shouldFollowBottom;
	          isPinnedRef.current = shouldFollowBottom;
	          bottomFollowModeStateRef.current = resolveTranscriptBottomFollowMode(bottomFollowModeStateRef.current, {
	              shouldFollowBottom,
	              type: 'session-entry',
	          });
	          lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
          lastAutoRepinAtMsRef.current = Number.NEGATIVE_INFINITY;
          lastPinOffsetForIntentRef.current = shouldFollowBottom ? 0 : (sessionViewport?.offsetY ?? null);
          lastScrollOffsetForIntentRef.current = null;
          lastObservedWebScrollTopRef.current = null;
          webNonProgrammaticScrollStreakRef.current = null;
          lastNativePinOffsetRef.current = null;
	          lastNativeBottomFollowPinCommandRef.current = null;
	          lastNativeStreamAppendPinRef.current = null;
	          nativeBottomFollowRearmedAfterDragRef.current = false;
	          nativeMomentumScrollActiveRef.current = false;
          lastProactiveAutoFollowActivityKeyRef.current = props.latestCommittedActivityKey;
          lastProactiveAutoFollowVisibleTailKeyRef.current = props.latestVisibleTailActivityKey;
          lastMeasuredContentActivityKeyRef.current = null;
          hasMoreOlderRef.current = null;
          resetOlderPaginationRef.current();
          nativeInitialFollowBottomAppliedSessionRef.current = { sessionId: props.sessionId, applied: false };
          updateNativeInitialViewportPendingObservation(false);
          pendingNativeMountSettleBottomPinRef.current = false;
	          nativeMountSettleAutoPinSuppressedRef.current = false;
	          entryRestoreTransactionRef.current = null;
	          entryRestoreWriteContextRef.current = null;
	          entryRestoreSuppressedRef.current = false;
	          legacyEntryRestoreAppliedRef.current = null;
	          nativeContentMeasurementSessionRef.current = { sessionId: props.sessionId, measured: false };
	          const entryRestoreDeadlineTimeout = entryRestoreDeadlineTimeoutRef.current;
	          if (entryRestoreDeadlineTimeout) {
	              entryRestoreDeadlineTimeoutRef.current = null;
	              clearTimeout(entryRestoreDeadlineTimeout.timeoutId);
	          }
	          const nativeEntryRestorePaintReleaseTimeout = nativeEntryRestorePaintReleaseTimeoutRef.current;
	          if (nativeEntryRestorePaintReleaseTimeout) {
	              nativeEntryRestorePaintReleaseTimeoutRef.current = null;
	              clearTimeout(nativeEntryRestorePaintReleaseTimeout.timeoutId);
	          }
	          invalidateNativePrependTransactionRef.current();
	          pendingNativeExplicitJumpConfirmRef.current = null;
	          // Plan P3: follow-bottom entries (cold or warm keep-alive) arm the one-shot
	          // settle re-confirm at entry — warm reopens never re-run the applied lifecycle,
	          // yet a catch-up content swap can leave them above the bottom. The event-source
	          // baseline is filled by the first observed frame.
	          pendingNativeEntrySettleConfirmRef.current =
	              shouldFollowBottom && Platform.OS !== 'web' && transcriptListImplementation !== 'flatlist_legacy'
	                  ? { sessionId: props.sessionId, issuedContentHeight: null }
	                  : null;
	          lastNativeRestoreIndexCommandRef.current = null;
          anchorLookupLoadCountRef.current = 0;
          anchorLookupInFlightRef.current = false;
          anchorLookupExhaustedRef.current = false;
          // Single-owner command lifecycle (plan F1): a fresh controller-owned ownership
          // machine per session entry. Restore entries open the entry phase at mount.
          viewportControllerRef.current!.resetForSession(props.sessionId, {
              openEntryTransaction: !shouldFollowBottom ||
                  (Platform.OS !== 'web' && transcriptListImplementation !== 'flatlist_legacy'),
          });
      }
      const [expandedToolCallsAnchorMessageIds, setExpandedToolCallsAnchorMessageIds] = React.useState<ReadonlySet<string>>(
          () => new Set<string>(),
      );
        const thinkingDefaultExpanded =
            sessionThinkingDisplayMode === 'inline' && sessionThinkingInlinePresentation === 'full';
        const [thinkingExpandedByMessageId, setThinkingExpandedByMessageId] = React.useState<ReadonlyMap<string, boolean>>(
            () => new Map<string, boolean>(),
        );

      const applyToolCallsGroupExpanded = React.useCallback((params: { toolCallsGroupId: string; toolMessageIds: readonly string[]; expanded: boolean }) => {
          setExpandedToolCallsAnchorMessageIds((prev) => {
              const next = new Set(prev);
              if (params.expanded) {
                  const toolMessageIds = params.toolMessageIds;
                  const anchor = toolMessageIds.length > 0 ? toolMessageIds[toolMessageIds.length - 1] : null;
                  if (typeof anchor === 'string' && anchor) {
                      next.add(anchor);
                  }
              } else {
                  for (const id of params.toolMessageIds) {
                      next.delete(id);
                  }
              }
              return next;
          });
      }, []);

        const resolveThinkingExpanded = React.useCallback((messageId: string): boolean => {
            return thinkingExpandedByMessageId.get(messageId) ?? thinkingDefaultExpanded;
        }, [thinkingDefaultExpanded, thinkingExpandedByMessageId]);

        const applyThinkingExpanded = React.useCallback((messageId: string, expanded: boolean) => {
            setThinkingExpandedByMessageId((prev) => {
                const prevValue = prev.get(messageId);
                if (prevValue === expanded) return prev;
                const next = new Map(prev);
                if (expanded === thinkingDefaultExpanded) {
                    next.delete(messageId);
                } else {
                    next.set(messageId, expanded);
                }
                return next;
            });
        }, [thinkingDefaultExpanded]);
        const setToolCallsGroupExpanded = React.useCallback((params: { toolCallsGroupId: string; toolMessageIds: readonly string[]; expanded: boolean }) => {
            deferAutoPinAfterLocalTranscriptInteraction();
            applyToolCallsGroupExpanded(params);
        }, [applyToolCallsGroupExpanded, deferAutoPinAfterLocalTranscriptInteraction]);
        const setThinkingExpanded = React.useCallback((messageId: string, expanded: boolean) => {
            if (resolveThinkingExpanded(messageId) === expanded) return;
            deferAutoPinAfterLocalTranscriptInteraction();
            applyThinkingExpanded(messageId, expanded);
        }, [applyThinkingExpanded, deferAutoPinAfterLocalTranscriptInteraction, resolveThinkingExpanded]);

    const onViewportChangeRef = React.useRef(props.onViewportChange);
    React.useEffect(() => {
        onViewportChangeRef.current = props.onViewportChange;
    }, [props.onViewportChange]);
    const emitViewportChange = React.useCallback((state: TranscriptViewportChangeState) => {
        onViewportChangeRef.current?.(state);
    }, []);
    const cancelScheduledViewportAnchorCapture = React.useCallback(() => {
        const scheduled = scheduledViewportAnchorCaptureRef.current;
        if (!scheduled) return;
        scheduledViewportAnchorCaptureRef.current = null;
        clearTimeout(scheduled.timeoutId);
    }, []);
    const lastFollowBottomIntentKeyRef = React.useRef<string | number | null>(props.followBottomIntentKey ?? null);

    React.useEffect(() => {
        return () => {
            flushViewportAnchorCaptureRef.current();
            flushExitLiveTailIntentRef.current();
            clearEntryRestoreDeadlineTimeout();
            initialFillAbortRef.current?.abort();
            initialFillAbortRef.current = null;
            clearOlderLoadSpinnerDelay();
            const nativeEntryRestorePaintReleaseTimeout = nativeEntryRestorePaintReleaseTimeoutRef.current;
            if (nativeEntryRestorePaintReleaseTimeout) {
                nativeEntryRestorePaintReleaseTimeoutRef.current = null;
                clearTimeout(nativeEntryRestorePaintReleaseTimeout.timeoutId);
            }
            mountSettleCoordinatorRef.current?.reset({ reason: 'unmount' });
            pendingNativeMountSettleBottomPinRef.current = false;
            invalidateNativePrependTransactionRef.current();
            nativeBottomFollowRearmedAfterDragRef.current = false;
            nativeMountSettleAutoPinSuppressedRef.current = false;
        };
    }, [
        clearEntryRestoreDeadlineTimeout,
        clearOlderLoadSpinnerDelay,
    ]);

    React.useEffect(() => {
        // Reset per-session state. The exiting session's debounced anchor capture was
        // already flushed in the render-phase session-exit block (plan A3); this flush is
        // a no-op then, and only acts for the unmount-without-session-change path.
        flushViewportAnchorCaptureRef.current();
        viewportAnchorCaptureGenerationRef.current += 1;
        cancelScheduledViewportAnchorCapture();
        initialFillAbortRef.current?.abort();
        initialFillAbortRef.current = null;
        mountSettleCoordinatorRef.current?.reset({ reason: 'session-change' });
        setNativeMountSettleStable(false);
        nativeMountSettleDeadlineReachedRef.current = false;
        nativeMountSettleAutoPinSuppressedRef.current = false;
        setNativeMountSettleDeadlineReached(false);
        clearOlderLoadSpinnerDelay();
        setIsLoadingOlder(false);
        hasMoreOlderRef.current = null;
        resetOlderPaginationRef.current();
        initialFillStatusRef.current = 'idle';
        didAutoExpandToolCallsGroupsForSessionRef.current = null;
        inFlightWebPrependAnchorRef.current = null;
        pendingWebPrependAnchorRef.current = null;
        pendingWebPrependIndexRecoveryRef.current = false;
        const scheduledRecovery = scheduledWebPrependIndexRecoveryRef.current;
        if (scheduledRecovery) {
            scheduledWebPrependIndexRecoveryRef.current = null;
            if (scheduledRecovery.kind === 'raf') {
                for (const id of scheduledRecovery.ids) {
                    cancelAnimationFrame(id);
                }
            } else {
                for (const id of scheduledRecovery.ids) {
                    clearTimeout(id);
                }
            }
        }
        setExpandedToolCallsAnchorMessageIds(new Set());
        setThinkingExpandedByMessageId(new Map());
        const entryViewport = sessionEntryViewportRef.current;
        const shouldFollowBottom = entryViewport?.shouldFollowBottom ?? true;
	        const offsetY = entryViewport?.offsetY ?? 0;
	        wantsPinnedRef.current = shouldFollowBottom;
	        isPinnedRef.current = shouldFollowBottom;
	        commitBottomFollowModeEvent({
	            shouldFollowBottom,
	            type: 'session-entry',
	        });
	        lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
        lastAutoRepinAtMsRef.current = Number.NEGATIVE_INFINITY;
        // Null (no trustworthy remembered offset) must survive here: 0 would read as
        // "at the bottom" and let the exit flush fabricate a live-tail report (plan P3).
        lastPinOffsetForIntentRef.current = shouldFollowBottom ? 0 : (entryViewport?.offsetY ?? null);
        lastScrollOffsetForIntentRef.current = null;
        lastObservedWebScrollTopRef.current = null;
        webNonProgrammaticScrollStreakRef.current = null;
        lastNativePinOffsetRef.current = null;
        lastNativeBottomFollowPinCommandRef.current = null;
        lastNativeStreamAppendPinRef.current = null;
        nativeBottomFollowRearmedAfterDragRef.current = false;
        lastProactiveAutoFollowActivityKeyRef.current = props.latestCommittedActivityKey;
        lastProactiveAutoFollowVisibleTailKeyRef.current = props.latestVisibleTailActivityKey;
	        lastMeasuredContentActivityKeyRef.current = null;
	        pendingNativeMountSettleBottomPinRef.current = false;
	        const nativeEntryRestorePaintReleaseTimeout = nativeEntryRestorePaintReleaseTimeoutRef.current;
	        if (nativeEntryRestorePaintReleaseTimeout) {
	            nativeEntryRestorePaintReleaseTimeoutRef.current = null;
	            clearTimeout(nativeEntryRestorePaintReleaseTimeout.timeoutId);
	        }
	        invalidateNativePrependTransactionRef.current();
	        lastNativeRestoreIndexCommandRef.current = null;
        setScrollPin({
            isPinned: shouldFollowBottom,
            newActivityCount: 0,
            lastActivityKey: null,
        });
        jumpToBottomDistanceFromBottomRef.current = offsetY;
        setJumpToBottomDistanceFromBottom(offsetY);
        emitViewportChange({
            isPinned: shouldFollowBottom,
            offsetY,
            shouldRestoreViewport: shouldFollowBottom !== true,
            anchor: shouldFollowBottom === true ? null : entryViewport?.anchor ?? null,
        });
    }, [
        cancelScheduledViewportAnchorCapture,
	        clearOlderLoadSpinnerDelay,
	        commitBottomFollowModeEvent,
	        emitViewportChange,
        // The per-session reset is keyed on the SESSION, never on activity: a new
        // committed message must not wipe pin/measurement/viewport state mid-session.
        props.sessionId,
    ]);

    const pinEnabled = transcriptScrollPinEnabled !== false;
    const pinThresholdPx =
        typeof transcriptScrollPinOffsetThresholdPx === 'number' && Number.isFinite(transcriptScrollPinOffsetThresholdPx)
            ? Math.max(0, Math.trunc(transcriptScrollPinOffsetThresholdPx))
            : 72;
    const autoFollowWhenPinned = transcriptScrollAutoFollowWhenPinned !== false;
    const jumpEnabled = transcriptScrollJumpToBottomEnabled !== false;
    const jumpMinNewCount =
        typeof transcriptScrollJumpToBottomMinNewCount === 'number' && Number.isFinite(transcriptScrollJumpToBottomMinNewCount)
            ? Math.max(1, Math.trunc(transcriptScrollJumpToBottomMinNewCount))
            : 1;
    const jumpRevealViewportRatio =
        typeof transcriptScrollJumpToBottomRevealViewportRatio === 'number' && Number.isFinite(transcriptScrollJumpToBottomRevealViewportRatio)
            ? Math.max(0, Math.min(TRANSCRIPT_SCROLL_JUMP_TO_BOTTOM_REVEAL_VIEWPORT_RATIO_MAX, transcriptScrollJumpToBottomRevealViewportRatio))
            : TRANSCRIPT_SCROLL_JUMP_TO_BOTTOM_REVEAL_VIEWPORT_RATIO_FALLBACK;
    const jumpRevealOffsetThresholdPx = Math.max(pinThresholdPx, Math.trunc(listLayoutHeight * jumpRevealViewportRatio));
	    const canAutoFollowForReason = React.useCallback((
	        reason: TranscriptViewportTelemetryScrollReason,
	        options?: Readonly<{ explicit?: boolean }>,
	    ): boolean => canAutoFollowTranscriptBottom({
        autoFollowWhenPinned,
        bottomFollowMode: bottomFollowModeStateRef.current.mode,
        isExplicitUserCommand: options?.explicit === true || isExplicitTranscriptBottomFollowCommand(reason),
        jumpToSeqActive: props.jumpToSeq != null,
        pinEnabled,
	        reason,
	        wantsPinned: wantsPinnedRef.current,
	    }), [autoFollowWhenPinned, pinEnabled, props.jumpToSeq]);
    const readCurrentNativeDistanceFromBottom = React.useCallback((params: {
        contentHeight?: number;
        layoutHeight?: number;
    } = {}): number | null => {
        if (Platform.OS === 'web') return null;
        const offset = listRef.current?.getAbsoluteLastScrollOffset?.();
        if (typeof offset !== 'number' || !Number.isFinite(offset)) return null;
        const layoutHeight = typeof params.layoutHeight === 'number' && Number.isFinite(params.layoutHeight)
            ? params.layoutHeight
            : listLayoutHeightRef.current;
        const contentHeight = typeof params.contentHeight === 'number' && Number.isFinite(params.contentHeight)
            ? params.contentHeight
            : listContentHeightRef.current;
        if (!Number.isFinite(contentHeight) || !Number.isFinite(layoutHeight) || layoutHeight <= 0) return null;
        return Math.max(0, Math.trunc(contentHeight - layoutHeight - offset));
    }, []);
	    const releaseNativeBottomFollowIfFlashListOffsetEscaped = React.useCallback((params: {
	        contentHeight: number;
	        layoutHeight: number;
	    }): boolean => {
	        if (Platform.OS === 'web') return false;
	        if (!wantsPinnedRef.current) return false;
	        if (hasActiveNativeViewportRestore()) return false;
        if (
            nativeBottomFollowRearmedAfterDragRef.current &&
            bottomFollowModeStateRef.current.mode === 'following'
        ) return false;
        // Plan P3 (B6-consistent): a stale offset against freshly grown content is only an
        // ESCAPE when the user could have escaped — an active/retained drag session, live
        // momentum, a finger on the list, or recent scroll intent. A streaming burst with no
        // touch attribution must never release follow off the not-yet-corrected offset.
        if (
            bottomFollowModeStateRef.current.mode === 'following' &&
            bottomFollowModeStateRef.current.dragSession == null &&
            !nativeMomentumScrollActiveRef.current &&
            nativeTranscriptTouchStartYRef.current == null &&
            Date.now() - lastUserScrollIntentAtMsRef.current >= TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS
        ) return false;
        const distanceFromBottom = readCurrentNativeDistanceFromBottom(params);
        if (distanceFromBottom == null) return false;
	        if (distanceFromBottom <= pinThresholdPx) return false;
	        releaseNativeBottomFollowForGestureIntent();
	        commitBottomFollowModeEvent({
            type: 'trusted-away-observation',
            distanceFromBottom,
            movedAwayFromBottom: true,
            pinThresholdPx,
        });
        return true;
    }, [
	        commitBottomFollowModeEvent,
	        hasActiveNativeViewportRestore,
	        pinThresholdPx,
        readCurrentNativeDistanceFromBottom,
	        releaseNativeBottomFollowForGestureIntent,
	    ]);
    const commitJumpToBottomDistanceForVisibility = React.useCallback((distanceFromBottom: number) => {
        jumpToBottomDistanceFromBottomRef.current = distanceFromBottom;
        setJumpToBottomDistanceFromBottom((previousCommittedDistance) =>
            resolveNextJumpToBottomDistanceVisibilityState({
                previousCommittedDistance,
                nextDistance: distanceFromBottom,
                revealThresholdPx: jumpRevealOffsetThresholdPx,
            })
        );
    }, [jumpRevealOffsetThresholdPx]);
    /**
     * Trusted arrival back at the bottom (plan B8): re-arming follow is a first-class
     * live-tail transition — the viewport emission must agree with the mode within the
     * same observation window so sync marks live-tail intent (catch-up resolves
     * `tail_reset_latest_page`, never `defer_forward_loading`, on the next big gap).
     */
    const adoptNativeFollowingForTrustedBottomArrival = React.useCallback((distanceFromBottom: number | null) => {
        if (Platform.OS === 'web') return;
        lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
        nativeMountSettleAutoPinSuppressedRef.current = false;
        nativeBottomFollowRearmedAfterDragRef.current = true;
        wantsPinnedRef.current = true;
        isPinnedRef.current = true;
        const normalizedDistance = typeof distanceFromBottom === 'number' && Number.isFinite(distanceFromBottom)
            ? Math.max(0, Math.trunc(distanceFromBottom))
            : 0;
        lastPinOffsetForIntentRef.current = normalizedDistance;
        commitJumpToBottomDistanceForVisibility(normalizedDistance);
        setScrollPin((prev) => ({ ...prev, isPinned: true, newActivityCount: 0 }));
        emitViewportChange({ isPinned: true, offsetY: 0, shouldRestoreViewport: false });
    }, [commitJumpToBottomDistanceForVisibility, emitViewportChange]);
	    const recordNativeListDragEndIntent = React.useCallback(() => {
	        if (Platform.OS === 'web') return;
	        const dragSession = bottomFollowModeStateRef.current.dragSession;
	        const distanceFromBottom =
	            dragSession?.latestDistanceFromBottom ??
            readCurrentNativeDistanceFromBottom() ??
	            null;
	        const nextBottomFollowState = commitBottomFollowModeEvent({
            distanceFromBottom,
            pinThresholdPx,
            sawAwayMovement: dragSession?.sawAwayMovement ?? false,
            type: 'drag-end',
        });
	        if (nextBottomFollowState.mode === 'following') {
	            adoptNativeFollowingForTrustedBottomArrival(distanceFromBottom);
	        } else {
            nativeBottomFollowRearmedAfterDragRef.current = false;
        }
	    }, [
	        adoptNativeFollowingForTrustedBottomArrival,
	        commitBottomFollowModeEvent,
	        pinThresholdPx,
	        readCurrentNativeDistanceFromBottom,
	    ]);
    const recordNativeMomentumScrollBeginIntent = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        nativeMomentumScrollActiveRef.current = true;
    }, []);
    /**
     * Post-drag momentum settle (plan B8): a trusted fling that lands within the pin
     * threshold re-arms follow even though every momentum frame is untrusted — the
     * retained trusted drag session is the user attribution, and it closes here either way.
     * Plan B9: the window also settles out of 'following' (drag ended near the bottom with
     * momentum pending) — a fling that carried the viewport away must end released, with the
     * pin/jump-button state committed even if every momentum frame was swallowed elsewhere.
     */
    const recordNativeMomentumScrollEndSettle = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        nativeMomentumScrollActiveRef.current = false;
        const state = bottomFollowModeStateRef.current;
        if (
            (state.mode !== 'released' && state.mode !== 'following') ||
            state.dragSession?.trusted !== true
        ) return;
        const distanceFromBottom = readCurrentNativeDistanceFromBottom();
        const nextBottomFollowState = commitBottomFollowModeEvent({
            distanceFromBottom,
            pinThresholdPx,
            type: 'momentum-settle',
        });
        if (nextBottomFollowState.mode === 'following') {
            adoptNativeFollowingForTrustedBottomArrival(
                distanceFromBottom ?? state.dragSession.latestDistanceFromBottom,
            );
            return;
        }
        if (wantsPinnedRef.current) {
            // The fling settled away from the bottom but the drag-end-near-bottom adoption
            // left follow armed: release it now and surface the released UI state.
            const settledDistanceFromBottom = Math.max(
                0,
                Math.trunc(distanceFromBottom ?? state.dragSession.latestDistanceFromBottom ?? 0),
            );
            wantsPinnedRef.current = false;
            isPinnedRef.current = false;
            nativeBottomFollowRearmedAfterDragRef.current = false;
            cancelScheduledPinToBottom();
            lastPinOffsetForIntentRef.current = settledDistanceFromBottom;
            commitJumpToBottomDistanceForVisibility(settledDistanceFromBottom);
            setScrollPin((prev) =>
                reduceTranscriptScrollPinState(prev, {
                    type: 'scroll',
                    enabled: pinEnabled,
                    offsetY: settledDistanceFromBottom,
                    pinnedOffsetThresholdPx: 0,
                })
            );
            const settledViewportState = {
                isPinned: false,
                offsetY: settledDistanceFromBottom,
                shouldRestoreViewport: true,
            };
            emitViewportChange(settledViewportState);
            // Plan P2: the settle is user-attributed (trusted drag session) — capture the
            // dwelled position even when every momentum frame was swallowed elsewhere.
            scheduleViewportAnchorCaptureRef.current(settledViewportState);
        }
    }, [
        adoptNativeFollowingForTrustedBottomArrival,
        cancelScheduledPinToBottom,
        commitBottomFollowModeEvent,
        commitJumpToBottomDistanceForVisibility,
        emitViewportChange,
        pinEnabled,
        pinThresholdPx,
        readCurrentNativeDistanceFromBottom,
    ]);
    React.useEffect(() => {
        setJumpToBottomDistanceFromBottom((previousCommittedDistance) =>
            resolveNextJumpToBottomDistanceVisibilityState({
                previousCommittedDistance,
                nextDistance: jumpToBottomDistanceFromBottomRef.current,
                revealThresholdPx: jumpRevealOffsetThresholdPx,
            })
        );
    }, [jumpRevealOffsetThresholdPx]);
    const showJumpToBottom = jumpEnabled && !scrollPin.isPinned && jumpToBottomDistanceFromBottom >= jumpRevealOffsetThresholdPx;
    const jumpAnimateScroll = transcriptScrollJumpToBottomAnimateScroll !== false;

    const preferredListImplementation = transcriptListImplementation === 'flatlist_legacy' ? 'flatlist_legacy' : 'flash_v2';
    // Plan E1: capture the viewport synchronously inside the crash handler, BEFORE the
    // implementation flip renders, so the fallback list can restore the reading position.
    const webCrashFallbackViewportRef = React.useRef<Readonly<{
        sessionId: string;
        anchor: ReturnType<typeof captureWebTranscriptViewportAnchor>;
        distanceFromBottom: number;
    }> | null>(null);
    const captureWebCrashFallbackViewport = React.useCallback(() => {
        if (Platform.OS !== 'web') return;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return;
        let anchor: ReturnType<typeof captureWebTranscriptViewportAnchor> = null;
        try {
            anchor = captureWebTranscriptViewportAnchor({ container: metrics.element });
        } catch {
            anchor = null;
        }
        webCrashFallbackViewportRef.current = {
            sessionId: props.sessionId,
            anchor,
            distanceFromBottom: Math.max(0, Math.trunc(getWebTranscriptDistanceFromBottom(metrics))),
        };
    }, [props.sessionId, resolveWebScrollMetrics]);
    const webFlashListCrashed = useWebFlashListCrashFallback({
        enabled: Platform.OS === 'web' && preferredListImplementation === 'flash_v2',
        onBeforeFallback: captureWebCrashFallbackViewport,
    });
    const listImplementation =
        Platform.OS === 'web' && preferredListImplementation === 'flash_v2' && webFlashListCrashed
            ? 'flatlist_legacy'
            : preferredListImplementation;
    const resolveSyncLoadOlderOptions = React.useCallback((): SyncLoadOlderOptions | undefined => {
        if (Platform.OS === 'web' || listImplementation !== 'flash_v2') return undefined;
        const configuredLimit = sync.getSyncTuning().transcriptNativeOlderMessagesPageSize;
        if (typeof configuredLimit !== 'number' || !Number.isFinite(configuredLimit)) return undefined;
        return { limit: Math.max(1, Math.trunc(configuredLimit)) };
    }, [listImplementation]);
    const telemetryPlatform = resolveTranscriptViewportTelemetryPlatform(Platform.OS);
    const telemetryListImplementation = resolveTranscriptViewportTelemetryListImplementation({
        platform: telemetryPlatform,
        listImplementation,
    });
    const resolveViewportTelemetryMode = React.useCallback((mode?: TranscriptViewportMode): TranscriptViewportMode => {
        return mode ?? (wantsPinnedRef.current ? 'follow-bottom' : 'user-unpinned');
    }, []);
    const recordViewportTelemetryEvent = React.useCallback((
        event: Readonly<Record<string, unknown> & {
            mode: TranscriptViewportMode;
            type: TranscriptViewportTelemetryEvent['type'];
        }>,
    ) => {
        const tuning = sync.getSyncTuning();
        if (tuning.transcriptViewportTelemetryEnabled !== true) return;
        const telemetryEvent = {
            ...event,
            sessionId: props.sessionId,
            platform: telemetryPlatform,
            listImplementation: telemetryListImplementation,
            timestampMs: Date.now(),
        };
        if (typeof __DEV__ !== 'undefined' && __DEV__ === true) {
            recordTranscriptViewportTelemetryEvent(telemetryEvent, tuning);
            return;
        }
        transcriptViewportTelemetry.record(telemetryEvent);
    }, [props.sessionId, telemetryListImplementation, telemetryPlatform]);
    const recordRestoreDecisionTelemetry = React.useCallback((
        reason: TranscriptViewportTelemetryObservationReason,
        params: Readonly<{
            contentHeight?: number;
            distanceFromBottom?: number;
            layoutHeight?: number;
            mode?: TranscriptViewportMode;
            offsetY?: number;
        }> = {},
    ) => {
        recordViewportTelemetryEvent({
            type: 'restore-decision',
            mode: resolveViewportTelemetryMode(params.mode ?? 'restore-distance'),
            reason,
            offsetY: params.offsetY,
            layoutHeight: params.layoutHeight,
            contentHeight: params.contentHeight,
            distanceFromBottom: params.distanceFromBottom,
        });
    }, [recordViewportTelemetryEvent, resolveViewportTelemetryMode]);
    const recordScrollObservedTelemetry = React.useCallback((
        params: Readonly<{
            contentHeight?: number;
            distanceFromBottom: number;
            layoutHeight?: number;
            offsetY: number;
            reason?: TranscriptViewportTelemetryObservationReason;
        }>,
    ) => {
        recordViewportTelemetryEvent({
            type: 'scroll-observed',
            mode: resolveViewportTelemetryMode(),
            reason: params.reason ?? 'observed',
            offsetY: params.offsetY,
            layoutHeight: params.layoutHeight,
            contentHeight: params.contentHeight,
            distanceFromBottom: params.distanceFromBottom,
        });
    }, [recordViewportTelemetryEvent, resolveViewportTelemetryMode]);
    /**
     * Deferred-newer drain (plan D6): when forward loading was deferred by the catch-up
     * policy and the user approaches the bottom, load the newer page exactly once.
     * Every decision is telemetered: triggered, skipped (in flight), drained (the
     * deferred-forward marker cleared).
     */
    const drainDeferredNewerMessages = React.useCallback((params: Readonly<{
        distanceFromBottom: number;
        pinned: boolean;
    }>) => {
        const prefetchThresholdPx = sync.getSyncTuning().transcriptForwardPrefetchThresholdPx;
        if (params.pinned || params.distanceFromBottom > prefetchThresholdPx) return;
        if (sync.hasDeferredNewerMessages(props.sessionId) !== true) return;
        if (loadNewerInFlight.current) {
            recordRestoreDecisionTelemetry('forward-newer-skipped', {
                distanceFromBottom: params.distanceFromBottom,
                mode: resolveViewportTelemetryMode(),
            });
            return;
        }
        loadNewerInFlight.current = true;
        recordRestoreDecisionTelemetry('forward-newer-triggered', {
            distanceFromBottom: params.distanceFromBottom,
            mode: resolveViewportTelemetryMode(),
        });
        const p = sync.loadNewerMessages(props.sessionId);
        p.then(() => {
            if (sync.hasDeferredNewerMessages(props.sessionId) !== true) {
                recordRestoreDecisionTelemetry('forward-newer-drained', {
                    mode: resolveViewportTelemetryMode(),
                });
            }
        }).catch(() => {}).finally(() => {
            loadNewerInFlight.current = false;
        });
        fireAndForget(p, { tag: 'ChatList.loadNewerMessages' });
    }, [props.sessionId, recordRestoreDecisionTelemetry, resolveViewportTelemetryMode]);

    const resolveViewportCommand = React.useCallback((input: TranscriptViewportControllerInput): TranscriptViewportCommand => {
        return viewportControllerRef.current!.resolve(input);
    }, []);
    /**
     * Web-scoped prepend ownership window (plan F4): the KEEP web prepend anchor system
     * routes its index-recovery writes through the seam, so its phase opens with its first
     * write and closes lazily when its pending refs clear. Native prepend phases are owned
     * by the prepend transaction (open-at-commit, close-at-outcome).
     */
    const hasWebPrependRestoreWindow = React.useCallback((): boolean => {
        if (Platform.OS !== 'web') return false;
        return (
            inFlightWebPrependAnchorRef.current != null ||
            pendingWebPrependAnchorRef.current != null ||
            pendingWebPrependIndexRecoveryRef.current === true
        );
    }, []);
    const resolveViewportCommandTelemetryWriter = React.useCallback((
        command: TranscriptViewportCommand,
    ): TranscriptViewportTelemetryScrollWriter => {
        if (command.kind === 'none' || command.kind === 'skip-native-js-pin') return 'mvcp-skip';
        if (command.kind === 'restore-index' || command.kind === 'jump-to-seq') {
            return resolveIndexScrollWriter({ platform: telemetryPlatform, listImplementation });
        }
        if (Platform.OS === 'web') {
            return command.kind === 'pin-bottom' || command.mode === 'follow-bottom' || command.mode === 'jump-to-bottom'
                ? 'web-dom-bottom'
                : 'web-dom-restore';
        }
        return command.mode === 'jump-to-bottom' ? 'native-explicit-jump' : 'native-scroll-to-offset';
    }, [listImplementation, telemetryPlatform]);
    const executeViewportCommand = React.useCallback((command: TranscriptViewportCommand): boolean => {
        if (command.kind === 'none') return false;
        const admission = viewportControllerRef.current!.resolveWriteAdmission({
            command,
            platform: telemetryPlatform,
            hasWebPrependRestoreWindow: hasWebPrependRestoreWindow(),
        });
        if (!admission.accepted) {
            if (admission.reason === 'ownership') {
                recordViewportTelemetryEvent({
                    type: 'scroll-write-rejected',
                    writer: resolveViewportCommandTelemetryWriter(command),
                    reason: command.reason,
                    rejectedOwner: admission.rejectedOwner,
                    activeOwner: admission.activeOwner,
                    mode: command.mode,
                    targetOffsetY: command.kind === 'scroll-offset' || command.kind === 'restore-offset'
                        ? command.offsetY
                        : command.kind === 'restore-index' || command.kind === 'jump-to-seq'
                            ? command.index
                            : undefined,
                    layoutHeight: listLayoutHeightRef.current,
                    contentHeight: listContentHeightRef.current,
                    nativeMountSettleStable,
                });
            }
            return false;
        }

        if (command.kind === 'skip-native-js-pin') {
            recordViewportTelemetryEvent({
                type: 'scroll-write',
                writer: 'mvcp-skip',
                reason: command.reason,
                mode: command.mode,
                targetOffsetY: command.targetOffsetY,
                previousOffsetY: lastNativePinOffsetRef.current ?? undefined,
                layoutHeight: listLayoutHeightRef.current,
                contentHeight: listContentHeightRef.current,
                distanceFromBottom: 0,
                nativeMountSettleStable,
            });
            return true;
        }

        if (command.kind === 'pin-bottom') {
            if (Platform.OS === 'web') {
                clearWebPrependRangeReserve();
                const metrics = resolveWebScrollMetrics();
                if (!metrics) return false;
                const previousOffsetY = metrics.scrollTop;
                const scrollToVisualBottom = listImplementation !== 'flatlist_legacy';
                try {
                    metrics.element.scrollTop = scrollToVisualBottom ? metrics.scrollHeight : 0;
                } catch {
                    try {
                        metrics.element.scrollTop = scrollToVisualBottom ? metrics.scrollHeight : 0;
                    } catch {
                        return false;
                    }
                }
                lastObservedWebScrollTopRef.current = metrics.element.scrollTop;
                const targetOffsetY = metrics.element.scrollTop;
                recordViewportTelemetryEvent({
                    type: 'scroll-write',
                    writer: 'web-dom-bottom',
                    reason: command.reason,
                    mode: command.mode,
                    targetOffsetY,
                    previousOffsetY,
                    layoutHeight: metrics.clientHeight,
                    contentHeight: metrics.scrollHeight,
                    distanceFromBottom: Math.max(0, Math.trunc(metrics.scrollHeight - metrics.clientHeight - targetOffsetY)),
                });
                return true;
            }

            const node = listRef.current;
            if (!node) return false;
            const isLegacyList = listImplementation === 'flatlist_legacy';
            const offset = isLegacyList
                ? 0
                : Math.max(0, Math.trunc(listContentHeightRef.current - listLayoutHeightRef.current));
            const previousOffsetY = lastNativePinOffsetRef.current ?? undefined;
            if (!isLegacyList && command.mode === 'jump-to-bottom' && typeof node.scrollToEnd === 'function') {
                // Plan B7: an explicit jump targets the list's OWN end. Our contentHeight
                // snapshot can be mid-churn (field trace: jump landed at ~93% after the
                // height shrank under the write), so never derive the explicit bottom
                // target from it when the list exposes scrollToEnd (FlashList 2.3.2 does).
                node.scrollToEnd({ animated: command.animated ?? false });
            } else {
                if (typeof node.scrollToOffset !== 'function') return false;
                if (
                    !isLegacyList &&
                    command.mode === 'jump-to-bottom' &&
                    offset <= 0 &&
                    listDataRef.current.length > 0 &&
                    (listContentHeightRef.current <= 0 || listLayoutHeightRef.current <= 0)
                ) {
                    // Plan B7: never issue scrollToOffset(0) for an explicit jump while the
                    // content is unmeasured (0 is the TOP of a scrollable transcript). Defer
                    // to the bounded explicit re-confirm and telemeter the deferral.
                    recordRestoreDecisionTelemetry('not-ready', {
                        mode: 'jump-to-bottom',
                        contentHeight: listContentHeightRef.current,
                        layoutHeight: listLayoutHeightRef.current,
                    });
                    return false;
                }
                node.scrollToOffset({ offset, animated: command.animated ?? false });
                lastNativePinOffsetRef.current = offset;
            }
            recordViewportTelemetryEvent({
                type: 'scroll-write',
                writer: command.mode === 'jump-to-bottom' ? 'native-explicit-jump' : 'native-scroll-to-offset',
                reason: command.reason,
                mode: command.mode,
                targetOffsetY: offset,
                previousOffsetY,
                layoutHeight: listLayoutHeightRef.current,
                contentHeight: listContentHeightRef.current,
                distanceFromBottom: 0,
                nativeMountSettleStable,
            });
            return true;
        }

        if (command.kind === 'scroll-offset' || command.kind === 'restore-offset') {
            if (Platform.OS === 'web') {
                const metrics = resolveWebScrollMetrics();
                if (!metrics) return false;
                const previousOffsetY = metrics.scrollTop;
                const targetOffsetY = command.kind === 'restore-offset'
                    ? listImplementation === 'flatlist_legacy'
                        ? Math.min(resolveWebTranscriptMaxScrollTop(metrics), command.offsetY)
                        : Math.max(0, resolveWebTranscriptMaxScrollTop(metrics) - command.offsetY)
                    : Math.max(0, Math.trunc(command.offsetY));
                try {
                    metrics.element.scrollTop = targetOffsetY;
                } catch {
                    return false;
                }
                lastObservedWebScrollTopRef.current = metrics.element.scrollTop;
                recordViewportTelemetryEvent({
                    type: 'scroll-write',
                    writer: command.mode === 'follow-bottom' || command.mode === 'jump-to-bottom'
                        ? 'web-dom-bottom'
                        : 'web-dom-restore',
                    reason: command.reason,
                    mode: command.mode,
                    targetOffsetY,
                    previousOffsetY,
                    layoutHeight: metrics.clientHeight,
                    contentHeight: metrics.scrollHeight,
                    distanceFromBottom: command.kind === 'restore-offset'
                        ? command.offsetY
                        : Math.max(0, Math.trunc(metrics.scrollHeight - metrics.clientHeight - targetOffsetY)),
                });
                return true;
            }

            const node = listRef.current;
            if (!node || typeof node.scrollToOffset !== 'function') return false;
            const layoutHeight = listLayoutHeightRef.current;
            const contentHeight = command.kind === 'restore-offset' && typeof command.contentHeight === 'number' && Number.isFinite(command.contentHeight)
                ? Math.max(0, Math.trunc(command.contentHeight))
                : listContentHeightRef.current;
            const maxOffset = Math.max(0, Math.trunc(contentHeight - layoutHeight));
            const targetOffsetY = command.kind === 'restore-offset'
                ? listImplementation === 'flatlist_legacy'
                    ? Math.min(maxOffset, command.offsetY)
                    : Math.max(0, maxOffset - command.offsetY)
                : Math.max(0, Math.trunc(command.offsetY));
            const previousOffsetY = lastNativePinOffsetRef.current ?? undefined;
            node.scrollToOffset({ offset: targetOffsetY, animated: command.animated ?? false });
            if (command.mode === 'follow-bottom' || command.mode === 'jump-to-bottom') {
                lastNativePinOffsetRef.current = targetOffsetY;
            }
            recordViewportTelemetryEvent({
                type: 'scroll-write',
                writer: command.mode === 'jump-to-bottom' ? 'native-explicit-jump' : 'native-scroll-to-offset',
                reason: command.reason,
                mode: command.mode,
                targetOffsetY,
                previousOffsetY,
                layoutHeight,
                contentHeight,
                distanceFromBottom: command.kind === 'restore-offset' ? command.offsetY : undefined,
                nativeMountSettleStable,
            });
            return true;
        }

        if (command.kind === 'restore-index' || command.kind === 'jump-to-seq') {
            const index = command.index;
            if (typeof index !== 'number' || !Number.isFinite(index)) return false;
            const node = listRef.current;
            if (!node || typeof node.scrollToIndex !== 'function') return false;
            if (command.kind === 'restore-index') {
                if (Platform.OS !== 'web') {
                    lastNativeRestoreIndexCommandRef.current = {
                        index,
                        issuedAtMs: Date.now(),
                        reason: command.reason,
                        sessionId: command.sessionId,
                        viewOffset: command.viewOffset,
                    };
                }
                node.scrollToIndex({
                    index,
                    animated: command.animated ?? false,
                    viewOffset: command.viewOffset,
                    ...(Platform.OS === 'web' ? { viewPosition: 0 } : {}),
                });
            } else {
                if (Platform.OS !== 'web') {
                    lastNativeRestoreIndexCommandRef.current = {
                        index,
                        issuedAtMs: Date.now(),
                        reason: command.reason,
                        sessionId: command.sessionId,
                    };
                }
                node.scrollToIndex({ index, animated: command.animated ?? true, viewPosition: 0.5 });
            }
            recordViewportTelemetryEvent({
                type: 'scroll-write',
                writer: resolveIndexScrollWriter({
                    platform: telemetryPlatform,
                    listImplementation,
                }),
                reason: command.reason,
                mode: command.mode,
                targetOffsetY: index,
                layoutHeight: listLayoutHeightRef.current,
                contentHeight: listContentHeightRef.current,
                nativeMountSettleStable,
            });
            return true;
        }

        return false;
    }, [
        clearWebPrependRangeReserve,
        hasWebPrependRestoreWindow,
        listImplementation,
        nativeMountSettleStable,
        recordRestoreDecisionTelemetry,
        recordViewportTelemetryEvent,
        resolveViewportCommandTelemetryWriter,
        resolveWebScrollMetrics,
        telemetryPlatform,
    ]);

    const writeWebRestoreScrollTopThroughViewportCommand = React.useCallback((
        params: Readonly<{
            mode: Extract<TranscriptViewportMode, 'restore-anchor' | 'restore-distance'>;
            reason: Extract<TranscriptViewportTelemetryScrollReason, 'entry-restore' | 'prepend-restore'>;
            targetScrollTop: number;
        }>,
    ): boolean => {
        return executeViewportCommand(resolveViewportCommand({
            type: 'scroll-offset',
            sessionId: props.sessionId,
            reason: params.reason,
            mode: params.mode,
            offsetY: params.targetScrollTop,
            animated: false,
        }));
    }, [executeViewportCommand, props.sessionId, resolveViewportCommand]);

    const restoreWebPrependAnchorThroughViewportCommand = React.useCallback((
        anchor: WebTranscriptPrependAnchor,
    ): WebTranscriptPrependRestoreResult => {
        return restoreWebTranscriptPrependAnchor(anchor, {
            writeScrollTop: (targetScrollTop) => writeWebRestoreScrollTopThroughViewportCommand({
                mode: 'restore-anchor',
                reason: 'prepend-restore',
                targetScrollTop,
            }),
        });
    }, [writeWebRestoreScrollTopThroughViewportCommand]);

    const restoreWebViewportAnchorThroughViewportCommand = React.useCallback((params: Readonly<{
        anchor: Parameters<typeof restoreWebTranscriptViewportAnchor>[0]['anchor'];
        container: HTMLElement;
    }>) => {
        return restoreWebTranscriptViewportAnchor(params, {
            writeScrollTop: (targetScrollTop) => writeWebRestoreScrollTopThroughViewportCommand({
                mode: 'restore-anchor',
                reason: 'entry-restore',
                targetScrollTop,
            }),
        });
    }, [writeWebRestoreScrollTopThroughViewportCommand]);

    const [firstListPaintObserved, setFirstListPaintObserved] = React.useState(false);
    const [nativeViewportPaintObserved, setNativeViewportPaintObservedState] = React.useState(false);
    const nativeViewportPaintObservedRef = React.useRef(false);
    const [nativeEntryRestorePaintReleaseState, setNativeEntryRestorePaintReleaseState] = React.useState<{
        released: boolean;
        sessionId: string;
    }>(() => ({
        released: false,
        sessionId: props.sessionId,
    }));
    const nativeEntryRestorePaintReleasedRef = React.useRef<{
        released: boolean;
        sessionId: string;
    }>({
        released: false,
        sessionId: props.sessionId,
    });
    const nativeEntryRestorePaintReleased =
        nativeEntryRestorePaintReleaseState.sessionId === props.sessionId &&
        nativeEntryRestorePaintReleaseState.released;
    const updateNativeViewportPaintObserved = React.useCallback((observed: boolean) => {
        if (Platform.OS === 'web') return;
        nativeViewportPaintObservedRef.current = observed;
        setNativeViewportPaintObservedState(observed);
    }, []);
    const updateNativeEntryRestorePaintReleased = React.useCallback((released: boolean) => {
        if (Platform.OS === 'web') return;
        const nextState = {
            released,
            sessionId: props.sessionId,
        };
        nativeEntryRestorePaintReleasedRef.current = nextState;
        setNativeEntryRestorePaintReleaseState(nextState);
    }, [props.sessionId]);
    const releaseNativePaintForIssuedEntryRestore = React.useCallback(() => {
        if (Platform.OS === 'web') return false;
        if (listImplementation !== 'flash_v2') return false;
        if (nativeViewportPaintObservedRef.current) return false;
        if (
            nativeEntryRestorePaintReleasedRef.current.sessionId === props.sessionId &&
            nativeEntryRestorePaintReleasedRef.current.released
        ) {
            return false;
        }
        if (listLayoutHeightRef.current <= 0 || listContentHeightRef.current <= 0) return false;
        if (sessionEntryViewportRef.current?.sessionId !== props.sessionId) return false;
        if (sessionEntryViewportRef.current.shouldFollowBottom !== false) return false;
        if (entryRestoreTransactionRef.current?.sessionId !== props.sessionId) return false;

        updateNativeEntryRestorePaintReleased(true);
        return true;
    }, [listImplementation, props.sessionId, updateNativeEntryRestorePaintReleased]);
    /**
     * 32ms paint-release polish (plan A4): once the entry-restore transaction has issued its
     * write (background sessions) or closed, reveal the restored viewport shortly after.
     * The transaction deadline always fires, so the placeholder can never hang.
     */
    const scheduleNativePaintReleaseForEntryRestore = React.useCallback((options?: Readonly<{ force?: boolean }>) => {
        if (Platform.OS === 'web') return;
        if (listImplementation !== 'flash_v2') return;
        if (options?.force !== true && props.sessionActive) return;
        if (nativeViewportPaintObservedRef.current) return;
        if (
            nativeEntryRestorePaintReleasedRef.current.sessionId === props.sessionId &&
            nativeEntryRestorePaintReleasedRef.current.released
        ) {
            return;
        }
        if (sessionEntryViewportRef.current?.sessionId !== props.sessionId) return;
        if (sessionEntryViewportRef.current.shouldFollowBottom !== false) return;
        const writeContext = entryRestoreWriteContextRef.current;
        if (writeContext?.sessionId !== props.sessionId) return;
        const existing = nativeEntryRestorePaintReleaseTimeoutRef.current;
        if (
            existing?.sessionId === props.sessionId &&
            existing.issuedAtMs === writeContext.createdAtMs
        ) {
            return;
        }
        if (existing) {
            nativeEntryRestorePaintReleaseTimeoutRef.current = null;
            clearTimeout(existing.timeoutId);
        }

        const handle = {
            issuedAtMs: writeContext.createdAtMs,
            sessionId: props.sessionId,
            timeoutId: null as unknown as ReturnType<typeof setTimeout>,
        };
        handle.timeoutId = setTimeout(() => {
            if (nativeEntryRestorePaintReleaseTimeoutRef.current !== handle) return;
            nativeEntryRestorePaintReleaseTimeoutRef.current = null;
            if (currentSessionIdRef.current !== handle.sessionId) return;
            if (entryRestoreWriteContextRef.current?.createdAtMs !== handle.issuedAtMs) return;
            releaseNativePaintForIssuedEntryRestore();
        }, TRANSCRIPT_NATIVE_ENTRY_RESTORE_PAINT_RELEASE_DELAY_MS);
        nativeEntryRestorePaintReleaseTimeoutRef.current = handle;
    }, [listImplementation, props.sessionActive, props.sessionId, releaseNativePaintForIssuedEntryRestore]);
    const firstPaintTelemetryRef = React.useRef<{
        recorded: boolean;
        sessionId: string;
        startedAtMs: number;
    } | null>(null);
    const stablePaintTelemetryRef = React.useRef<{
        recorded: boolean;
        sessionId: string;
        startedAtMs: number;
    } | null>(null);
    const [webStablePaintRetryTick, bumpWebStablePaintRetryTick] = React.useReducer((value: number) => (value + 1) % 1_000_000, 0);
    const webStablePaintRetryTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const clearWebStablePaintRetry = React.useCallback(() => {
        const timeout = webStablePaintRetryTimeoutRef.current;
        if (timeout === null) return;
        clearTimeout(timeout);
        webStablePaintRetryTimeoutRef.current = null;
    }, []);
    const scheduleWebStablePaintRetry = React.useCallback(() => {
        if (!syncPerformanceTelemetry.isEnabled()) return;
        if (Platform.OS !== 'web') return;
        if (stablePaintTelemetryRef.current?.recorded === true) return;
        if (webStablePaintRetryTimeoutRef.current !== null) return;
        webStablePaintRetryTimeoutRef.current = setTimeout(() => {
            webStablePaintRetryTimeoutRef.current = null;
            bumpWebStablePaintRetryTick();
        }, 16);
    }, []);
    if (firstPaintTelemetryRef.current?.sessionId !== props.sessionId) {
        firstPaintTelemetryRef.current = {
            recorded: false,
            sessionId: props.sessionId,
            startedAtMs: readSessionUiTelemetryNowMs(),
        };
    }
    if (stablePaintTelemetryRef.current?.sessionId !== props.sessionId) {
        stablePaintTelemetryRef.current = {
            recorded: false,
            sessionId: props.sessionId,
            startedAtMs: readSessionUiTelemetryNowMs(),
        };
    }

    React.useEffect(() => clearWebStablePaintRetry, [clearWebStablePaintRetry]);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return undefined;
        if (isEnrichedMarkdownRuntimePreloaded()) {
            setWebMarkdownRuntimeReady(true);
            return undefined;
        }

        let cancelled = false;
        const preload = preloadEnrichedMarkdownRuntime();
        fireAndForget(preload, { tag: 'ChatList.webMarkdownRuntimeFirstPaint' });
        preload.then(
            () => {
                if (!cancelled) setWebMarkdownRuntimeReady(true);
            },
            () => {
                if (!cancelled) setWebMarkdownRuntimeReady(true);
            },
        );

        return () => {
            cancelled = true;
        };
    }, []);

    const displayItems = React.useMemo(() => {
        if (listImplementation === 'flatlist_legacy') {
            // Legacy: inverted lists expect newest-first input.
            return [...props.items].reverse();
        }
        return props.items;
    }, [listImplementation, props.items]);
    const transcriptHotColdSegments = React.useMemo(() => {
        const tuning = sync.getSyncTuning();
        return buildTranscriptHotColdSegments({
            enabled: listImplementation === 'flash_v2',
            hotTailItemCount: tuning.transcriptWebHotTailItemCount,
            items: displayItems,
            activeThinkingMessageId: props.activeThinkingMessageId,
            expandedToolCallsAnchorMessageIds,
        });
    }, [displayItems, expandedToolCallsAnchorMessageIds, listImplementation, props.activeThinkingMessageId]);
    const shouldUseWebHotColdSplit =
        Platform.OS === 'web' &&
        listImplementation === 'flash_v2' &&
        transcriptHotColdSegments.hotItems.length > 0;
    const listData = shouldUseWebHotColdSplit ? transcriptHotColdSegments.coldItems : displayItems;
    const handleWebHotTailLayout = React.useCallback(() => {
        scheduleWebHotTailBottomFollowRef.current?.();
    }, []);

    React.useEffect(() => {
        setFirstListPaintObserved(false);
        updateNativeViewportPaintObserved(false);
        updateNativeEntryRestorePaintReleased(false);
    }, [
        listImplementation,
        props.sessionId,
        updateNativeEntryRestorePaintReleased,
        updateNativeViewportPaintObserved,
    ]);

    // Keep a synchronous view of the current list items for effects that run between renders
    // (e.g. initial viewport fill and jump-to-seq resolution).
    itemsRef.current = displayItems;
    listDataRef.current = listData;

    React.useEffect(() => {
        recordStreamingVisibleUpdateForSessionUiTelemetry({
            sessionId: props.sessionId,
            latestMessageId: props.latestCommittedActivityKey,
            committedMessages: props.committedMessagesCount,
            transcriptLoaded: props.isLoaded ? 1 : 0,
            visibleItems: listData.length,
        });
    }, [
        listData.length,
        props.committedMessagesCount,
        props.isLoaded,
        props.latestCommittedActivityKey,
        props.messagesById,
        props.sessionId,
    ]);

    React.useEffect(() => {
        return () => {
            clearStreamingSessionUiTelemetryMarks(props.sessionId);
        };
    }, [props.sessionId]);

    const usesNativeFlashListBottomMaintenance =
        Platform.OS !== 'web' && listImplementation === 'flash_v2';
    const nativeEntryShouldUseBottomMaintenance =
        sessionEntryViewportRef.current?.shouldFollowBottom !== false;
    const transcriptWidthBucket = React.useMemo(
        () => resolveTranscriptWidthBucket(listLayoutWidth),
        [listLayoutWidth],
    );
    const transcriptFontScaleKey = React.useMemo(() => resolveTranscriptFontScaleKey(), []);
    const configuredFlashListDrawDistance = sync.getSyncTuning().transcriptFlashListDrawDistance;
    const flashListDrawDistance =
        Platform.OS !== 'web' && listImplementation === 'flash_v2'
            ? (typeof configuredFlashListDrawDistance === 'number' &&
                Number.isFinite(configuredFlashListDrawDistance) &&
                configuredFlashListDrawDistance > 0
                ? Math.trunc(configuredFlashListDrawDistance)
                // Plan C4: default ≈ one viewport height clamped to [600, 1200]px so the rows
                // a prepend lands behind are measured before the reader reaches them.
                : Math.min(
                    TRANSCRIPT_NATIVE_DRAW_DISTANCE_DEFAULT_MAX_PX,
                    Math.max(
                        TRANSCRIPT_NATIVE_DRAW_DISTANCE_DEFAULT_MIN_PX,
                        Math.ceil(Number.isFinite(listLayoutHeight) ? listLayoutHeight : 0),
                    ),
                ))
            : undefined;
    const observeMountSettleMetrics = React.useCallback((params: { distanceFromBottom?: number; nowMs?: number } = {}) => {
        const coordinator = mountSettleCoordinatorRef.current;
        if (!coordinator) return;
        coordinator.observeMetrics({
            sessionId: props.sessionId,
            nowMs: params.nowMs ?? Date.now(),
            initialFillStatus: initialFillStatusRef.current,
            listContentHeight: listContentHeightRef.current,
            listLayoutHeight: listLayoutHeightRef.current,
            composerInsetHeight: composerInsetHeightRef.current,
            distanceFromBottom: params.distanceFromBottom ?? lastPinOffsetForIntentRef.current ?? 0,
        });
    }, [props.sessionId]);
    React.useEffect(() => {
        if (!usesNativeFlashListBottomMaintenance) return undefined;
        const tuning = sync.getSyncTuning();
        const intervalMs = tuning.transcriptMountSettleQuiescentWindowMs;
        const deadlineMs = Date.now() + tuning.transcriptInitialFillBudgetMs + intervalMs;
        const intervalId = setInterval(() => {
            const coordinator = mountSettleCoordinatorRef.current;
            if (!coordinator) {
                clearInterval(intervalId);
                return;
            }
            const nowMs = Date.now();
            coordinator.sample({ sessionId: props.sessionId, nowMs });
            if (coordinator.getSnapshot().stableSettle || nowMs >= deadlineMs) {
                // Cold-open entry phase backstop (plan B1): the mount window is over —
                // release entry ownership so follow writes flow again. No-op for restore
                // entries whose transaction already closed the phase, and for phases
                // already closed 'confirmed' via markNativeInitialViewportApplied.
                closeEntryViewportOwnership('deadline');
                if (coordinator.getSnapshot().stableSettle) {
                    setNativeMountSettleStable(true);
                    nativeMountSettleDeadlineReachedRef.current = false;
                    flushPendingNativeMountSettleBottomPinRef.current?.();
                } else {
                    nativeMountSettleDeadlineReachedRef.current = true;
                    setNativeMountSettleDeadlineReached(true);
                    if (!nativeMountSettleAutoPinSuppressedRef.current) {
                        pendingNativeMountSettleBottomPinRef.current = true;
                        flushPendingNativeMountSettleBottomPinRef.current?.();
                    }
                }
                clearInterval(intervalId);
            }
        }, intervalMs);
        return () => clearInterval(intervalId);
    }, [closeEntryViewportOwnership, props.sessionId, usesNativeFlashListBottomMaintenance]);
    const recordFirstListPaint = React.useCallback(() => {
        const nowMs = Date.now();
        setFirstListPaintObserved(true);
        const telemetryState = firstPaintTelemetryRef.current;
        if (
            telemetryState &&
            telemetryState.sessionId === props.sessionId &&
            telemetryState.recorded === false &&
            syncPerformanceTelemetry.isEnabled()
        ) {
            telemetryState.recorded = true;
            syncPerformanceTelemetry.recordDuration(
                'ui.sessions.transcript.firstPaint',
                readSessionUiTelemetryNowMs() - telemetryState.startedAtMs,
                {
                    committedMessages: props.committedMessagesCount,
                    items: listDataRef.current.length,
                    native: Platform.OS === 'web' ? 0 : 1,
                    routeHydrationPending: props.routeHydrationPending === true ? 1 : 0,
                    web: Platform.OS === 'web' ? 1 : 0,
                },
            );
            recordSessionOpenPaintForSessionUiTelemetry({
                committedMessages: props.committedMessagesCount,
                items: listDataRef.current.length,
                native: Platform.OS === 'web' ? 0 : 1,
                phase: 'firstPaint',
                routeHydrationPending: props.routeHydrationPending === true ? 1 : 0,
                sessionId: props.sessionId,
                web: Platform.OS === 'web' ? 1 : 0,
            });
        }
        mountSettleCoordinatorRef.current?.recordFirstListPaint({
            sessionId: props.sessionId,
            nowMs,
        });
        observeMountSettleMetrics({ nowMs });
        releaseNativePaintForIssuedEntryRestore();
    }, [
        observeMountSettleMetrics,
        props.committedMessagesCount,
        props.routeHydrationPending,
        props.sessionId,
        releaseNativePaintForIssuedEntryRestore,
    ]);
    const resolveEffectiveListPaintMetrics = React.useCallback(() => {
        if (Platform.OS === 'web') {
            const webMetrics = resolveWebScrollMetrics();
            if (webMetrics && webMetrics.clientHeight > 0 && webMetrics.scrollHeight > 0) {
                return {
                    contentHeight: Math.max(0, Math.trunc(webMetrics.scrollHeight)),
                    distanceFromBottom: Math.max(0, Math.trunc(getWebTranscriptDistanceFromBottom(webMetrics))),
                    layoutHeight: Math.max(0, Math.trunc(webMetrics.clientHeight)),
                };
            }
        }

        const measuredLayoutHeight = listLayoutHeightRef.current;
        const measuredContentHeight = listContentHeightRef.current;
        if (measuredLayoutHeight > 0 && measuredContentHeight > 0) {
            const distanceFromBottom =
                typeof lastPinOffsetForIntentRef.current === 'number' &&
                Number.isFinite(lastPinOffsetForIntentRef.current)
                    ? Math.max(0, Math.trunc(lastPinOffsetForIntentRef.current))
                    : 0;
            return {
                contentHeight: Math.max(0, Math.trunc(measuredContentHeight)),
                distanceFromBottom,
                layoutHeight: Math.max(0, Math.trunc(measuredLayoutHeight)),
            };
        }

        return null;
    }, [resolveWebScrollMetrics]);
    const hasWarmStablePaint = hasTranscriptWarmStablePaint({
        committedMessagesCount: props.committedMessagesCount,
        items: listData.length,
        latestCommittedActivityKey: props.latestCommittedActivityKey,
        listImplementation: telemetryListImplementation,
        platform: telemetryPlatform,
        routeHydrationPending: props.routeHydrationPending === true,
        sessionId: props.sessionId,
    });
    const isWarmKeepAliveInstance = props.isWarmKeepAliveInstance === true || hasWarmStablePaint;
    const recordStablePaintTelemetry = React.useCallback((
        paintMetrics: Readonly<{
            contentHeight: number;
            distanceFromBottom: number;
            layoutHeight: number;
        }>,
        options: Readonly<{
            nativeViewportObserved?: boolean;
        }> = {},
    ): boolean => {
        if (options.nativeViewportObserved === true) {
            rememberTranscriptWarmStablePaint({
                committedMessagesCount: props.committedMessagesCount,
                items: listData.length,
                latestCommittedActivityKey: props.latestCommittedActivityKey,
                listImplementation: telemetryListImplementation,
                platform: telemetryPlatform,
                routeHydrationPending: props.routeHydrationPending === true,
                sessionId: props.sessionId,
            });
        }
        const telemetryState = stablePaintTelemetryRef.current;
        if (
            !telemetryState ||
            telemetryState.sessionId !== props.sessionId ||
            telemetryState.recorded === true ||
            !syncPerformanceTelemetry.isEnabled()
        ) {
            return false;
        }
        clearWebStablePaintRetry();
        telemetryState.recorded = true;
        syncPerformanceTelemetry.recordDuration(
            'ui.sessions.transcript.stablePaint',
            readSessionUiTelemetryNowMs() - telemetryState.startedAtMs,
            {
                coldItems: shouldUseWebHotColdSplit ? transcriptHotColdSegments.coldItems.length : 0,
                committedMessages: props.committedMessagesCount,
                contentHeight: paintMetrics.contentHeight,
                distanceFromBottom: paintMetrics.distanceFromBottom,
                firstListPaintObserved: firstListPaintObserved ? 1 : 0,
                hotItems: shouldUseWebHotColdSplit ? transcriptHotColdSegments.hotItems.length : 0,
                items: listData.length,
                layoutHeight: paintMetrics.layoutHeight,
                native: Platform.OS === 'web' ? 0 : 1,
                nativeMountSettleDeadlineReached: nativeMountSettleDeadlineReached ? 1 : 0,
                nativeMountSettleStable: nativeMountSettleStable ? 1 : 0,
                nativeViewportObserved: options.nativeViewportObserved === true ? 1 : 0,
                routeHydrationPending: props.routeHydrationPending === true ? 1 : 0,
                warmKeepAlive: isWarmKeepAliveInstance ? 1 : 0,
                web: Platform.OS === 'web' ? 1 : 0,
                webHotColdSplit: shouldUseWebHotColdSplit ? 1 : 0,
            },
        );
        recordSessionOpenPaintForSessionUiTelemetry({
            committedMessages: props.committedMessagesCount,
            distanceFromBottom: paintMetrics.distanceFromBottom,
            items: listData.length,
            native: Platform.OS === 'web' ? 0 : 1,
            phase: 'stablePaint',
            routeHydrationPending: props.routeHydrationPending === true ? 1 : 0,
            sessionId: props.sessionId,
            web: Platform.OS === 'web' ? 1 : 0,
        });
        return true;
    }, [
        clearWebStablePaintRetry,
        firstListPaintObserved,
        listData.length,
        nativeMountSettleDeadlineReached,
        nativeMountSettleStable,
        props.committedMessagesCount,
        props.latestCommittedActivityKey,
        props.routeHydrationPending,
        props.sessionId,
        isWarmKeepAliveInstance,
        shouldUseWebHotColdSplit,
        telemetryListImplementation,
        telemetryPlatform,
        transcriptHotColdSegments.coldItems.length,
        transcriptHotColdSegments.hotItems.length,
    ]);
    const recordLayoutCommitObserved = React.useCallback(() => {
        const nowMs = Date.now();
        mountSettleCoordinatorRef.current?.recordLayoutCommitObserved({
            sessionId: props.sessionId,
            nowMs,
        });
        observeMountSettleMetrics({ nowMs });
        scheduleNativePaintReleaseForEntryRestore();
    }, [observeMountSettleMetrics, props.sessionId, scheduleNativePaintReleaseForEntryRestore]);

    const shouldCommitContentHeightState = React.useCallback(() => {
        if (Platform.OS === 'web') return true;
        if (initialFillStatusRef.current !== 'done') return true;
        return props.jumpToSeq != null;
    }, [props.jumpToSeq]);

    const flashListMaintainVisibleContentPosition = React.useMemo(() => {
        // FlashList/web can throw "index out of bounds, not enough layouts" under heavy append + scroll
        // when `maintainVisibleContentPosition.startRenderingFromBottom` is enabled. On web we already
        // pin via direct DOM scroll writes, so omit this prop to avoid the crash.
        return resolveTranscriptFlashListBottomMaintenance({
            autoFollowWhenPinned,
            bottomFollowMode: bottomFollowModeStateRef.current.mode,
            // Plan B3: the MVCP autoscroll threshold is armed only while following AND
            // no viewport transaction is open (entry or prepend transaction, plan F4).
            hasOpenViewportTransaction: hasActiveNativeViewportRestore(),
            layoutHeight: nativeMountSettleStable ? listLayoutHeight : 0,
            nativeEntryShouldUseBottomMaintenance,
            pinEnabled,
            pinThresholdPx,
            platformIsWeb: Platform.OS === 'web',
        });
    }, [
        autoFollowWhenPinned,
        bottomFollowModeRevision,
        hasActiveNativeViewportRestore,
        listLayoutHeight,
        nativeEntryShouldUseBottomMaintenance,
        nativeInitialViewportPendingObservation,
        nativeMountSettleStable,
        nativePrependTransactionRevision,
        pinEnabled,
        pinThresholdPx,
    ]);

    const flatListMaintainVisibleContentPosition = React.useMemo(() => {
        return canAutoFollowForReason('stream-append')
            ? { minIndexForVisible: 0, autoscrollToTopThreshold: pinThresholdPx }
            : undefined;
    }, [bottomFollowModeRevision, canAutoFollowForReason, pinThresholdPx]);

    const resolveCreatedAtForMessageId = React.useCallback((messageId: string): number | null => {
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[props.sessionId];
        const message = session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
        const createdAt = message?.createdAt;
        return typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : null;
    }, [props.sessionId]);

    const resolveSeqForMessageId = React.useCallback((messageId: string): number | null => {
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[props.sessionId];
        const message = session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
        const seq = message?.seq;
        return typeof seq === 'number' && Number.isFinite(seq) ? Math.trunc(seq) : null;
    }, [props.sessionId]);

    const resolveKindForMessageId = React.useCallback((messageId: string): string | null => {
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[props.sessionId];
        const message = session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
        const kind = message?.kind;
        return typeof kind === 'string' ? kind : null;
    }, [props.sessionId]);

    const getTurnMessageById = React.useCallback((messageId: string): Message | null => {
        const rowTypeMessage = props.rowTypeMessagesById[messageId];
        if (rowTypeMessage) return rowTypeMessage;
        const forkAwareMessage = props.messagesById[messageId];
        if (forkAwareMessage) return forkAwareMessage;
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[props.sessionId];
        return session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
    }, [props.messagesById, props.rowTypeMessagesById, props.sessionId]);

    const toolTimelineChromeMode = props.toolChromeCommon.toolViewTimelineChromeMode;
    const keyExtractor = useCallback((item: ChatTranscriptListItem) => item.id, []);
    const getItemType = useCallback((item: ChatTranscriptListItem): string => resolveTranscriptRowItemType({
        activeThinkingMessageId: props.activeThinkingMessageId,
        getMessageById: getTurnMessageById,
        item,
    }), [getTurnMessageById, props.activeThinkingMessageId]);
    const resolveRollbackActionForMessage = React.useCallback((messageId: string): TranscriptRollbackAction | null => {
        return props.rollbackActionsByMessageId[messageId] ?? null;
    }, [props.rollbackActionsByMessageId]);
    const buildRowShellSignature = React.useCallback((item: ChatTranscriptListItem) => (
        buildTranscriptRowShellSignature({
            activeThinkingMessageId: props.activeThinkingMessageId,
            expandedToolCallsAnchorMessageIds,
            forkMessageMetadataById: props.forkMessageMetadataById,
            getMessageById: getTurnMessageById,
            groupingMode: props.groupingMode,
            item,
            latestCommittedActivityKey: props.latestCommittedActivityKey,
            resolveThinkingExpanded,
            sessionActive: props.sessionActive,
            widthBucket: transcriptWidthBucket,
            fontScaleKey: transcriptFontScaleKey,
        })
    ), [
        expandedToolCallsAnchorMessageIds,
        getTurnMessageById,
        props.activeThinkingMessageId,
        props.forkMessageMetadataById,
        props.groupingMode,
        props.latestCommittedActivityKey,
        props.sessionActive,
        resolveThinkingExpanded,
        transcriptFontScaleKey,
        transcriptWidthBucket,
    ]);
    const shouldHoldNativeFirstPaintPlaceholderForMountSettle =
        usesNativeFlashListBottomMaintenance &&
        sessionEntryViewportRef.current?.shouldFollowBottom !== false &&
        props.jumpToSeq == null &&
        !nativeMountSettleStable &&
        !nativeMountSettleDeadlineReached;
    const shouldHoldNativeFirstPaintPlaceholderForPendingViewport =
        usesNativeFlashListBottomMaintenance &&
        props.jumpToSeq == null &&
        !nativeMountSettleDeadlineReached &&
        nativeInitialViewportPendingObservation &&
        (
            sessionEntryViewportRef.current?.shouldFollowBottom !== false ||
            (
                entryRestoreTransactionRef.current?.sessionId === props.sessionId &&
                !entryRestoreTransactionRef.current.isClosed()
            )
        );
    const nativeWarmFirstPaintDistanceAppearsOffBottom =
        usesNativeFlashListBottomMaintenance &&
        sessionEntryViewportRef.current?.shouldFollowBottom !== false &&
        typeof lastPinOffsetForIntentRef.current === 'number' &&
        Number.isFinite(lastPinOffsetForIntentRef.current) &&
        lastPinOffsetForIntentRef.current > pinThresholdPx;
    const canWarmKeepAliveBypassNativeFirstPaintPlaceholder =
        isWarmKeepAliveInstance &&
        !nativeWarmFirstPaintDistanceAppearsOffBottom;
    const shouldHoldNativeFirstPaintPlaceholder =
        !nativeViewportPaintObserved &&
        !nativeEntryRestorePaintReleased &&
        (
            (
                !nativeMountSettleStable &&
                !nativeMountSettleDeadlineReached &&
                (!firstListPaintObserved || shouldHoldNativeFirstPaintPlaceholderForMountSettle)
            ) ||
            shouldHoldNativeFirstPaintPlaceholderForPendingViewport
        );
    const showNativeFirstPaintPlaceholder =
        Platform.OS !== 'web' &&
        listImplementation === 'flash_v2' &&
        props.isLoaded &&
        listData.length > 0 &&
        !canWarmKeepAliveBypassNativeFirstPaintPlaceholder &&
        shouldHoldNativeFirstPaintPlaceholder;
    const showWebMarkdownRuntimeFirstPaintPlaceholder =
        Platform.OS === 'web' &&
        listImplementation === 'flash_v2' &&
        props.isLoaded &&
        listData.length > 0 &&
        !firstListPaintObserved &&
        !webMarkdownRuntimeReady;
    const showRouteHydrationFirstPaintPlaceholder =
        props.routeHydrationPending === true &&
        props.isLoaded &&
        listData.length > 0;
    const showFirstPaintPlaceholder =
        showNativeFirstPaintPlaceholder ||
        showWebMarkdownRuntimeFirstPaintPlaceholder ||
        showRouteHydrationFirstPaintPlaceholder;
    const nativeFirstPaintReleasedWithoutListLoad =
        Platform.OS !== 'web' &&
        listImplementation === 'flash_v2' &&
        (nativeMountSettleStable || nativeMountSettleDeadlineReached);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (listImplementation !== 'flash_v2') return;
        if (firstListPaintObserved) return;
        if (!props.isLoaded) return;
        if (listData.length <= 0) return;
        if (showRouteHydrationFirstPaintPlaceholder) return;
        if (!resolveEffectiveListPaintMetrics()) return;

        recordFirstListPaint();
    }, [
        firstListPaintObserved,
        listContentHeight,
        listData.length,
        listImplementation,
        listLayoutHeight,
        props.isLoaded,
        recordFirstListPaint,
        resolveEffectiveListPaintMetrics,
        showRouteHydrationFirstPaintPlaceholder,
    ]);
    React.useEffect(() => {
        if (!props.isLoaded) return;
        if (listData.length <= 0) return;
        if (showFirstPaintPlaceholder) return;
        if (
            !firstListPaintObserved &&
            !isWarmKeepAliveInstance &&
            !nativeFirstPaintReleasedWithoutListLoad &&
            !nativeEntryRestorePaintReleased &&
            !nativeViewportPaintObserved &&
            !nativeViewportPaintObservedRef.current
        ) {
            return;
        }
        const paintMetrics = resolveEffectiveListPaintMetrics();
        if (!paintMetrics) {
            scheduleWebStablePaintRetry();
            return;
        }
        if (
            Platform.OS === 'web' &&
            sessionEntryViewportRef.current?.shouldFollowBottom !== false &&
            paintMetrics.distanceFromBottom > pinThresholdPx
        ) {
            scheduleWebStablePaintRetry();
            return;
        }
        recordStablePaintTelemetry(paintMetrics, {
            nativeViewportObserved: nativeViewportPaintObserved || nativeViewportPaintObservedRef.current,
        });
    }, [
        firstListPaintObserved,
        listContentHeight,
        listData.length,
        listLayoutHeight,
        nativeFirstPaintReleasedWithoutListLoad,
        nativeEntryRestorePaintReleased,
        nativeMountSettleDeadlineReached,
        nativeMountSettleStable,
        nativeViewportPaintObserved,
        props.committedMessagesCount,
        props.isLoaded,
        props.routeHydrationPending,
        props.sessionId,
        isWarmKeepAliveInstance,
        pinThresholdPx,
        recordStablePaintTelemetry,
        resolveEffectiveListPaintMetrics,
        scheduleWebStablePaintRetry,
        shouldUseWebHotColdSplit,
        showFirstPaintPlaceholder,
        transcriptHotColdSegments.coldItems.length,
        transcriptHotColdSegments.hotItems.length,
        webStablePaintRetryTick,
    ]);
    const wrapTranscriptItemForAnchor = React.useCallback((item: ChatTranscriptListItem, node: React.ReactNode) => {
        const signature = buildRowShellSignature(item);
        return (
            <TranscriptRowShell
                cache={rowShellHeightCache}
                item={item}
                signature={signature}
            >
                {node}
            </TranscriptRowShell>
        );
    }, [buildRowShellSignature, rowShellHeightCache]);

    const captureCurrentWebPrependAnchor = React.useCallback(() => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return null;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return null;
        if (!isWebTranscriptScrollable(metrics, 1)) return null;
        if (getWebTranscriptDistanceFromBottom(metrics) <= pinThresholdPx) return null;
        const tuning = sync.getSyncTuning();
        const anchor = captureWebTranscriptPrependAnchor({
            metrics,
            userIntentAtMs: lastUserScrollIntentAtMsRef.current,
            stabilizeForMs: tuning.transcriptWebInitialPinStabilizeMs,
        });
        return anchor;
    }, [listImplementation, pinThresholdPx, resolveWebScrollMetrics]);

    /**
     * Plan E2: every web prepend restore outcome (anchor/item restore, growth fallback,
     * not-found) is telemetered as a restore decision (existing reasons only; no behavior
     * change). Growth fallbacks report mode 'restore-distance' so they are distinguishable
     * from anchor/item restores; intermediate outcomes use non-transaction reasons so native
     * invariant-D outcome counting stays unaffected.
     */
    const recordWebPrependRestoreOutcome = React.useCallback((
        result: Readonly<{ didAdjustScroll: boolean; strategy: 'anchor' | 'item' | 'growth' | 'none' }>,
    ) => {
        if (Platform.OS !== 'web') return;
        if (result.strategy === 'growth') {
            recordRestoreDecisionTelemetry('restored', { mode: 'restore-distance' });
            return;
        }
        if (result.strategy === 'none') {
            recordRestoreDecisionTelemetry('not-ready', { mode: 'restore-anchor' });
            return;
        }
        recordRestoreDecisionTelemetry(result.didAdjustScroll ? 'restored' : 'observed', { mode: 'restore-anchor' });
    }, [recordRestoreDecisionTelemetry]);

    const clearNativePrependQuietState = React.useCallback(() => {
        nativePrependQuietGateRef.current = null;
        const quietTimer = nativePrependQuietTimerRef.current;
        if (quietTimer != null) {
            nativePrependQuietTimerRef.current = null;
            clearTimeout(quietTimer);
        }
    }, []);

    const finishNativePrependTransaction = React.useCallback((transaction: PrependTransaction) => {
        if (nativePrependTransactionRef.current === transaction) {
            nativePrependTransactionRef.current = null;
        }
        nativePrependCommitArmedRef.current = false;
        clearNativePrependQuietState();
        const layoutTimeout = nativePrependLayoutTimeoutRef.current;
        if (layoutTimeout != null) {
            nativePrependLayoutTimeoutRef.current = null;
            clearTimeout(layoutTimeout);
        }
        const outcome = transaction.outcome() ?? 'abandoned-identity';
        const controller = viewportControllerRef.current;
        if (controller && controller.activeOwner() === 'prepend') {
            controller.closeTransaction('prepend', outcome);
        }
        // Every prepend outcome is telemetered (invariant D: never silent), attributed to the
        // transaction's own session even when disposal happens during a session switch.
        // Session-explicit pattern (W2.2 deviation note): gate on tuning here and split
        // dev/prod recording; never call the configure-from-tuning recorder standalone.
        const tuning = sync.getSyncTuning();
        if (tuning.transcriptViewportTelemetryEnabled === true) {
            const telemetryEvent = {
                type: 'restore-decision' as const,
                mode: 'restore-anchor' as const,
                reason: outcome,
                sessionId: transaction.sessionId,
                platform: telemetryPlatform,
                listImplementation: telemetryListImplementation,
                timestampMs: Date.now(),
                anchorItemOffsetPx: transaction.capturedAnchor.itemOffsetPx,
            };
            if (typeof __DEV__ !== 'undefined' && __DEV__ === true) {
                recordTranscriptViewportTelemetryEvent(telemetryEvent, tuning);
            } else {
                transcriptViewportTelemetry.record(telemetryEvent);
            }
        }
        bumpNativePrependTransactionRevision();
    }, [clearNativePrependQuietState, telemetryListImplementation, telemetryPlatform]);

    const invalidateNativePrependTransaction = React.useCallback(() => {
        const transaction = nativePrependTransactionRef.current;
        if (!transaction) return;
        if (!transaction.isClosed()) {
            transaction.onCaptureInvalidated();
        }
        finishNativePrependTransaction(transaction);
    }, [finishNativePrependTransaction]);
    invalidateNativePrependTransactionRef.current = invalidateNativePrependTransaction;

    const beginNativePrependTransaction = React.useCallback((): PrependTransaction | null => {
        if (Platform.OS === 'web' || listImplementation !== 'flash_v2') return null;
        if (wantsPinnedRef.current) return null;
        // Entry restore owns the viewport during materialization loads (LA-R contract):
        // MVCP alone holds position; the entry transaction places the viewport afterwards.
        if (viewportControllerRef.current?.activeOwner() === 'entry') return null;
        const layoutHeight = listLayoutHeightRef.current;
        const contentHeight = listContentHeightRef.current;
        if (!Number.isFinite(layoutHeight) || layoutHeight <= 0) return null;
        if (!Number.isFinite(contentHeight) || contentHeight <= layoutHeight + 1) return null;

        const result = captureNativeTranscriptViewportAnchor({
            ref: listRef.current,
            data: listDataRef.current,
            focusOffsetPx: resolveTranscriptViewportAnchorFocusOffsetPx(layoutHeight),
            capturedAtMs: Date.now(),
            resolveAnchor: (item) => resolveTranscriptViewportAnchorDescriptor(item),
        });
        if (result.status !== 'captured') return null;
        // LC-R capture hardening: a non-finite captured offset can never produce a conclusive
        // observation, so skip creating a transaction at all.
        if (!Number.isFinite(result.anchor.itemOffsetPx)) return null;
        const anchorItemId = result.anchor.itemId;
        if (typeof anchorItemId !== 'string' || anchorItemId.length === 0) return null;
        const capturedAnchor: PrependCapturedAnchor = {
            key: { itemId: anchorItemId, messageId: result.anchor.messageId ?? null },
            itemOffsetPx: result.anchor.itemOffsetPx,
            capturedDataLength: listDataRef.current.length,
            capturedFirstItemId: typeof listDataRef.current[0]?.id === 'string'
                ? listDataRef.current[0].id
                : null,
        };

        invalidateNativePrependTransaction();
        const transaction = createPrependTransaction({ sessionId: props.sessionId, capturedAnchor });
        nativePrependTransactionRef.current = transaction;
        nativePrependCommitArmedRef.current = false;
        nativePrependQuietGateRef.current = createPrependFallbackQuietGate();
        return transaction;
    }, [invalidateNativePrependTransaction, listImplementation, props.sessionId]);

    const computeNativePrependObservation = React.useCallback((transaction: PrependTransaction): PrependOutcome => {
        const node = listRef.current;
        const absoluteScrollOffset = (() => {
            try {
                const value = node?.getAbsoluteLastScrollOffset?.();
                return typeof value === 'number' ? value : Number.NaN;
            } catch {
                return Number.NaN;
            }
        })();
        return observePrependOutcome({
            capturedAnchor: transaction.capturedAnchor,
            postCommit: {
                items: listDataRef.current,
                getLayout: (index: number) => {
                    try {
                        return node?.getLayout?.(index) ?? undefined;
                    } catch {
                        return undefined;
                    }
                },
                absoluteScrollOffset,
                contentHeight: listContentHeightRef.current,
                layoutHeight: listLayoutHeightRef.current,
            },
        });
    }, []);

    const forwardNativePrependObservation = React.useCallback((
        transaction: PrependTransaction,
        outcome: PrependOutcome,
    ) => {
        const write = transaction.onObservationWindow(outcome);
        if (write) {
            // Execute the single fallback against the same live snapshot the observation came
            // from (LC-R #7); the prepend phase is open, so the seam accepts owner='prepend'.
            executeViewportCommand(resolveViewportCommand({
                type: 'scroll-offset',
                sessionId: transaction.sessionId,
                reason: 'prepend-restore',
                mode: 'restore-anchor',
                offsetY: write.write.targetOffsetY,
                animated: false,
            }));
        }
    }, [executeViewportCommand, resolveViewportCommand]);

    const observeNativePrependTransaction = React.useCallback(() => {
        if (Platform.OS === 'web' || listImplementation !== 'flash_v2') return;
        const transaction = nativePrependTransactionRef.current;
        if (!transaction) return;
        if (transaction.sessionId !== props.sessionId) {
            invalidateNativePrependTransaction();
            return;
        }
        if (transaction.isClosed()) {
            finishNativePrependTransaction(transaction);
            return;
        }
        if (transaction.state() === 'awaiting-commit') {
            if (!nativePrependCommitArmedRef.current) return;
            // Commit once the prepended page is reflected in the rendered items (LC-R #2):
            // the prepend ownership phase opens here, bounded by ONE post-commit layout timeout.
            transaction.onCommit();
            const controller = viewportControllerRef.current;
            if (controller) {
                const openResult = controller.openTransaction('prepend');
                if (!openResult.opened) {
                    transaction.onCaptureInvalidated();
                    finishNativePrependTransaction(transaction);
                    return;
                }
            }
            bumpNativePrependTransactionRevision();
            const tuning = sync.getSyncTuning();
            const { budgetMs } = resolveTranscriptInitialFillTuning({
                transcriptInitialFillBudgetMs: tuning.transcriptInitialFillBudgetMs,
                transcriptInitialFillMaxNoProgressLoads: tuning.transcriptInitialFillMaxNoProgressLoads,
            });
            nativePrependLayoutTimeoutRef.current = setTimeout(() => {
                nativePrependLayoutTimeoutRef.current = null;
                const current = nativePrependTransactionRef.current;
                if (current !== transaction || transaction.isClosed()) return;
                // Plan P1: the deadline bounds the layout-quiet wait. If a conclusive
                // observation exists at the deadline, spend it (write-once: fallback-restored
                // or mvcp-preserved) instead of abandoning the reading position.
                const finalOutcome = computeNativePrependObservation(transaction);
                if (finalOutcome.kind === 'mvcp-preserved' || finalOutcome.kind === 'needs-fallback') {
                    forwardNativePrependObservation(transaction, finalOutcome);
                }
                if (!transaction.isClosed()) {
                    transaction.onLayoutTimeout();
                }
                finishNativePrependTransaction(transaction);
            }, budgetMs);
        }
        if (transaction.state() !== 'committed') return;
        const outcome = computeNativePrependObservation(transaction);
        if (outcome.kind === 'needs-fallback') {
            // Layout-quiet gate (plan P1): FlashList's own MVCP correction applies
            // asynchronously — withhold the single fallback until the misalignment is stable
            // across one quiet window, re-observing on a single re-armed timer. The post-commit
            // layout timeout above bounds the whole wait.
            const gate = nativePrependQuietGateRef.current ?? createPrependFallbackQuietGate();
            nativePrependQuietGateRef.current = gate;
            const decision = gate.onMisalignedObservation({
                observedItemOffsetPx: transaction.capturedAnchor.itemOffsetPx + outcome.deltaPx,
                nowMs: Date.now(),
            });
            if (decision.kind === 'wait') {
                const previousTimer = nativePrependQuietTimerRef.current;
                if (previousTimer != null) clearTimeout(previousTimer);
                nativePrependQuietTimerRef.current = setTimeout(() => {
                    nativePrependQuietTimerRef.current = null;
                    observeNativePrependTransactionRef.current();
                }, decision.reobserveInMs);
                return;
            }
        }
        forwardNativePrependObservation(transaction, outcome);
        if (transaction.isClosed()) {
            finishNativePrependTransaction(transaction);
        }
        // Non-conclusive outcomes (layout-not-ready / identity-unchanged) keep the single
        // window open; the host re-observes on the next layout/content/scroll event.
    }, [
        computeNativePrependObservation,
        finishNativePrependTransaction,
        forwardNativePrependObservation,
        invalidateNativePrependTransaction,
        listImplementation,
        props.sessionId,
    ]);
    observeNativePrependTransactionRef.current = observeNativePrependTransaction;

    const captureCurrentViewportAnchor = React.useCallback((): SessionViewportAnchorSnapshot | null => {
        if (wantsPinnedRef.current) return null;

        const capturedAtMs = Date.now();
        if (Platform.OS === 'web' && listImplementation === 'flash_v2') {
            const metrics = resolveWebScrollMetrics();
            if (!metrics) return null;
            const anchor = captureWebTranscriptViewportAnchor({ container: metrics.element });
            if (!anchor) return null;
            return {
                ...anchor,
                capturedAtMs,
            };
        }

        if (Platform.OS !== 'web' && listImplementation === 'flash_v2') {
            const result = captureNativeTranscriptViewportAnchor({
                ref: listRef.current,
                data: listDataRef.current,
                focusOffsetPx: resolveTranscriptViewportAnchorFocusOffsetPx(listLayoutHeightRef.current),
                capturedAtMs,
                resolveAnchor: (item) => resolveTranscriptViewportAnchorDescriptor(item),
            });
            return result.status === 'captured' ? result.anchor : null;
        }

        return null;
    }, [listImplementation, resolveWebScrollMetrics]);

    /**
     * Anchor-capture telemetry (plan P2) with an EXPLICIT session id: exit flushes run for the
     * exiting session after props already point at the next one. Mirrors
     * `recordViewportTelemetryEvent`'s tuning gate and dev/prod record split.
     */
    const recordAnchorCaptureTelemetryEvent = React.useCallback((event: Readonly<{
        sessionId: string;
        reason: 'anchor-captured' | 'anchor-capture-empty' | 'anchor-capture-dropped';
        distanceFromBottom?: number;
        anchorItemOffsetPx?: number;
    }>) => {
        const tuning = sync.getSyncTuning();
        if (tuning.transcriptViewportTelemetryEnabled !== true) return;
        const telemetryEvent = {
            type: 'anchor-capture',
            mode: 'user-unpinned',
            ...event,
            platform: telemetryPlatform,
            listImplementation: telemetryListImplementation,
            timestampMs: Date.now(),
        };
        if (typeof __DEV__ !== 'undefined' && __DEV__ === true) {
            recordTranscriptViewportTelemetryEvent(telemetryEvent, tuning);
            return;
        }
        transcriptViewportTelemetry.record(telemetryEvent);
    }, [telemetryListImplementation, telemetryPlatform]);

    const emitViewportAnchorCapture = React.useCallback((
        state: TranscriptViewportChangeState,
        generation: number,
        wantsPinned: boolean,
        emit: ((nextState: TranscriptViewportChangeState) => void) | undefined,
        captureAnchor: () => SessionViewportAnchorSnapshot | null,
        sessionId: string,
    ) => {
        const recordCaptureOutcome = (
            reason: 'anchor-captured' | 'anchor-capture-empty' | 'anchor-capture-dropped',
            anchorItemOffsetPx?: number,
        ) => {
            recordAnchorCaptureTelemetryEvent({
                sessionId,
                reason,
                distanceFromBottom: typeof state.offsetY === 'number' ? state.offsetY : undefined,
                anchorItemOffsetPx,
            });
        };
        if (viewportAnchorCaptureGenerationRef.current !== generation) {
            recordCaptureOutcome('anchor-capture-dropped');
            return;
        }
        // Session guard (plan A3): a capture scheduled for session A must never run against
        // session B's mounted list/data — it would write B's anchor into A's viewport memory.
        // Exit flushes happen synchronously in the session-entry render block, before the
        // current-session ref flips, so legitimate flushes pass this guard.
        if (sessionId !== currentSessionIdRef.current) {
            recordCaptureOutcome('anchor-capture-dropped');
            return;
        }
        if (state.shouldRestoreViewport !== true || state.isPinned === true || wantsPinned) {
            recordCaptureOutcome('anchor-capture-dropped');
            return;
        }

        const anchor = captureAnchor();
        recordCaptureOutcome(
            anchor ? 'anchor-captured' : 'anchor-capture-empty',
            anchor?.itemOffsetPx,
        );
        emit?.({
            ...state,
            anchor,
        });
    }, [recordAnchorCaptureTelemetryEvent]);

    const scheduleViewportAnchorCapture = React.useCallback((
        state: TranscriptViewportChangeState,
        options?: Readonly<{ suppressAnchorCapture?: boolean }>,
    ) => {
        if (options?.suppressAnchorCapture === true) {
            // Plan P2: an unattributable (churn) frame must not initiate or refresh a capture,
            // but it no longer destroys a pending user-attributed capture — the debounced
            // capture re-reads the anchor from the live list at fire time, so it stays
            // truthful even when churn moves content in between.
            return;
        }

        if (state.shouldRestoreViewport !== true || state.isPinned === true) {
            viewportAnchorCaptureGenerationRef.current += 1;
            cancelScheduledViewportAnchorCapture();
            return;
        }

        const debounceMs = sync.getSyncTuning().transcriptViewportAnchorCaptureDebounceMs;
        const captureAnchor = captureCurrentViewportAnchor;
        const dueAtMs = Date.now() + debounceMs;
        const emit = onViewportChangeRef.current;
        const generation = viewportAnchorCaptureGenerationRef.current;
        const sessionId = currentSessionIdRef.current;
        const wantsPinned = wantsPinnedRef.current;
        const existing = scheduledViewportAnchorCaptureRef.current;
        if (existing && existing.generation === generation && existing.sessionId === sessionId) {
            existing.captureAnchor = captureAnchor;
            existing.dueAtMs = dueAtMs;
            existing.emit = emit;
            existing.state = state;
            existing.wantsPinned = wantsPinned;
            return;
        }
        cancelScheduledViewportAnchorCapture();
        const armTimeout = (delayMs: number): ReturnType<typeof setTimeout> => {
            const timeoutId = setTimeout(() => {
                const scheduled = scheduledViewportAnchorCaptureRef.current;
                if (!scheduled || scheduled.timeoutId !== timeoutId) return;
                const remainingMs = scheduled.dueAtMs - Date.now();
                if (remainingMs > 0) {
                    scheduled.timeoutId = armTimeout(remainingMs);
                    return;
                }
                scheduledViewportAnchorCaptureRef.current = null;
                emitViewportAnchorCapture(
                    scheduled.state,
                    scheduled.generation,
                    scheduled.wantsPinned,
                    scheduled.emit,
                    scheduled.captureAnchor,
                    scheduled.sessionId,
                );
            }, Math.max(0, delayMs));
            return timeoutId;
        };
        const timeoutId = armTimeout(debounceMs);
        scheduledViewportAnchorCaptureRef.current = { captureAnchor, dueAtMs, emit, generation, sessionId, state, timeoutId, wantsPinned };
    }, [cancelScheduledViewportAnchorCapture, captureCurrentViewportAnchor, emitViewportAnchorCapture]);

    const flushScheduledViewportAnchorCapture = React.useCallback((options?: Readonly<{ deferEmit?: boolean }>) => {
        const scheduled = scheduledViewportAnchorCaptureRef.current;
        if (!scheduled) return;
        scheduledViewportAnchorCaptureRef.current = null;
        clearTimeout(scheduled.timeoutId);
        if (scheduled.generation !== viewportAnchorCaptureGenerationRef.current) return;
        // Session guard (plan A3): only flush a capture that still belongs to the session the
        // refs currently point at; otherwise drop it instead of polluting another session.
        if (scheduled.sessionId !== currentSessionIdRef.current) return;
        if (scheduled.state.shouldRestoreViewport !== true || scheduled.state.isPinned === true || scheduled.wantsPinned) {
            return;
        }
        // Capture against the still-mounted list synchronously; the render-phase exit flush
        // defers only the emit so it never writes to the sync store mid-render.
        const anchor = scheduled.captureAnchor();
        recordAnchorCaptureTelemetryEvent({
            sessionId: scheduled.sessionId,
            reason: anchor ? 'anchor-captured' : 'anchor-capture-empty',
            distanceFromBottom: typeof scheduled.state.offsetY === 'number' ? scheduled.state.offsetY : undefined,
            anchorItemOffsetPx: anchor?.itemOffsetPx,
        });
        const emit = scheduled.emit;
        const state = scheduled.state;
        if (options?.deferEmit === true) {
            queueMicrotask(() => {
                emit?.({ ...state, anchor });
            });
            return;
        }
        emit?.({ ...state, anchor });
    }, [recordAnchorCaptureTelemetryEvent]);

    React.useLayoutEffect(() => {
        flushViewportAnchorCaptureRef.current = flushScheduledViewportAnchorCapture;
    }, [flushScheduledViewportAnchorCapture]);
    scheduleViewportAnchorCaptureRef.current = scheduleViewportAnchorCapture;

    /**
     * Exit-flush live-tail intent (plan P3): on navigation away/unmount, when the viewport
     * visibly sits within the pin threshold of the bottom, persist an explicit live-tail
     * report ({isPinned:true, shouldRestoreViewport:false}) for the exiting session. The B8
     * arrival emission only fires on trusted arrivals — passive settles and swallowed
     * momentum tails leave the stored viewport unpinned, which reopens slightly above the
     * bottom and poisons catch-up. The report intentionally bypasses the sync seam's
     * observed-unpinned preserve branch (shouldRestoreViewport:false routes straight to
     * markSessionLiveTailIntent): exit-time bottom is a deliberate, deterministic signal.
     */
    const flushExitLiveTailIntent = React.useCallback((options?: Readonly<{ deferEmit?: boolean }>) => {
        if (Platform.OS === 'web' || listImplementation !== 'flash_v2') return;
        // Real navigation detaches the list ref before the passive unmount cleanup runs —
        // fall back to the last observed distance (kept honest by the passive bottom-arrival
        // branch) when the live read is unavailable.
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
    }, [listImplementation, pinThresholdPx, readCurrentNativeDistanceFromBottom]);
    React.useLayoutEffect(() => {
        flushExitLiveTailIntentRef.current = flushExitLiveTailIntent;
    }, [flushExitLiveTailIntent]);

    const refreshInFlightWebPrependAnchor = React.useCallback((options?: Readonly<{ userScrolledDuringLoad?: boolean }>) => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return;
        if (options?.userScrolledDuringLoad !== true) return;
        const currentAnchor = inFlightWebPrependAnchorRef.current;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return;
        if (!isWebTranscriptScrollable(metrics, 1)) return;
        if (!currentAnchor) {
            inFlightWebPrependAnchorRef.current = captureCurrentWebPrependAnchor();
            return;
        }
        inFlightWebPrependAnchorRef.current = refreshWebTranscriptPrependAnchor(currentAnchor, {
            ...metrics,
            scrollHeight: currentAnchor.metrics.scrollHeight,
        }, {
            recaptureAnchor: true,
            userIntentAtMs: lastUserScrollIntentAtMsRef.current,
        });
    }, [captureCurrentWebPrependAnchor, listImplementation, resolveWebScrollMetrics]);

    // G-1 late-RD delta: a trusted user scroll AFTER the prepend commit retargets the
    // pending web anchor to the user's new position so a later growth restore preserves
    // THAT viewport instead of yanking back to the stale capture.
    const retargetPendingWebPrependAnchorForUserScroll = React.useCallback(() => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return;
        const pendingAnchor = pendingWebPrependAnchorRef.current;
        if (!pendingAnchor) return;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return;
        if (!isWebTranscriptScrollable(metrics, 1)) return;
        pendingWebPrependAnchorRef.current = refreshWebTranscriptPrependAnchor(pendingAnchor, metrics, {
            recaptureAnchor: true,
            resetExpiry: true,
            userIntentAtMs: lastUserScrollIntentAtMsRef.current,
        });
        pendingWebPrependIndexRecoveryRef.current = false;
    }, [listImplementation, resolveWebScrollMetrics]);

    const resolvePendingWebPrependRefreshOptions = React.useCallback((strategy: 'anchor' | 'item' | 'growth' | 'none') => {
        if (strategy === 'anchor') {
            return { recaptureAnchor: true, recaptureItem: true } as const;
        }
        if (strategy === 'item') {
            return { recaptureItem: true } as const;
        }
        return { preserveBaselineMetrics: true } as const;
    }, []);

    const updateWebPrependRangeReserve = React.useCallback((
        anchor: WebTranscriptPrependAnchor | null,
        metrics: Readonly<{ scrollHeight: number }> | null,
    ) => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2' || !anchor || !metrics) {
            clearWebPrependRangeReserve();
            return;
        }
        const nextReserve = resolveWebTranscriptPrependRangeReservePx({
            baselineScrollHeight: anchor.metrics.scrollHeight,
            currentScrollHeight: metrics.scrollHeight,
        });
        setWebPrependRangeReservePx((previous) => previous === nextReserve ? previous : nextReserve);
    }, [clearWebPrependRangeReserve, listImplementation]);

    const resolvePendingWebPrependItemIndex = React.useCallback((itemTestId: string | null): number | null => {
        if (!itemTestId?.startsWith(TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX)) return null;
        const itemId = itemTestId.slice(TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX.length);
        const index = itemsRef.current.findIndex((item) => item.id === itemId);
        return index >= 0 ? index : null;
    }, []);

    const resolvePendingWebPrependAnchorIndex = React.useCallback((anchorTestId: string | null): number | null => {
        let anchorMessageId: string | null = null;
        if (anchorTestId?.startsWith(TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX)) {
            anchorMessageId = anchorTestId.slice(TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX.length);
        } else if (anchorTestId?.startsWith(TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX)) {
            anchorMessageId = anchorTestId.slice(TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX.length);
        } else if (anchorTestId?.startsWith(TRANSCRIPT_WEB_TOOL_CALL_PREPEND_ANCHOR_TEST_ID_PREFIX)) {
            anchorMessageId = anchorTestId.slice(TRANSCRIPT_WEB_TOOL_CALL_PREPEND_ANCHOR_TEST_ID_PREFIX.length);
        }
        if (!anchorMessageId) return null;

        const index = itemsRef.current.findIndex((item) => {
            if (item.kind === 'message') {
                return item.messageId === anchorMessageId;
            }
            if (item.kind === 'tool-calls-group') {
                return item.toolMessageIds.includes(anchorMessageId);
            }
            if (item.kind === 'turn') {
                if (item.turn.userMessageId === anchorMessageId) return true;
                return item.turn.content.some((content) => {
                    if (content.kind === 'message') {
                        return content.messageId === anchorMessageId;
                    }
                    if (content.kind === 'tool_calls') {
                        return content.toolMessageIds.includes(anchorMessageId);
                    }
                    return false;
                });
            }
            return false;
        });

        return index >= 0 ? index : null;
    }, []);

    const resolvePendingWebPrependRecoveryIndex = React.useCallback((pendingAnchor: WebTranscriptPrependAnchor | null): number | null => {
        if (!pendingAnchor) return null;
        return resolvePendingWebPrependAnchorIndex(pendingAnchor.anchorTestId) ?? resolvePendingWebPrependItemIndex(pendingAnchor.itemTestId);
    }, [resolvePendingWebPrependAnchorIndex, resolvePendingWebPrependItemIndex]);

    const tryScrollPendingWebPrependItemIntoView = React.useCallback((pendingAnchor: WebTranscriptPrependAnchor | null): boolean => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return false;
        const index = resolvePendingWebPrependRecoveryIndex(pendingAnchor);
        if (index == null) return false;
        return executeViewportCommand(resolveViewportCommand({
            type: 'restore-anchor',
            sessionId: props.sessionId,
            reason: 'prepend-restore',
            index,
            animated: false,
        }));
    }, [
        executeViewportCommand,
        listImplementation,
        props.sessionId,
        resolvePendingWebPrependRecoveryIndex,
        resolveViewportCommand,
    ]);

    const attemptPendingWebPrependIndexRecovery = React.useCallback((): boolean => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return false;
        if (!pendingWebPrependIndexRecoveryRef.current || !pendingWebPrependAnchorRef.current) return false;
        const scheduleRetry = () => {
            if (scheduledWebPrependIndexRecoveryRef.current) return;
            const handle: { kind: 'timeout'; ids: any[] } = { kind: 'timeout', ids: [] };
            scheduledWebPrependIndexRecoveryRef.current = handle;
            const timeoutId = setTimeout(() => {
                if (scheduledWebPrependIndexRecoveryRef.current !== handle) return;
                scheduledWebPrependIndexRecoveryRef.current = null;
                attemptPendingWebPrependIndexRecovery();
            }, 16);
            handle.ids.push(timeoutId);
        };
        const didRecoverIndex = tryScrollPendingWebPrependItemIntoView(pendingWebPrependAnchorRef.current);
        if (!didRecoverIndex) {
            if (Date.now() <= pendingWebPrependAnchorRef.current.expiresAtMs) {
                scheduleRetry();
            } else {
                pendingWebPrependIndexRecoveryRef.current = false;
                clearWebPrependRangeReserve();
                // Plan E2: recovery window expired without remounting the anchor row.
                recordRestoreDecisionTelemetry('skipped', { mode: 'restore-anchor' });
            }
            return false;
        }

        pendingWebPrependIndexRecoveryRef.current = false;
        const retryAnchor = pendingWebPrependAnchorRef.current;
        const retryRestoreResult = restoreWebPrependAnchorThroughViewportCommand(retryAnchor);
        recordWebPrependRestoreOutcome(retryRestoreResult);
        const retryMetrics = resolveWebScrollMetrics();
        if (!retryMetrics) {
            pendingWebPrependAnchorRef.current = null;
            clearWebPrependRangeReserve();
            return true;
        }
        updateWebPrependRangeReserve(retryAnchor, retryMetrics);
        pendingWebPrependAnchorRef.current = refreshWebTranscriptPrependAnchor(
            retryAnchor,
            retryMetrics,
            resolvePendingWebPrependRefreshOptions(retryRestoreResult.strategy),
        );
        if (
            (retryRestoreResult.strategy === 'growth' || retryRestoreResult.strategy === 'none') &&
            pendingWebPrependAnchorRef.current &&
            Date.now() <= pendingWebPrependAnchorRef.current.expiresAtMs
        ) {
            pendingWebPrependIndexRecoveryRef.current = true;
            scheduleRetry();
        }
        return true;
    }, [
        listImplementation,
        recordRestoreDecisionTelemetry,
        recordWebPrependRestoreOutcome,
        resolvePendingWebPrependRefreshOptions,
        resolveWebScrollMetrics,
        restoreWebPrependAnchorThroughViewportCommand,
        tryScrollPendingWebPrependItemIntoView,
        updateWebPrependRangeReserve,
        clearWebPrependRangeReserve,
    ]);

    const schedulePendingWebPrependIndexRecovery = React.useCallback(() => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return;
        const scheduledRecovery = scheduledWebPrependIndexRecoveryRef.current;
        if (scheduledRecovery) return;

        if (typeof requestAnimationFrame === 'function') {
            const handle: { kind: 'raf'; ids: any[] } = { kind: 'raf', ids: [] };
            scheduledWebPrependIndexRecoveryRef.current = handle;
            const first = requestAnimationFrame(() => {
                const second = requestAnimationFrame(() => {
                    if (scheduledWebPrependIndexRecoveryRef.current !== handle) return;
                    scheduledWebPrependIndexRecoveryRef.current = null;
                    attemptPendingWebPrependIndexRecovery();
                });
                handle.ids.push(second);
            });
            handle.ids.push(first);
            return;
        }

        const handle: { kind: 'timeout'; ids: any[] } = { kind: 'timeout', ids: [] };
        scheduledWebPrependIndexRecoveryRef.current = handle;
        const timeoutId = setTimeout(() => {
            if (scheduledWebPrependIndexRecoveryRef.current !== handle) return;
            scheduledWebPrependIndexRecoveryRef.current = null;
            attemptPendingWebPrependIndexRecovery();
        }, 0);
        handle.ids.push(timeoutId);
    }, [attemptPendingWebPrependIndexRecovery, listImplementation]);

      const renderItem = useCallback(({ item, index }: { item: ChatTranscriptListItem; index: number }) => {
          if (item.kind === 'action-draft') {
              return wrapTranscriptItemForAnchor(item, <SessionActionDraftCard sessionId={props.sessionId} draft={item.draft} />);
          }
        if (item.kind === 'fork-divider') {
            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper id={item.id} createdAt={0}>
                    <ForkDividerRow
                        parentSessionId={item.parentSessionId}
                        childSessionId={item.childSessionId}
                        parentCutoffSeqInclusive={item.parentCutoffSeqInclusive}
                    />
                </TranscriptEnterWrapper>
            ));
        }
        if (item.kind === 'pending-queue') {
            const createdAt = item.pendingMessages[0]?.createdAt ?? item.discardedMessages[0]?.createdAt ?? 0;
            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper id={item.id} createdAt={createdAt}>
                    <PendingMessagesTranscriptBlock
                        sessionId={props.sessionId}
                        pendingMessages={item.pendingMessages}
                        discardedMessages={item.discardedMessages}
                        onEditPendingMessage={props.onEditPendingMessage}
                    />
                </TranscriptEnterWrapper>
            ));
        }
        if (item.kind === 'tool-calls-group') {
            return wrapTranscriptItemForAnchor(item, (
                <ToolCallsGroupRowWithSessionCommon
                    sessionId={props.sessionId}
                    toolCallsGroupId={item.id}
                    toolMessageIds={item.toolMessageIds}
                    metadata={props.metadata}
                    expanded={item.toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id))}
                    onSetExpanded={setToolCallsGroupExpanded}
                    interaction={props.interaction}
                    approvalRequests={props.approvalRequests}
                    forkCommon={props.forkCommon}
                    messageDisplayCommon={props.messageDisplayCommon}
                    toolChromeCommon={props.toolChromeCommon}
                    toolRouteCommon={toolRouteCommonRef.current}
                />
            ));
        }
        if (item.kind === 'turn') {
            const turnCreatedAt =
                (item.turn.userMessageId ? resolveCreatedAtForMessageId(item.turn.userMessageId) : null) ??
                (item.turn.content[0]?.kind === 'message'
                    ? resolveCreatedAtForMessageId(item.turn.content[0].messageId)
                    : item.turn.content[0]?.kind === 'tool_calls'
                        ? (item.turn.content[0].toolMessageIds[0]
                            ? resolveCreatedAtForMessageId(item.turn.content[0].toolMessageIds[0])
                            : null)
                        : null) ??
                0;
            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper id={item.id} createdAt={turnCreatedAt}>
                    <TurnViewWithSessionCommon
                        turn={item.turn}
                        metadata={props.metadata}
                        sessionId={props.sessionId}
                        interaction={props.interaction}
                        activeThinkingMessageId={props.activeThinkingMessageId}
                        approvalRequests={props.approvalRequests}
                        getMessageById={getTurnMessageById}
                        rollbackRanges={props.rollbackRanges}
                        resolveRollbackAction={resolveRollbackActionForMessage}
                        resolveThinkingExpanded={resolveThinkingExpanded}
                        setThinkingExpanded={setThinkingExpanded}
                        expandedToolCallsAnchorMessageIds={expandedToolCallsAnchorMessageIds}
                        setToolCallsGroupExpanded={setToolCallsGroupExpanded}
                        forkCommon={props.forkCommon}
                        messageDisplayCommon={props.messageDisplayCommon}
                        toolChromeCommon={props.toolChromeCommon}
                        toolRouteCommon={toolRouteCommonRef.current}
                    />
                </TranscriptEnterWrapper>
            ));
        }
        if (item.kind === 'message') {
            const toolChromeMode = toolTimelineChromeMode === 'activity_feed' ? 'activity_feed' : 'cards';
            const prev = listImplementation === 'flash_v2' ? itemsRef.current[index - 1] : undefined;
            const shouldTightenToolStack =
                listImplementation === 'flash_v2' &&
                toolChromeMode === 'activity_feed' &&
                resolveKindForMessageId(item.messageId) === 'tool-call' &&
                prev?.kind === 'message' &&
                resolveKindForMessageId(prev.messageId) === 'tool-call';
            const wrapperStyle = shouldTightenToolStack ? { marginTop: -12 } : undefined;

            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper id={item.id} createdAt={item.createdAt}>
                    <View style={wrapperStyle}>
                        <ChatListMessageRow
                            sessionId={props.sessionId}
                            messageId={item.messageId}
                            messageOverride={item.originSessionId ? (props.messagesById[item.messageId] ?? null) : undefined}
                            originSessionId={item.originSessionId}
                            isReadOnlyContext={item.isReadOnlyContext}
                            metadata={props.metadata}
                            activeThinkingMessageId={props.activeThinkingMessageId}
                            approvalRequests={props.approvalRequests}
                            resolveThinkingExpanded={resolveThinkingExpanded}
                            setThinkingExpanded={setThinkingExpanded}
                            interaction={props.interaction}
                            rollbackAction={props.rollbackActionsByMessageId[item.messageId] ?? null}
                            rollbackRanges={props.rollbackRanges}
                            forkCommon={props.forkCommon}
                            messageDisplayCommon={props.messageDisplayCommon}
                            toolChromeCommon={props.toolChromeCommon}
                            toolRouteCommon={toolRouteCommonRef.current}
                        />
                    </View>
                </TranscriptEnterWrapper>
            ));
        }
        return null;
    }, [expandedToolCallsAnchorMessageIds, getTurnMessageById, listImplementation, props.activeThinkingMessageId, props.approvalRequests, props.forkCommon, props.interaction, props.messageDisplayCommon, props.metadata, props.rollbackRanges, props.sessionId, props.toolChromeCommon, resolveCreatedAtForMessageId, resolveKindForMessageId, resolveRollbackActionForMessage, resolveThinkingExpanded, setThinkingExpanded, setToolCallsGroupExpanded, toolTimelineChromeMode, wrapTranscriptItemForAnchor]);
    const renderTranscriptItemAtIndex = React.useCallback((item: ChatTranscriptListItem, index: number) => {
        return renderItem({ item, index });
    }, [renderItem]);
    const listHeaderNode = React.useMemo(() => (
        <ListHeader />
    ), []);

    const loadOlder = useCallback(async (options: LoadOlderOptions = {}): Promise<{
        loaded: number;
        hasMore: boolean;
        status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
    } | null> => {
        if (!props.isLoaded && props.forkedTranscriptEnabled !== true) return null;
        const showLoadingIndicator = options.showLoadingIndicator !== false;
        const preservePrependViewport = options.preservePrependViewport !== false;
        if (loadOlderInFlight.current || hasMoreOlderRef.current === false || hasMoreOlder === false) {
            if (loadOlderInFlight.current && showLoadingIndicator && options.loadingIndicatorDelayMs === 0) {
                showOlderLoadSpinner();
            }
            return null;
        }
        loadOlderInFlight.current = true;
        const loadingIndicatorDelayMs =
            typeof options.loadingIndicatorDelayMs === 'number' && Number.isFinite(options.loadingIndicatorDelayMs)
                ? Math.max(0, Math.trunc(options.loadingIndicatorDelayMs))
                : 0;
        if (!showLoadingIndicator) {
            clearOlderLoadSpinnerDelay();
        } else if (loadingIndicatorDelayMs > 0) {
            clearOlderLoadSpinnerDelay();
            olderLoadSpinnerDelayTimeoutRef.current = setTimeout(() => {
                olderLoadSpinnerDelayTimeoutRef.current = null;
                setIsLoadingOlder(true);
            }, loadingIndicatorDelayMs);
        } else {
            showOlderLoadSpinner();
        }
        try {
            inFlightWebPrependAnchorRef.current = preservePrependViewport
                ? captureCurrentWebPrependAnchor()
                : null;
            const nativePrependTransaction = preservePrependViewport
                ? beginNativePrependTransaction()
                : null;

            const syncLoadOlderOptions = resolveSyncLoadOlderOptions();
            const result = props.forkedTranscriptEnabled
                ? (syncLoadOlderOptions
                    ? await sync.loadOlderMessagesForkAware(props.sessionId, syncLoadOlderOptions)
                    : await sync.loadOlderMessagesForkAware(props.sessionId))
                : (syncLoadOlderOptions
                    ? await sync.loadOlderMessages(props.sessionId, syncLoadOlderOptions)
                    : await sync.loadOlderMessages(props.sessionId));

            const webPrependAnchor = inFlightWebPrependAnchorRef.current;
            inFlightWebPrependAnchorRef.current = null;

            if (Platform.OS === 'web' && listImplementation === 'flash_v2' && preservePrependViewport && result.loaded > 0) {
                // Plan E2: capture outcome — a restore window opens ('pending') or the capture
                // was skipped (pinned/non-scrollable viewport) and the prepend rides bottom-follow.
                recordRestoreDecisionTelemetry(webPrependAnchor ? 'pending' : 'skipped', { mode: 'restore-anchor' });
            }
            if (webPrependAnchor && result.loaded > 0) {
                pendingWebPrependAnchorRef.current = refreshWebTranscriptPrependAnchor(
                    webPrependAnchor,
                    webPrependAnchor.metrics,
                    {
                        resetExpiry: true,
                        userIntentAtMs: lastUserScrollIntentAtMsRef.current,
                    },
                );
                const restoreResult = restoreWebPrependAnchorThroughViewportCommand(pendingWebPrependAnchorRef.current);
                recordWebPrependRestoreOutcome(restoreResult);
                const metrics = resolveWebScrollMetrics();
                updateWebPrependRangeReserve(webPrependAnchor, metrics);
                if (metrics && pendingWebPrependAnchorRef.current) {
                    pendingWebPrependAnchorRef.current = refreshWebTranscriptPrependAnchor(
                        pendingWebPrependAnchorRef.current,
                        metrics,
                        resolvePendingWebPrependRefreshOptions(restoreResult.strategy),
                    );
                }
                pendingWebPrependIndexRecoveryRef.current = restoreResult.strategy === 'growth';
                if (restoreResult.strategy === 'growth') {
                    schedulePendingWebPrependIndexRecovery();
                }
            }
            if (
                nativePrependTransaction &&
                nativePrependTransactionRef.current === nativePrependTransaction &&
                !nativePrependTransaction.isClosed()
            ) {
                if (result.loaded > 0) {
                    // Commit happens when the prepended items are reflected in the rendered
                    // array (layout effect), not here at promise resolution (LC-R #2).
                    nativePrependCommitArmedRef.current = true;
                } else {
                    // Empty/no-op loads dispose the capture with an explicit outcome (LC-R #4).
                    invalidateNativePrependTransaction();
                }
            }

            if (result.status === 'no_more') {
                hasMoreOlderRef.current = false;
                setHasMoreOlder(false);
            } else if (result.status === 'loaded' || result.status === 'not_ready' || result.status === 'in_flight') {
                hasMoreOlderRef.current = result.hasMore;
                setHasMoreOlder(result.hasMore);
            }
            return {
                loaded: result.loaded,
                hasMore: result.hasMore,
                status: result.status,
            };
        } finally {
            inFlightWebPrependAnchorRef.current = null;
            const danglingTransaction = nativePrependTransactionRef.current;
            if (
                danglingTransaction != null &&
                !nativePrependCommitArmedRef.current &&
                danglingTransaction.sessionId === props.sessionId &&
                danglingTransaction.state() === 'awaiting-commit'
            ) {
                // The load threw or yielded nothing observable: never drop the capture silently.
                invalidateNativePrependTransaction();
            }
            hideOlderLoadSpinner();
            loadOlderInFlight.current = false;
        }
    }, [
        beginNativePrependTransaction,
        captureCurrentWebPrependAnchor,
        invalidateNativePrependTransaction,
        clearOlderLoadSpinnerDelay,
        hasMoreOlder,
        hideOlderLoadSpinner,
        listImplementation,
        props.forkedTranscriptEnabled,
        props.isLoaded,
        props.sessionId,
        recordRestoreDecisionTelemetry,
        recordWebPrependRestoreOutcome,
        resolveSyncLoadOlderOptions,
        showOlderLoadSpinner,
        resolvePendingWebPrependRefreshOptions,
        resolveWebScrollMetrics,
        schedulePendingWebPrependIndexRecovery,
        restoreWebPrependAnchorThroughViewportCommand,
        updateWebPrependRangeReserve,
    ]);
    loadOlderForAnchorLookupRef.current = loadOlder;

    const paginationLoadOlder = React.useCallback(async () => {
        if (hasMoreOlderRef.current === false) {
            return { loaded: 0, hasMore: false, status: 'no_more' as const };
        }
        // The hook owns pacing and the loading indicator (plan D2/D3).
        return await loadOlder({ showLoadingIndicator: false });
    }, [loadOlder]);

    // Single owner of user-triggered older pagination (plan D2): machine-driven hook shared
    // with ChainTranscriptList; replaces the deleted dwell scheduler family. Suspension while
    // any viewport transaction is open comes from the ownership machine.
    const olderPagination = useTranscriptOlderPagination({
        enabled: listImplementation === 'flash_v2',
        loadOlder: paginationLoadOlder,
        thresholdPx: resolveBackwardPrefetchThresholdPx(listLayoutHeight),
        cooldownMs: sync.getSyncTuning().transcriptOlderLoadCooldownMs,
        spinnerDelayMs: sync.getSyncTuning().transcriptOlderLoadSpinnerDelayMs,
        isFillDone: () => initialFillStatusRef.current === 'done',
        isTransactionOpen: () => {
            return viewportControllerRef.current?.isTransactionOpen() === true;
        },
    });
    resetOlderPaginationRef.current = olderPagination.reset;
    const onOlderPaginationScrollObservation = olderPagination.onScrollObservation;

    const observeOlderPaginationScroll = React.useCallback((params: Readonly<{
        offsetY: number;
        layoutHeight: number;
        contentHeight: number;
        distanceFromBottom: number;
    }>) => {
        if (listImplementation !== 'flash_v2') return;
        const scrollable = params.layoutHeight > 0 && params.contentHeight > params.layoutHeight + 16;
        // The follow-mode gate stays consumer-side (Lane D contract): no top prefetch while
        // the native mode machine reports 'following' or the viewport wants the bottom.
        const followGateOpen = Platform.OS === 'web'
            ? !(wantsPinnedRef.current && params.distanceFromBottom <= pinThresholdPx)
            : bottomFollowModeStateRef.current.mode !== 'following' && !wantsPinnedRef.current;
        onOlderPaginationScrollObservation({
            offsetY: params.offsetY,
            scrollable: scrollable && followGateOpen,
        });
    }, [listImplementation, onOlderPaginationScrollObservation, pinThresholdPx]);

    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return;

        let pendingAnchor = pendingWebPrependAnchorRef.current;
        if (!pendingAnchor) return;
        if (pendingAnchor.userIntentAtMs !== lastUserScrollIntentAtMsRef.current) {
            const intentMetrics = resolveWebScrollMetrics();
            if (!intentMetrics || !isWebTranscriptScrollable(intentMetrics, 1)) {
                pendingWebPrependAnchorRef.current = null;
                pendingWebPrependIndexRecoveryRef.current = false;
                clearWebPrependRangeReserve();
                // Plan E2: the scroller went away/unscrollable — the restore window is disposed.
                recordRestoreDecisionTelemetry('skipped', { mode: 'restore-anchor' });
                return;
            }
            pendingAnchor = refreshWebTranscriptPrependAnchor(pendingAnchor, intentMetrics, {
                recaptureAnchor: true,
                resetExpiry: true,
                userIntentAtMs: lastUserScrollIntentAtMsRef.current,
            });
            pendingWebPrependAnchorRef.current = pendingAnchor;
            pendingWebPrependIndexRecoveryRef.current = false;
        }
        if (Date.now() > pendingAnchor.expiresAtMs) {
            pendingWebPrependAnchorRef.current = null;
            pendingWebPrependIndexRecoveryRef.current = false;
            clearWebPrependRangeReserve();
            // Plan E2: the stabilization window expired; the restore window closes silently no more.
            recordRestoreDecisionTelemetry('skipped', { mode: 'restore-anchor' });
            return;
        }

        const restoreResult = restoreWebPrependAnchorThroughViewportCommand(pendingAnchor);
        recordWebPrependRestoreOutcome(restoreResult);
        const metrics = resolveWebScrollMetrics();
        if (!metrics) {
            pendingWebPrependAnchorRef.current = null;
            pendingWebPrependIndexRecoveryRef.current = false;
            clearWebPrependRangeReserve();
            return;
        }
        updateWebPrependRangeReserve(pendingAnchor, metrics);
        pendingWebPrependAnchorRef.current = refreshWebTranscriptPrependAnchor(
            pendingAnchor,
            metrics,
            resolvePendingWebPrependRefreshOptions(restoreResult.strategy),
        );
        pendingWebPrependIndexRecoveryRef.current =
            pendingWebPrependIndexRecoveryRef.current || restoreResult.strategy === 'growth';
        if (pendingWebPrependIndexRecoveryRef.current && pendingWebPrependAnchorRef.current) {
            attemptPendingWebPrependIndexRecovery();
        }
    }, [attemptPendingWebPrependIndexRecovery, clearWebPrependRangeReserve, listContentHeight, listData.length, listImplementation, props.sessionId, recordRestoreDecisionTelemetry, recordWebPrependRestoreOutcome, resolvePendingWebPrependRefreshOptions, resolveWebScrollMetrics, restoreWebPrependAnchorThroughViewportCommand, updateWebPrependRangeReserve]);

    const tryPinToBottomDom = React.useCallback((
        reason: TranscriptViewportTelemetryScrollReason = 'initial-open',
    ): boolean => {
        if (Platform.OS !== 'web') return false;
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
                platform: telemetryPlatform,
                listImplementation: telemetryListImplementation,
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
        telemetryListImplementation,
        telemetryPlatform,
    ]);

	    const resolveNearestSurvivingViewportAnchorIndex = React.useCallback((anchor: SessionViewportAnchorSnapshot): number | null => {
        const anchorMessageId = typeof anchor.messageId === 'string' && anchor.messageId.length > 0
            ? anchor.messageId
            : null;
        if (!anchorMessageId) return null;
        const anchorSeq = resolveSeqForMessageId(anchorMessageId);
        if (typeof anchorSeq !== 'number' || !Number.isFinite(anchorSeq)) return null;

        type AnchorIndexCandidate = { index: number; seq: number };
        let earlier: AnchorIndexCandidate | null = null;
        let later: AnchorIndexCandidate | null = null;
        const resolveItemSeqs = (item: ChatTranscriptListItem): number[] => {
            const seqs: number[] = [];
            const addSeq = (seq: number | null | undefined) => {
                if (typeof seq === 'number' && Number.isFinite(seq)) seqs.push(Math.trunc(seq));
            };
            if (item.kind === 'message') {
                addSeq(item.seq ?? resolveSeqForMessageId(item.messageId));
                return seqs;
            }
            if (item.kind === 'tool-calls-group') {
                for (const toolMessageId of item.toolMessageIds) {
                    addSeq(resolveSeqForMessageId(toolMessageId));
                }
                return seqs;
            }
            if (item.kind === 'turn') {
                if (item.turn.userMessageId) {
                    addSeq(resolveSeqForMessageId(item.turn.userMessageId));
                }
                for (const content of item.turn.content) {
                    if (content.kind === 'message') {
                        addSeq(resolveSeqForMessageId(content.messageId));
                    } else if (content.kind === 'tool_calls') {
                        for (const toolMessageId of content.toolMessageIds) {
                            addSeq(resolveSeqForMessageId(toolMessageId));
                        }
                    }
                }
            }
            return seqs;
        };

        const items = listDataRef.current;
        for (let index = 0; index < items.length; index += 1) {
            const item = items[index]!;
            for (const normalizedSeq of resolveItemSeqs(item)) {
                if (normalizedSeq < anchorSeq) {
                    if (!earlier || normalizedSeq > earlier.seq) earlier = { index, seq: normalizedSeq };
                    continue;
                }
                if (normalizedSeq > anchorSeq) {
                    if (!later || normalizedSeq < later.seq) later = { index, seq: normalizedSeq };
                }
            }
        }

        return earlier?.index ?? later?.index ?? null;
    }, [resolveSeqForMessageId]);

    React.useLayoutEffect(() => {
        // Prepend transaction commit/observe loop (plan F4): commits once the prepended page
        // is reflected in the rendered items, then re-observes the single window on every
        // layout/data pass until the transaction closes.
        observeNativePrependTransaction();
    }, [
        listContentHeight,
        listData.length,
        listImplementation,
        observeNativePrependTransaction,
        props.sessionId,
    ]);

    const handleNativeRestoreIndexFailure = React.useCallback((failedIndex: number): boolean => {
        if (Platform.OS === 'web') return false;
        const lastCommand = lastNativeRestoreIndexCommandRef.current;
        if (!lastCommand || lastCommand.sessionId !== props.sessionId || lastCommand.index !== failedIndex) return false;
        if (lastCommand.reason === 'jump-to-seq') return false;

        // entry-restore index failures schedule nothing (plan F2): the transaction holds
        // ownership; a later layout pass re-resolves, and the deadline closes it honestly.
        // Prepend fallbacks are scroll-offset writes (plan F4), never index restores.
        return lastCommand.reason === 'entry-restore';
    }, [
        props.sessionId,
    ]);

    const canRequestBoundedEntryViewportMaterialization = React.useCallback((): boolean => {
        if (anchorLookupExhaustedRef.current) return false;
        if (anchorLookupInFlightRef.current) return true;
        if (!loadOlderForAnchorLookupRef.current) return false;
        return anchorLookupLoadCountRef.current < sync.getSyncTuning().transcriptViewportAnchorOlderLookupMaxLoads;
    }, []);

    const requestBoundedEntryViewportMaterialization = React.useCallback((): boolean => {
        if (anchorLookupInFlightRef.current) return true;
        if (anchorLookupExhaustedRef.current) return false;
        const maxLoads = sync.getSyncTuning().transcriptViewportAnchorOlderLookupMaxLoads;
        if (anchorLookupLoadCountRef.current >= maxLoads) return false;
        const loadOlderForAnchorLookup = loadOlderForAnchorLookupRef.current;
        if (!loadOlderForAnchorLookup) return false;

        anchorLookupInFlightRef.current = true;
        anchorLookupLoadCountRef.current += 1;
        fireAndForget((async () => {
            let shouldRetryRestore = false;
            try {
                const result = await loadOlderForAnchorLookup({ preservePrependViewport: false, showLoadingIndicator: false });
                shouldRetryRestore = true;
                if (result && (result.status === 'no_more' || result.hasMore === false)) {
                    anchorLookupExhaustedRef.current = true;
                }
                await Promise.resolve();
                await Promise.resolve();
            } finally {
                anchorLookupInFlightRef.current = false;
            }
            if (shouldRetryRestore) {
                attemptEntryRestoreRef.current();
            }
        })(), { tag: 'ChatList.restoreEntryViewportMaterialization' });
        return true;
    }, []);

    const resolveEntryRestoreCanonicalMetrics = React.useCallback((): { contentHeight: number; layoutHeight: number } => {
        if (Platform.OS === 'web') {
            const metrics = resolveWebScrollMetrics();
            return {
                contentHeight: metrics ? Math.max(0, Math.trunc(metrics.scrollHeight)) : 0,
                layoutHeight: metrics ? Math.max(0, Math.trunc(metrics.clientHeight)) : 0,
            };
        }
        // A6: ONE canonical native content basis — the scroll-event contentSize. The measured
        // ref carries the composer inset added back (`resolveMeasuredContentHeight`), so the
        // canonical basis subtracts it again; entry alignment checks in onScroll read the same
        // basis directly from the scroll event.
        if (!hasNativeContentMeasurementForCurrentSession()) {
            return { contentHeight: 0, layoutHeight: listLayoutHeightRef.current };
        }
        const contentHeight = listImplementation === 'flash_v2'
            ? Math.max(0, Math.trunc(listContentHeightRef.current - composerInsetHeightRef.current))
            : Math.max(0, Math.trunc(listContentHeightRef.current));
        return { contentHeight, layoutHeight: listLayoutHeightRef.current };
    }, [hasNativeContentMeasurementForCurrentSession, listImplementation, resolveWebScrollMetrics]);

    /**
     * Single close point of the entry-restore lifecycle (plan F2): ownership phase release,
     * outcome telemetry, and the native first-paint reveal all hang off the transaction close.
     */
    const finishEntryRestoreTransaction = React.useCallback((transaction: EntryRestoreTransaction) => {
        if (entryRestoreTransactionRef.current !== transaction) return;
        if (!transaction.isClosed()) return;
        clearEntryRestoreDeadlineTimeout();
        const outcome = transaction.outcome();
        const writeContext = entryRestoreWriteContextRef.current;
        closeEntryViewportOwnership(
            outcome === 'preempted-user-scroll'
                ? 'preempted'
                : outcome === 'deadline'
                    ? 'deadline'
                    : 'confirmed',
        );
        recordRestoreDecisionTelemetry(
            outcome === 'confirmed'
                ? 'restored'
                : outcome === 'deadline'
                    ? 'not-ready'
                    : 'skipped',
            {
                mode: writeContext?.kind === 'anchor'
                    ? 'restore-anchor'
                    : writeContext?.kind === 'bottom'
                        ? 'follow-bottom'
                        : 'restore-distance',
                offsetY: writeContext?.distanceFromBottom,
                contentHeight: writeContext?.issuedContentHeight,
                layoutHeight: writeContext?.issuedLayoutHeight,
            },
        );
        if (Platform.OS !== 'web' && transaction.sessionId === currentSessionIdRef.current) {
            updateNativeInitialViewportPendingObservation(false);
            if (outcome === 'confirmed') {
                markNativeInitialViewportAppliedForCurrentSession();
            } else {
                // A4: the placeholder release is driven by transaction close; the 32ms polish
                // keeps the reveal off the same frame as the final write. The deadline timer
                // always fires, so this can never hang.
                scheduleNativePaintReleaseForEntryRestore({ force: true });
            }
        }
    }, [
        clearEntryRestoreDeadlineTimeout,
        closeEntryViewportOwnership,
        markNativeInitialViewportAppliedForCurrentSession,
        recordRestoreDecisionTelemetry,
        scheduleNativePaintReleaseForEntryRestore,
        updateNativeInitialViewportPendingObservation,
    ]);
    finishEntryRestoreTransactionRef.current = finishEntryRestoreTransaction;

    const armEntryRestoreDeadline = React.useCallback((transaction: EntryRestoreTransaction, deadlineMs: number) => {
        clearEntryRestoreDeadlineTimeout();
        const handle = {
            sessionId: transaction.sessionId,
            timeoutId: null as unknown as ReturnType<typeof setTimeout>,
        };
        handle.timeoutId = setTimeout(() => {
            if (entryRestoreDeadlineTimeoutRef.current !== handle) return;
            entryRestoreDeadlineTimeoutRef.current = null;
            if (entryRestoreTransactionRef.current !== transaction || transaction.isClosed()) return;
            // The deadline must always close the transaction, regardless of timer clock skew.
            transaction.onDeadline(Number.MAX_SAFE_INTEGER);
            finishEntryRestoreTransactionRef.current(transaction);
        }, Math.max(0, Math.trunc(deadlineMs)));
        entryRestoreDeadlineTimeoutRef.current = handle;
    }, [clearEntryRestoreDeadlineTimeout]);

    const resolveEntryRestoreDeadlineMs = React.useCallback((): number => {
        const tuning = sync.getSyncTuning();
        return resolveTranscriptInitialFillTuning({
            transcriptInitialFillBudgetMs: tuning.transcriptInitialFillBudgetMs,
            transcriptInitialFillMaxNoProgressLoads: tuning.transcriptInitialFillMaxNoProgressLoads,
        }).budgetMs;
    }, []);

    const issueEntryRestoreAnchorWrite = React.useCallback((index: number, viewOffset: number): boolean => {
        return executeViewportCommand(resolveViewportCommand({
            type: 'first-paint',
            sessionId: props.sessionId,
            shouldFollowBottom: false,
            entrySnapshot: {
                shouldFollowBottom: false,
                offsetY: 0,
                anchorIndex: index,
                anchorViewOffset: viewOffset,
            },
            jumpToSeq: null,
            platform: telemetryPlatform,
            listImplementation: telemetryListImplementation,
        }));
    }, [executeViewportCommand, props.sessionId, resolveViewportCommand, telemetryListImplementation, telemetryPlatform]);

    const issueEntryRestoreDistanceWrite = React.useCallback((distanceFromBottom: number, contentHeight: number): boolean => {
        const command = resolveViewportCommand({
            type: 'first-paint',
            sessionId: props.sessionId,
            shouldFollowBottom: false,
            entrySnapshot: {
                shouldFollowBottom: false,
                offsetY: distanceFromBottom,
            },
            jumpToSeq: null,
            platform: telemetryPlatform,
            listImplementation: telemetryListImplementation,
        });
        const commandWithContentHeight = Platform.OS !== 'web' && command.kind === 'restore-offset'
            ? { ...command, contentHeight }
            : command;
        return executeViewportCommand(commandWithContentHeight);
    }, [executeViewportCommand, props.sessionId, resolveViewportCommand, telemetryListImplementation, telemetryPlatform]);

    const issueWebEntryRestoreAnchorWrite = React.useCallback((anchor: SessionViewportAnchorSnapshot | null): boolean => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2' || !anchor) return false;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return false;
        const result = restoreWebViewportAnchorThroughViewportCommand({
            container: metrics.element,
            anchor: { ...anchor, messageId: anchor.messageId ?? null },
        });
        return result.status === 'restored' || result.status === 'already_aligned';
    }, [listImplementation, resolveWebScrollMetrics, restoreWebViewportAnchorThroughViewportCommand]);

    // Plan E1: after the crash fallback flips the implementation, restore the viewport that
    // was captured from the crashed list — a fresh entry restore on the new implementation,
    // anchor-first through the viewport command seam with the remembered distance as fallback.
    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web' || !webFlashListCrashed) return;
        const snapshot = webCrashFallbackViewportRef.current;
        if (!snapshot) return;
        webCrashFallbackViewportRef.current = null;
        if (snapshot.sessionId !== props.sessionId) return;
        // An open entry transaction still owns the viewport and will place it itself.
        const entryTransaction = entryRestoreTransactionRef.current;
        if (entryTransaction && !entryTransaction.isClosed()) return;
        // A pinned-at-bottom viewport rides bottom-follow on the new implementation.
        if (wantsPinnedRef.current && snapshot.distanceFromBottom <= pinThresholdPx) return;
        const controller = viewportControllerRef.current;
        if (!controller) return;
        const opened = controller.activeOwner() === 'follow'
            ? controller.openTransaction('entry').opened
            : false;
        try {
            let restored = false;
            if (snapshot.anchor) {
                const metrics = resolveWebScrollMetrics();
                if (metrics) {
                    const result = restoreWebViewportAnchorThroughViewportCommand({
                        container: metrics.element,
                        anchor: snapshot.anchor,
                    });
                    restored = result.status === 'restored' || result.status === 'already_aligned';
                }
            }
            if (!restored) {
                issueEntryRestoreDistanceWrite(snapshot.distanceFromBottom, listContentHeightRef.current);
            }
        } finally {
            if (opened) {
                controller.closeTransaction('entry', 'confirmed');
            }
        }
    }, [
        issueEntryRestoreDistanceWrite,
        pinThresholdPx,
        props.sessionId,
        resolveWebScrollMetrics,
        restoreWebViewportAnchorThroughViewportCommand,
        webFlashListCrashed,
    ]);

    /**
     * Web confirm-or-deadline (plan A5): verify the open web entry transaction against live DOM
     * metrics. Conclusive misalignment spends the single correction; stale-height frames are
     * inconclusive and never forwarded (only-conclusive-observations rule).
     */
    const verifyWebEntryRestoreTransaction = React.useCallback(() => {
        if (Platform.OS !== 'web') return;
        const transaction = entryRestoreTransactionRef.current;
        const writeContext = entryRestoreWriteContextRef.current;
        if (!transaction || transaction.isClosed() || transaction.sessionId !== props.sessionId || !writeContext) return;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return;
        const nowMs = Date.now();
        const tolerancePx = Math.max(pinThresholdPx, 2);
        if (writeContext.kind === 'anchor') {
            if (!writeContext.anchor) return;
            // A still-open web anchor transaction means the issue-time anchor restore could
            // not see the anchor row (seam scroll-to-index fallback). Once the row mounts, a
            // read-only alignment observation drives confirm or the single DOM correction.
            const alignment = resolveWebTranscriptViewportAnchorAlignment({
                container: metrics.element,
                anchor: { ...writeContext.anchor, messageId: writeContext.anchor.messageId ?? null },
                tolerancePx,
            });
            if (alignment.status === 'aligned') {
                transaction.onObservation({ status: 'aligned' }, nowMs);
            } else if (alignment.status === 'misaligned') {
                const directive = transaction.onObservation({ status: 'misaligned' }, nowMs);
                if (directive.action === 'issue-correction-write') {
                    const result = restoreWebViewportAnchorThroughViewportCommand({
                        container: metrics.element,
                        anchor: { ...writeContext.anchor, messageId: writeContext.anchor.messageId ?? null },
                    });
                    if (result.status === 'restored' || result.status === 'already_aligned') {
                        // The helper read the anchor position and routed the exact target
                        // through the command seam.
                        transaction.onObservation({ status: 'aligned' }, nowMs);
                    }
                }
            }
            // not_found stays inconclusive; the deadline closes the transaction honestly.
        } else {
            const distanceTarget = writeContext.kind === 'bottom' ? 0 : writeContext.distanceFromBottom;
            const distanceFromBottom = getWebTranscriptDistanceFromBottom(metrics);
            if (Math.abs(distanceFromBottom - distanceTarget) <= tolerancePx) {
                transaction.onObservation({ status: 'aligned' }, nowMs);
            } else if (metrics.scrollHeight + tolerancePx >= writeContext.issuedContentHeight) {
                const directive = transaction.onObservation({ status: 'misaligned' }, nowMs);
                if (directive.action === 'issue-correction-write') {
                    const issuedContentHeight = Math.max(0, Math.trunc(metrics.scrollHeight));
                    if (writeContext.kind === 'bottom') {
                        tryPinToBottomDom('initial-open');
                    } else {
                        issueEntryRestoreDistanceWrite(distanceTarget, issuedContentHeight);
                    }
                    entryRestoreWriteContextRef.current = {
                        ...writeContext,
                        issuedContentHeight,
                    };
                }
            }
        }
        if (transaction.isClosed()) {
            finishEntryRestoreTransaction(transaction);
        }
    }, [
        finishEntryRestoreTransaction,
        issueEntryRestoreDistanceWrite,
        pinThresholdPx,
        props.sessionId,
        resolveWebScrollMetrics,
        restoreWebViewportAnchorThroughViewportCommand,
        tryPinToBottomDom,
    ]);

    /**
     * Maps a native scroll observation to a CONCLUSIVE transaction observation, or null when
     * the frame is inconclusive (anchor layout unmeasured, stale content metrics): only
     * conclusive aligned|misaligned observations are ever forwarded (Lane A review contract).
     */
    const resolveNativeEntryRestoreAlignmentObservation = React.useCallback((params: Readonly<{
        contentHeight: number;
        distanceFromBottom: number;
        offsetY: number;
    }>): { status: 'aligned' | 'misaligned' } | null => {
        const writeContext = entryRestoreWriteContextRef.current;
        if (!writeContext || writeContext.sessionId !== props.sessionId) return null;
        const tolerancePx = Math.max(pinThresholdPx, 2);
        if (writeContext.kind === 'anchor' && writeContext.anchor) {
            const anchorIndex = resolveTranscriptViewportAnchorIndex({
                anchor: writeContext.anchor,
                items: listDataRef.current,
            }) ?? resolveNearestSurvivingViewportAnchorIndex(writeContext.anchor);
            if (anchorIndex == null) return null;
            const observation = resolveNativeTranscriptViewportAnchorRestoreObservation({
                ref: listRef.current,
                index: anchorIndex,
                itemOffsetPx: writeContext.anchor.itemOffsetPx,
                tolerancePx,
            });
            if (observation.status === 'aligned' || observation.status === 'misaligned') {
                return { status: observation.status };
            }
            return null;
        }
        if (writeContext.kind === 'distance') {
            const matches = nativeEntryRestoreObservationMatches({
                contentHeight: writeContext.issuedContentHeight,
                kind: 'distance',
                offsetY: writeContext.distanceFromBottom,
                sessionId: writeContext.sessionId,
                targetOffsetY: writeContext.targetOffsetY ?? undefined,
                targetOffsetYWasClamped: writeContext.targetOffsetYWasClamped,
            }, {
                contentHeight: params.contentHeight,
                distanceFromBottom: params.distanceFromBottom,
                observedOffsetY: params.offsetY,
                sessionId: props.sessionId,
                tolerancePx,
            });
            if (matches) return { status: 'aligned' };
            if (params.contentHeight + tolerancePx < writeContext.issuedContentHeight) {
                // Stale content frame: the list has not laid out the issued basis yet.
                return null;
            }
            return { status: 'misaligned' };
        }
        return null;
    }, [pinThresholdPx, props.sessionId, resolveNearestSurvivingViewportAnchorIndex]);

    /** Host-derived single correction write for the open native entry transaction. */
    const issueNativeEntryRestoreCorrection = React.useCallback((params: Readonly<{
        contentHeight: number;
        layoutHeight: number;
    }>) => {
        const writeContext = entryRestoreWriteContextRef.current;
        if (!writeContext || writeContext.sessionId !== props.sessionId) return;
        if (writeContext.kind === 'anchor' && writeContext.anchor) {
            const anchorIndex = resolveTranscriptViewportAnchorIndex({
                anchor: writeContext.anchor,
                items: listDataRef.current,
            }) ?? resolveNearestSurvivingViewportAnchorIndex(writeContext.anchor);
            if (anchorIndex == null) return;
            const restorePlan = planNativeTranscriptViewportAnchorRestore({
                index: anchorIndex,
                itemOffsetPx: writeContext.anchor.itemOffsetPx,
            });
            if (restorePlan.status !== 'planned') return;
            executeViewportCommand(resolveViewportCommand({
                type: 'restore-anchor',
                sessionId: props.sessionId,
                reason: 'entry-restore',
                index: restorePlan.index,
                viewOffset: restorePlan.viewOffset,
                animated: false,
            }));
            return;
        }
        if (writeContext.kind === 'distance') {
            const issuedContentHeight = Math.max(0, Math.trunc(params.contentHeight));
            const maxOffsetY = Math.max(0, Math.trunc(issuedContentHeight - params.layoutHeight));
            const targetOffsetY = Math.max(0, maxOffsetY - writeContext.distanceFromBottom);
            executeViewportCommand(resolveViewportCommand({
                type: 'scroll-offset',
                sessionId: props.sessionId,
                reason: 'entry-restore',
                mode: 'restore-distance',
                offsetY: targetOffsetY,
                animated: false,
            }));
            entryRestoreWriteContextRef.current = {
                ...writeContext,
                issuedContentHeight,
                targetOffsetY,
                targetOffsetYWasClamped: maxOffsetY < writeContext.distanceFromBottom,
            };
        }
    }, [executeViewportCommand, props.sessionId, resolveNearestSurvivingViewportAnchorIndex, resolveViewportCommand]);

    /**
     * KEEP-INLINE legacy escape hatch (Lane A review F2 contract): `flatlist_legacy` keeps its
     * old inline distance restore (the seam applies the inverted-offset semantics) and never
     * opens an entry-restore transaction; this path dies with flatlist_legacy itself.
     */
    const attemptLegacyEntryDistanceRestore = React.useCallback(() => {
        const entryViewport = sessionEntryViewportRef.current;
        if (!entryViewport || entryViewport.sessionId !== props.sessionId) return;
        if (entryViewport.shouldFollowBottom !== false) return;
        if (props.jumpToSeq != null) return;
        if (wantsPinnedRef.current) return;
        if (lastUserScrollIntentAtMsRef.current !== Number.NEGATIVE_INFINITY) return;
        const offsetY = Number.isFinite(entryViewport.offsetY)
            ? Math.max(0, Math.trunc(entryViewport.offsetY))
            : 0;
        const applied = legacyEntryRestoreAppliedRef.current;
        if (applied?.sessionId === entryViewport.sessionId && applied.offsetY === offsetY) return;
        if (Platform.OS === 'web') {
            const metrics = resolveWebScrollMetrics();
            if (!metrics) return;
            if (resolveWebTranscriptMaxScrollTop(metrics) < offsetY && requestBoundedEntryViewportMaterialization()) {
                return;
            }
        } else {
            const layoutHeight = listLayoutHeightRef.current;
            const contentHeight = listContentHeightRef.current;
            if (!Number.isFinite(layoutHeight) || layoutHeight <= 0) return;
            if (!Number.isFinite(contentHeight) || contentHeight <= 0) return;
            if (
                Math.max(0, Math.trunc(contentHeight - layoutHeight)) < offsetY &&
                requestBoundedEntryViewportMaterialization()
            ) {
                return;
            }
        }
        if (!executeViewportCommand(resolveViewportCommand({
            type: 'first-paint',
            sessionId: props.sessionId,
            shouldFollowBottom: false,
            entrySnapshot: {
                shouldFollowBottom: false,
                offsetY,
            },
            jumpToSeq: null,
            platform: telemetryPlatform,
            listImplementation: telemetryListImplementation,
        }))) {
            return;
        }
        legacyEntryRestoreAppliedRef.current = { sessionId: entryViewport.sessionId, offsetY };
        closeEntryViewportOwnership('confirmed');
        recordRestoreDecisionTelemetry('restored', { mode: 'restore-distance', offsetY });
    }, [
        closeEntryViewportOwnership,
        executeViewportCommand,
        props.jumpToSeq,
        props.sessionId,
        recordRestoreDecisionTelemetry,
        requestBoundedEntryViewportMaterialization,
        resolveViewportCommand,
        resolveWebScrollMetrics,
        telemetryListImplementation,
        telemetryPlatform,
    ]);

    /**
     * Entry-restore resolution driver (plan F2 + Lane A, W2.2): resolves the entry target
     * through `resolveEntryRestoreTarget`, runs pre-transaction materialization for unresolved
     * anchors and too-deep distances (dev's fork-aware loadOlder feeds the bounded lookup),
     * and creates exactly ONE transaction per session entry whose initial write is issued
     * here. Content-height churn can never re-issue a write: there is no reapply path (E1).
     */
    const attemptEntryRestore = React.useCallback((): void => {
        const entryViewport = sessionEntryViewportRef.current;
        if (!entryViewport || entryViewport.sessionId !== props.sessionId) return;
        if (entryViewport.shouldFollowBottom !== false) return;
        if (listImplementation === 'flatlist_legacy') {
            attemptLegacyEntryDistanceRestore();
            return;
        }
        if (entryRestoreTransactionRef.current != null) return;
        if (entryRestoreSuppressedRef.current) return;
        if (props.jumpToSeq != null || latestJumpToSeqRef.current != null) {
            entryRestoreSuppressedRef.current = true;
            closeEntryViewportOwnership('preempted');
            return;
        }
        if (lastUserScrollIntentAtMsRef.current !== Number.NEGATIVE_INFINITY) {
            entryRestoreSuppressedRef.current = true;
            closeEntryViewportOwnership('preempted');
            return;
        }

        const { contentHeight, layoutHeight } = resolveEntryRestoreCanonicalMetrics();
        const items = listDataRef.current;
        const anchor = entryViewport.anchor;
        const exactAnchorIndex = anchor
            ? resolveTranscriptViewportAnchorIndex({ anchor, items })
            : null;
        const distanceFromBottom = Number.isFinite(entryViewport.offsetY)
            ? Math.max(0, Math.trunc(entryViewport.offsetY))
            : 0;
        const target = resolveEntryRestoreTarget({
            snapshot: { shouldFollowBottom: false, offsetY: distanceFromBottom, anchor },
            items,
            contentMeasured: { contentHeight, layoutHeight },
            fillSettled: initialFillStatusRef.current === 'done',
            canMaterializeOlder: canRequestBoundedEntryViewportMaterialization(),
            anchorIndexResolver: () => exactAnchorIndex,
            nearestSurvivingResolver: () => (anchor ? resolveNearestSurvivingViewportAnchorIndex(anchor) : null),
            anchorSeqResolver: () => (
                typeof anchor?.messageId === 'string' && anchor.messageId.length > 0
                    ? resolveSeqForMessageId(anchor.messageId) ?? null
                    : null
            ),
        });

        if (target.kind === 'none' && (target.reason === 'awaiting-fill-settle' || target.reason === 'content-unmeasured')) {
            // Wait verdict (type-split per Lane A review): re-resolve on the next
            // measurement/fill change without opening a transaction.
            return;
        }
        if (target.kind === 'materialize-then-anchor') {
            requestBoundedEntryViewportMaterialization();
            recordRestoreDecisionTelemetry('missing-anchor', {
                mode: 'restore-anchor',
                offsetY: distanceFromBottom,
                contentHeight,
                layoutHeight,
            });
            return;
        }
        if (
            target.kind === 'distance-oneshot' &&
            distanceFromBottom > Math.max(0, Math.trunc(contentHeight - layoutHeight)) &&
            requestBoundedEntryViewportMaterialization()
        ) {
            // Wiring-layer extension over resolveEntryRestoreTarget (remote-dev FW1 ledger): a
            // remembered distance deeper than the loaded window materializes older pages first
            // (bounded), then the one-shot still issues exactly once.
            recordRestoreDecisionTelemetry('not-ready', {
                mode: 'restore-distance',
                offsetY: distanceFromBottom,
                contentHeight,
                layoutHeight,
            });
            return;
        }
        if (anchor && exactAnchorIndex == null && target.kind !== 'none') {
            recordRestoreDecisionTelemetry('entry-anchor-missing', {
                mode: 'restore-anchor',
                offsetY: distanceFromBottom,
                contentHeight,
                layoutHeight,
            });
        }

        const nowMs = Date.now();
        const deadlineMs = resolveEntryRestoreDeadlineMs();
        if (target.kind === 'none') {
            if (target.reason === 'awaiting-fill-settle' || target.reason === 'content-unmeasured') {
                return;
            }
            const transaction = createEntryRestoreTransaction({
                sessionId: props.sessionId,
                target: { kind: 'none', reason: target.reason },
                nowMs,
                deadlineMs,
            });
            entryRestoreTransactionRef.current = transaction;
            finishEntryRestoreTransaction(transaction);
            return;
        }

        let issued = false;
        let targetOffsetY: number | null = null;
        let targetOffsetYWasClamped = false;
        let webAnchorConfirmedAtIssue = false;
        if (target.kind === 'anchor') {
            if (Platform.OS === 'web') {
                webAnchorConfirmedAtIssue = issueWebEntryRestoreAnchorWrite(anchor);
                issued = webAnchorConfirmedAtIssue || issueEntryRestoreAnchorWrite(target.index, target.viewOffset);
            } else {
                issued = issueEntryRestoreAnchorWrite(target.index, target.viewOffset);
            }
        } else if (target.kind === 'distance-oneshot') {
            const maxOffsetY = Math.max(0, Math.trunc(contentHeight - layoutHeight));
            targetOffsetY = target.targetOffsetY;
            targetOffsetYWasClamped = maxOffsetY < distanceFromBottom;
            issued = issueEntryRestoreDistanceWrite(distanceFromBottom, contentHeight);
        } else {
            // 'bottom' cannot occur for restore entries (shouldFollowBottom === false), but the
            // resolver type carries it; route it through the seam for completeness.
            issued = executeViewportCommand(resolveViewportCommand({
                type: 'first-paint',
                sessionId: props.sessionId,
                shouldFollowBottom: true,
                entrySnapshot: null,
                jumpToSeq: null,
                platform: telemetryPlatform,
                listImplementation: telemetryListImplementation,
            }));
        }
        if (!issued) {
            // No write landed (list ref/metrics not ready): retry on the next layout pass —
            // the transaction only exists once its initial write is real.
            recordRestoreDecisionTelemetry('not-ready', {
                mode: target.kind === 'anchor' ? 'restore-anchor' : 'restore-distance',
                offsetY: distanceFromBottom,
                contentHeight,
                layoutHeight,
            });
            return;
        }

        const transaction = createEntryRestoreTransaction({
            sessionId: props.sessionId,
            target,
            nowMs,
            deadlineMs,
        });
        entryRestoreTransactionRef.current = transaction;
        entryRestoreWriteContextRef.current = {
            anchor: target.kind === 'anchor' ? anchor : null,
            createdAtMs: nowMs,
            distanceFromBottom,
            issuedContentHeight: contentHeight,
            issuedLayoutHeight: layoutHeight,
            kind: target.kind === 'anchor' ? 'anchor' : target.kind === 'bottom' ? 'bottom' : 'distance',
            sessionId: props.sessionId,
            targetOffsetY,
            targetOffsetYWasClamped,
        };
        armEntryRestoreDeadline(transaction, deadlineMs);
        if (Platform.OS !== 'web') {
            updateNativeInitialViewportPendingObservation(true);
        }
        recordRestoreDecisionTelemetry(
            target.kind === 'distance-oneshot' ? 'entry-distance-oneshot' : 'pending',
            {
                mode: target.kind === 'anchor' ? 'restore-anchor' : 'restore-distance',
                offsetY: distanceFromBottom,
                contentHeight,
                layoutHeight,
            },
        );
        if (webAnchorConfirmedAtIssue) {
            // The helper read the anchor position and routed the exact target through the
            // command seam; that read-back is the conclusive aligned observation.
            transaction.onObservation({ status: 'aligned' }, nowMs);
            finishEntryRestoreTransaction(transaction);
            return;
        }
        if (Platform.OS === 'web' && initialFillStatusRef.current === 'done') {
            verifyWebEntryRestoreTransaction();
        }
    }, [
        armEntryRestoreDeadline,
        attemptLegacyEntryDistanceRestore,
        canRequestBoundedEntryViewportMaterialization,
        closeEntryViewportOwnership,
        executeViewportCommand,
        finishEntryRestoreTransaction,
        issueEntryRestoreAnchorWrite,
        issueEntryRestoreDistanceWrite,
        issueWebEntryRestoreAnchorWrite,
        listImplementation,
        props.jumpToSeq,
        props.sessionId,
        recordRestoreDecisionTelemetry,
        requestBoundedEntryViewportMaterialization,
        resolveEntryRestoreCanonicalMetrics,
        resolveEntryRestoreDeadlineMs,
        resolveNearestSurvivingViewportAnchorIndex,
        resolveSeqForMessageId,
        resolveViewportCommand,
        telemetryListImplementation,
        telemetryPlatform,
        updateNativeInitialViewportPendingObservation,
        verifyWebEntryRestoreTransaction,
    ]);
    attemptEntryRestoreRef.current = attemptEntryRestore;

    React.useLayoutEffect(() => {
        attemptEntryRestore();
        if (Platform.OS === 'web') {
            verifyWebEntryRestoreTransaction();
        }
    }, [attemptEntryRestore, listContentHeight, listData.length, listImplementation, listLayoutHeight, props.sessionId, verifyWebEntryRestoreTransaction]);

    const captureWebBottomFollowPreviousMetrics = React.useCallback((): WebTranscriptScrollMetrics | null => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return null;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return null;
        return {
            ...metrics,
            clientHeight: listLayoutHeightRef.current > 0 ? listLayoutHeightRef.current : metrics.clientHeight,
            scrollHeight: listContentHeightRef.current > 0 ? listContentHeightRef.current : metrics.scrollHeight,
        };
    }, [listImplementation, resolveWebScrollMetrics]);

    const applyWebBottomFollowAdjustment = React.useCallback((
        previousMetrics: WebTranscriptScrollMetrics,
        reason: TranscriptViewportTelemetryScrollReason = 'content-size-change',
    ): boolean => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return false;
        const nextMetrics = resolveWebScrollMetrics();
        if (!nextMetrics) return false;
        const targetScrollTop = resolveWebBottomFollowAdjustment({
            mode: wantsPinnedRef.current ? 'following' : 'released',
            previousMetrics,
            nextMetrics,
            tolerancePx: pinThresholdPx,
            recentUserIntent: Date.now() - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS,
        });
        if (targetScrollTop === null) return false;
        return executeViewportCommand(resolveViewportCommand({
            type: 'auto-follow',
            sessionId: props.sessionId,
            distanceFromBottom: Number.MAX_SAFE_INTEGER,
            pinThresholdPx,
            recentUserIntent: false,
            wantsPinned: wantsPinnedRef.current,
            reason,
            targetOffsetY: targetScrollTop,
        }));
    }, [
        executeViewportCommand,
        listImplementation,
        pinThresholdPx,
        props.sessionId,
        resolveViewportCommand,
        resolveWebScrollMetrics,
    ]);

    const pinNativeFlashListToBottomIfMeasured = React.useCallback((options?: {
        force?: boolean;
        markInitialViewportApplied?: 'always' | 'when-scrollable';
        reason?: TranscriptViewportTelemetryScrollReason;
	    }): boolean => {
	        if (!usesNativeFlashListBottomMaintenance) return false;
	        if (props.jumpToSeq != null) return false;
	        const reason = options?.reason ?? 'content-size-change';
	        const isExplicitNativeCommand = reason === 'jump-to-bottom' || reason === 'jump-to-seq';
	        if (!canAutoFollowForReason(reason, { explicit: isExplicitNativeCommand })) return false;
	        if (!isExplicitNativeCommand && Date.now() - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS) return false;
        // Plan B3: streaming bottom maintenance is MVCP-owned — stream-append never
        // issues a JS pin write; everything else stays JS-pin-owned.
        const shouldSkipNativeJsPinForStreamAppend =
            !isExplicitNativeCommand &&
            reason === 'stream-append';
        if (
            !shouldSkipNativeJsPinForStreamAppend &&
            !isExplicitNativeCommand &&
            !(options?.force === true && reason === 'mount-settle') &&
            mountSettleCoordinatorRef.current?.getSnapshot().isMountSettleActive === true &&
            !nativeMountSettleDeadlineReachedRef.current
        ) {
            pendingNativeMountSettleBottomPinRef.current = true;
            return false;
        }

        const layoutHeight = listLayoutHeightRef.current;
        const contentHeight = listContentHeightRef.current;
        if (!Number.isFinite(layoutHeight) || layoutHeight <= 0) return false;
        if (!Number.isFinite(contentHeight) || contentHeight <= 0) return false;

        const offset = Math.max(0, Math.trunc(contentHeight - layoutHeight));
        const shouldDeferInitialViewportAppliedUntilObserved =
            options?.markInitialViewportApplied === 'when-scrollable';
        const shouldMarkInitialViewportApplied =
            !shouldDeferInitialViewportAppliedUntilObserved;
        const shouldRetryUnobservedNativeBottomPin =
            offset > 0 &&
            pendingNativeMountSettleBottomPinRef.current &&
            !hasNativeInitialViewportAppliedForCurrentSession() &&
            nativeMountSettleStable;
        const shouldSkipUnstableAutomaticRetryUntilObserved =
            !shouldSkipNativeJsPinForStreamAppend &&
            !isExplicitNativeCommand &&
            offset > 0 &&
            pendingNativeMountSettleBottomPinRef.current &&
            reason === 'initial-open';
        const shouldSkipDefaultNativeMaterializationPin =
            !shouldSkipNativeJsPinForStreamAppend &&
            !isExplicitNativeCommand &&
            !(
                reason === 'content-size-change' &&
                nativeContentMaterializationAutoPinRef.current?.sessionId === props.sessionId &&
                nativeContentMaterializationAutoPinRef.current.contentHeight === contentHeight
            ) &&
            (
                reason === 'initial-open' ||
                reason === 'layout-change' ||
                reason === 'content-size-change'
            );
        const shouldSkipDuplicateAutomaticRetryUntilObserved =
            !shouldSkipNativeJsPinForStreamAppend &&
            !isExplicitNativeCommand &&
            !(options?.force === true && reason === 'mount-settle') &&
            offset > 0 &&
            pendingNativeMountSettleBottomPinRef.current &&
            lastNativePinOffsetRef.current != null &&
            (
                lastNativePinOffsetRef.current === offset ||
                reason === 'initial-open'
            );
        if (
            shouldSkipDefaultNativeMaterializationPin ||
            shouldSkipUnstableAutomaticRetryUntilObserved ||
            shouldSkipDuplicateAutomaticRetryUntilObserved
        ) {
            if (!hasNativeInitialViewportAppliedForCurrentSession()) {
                pendingNativeMountSettleBottomPinRef.current = true;
            }
            return true;
        }
        if (
            !shouldSkipNativeJsPinForStreamAppend &&
            options?.force !== true &&
            lastNativePinOffsetRef.current === offset &&
            !shouldRetryUnobservedNativeBottomPin
        ) {
            if (shouldMarkInitialViewportApplied) {
                markNativeInitialViewportAppliedForCurrentSession();
            }
            if (shouldDeferInitialViewportAppliedUntilObserved && offset > 0) {
                pendingNativeMountSettleBottomPinRef.current = true;
            }
            return true;
        }
        if (
            options?.force === true &&
            reason === 'mount-settle' &&
            pendingNativeMountSettleBottomPinRef.current &&
            !hasNativeInitialViewportAppliedForCurrentSession() &&
            lastNativePinOffsetRef.current === offset
        ) {
            // One idempotent settle pin per mount window (plan B4): a same-offset
            // mount-settle wake never re-issues the write.
            if (shouldDeferInitialViewportAppliedUntilObserved && offset > 0) {
                updateNativeInitialViewportPendingObservation(true);
            }
            return true;
        }

        if (
            shouldSkipNativeJsPinForStreamAppend &&
            lastNativeStreamAppendPinRef.current?.sessionId === props.sessionId &&
            lastNativeStreamAppendPinRef.current.contentHeight === contentHeight
        ) {
            // Invariant F: never two follow commands for the same content version.
            return true;
        }
        if (!executeViewportCommand(resolveViewportCommand({
            type: 'auto-follow',
            sessionId: props.sessionId,
            distanceFromBottom: Number.MAX_SAFE_INTEGER,
            pinThresholdPx,
            recentUserIntent: false,
            wantsPinned: wantsPinnedRef.current,
            reason,
            targetOffsetY: offset,
            skipNativeJsPin: shouldSkipNativeJsPinForStreamAppend,
        }))) {
            return false;
        }
        if (shouldSkipNativeJsPinForStreamAppend) {
            lastNativeStreamAppendPinRef.current = {
                contentHeight,
                sessionId: props.sessionId,
            };
        }
        if (!shouldSkipNativeJsPinForStreamAppend) {
            lastNativePinOffsetRef.current = offset;
        }
        if (!isExplicitNativeCommand && !shouldSkipNativeJsPinForStreamAppend) {
            lastNativeBottomFollowPinCommandRef.current = {
                sessionId: props.sessionId,
                offsetY: offset,
                writtenAtMs: Date.now(),
            };
        }
        if (reason === 'content-size-change') {
            nativeContentMaterializationAutoPinRef.current = null;
        }
        if (
            shouldMarkInitialViewportApplied ||
            (shouldDeferInitialViewportAppliedUntilObserved && offset <= 0)
        ) {
            pendingNativeMountSettleBottomPinRef.current = false;
            markNativeInitialViewportAppliedForCurrentSession();
        }
        if (shouldDeferInitialViewportAppliedUntilObserved && offset > 0) {
            pendingNativeMountSettleBottomPinRef.current = true;
            updateNativeInitialViewportPendingObservation(true);
        }
        return true;
	    }, [
	        canAutoFollowForReason,
	        executeViewportCommand,
	        hasNativeInitialViewportAppliedForCurrentSession,
        markNativeInitialViewportAppliedForCurrentSession,
        nativeMountSettleStable,
        pinThresholdPx,
        props.jumpToSeq,
        props.sessionId,
        resolveViewportCommand,
        updateNativeInitialViewportPendingObservation,
        usesNativeFlashListBottomMaintenance,
    ]);

    const pinNativeInitialFollowBottomViewportIfReady = React.useCallback((
        reason: TranscriptViewportTelemetryScrollReason = 'initial-open',
	    ): boolean => {
	        if (!usesNativeFlashListBottomMaintenance) return false;
	        if (props.jumpToSeq != null) return false;
	        if (!canAutoFollowForReason(reason)) return false;
	        if (hasNativeInitialViewportAppliedForCurrentSession()) return false;
        if (Date.now() - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS) return false;
        if (
            reason === 'initial-open' &&
            (
                pendingNativeMountSettleBottomPinRef.current ||
                lastNativePinOffsetRef.current != null
            )
        ) {
            return true;
        }
        return pinNativeFlashListToBottomIfMeasured({
            force: true,
            markInitialViewportApplied: 'when-scrollable',
            reason,
        });
	    }, [
	        canAutoFollowForReason,
	        hasNativeInitialViewportAppliedForCurrentSession,
        pinNativeFlashListToBottomIfMeasured,
        props.jumpToSeq,
	        usesNativeFlashListBottomMaintenance,
	    ]);

	    const shouldKeepPendingNativeMountSettleBottomPin = React.useCallback((
	        reason: TranscriptViewportTelemetryScrollReason = 'mount-settle',
	    ): boolean => {
	        if (!usesNativeFlashListBottomMaintenance) return false;
	        if (props.jumpToSeq != null) return false;
	        if (!canAutoFollowForReason(reason)) return false;
	        return Date.now() - lastUserScrollIntentAtMsRef.current >= TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS;
	    }, [canAutoFollowForReason, props.jumpToSeq, usesNativeFlashListBottomMaintenance]);

    const shouldIgnoreNativeInvalidScrollObservation = React.useCallback((
        offsetY: number,
        distanceFromBottom: number,
        layoutHeight: number,
        contentHeight: number,
    ): boolean => resolveShouldIgnoreNativeInvalidScrollObservation({
        contentHeight,
        distanceFromBottom,
        isWeb: Platform.OS === 'web',
        layoutHeight,
        offsetY,
    }), []);

	    const pinToBottom = React.useCallback((
        reason: TranscriptViewportTelemetryScrollReason = 'initial-open',
    ) => {
        if (Platform.OS === 'web') {
            // Prefer DOM scroll writes on web: RNW list refs can apply delayed `scrollToOffset` that
            // fights against our pinning and results in visible drift/jitter.
            if (tryPinToBottomDom(reason)) {
                return;
            }
            // If we cannot reliably locate a DOM scroll container yet, avoid falling back to the
            // list ref scroll APIs on web. Early `scrollToOffset({ offset: 0 })` calls can create
            // visible "scroll to top" jitter during mount while the real scroll container is still
            // being attached/measured.
            return;
        }
        if (usesNativeFlashListBottomMaintenance) {
            const isExplicitNativeCommand = reason === 'jump-to-bottom' || reason === 'jump-to-seq';
            if (isExplicitNativeCommand) {
                pendingNativeMountSettleBottomPinRef.current = false;
            }
            pinNativeFlashListToBottomIfMeasured({
                force: isExplicitNativeCommand,
                reason,
            });
            return;
        }
        executeViewportCommand(resolveViewportCommand(reason === 'jump-to-bottom'
            ? {
                type: 'jump-to-bottom',
                sessionId: props.sessionId,
            }
            : {
                type: 'pin-bottom',
                sessionId: props.sessionId,
                reason,
                mode: reason === 'jump-to-seq' ? 'jump-to-seq' : 'follow-bottom',
                animated: false,
            }));
    }, [
        executeViewportCommand,
        pinNativeFlashListToBottomIfMeasured,
        props.sessionId,
        resolveViewportCommand,
        tryPinToBottomDom,
        usesNativeFlashListBottomMaintenance,
    ]);

    const pinToBottomRespectingNativeMountSettle = React.useCallback((
        reason: TranscriptViewportTelemetryScrollReason = 'mount-settle',
    ) => {
        if (usesNativeFlashListBottomMaintenance) {
            if (pinNativeInitialFollowBottomViewportIfReady(reason)) {
                return;
            }
            if (reason === 'initial-open') {
                return;
            }
            if (pinNativeFlashListToBottomIfMeasured({ reason })) {
                if (hasNativeInitialViewportAppliedForCurrentSession()) {
                    pendingNativeMountSettleBottomPinRef.current = false;
                }
                return;
            }
            if (shouldKeepPendingNativeMountSettleBottomPin()) {
                pendingNativeMountSettleBottomPinRef.current = true;
            }
            return;
        }
        pinToBottom(reason);
    }, [
        hasNativeInitialViewportAppliedForCurrentSession,
        pinNativeInitialFollowBottomViewportIfReady,
        pinNativeFlashListToBottomIfMeasured,
        pinToBottom,
        shouldKeepPendingNativeMountSettleBottomPin,
        usesNativeFlashListBottomMaintenance,
    ]);

    const flushPendingNativeMountSettleBottomPin = React.useCallback(() => {
        if (!pendingNativeMountSettleBottomPinRef.current && !nativeMountSettleDeadlineReachedRef.current) return;
        if (!shouldKeepPendingNativeMountSettleBottomPin()) {
            pendingNativeMountSettleBottomPinRef.current = false;
            return;
        }
        if (
            mountSettleCoordinatorRef.current?.getSnapshot().isMountSettleActive === true &&
            !nativeMountSettleDeadlineReachedRef.current
        ) return;
        if (pinNativeFlashListToBottomIfMeasured({
            markInitialViewportApplied: 'when-scrollable',
            reason: 'mount-settle',
        })) {
            if (!hasNativeInitialViewportAppliedForCurrentSession()) {
                return;
            }
            pendingNativeMountSettleBottomPinRef.current = false;
        }
    }, [
        hasNativeInitialViewportAppliedForCurrentSession,
        pinNativeFlashListToBottomIfMeasured,
        shouldKeepPendingNativeMountSettleBottomPin,
    ]);
    flushPendingNativeMountSettleBottomPinRef.current = flushPendingNativeMountSettleBottomPin;

    React.useEffect(() => {
        if (!nativeMountSettleStable) return;
        flushPendingNativeMountSettleBottomPin();
    }, [flushPendingNativeMountSettleBottomPin, nativeMountSettleStable]);

    React.useEffect(() => {
        if (!nativeMountSettleDeadlineReached) return;
        if (nativeMountSettleAutoPinSuppressedRef.current) return;
        if (hasNativeInitialViewportAppliedForCurrentSession()) return;
        pendingNativeMountSettleBottomPinRef.current = true;
        flushPendingNativeMountSettleBottomPin();
    }, [flushPendingNativeMountSettleBottomPin, hasNativeInitialViewportAppliedForCurrentSession, nativeMountSettleDeadlineReached]);

    const jumpToBottom = React.useCallback(() => {
        // Plan F2/A2/F4: an explicit jump preempts and closes BOTH restore transactions
        // BEFORE the write is issued, so no restore decision can fire after the jump.
        preemptEntryRestoreTransaction();
        const prependTransaction = nativePrependTransactionRef.current;
        if (prependTransaction && !prependTransaction.isClosed()) {
            prependTransaction.onTrustedUserScroll();
            finishNativePrependTransaction(prependTransaction);
        }
        viewportAnchorCaptureGenerationRef.current += 1;
        cancelScheduledViewportAnchorCapture();
        if (Platform.OS === 'web') {
	            if (tryPinToBottomDom('jump-to-bottom')) {
	                isPinnedRef.current = true;
	                wantsPinnedRef.current = true;
	                commitBottomFollowModeEvent({ type: 'jump-to-bottom' });
	                setScrollPin((prev) => ({ ...prev, isPinned: true, newActivityCount: 0 }));
                emitViewportChange({ isPinned: true, offsetY: 0, shouldRestoreViewport: false });
                return;
            }
        }
        if (usesNativeFlashListBottomMaintenance) {
            // Arm the single bounded re-confirm (plan B7): if the content height churns
            // before the bottom is observed, ONE more explicit write lands the jump.
            pendingNativeExplicitJumpConfirmRef.current = {
                sessionId: props.sessionId,
                issuedContentHeight: listContentHeightRef.current,
            };
        }
        const command = resolveViewportCommand({
            type: 'jump-to-bottom',
            sessionId: props.sessionId,
        });
        if (!executeViewportCommand(withTranscriptViewportCommandAnimation(command, jumpAnimateScroll))) {
            pinToBottom('jump-to-bottom');
	        }
	        isPinnedRef.current = true;
	        wantsPinnedRef.current = true;
	        commitBottomFollowModeEvent({ type: 'jump-to-bottom' });
	        setScrollPin((prev) => ({ ...prev, isPinned: true, newActivityCount: 0 }));
        emitViewportChange({ isPinned: true, offsetY: 0, shouldRestoreViewport: false });
        if (Platform.OS === 'web') {
            tryPinToBottomDom('jump-to-bottom');
        }
	    }, [
	        cancelScheduledViewportAnchorCapture,
	        commitBottomFollowModeEvent,
	        emitViewportChange,
        executeViewportCommand,
        finishNativePrependTransaction,
        jumpAnimateScroll,
        pinToBottom,
        preemptEntryRestoreTransaction,
        props.sessionId,
        resolveViewportCommand,
        tryPinToBottomDom,
        usesNativeFlashListBottomMaintenance,
    ]);

    React.useLayoutEffect(() => {
        const followBottomIntentKey = props.followBottomIntentKey ?? null;
        if (followBottomIntentKey == null) return;
        if (lastFollowBottomIntentKeyRef.current === followBottomIntentKey) return;

	        lastFollowBottomIntentKeyRef.current = followBottomIntentKey;
	        wantsPinnedRef.current = true;
	        isPinnedRef.current = true;
	        commitBottomFollowModeEvent({ type: 'follow-bottom-intent' });
	        lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
        lastPinOffsetForIntentRef.current = 0;
        viewportAnchorCaptureGenerationRef.current += 1;
        cancelScheduledViewportAnchorCapture();
        preemptEntryRestoreTransaction();
        setScrollPin((prev) => ({ ...prev, isPinned: true, newActivityCount: 0 }));
        emitViewportChange({ isPinned: true, offsetY: 0, shouldRestoreViewport: false });
        pinToBottom();
	    }, [
	        cancelScheduledViewportAnchorCapture,
	        commitBottomFollowModeEvent,
	        emitViewportChange,
	        pinToBottom,
	        preemptEntryRestoreTransaction,
	        props.followBottomIntentKey,
	    ]);

	    const resolveAutoPinWaitMs = React.useCallback((
	        reason: TranscriptViewportTelemetryScrollReason = 'stream-append',
	    ): number | null => {
	        if (!pinEnabled || !autoFollowWhenPinned) return null;
	        if (props.jumpToSeq != null) return null;
	        if (!canAutoFollowForReason(reason)) return null;
	        const elapsedSinceUserIntentMs = Date.now() - lastUserScrollIntentAtMsRef.current;
	        if (elapsedSinceUserIntentMs >= TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS) return 0;
	        return Math.max(0, TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS - elapsedSinceUserIntentMs);
	    }, [autoFollowWhenPinned, canAutoFollowForReason, pinEnabled, props.jumpToSeq]);

	    const schedulePinToBottom = React.useCallback((
	        previousWebMetrics: WebTranscriptScrollMetrics | null = null,
	        reason: TranscriptViewportTelemetryScrollReason = 'stream-append',
    ) => {
        if (listImplementation !== 'flash_v2') return;
	        const waitMs = resolveAutoPinWaitMs(reason);
        if (waitMs === null) return;
        if (scheduledPinRef.current) return;

        const raf = (globalThis as any)?.requestAnimationFrame as undefined | ((cb: () => void) => any);
        if (waitMs === 0 && typeof raf === 'function') {
            const handle: {
                kind: 'raf';
                id: any;
                previousWebMetrics: WebTranscriptScrollMetrics | null;
                reason: TranscriptViewportTelemetryScrollReason;
            } = { kind: 'raf', id: 0, previousWebMetrics, reason };
            scheduledPinRef.current = handle;
            handle.id = raf(() => {
                if (scheduledPinRef.current !== handle) return;
                scheduledPinRef.current = null;
	                if (resolveAutoPinWaitMs(handle.reason) !== 0) return;
                if (handle.previousWebMetrics && applyWebBottomFollowAdjustment(handle.previousWebMetrics, handle.reason)) return;
                if (usesNativeFlashListBottomMaintenance) {
                    pinToBottomRespectingNativeMountSettle(handle.reason);
                    return;
                }
                pinToBottom(handle.reason);
            });
            return;
        }

        const handle: {
            kind: 'timeout';
            id: any;
            previousWebMetrics: WebTranscriptScrollMetrics | null;
            reason: TranscriptViewportTelemetryScrollReason;
        } = { kind: 'timeout', id: null, previousWebMetrics, reason };
        scheduledPinRef.current = handle;
        handle.id = setTimeout(() => {
            if (scheduledPinRef.current !== handle) return;
            scheduledPinRef.current = null;
	            if (resolveAutoPinWaitMs(handle.reason) !== 0) return;
            if (handle.previousWebMetrics && applyWebBottomFollowAdjustment(handle.previousWebMetrics, handle.reason)) return;
            if (usesNativeFlashListBottomMaintenance) {
                pinToBottomRespectingNativeMountSettle(handle.reason);
                return;
            }
            pinToBottom(handle.reason);
        }, waitMs);
    }, [
        applyWebBottomFollowAdjustment,
        listImplementation,
        pinToBottom,
        pinToBottomRespectingNativeMountSettle,
	        resolveAutoPinWaitMs,
	        usesNativeFlashListBottomMaintenance,
	    ]);

	    const updateNativeBottomFollowModeFromScrollObservation = React.useCallback((params: Readonly<{
	        distanceFromBottom: number;
	        isTrusted: boolean;
	        movedAwayFromBottom: boolean;
	        movedTowardBottom: boolean;
	        recentUserIntent: boolean;
	    }>) => {
	        if (Platform.OS === 'web') return;
	        if (params.movedAwayFromBottom && params.recentUserIntent) {
	            commitBottomFollowModeEvent({
	                distanceFromBottom: params.distanceFromBottom,
	                movedAwayFromBottom: true,
	                pinThresholdPx,
	                type: 'trusted-away-observation',
	            });
	            return;
	        }
	        if (params.isTrusted && params.movedTowardBottom) {
	            commitBottomFollowModeEvent({
	                distanceFromBottom: params.distanceFromBottom,
	                movedTowardBottom: true,
	                pinThresholdPx,
	                type: 'trusted-bottom-observation',
	            });
	            return;
	        }
	        if (!params.isTrusted && params.distanceFromBottom <= pinThresholdPx) {
	            commitBottomFollowModeEvent({
	                distanceFromBottom: params.distanceFromBottom,
	                pinThresholdPx,
	                type: 'passive-bottom-observation',
	            });
	        }
	    }, [commitBottomFollowModeEvent, pinThresholdPx]);

	    const handleComposerInsetHeightChange = React.useCallback((height: number) => {
        const nextHeight = typeof height === 'number' && Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0;
        const previousHeight = composerInsetHeightRef.current;
        if (previousHeight === nextHeight) return;
        composerInsetHeightRef.current = nextHeight;

        if (Platform.OS !== 'web' && listImplementation === 'flash_v2') {
            const delta = nextHeight - previousHeight;
            if (delta !== 0 && listContentHeightRef.current > 0) {
                const nextContentHeight = Math.max(0, listContentHeightRef.current + delta);
                listContentHeightRef.current = nextContentHeight;
                if (shouldCommitContentHeightState()) {
                    setListContentHeight(nextContentHeight);
                }
            }
        }

        const nowMs = Date.now();
        observeMountSettleMetrics({ nowMs });
        schedulePinToBottom(null, 'layout-change');
    }, [listImplementation, observeMountSettleMetrics, schedulePinToBottom, shouldCommitContentHeightState]);

    const resolveMeasuredContentHeight = React.useCallback((height: number): number => {
        const normalizedHeight = Math.max(0, Math.trunc(height));
        if (Platform.OS === 'web' || listImplementation !== 'flash_v2') {
            return normalizedHeight;
        }
        return normalizedHeight + composerInsetHeightRef.current;
    }, [listImplementation]);

    const listFooterNode = React.useMemo(() => (
        <>
            {webPrependRangeReservePx > 0 ? (
                <View
                    pointerEvents="none"
                    testID="transcript-web-prepend-range-reserve"
                    style={{ height: webPrependRangeReservePx }}
                />
            ) : null}
            <ChatListFooterWithKeyboardInset
                sessionId={props.sessionId}
                bottomNotice={props.bottomNotice}
                controlledByUserOverride={props.controlledByUserOverride}
                controlSwitchTo={props.controlSwitchTo ?? null}
                onRequestSwitchToRemote={props.onRequestSwitchToRemote}
                directControl={props.directControlFooter}
                onComposerInsetHeightChange={handleComposerInsetHeightChange}
            />
        </>
    ), [
        handleComposerInsetHeightChange,
        props.bottomNotice,
        props.controlSwitchTo,
        props.controlledByUserOverride,
        props.directControlFooter,
        props.onRequestSwitchToRemote,
        props.sessionId,
        webPrependRangeReservePx,
    ]);
    const flashListFooterNode = React.useMemo(() => {
        if (!shouldUseWebHotColdSplit) {
            return listFooterNode;
        }
        return (
            <WebTranscriptSplitFooter
                hotItems={transcriptHotColdSegments.hotItems}
                startIndex={transcriptHotColdSegments.coldItems.length}
                renderItemAtIndex={renderTranscriptItemAtIndex}
                footer={listFooterNode}
                onTailLayout={handleWebHotTailLayout}
            />
        );
    }, [
        handleWebHotTailLayout,
        listFooterNode,
        renderTranscriptItemAtIndex,
        shouldUseWebHotColdSplit,
        transcriptHotColdSegments.coldItems.length,
        transcriptHotColdSegments.hotItems,
    ]);

    React.useLayoutEffect(() => {
        scheduleWebHotTailBottomFollowRef.current = () => {
            if (Platform.OS !== 'web') return;
            if (!shouldUseWebHotColdSplit) return;
            schedulePinToBottom(captureWebBottomFollowPreviousMetrics());
        };
        return () => {
            scheduleWebHotTailBottomFollowRef.current = null;
        };
    }, [captureWebBottomFollowPreviousMetrics, schedulePinToBottom, shouldUseWebHotColdSplit]);

    React.useEffect(() => {
        return () => {
            cancelScheduledPinToBottom();
        };
    }, [cancelScheduledPinToBottom]);

    React.useLayoutEffect(() => {
        // When pinned, proactively keep the list at the visual bottom as new activity arrives.
        // This complements `maintainVisibleContentPosition`, especially on platforms where
        // inverted list anchoring can be inconsistent.
        const latestActivityKey = props.latestCommittedActivityKey;
        const hasNewCommittedActivity =
            latestActivityKey != null &&
            lastProactiveAutoFollowActivityKeyRef.current !== latestActivityKey;
        if (latestActivityKey == null) {
            lastProactiveAutoFollowActivityKeyRef.current = null;
        }
        // Pending rows extend the visible tail before they commit; legacy/web pinning
        // follows the visible tail (one pin per tail version), while the native
        // offset-escape release stays keyed to committed activity.
        const latestVisibleTailKey = props.latestVisibleTailActivityKey;
        const hasNewVisibleTailActivity =
            latestVisibleTailKey != null &&
            lastProactiveAutoFollowVisibleTailKeyRef.current !== latestVisibleTailKey;
        if (latestVisibleTailKey == null) {
            lastProactiveAutoFollowVisibleTailKeyRef.current = null;
        }
        if (hasNewVisibleTailActivity) {
            lastProactiveAutoFollowVisibleTailKeyRef.current = latestVisibleTailKey;
        }
        if (hasNewCommittedActivity || hasNewVisibleTailActivity) {
            if (hasNewCommittedActivity) {
                lastProactiveAutoFollowActivityKeyRef.current = latestActivityKey;
            }
            const nativeOffsetEscapedBottomFollow = hasNewCommittedActivity
                ? releaseNativeBottomFollowIfFlashListOffsetEscaped({
                    contentHeight: listContentHeightRef.current,
                    layoutHeight: listLayoutHeightRef.current,
                })
                : false;
	            if (
                !nativeOffsetEscapedBottomFollow &&
	                pinEnabled &&
	                autoFollowWhenPinned &&
	                isPinnedRef.current &&
	                props.jumpToSeq == null &&
	                canAutoFollowForReason('stream-append') &&
	                !usesNativeFlashListBottomMaintenance
	            ) {
	                // Native flash stream growth pins exactly once per measured content
	                // version from onContentSizeChange (plan B3 single writer).
	                pinToBottomRespectingNativeMountSettle('stream-append');
	            }
        }
        setScrollPin((prev) =>
            reduceTranscriptScrollPinState({ ...prev, isPinned: isPinnedRef.current }, {
                type: 'newActivity',
                enabled: pinEnabled,
                activityKey: props.latestVisibleTailActivityKey,
            })
        );
    }, [
	        autoFollowWhenPinned,
	        canAutoFollowForReason,
	        pinEnabled,
        pinToBottomRespectingNativeMountSettle,
        props.jumpToSeq,
        props.latestCommittedActivityKey,
        props.latestVisibleTailActivityKey,
        releaseNativeBottomFollowIfFlashListOffsetEscaped,
        usesNativeFlashListBottomMaintenance,
    ]);

    React.useEffect(() => {
        if (!props.isLoaded) return;
        if (props.jumpToSeq != null) return;
        if (!props.sessionId) return;
        if (initialPinSessionIdRef.current === props.sessionId) return;
        if (sessionEntryViewportRef.current?.shouldFollowBottom === false) {
            initialPinSessionIdRef.current = props.sessionId;
            initialWebPinStabilizingRef.current = false;
            return;
        }

        // Some platforms (especially web) can apply scroll anchoring / restoration
        // during the first render+layout ticks, resulting in the transcript appearing "scrolled up"
        // after a refresh. The web follow-bottom entry runs through the entry-restore transaction
        // (plan A5): one initial pin write, at most one correction, and a stop-condition of
        // confirm-or-deadline instead of the legacy bottom-stability polling.
        initialPinSessionIdRef.current = props.sessionId;
        let cancelled = false;

        const tuning = sync.getSyncTuning();
        const stabilizeMaxMsRaw = tuning.transcriptWebInitialPinStabilizeMs;
        const retryIntervalMsRaw = tuning.transcriptWebInitialPinRetryIntervalMs;
        const stabilizeMaxMs =
            typeof stabilizeMaxMsRaw === 'number' && Number.isFinite(stabilizeMaxMsRaw)
                ? Math.max(0, Math.trunc(stabilizeMaxMsRaw))
                : 0;
        const retryIntervalMs =
            typeof retryIntervalMsRaw === 'number' && Number.isFinite(retryIntervalMsRaw)
                ? Math.max(16, Math.trunc(retryIntervalMsRaw))
                : 250;

        const ensureWebEntryBottomTransaction = (): EntryRestoreTransaction | null => {
            const existing = entryRestoreTransactionRef.current;
            if (existing) {
                return existing.sessionId === props.sessionId ? existing : null;
            }
            const metrics = resolveWebScrollMetrics();
            if (!metrics) return null;
            // First write of the web follow-bottom entry.
            pinToBottom();
            const nowMs = Date.now();
            const transaction = createEntryRestoreTransaction({
                sessionId: props.sessionId,
                target: { kind: 'bottom' },
                nowMs,
                deadlineMs: stabilizeMaxMs,
            });
            entryRestoreTransactionRef.current = transaction;
            entryRestoreWriteContextRef.current = {
                anchor: null,
                createdAtMs: nowMs,
                distanceFromBottom: 0,
                issuedContentHeight: Math.max(0, Math.trunc(metrics.scrollHeight)),
                issuedLayoutHeight: Math.max(0, Math.trunc(metrics.clientHeight)),
                kind: 'bottom',
                sessionId: props.sessionId,
                targetOffsetY: null,
                targetOffsetYWasClamped: false,
            };
            armEntryRestoreDeadline(transaction, stabilizeMaxMs);
            return transaction;
        };

        const attempt = (): boolean => {
            if (cancelled) return true;
            // If the user is actively scrolling (or scroll inertia is still firing wheel events),
            // avoid fighting their intent with initial pin retries.
            if (Platform.OS === 'web') {
                if (wantsPinnedRef.current === false) {
                    preemptEntryRestoreTransaction();
                    initialWebPinStabilizingRef.current = false;
                    return true;
                }
                if (Date.now() - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS) return false;
                const transaction = ensureWebEntryBottomTransaction();
                if (!transaction) return false;
                if (!transaction.isClosed()) {
                    verifyWebEntryRestoreTransaction();
                }
                if (transaction.isClosed()) {
                    initialWebPinStabilizingRef.current = false;
                    return true;
                }
                return false;
            }
            pinToBottomRespectingNativeMountSettle('initial-open');
            return false;
        };

        if (Platform.OS === 'web') {
            const startedAtMs = Date.now();

            if (stabilizeMaxMs <= 0 || attempt()) {
                if (stabilizeMaxMs <= 0) {
                    attempt();
                }
                return () => {
                    cancelled = true;
                    initialWebPinStabilizingRef.current = false;
                };
            }

            const delays = resolveInitialWebPinRetryDelays({
                milestonesMs: tuning.transcriptWebInitialPinRetryMilestonesMs,
                stabilizeMaxMs,
                retryIntervalMs,
            });

            if (delays.length === 0) {
                initialWebPinStabilizingRef.current = false;
                return () => {
                    cancelled = true;
                };
            }

            initialWebPinStabilizingRef.current = true;
            let timeoutId: ReturnType<typeof setTimeout> | null = null;
            let delayIndex = 0;

            const scheduleNext = () => {
                if (cancelled) return;
                if (delayIndex >= delays.length) {
                    initialWebPinStabilizingRef.current = false;
                    return;
                }
                const delayMs = delays[delayIndex];
                delayIndex += 1;
                const timeoutMs = resolveWebPinRetryTimeoutMs({
                    startedAtMs,
                    nowMs: Date.now(),
                    milestoneMs: delayMs,
                });
                timeoutId = setTimeout(() => {
                    timeoutId = null;
                    if (attempt()) return;
                    scheduleNext();
                }, timeoutMs);
            };

            scheduleNext();
            return () => {
                cancelled = true;
                initialWebPinStabilizingRef.current = false;
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
            };
        }

        // One idempotent settle pin per mount window (plan B4): pin once; the
        // mount-settle coordinator owns any later settle pin.
        attempt();
        return () => { cancelled = true; };
    }, [armEntryRestoreDeadline, pinNativeFlashListToBottomIfMeasured, pinToBottom, pinToBottomRespectingNativeMountSettle, preemptEntryRestoreTransaction, props.isLoaded, props.jumpToSeq, props.sessionId, resolveWebScrollMetrics, verifyWebEntryRestoreTransaction]);

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

    const flashListStartReachedThreshold = React.useMemo(() => {
        if (!Number.isFinite(listLayoutHeight) || listLayoutHeight <= 0) {
            return TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO;
        }
        const thresholdPx = resolveBackwardPrefetchThresholdPx(listLayoutHeight);
        if (thresholdPx <= 0) return 0;
        return thresholdPx / listLayoutHeight;
    }, [listLayoutHeight, resolveBackwardPrefetchThresholdPx]);

    const resolveToolCallsCollapsedPreviewCount = React.useCallback((): number => {
        return resolveTranscriptToolCallsCollapsedPreviewCount(transcriptToolCallsCollapsedPreviewCountSetting);
    }, [transcriptToolCallsCollapsedPreviewCountSetting]);

    const tryAutoExpandNewestToolCallsGroup = React.useCallback((): boolean => {
        const previewCount = resolveToolCallsCollapsedPreviewCount();
        const items = itemsRef.current;
        const newestFirst = listImplementation === 'flatlist_legacy';
        const shouldAutoExpandGroup = (toolMessageIds: readonly string[]): boolean => (
            shouldAutoExpandToolCallsGroupForShortTranscript({
                toolMessageCount: toolMessageIds.length,
                collapsedPreviewCount: previewCount,
                maxTurnEntriesPerListItem: props.maxTurnEntriesPerListItem,
            })
        );

        const visitItem = (it: ChatTranscriptListItem | null | undefined): boolean => {
            if (!it) return false;
            if (it.kind === 'tool-calls-group') {
                const toolMessageIds = it.toolMessageIds;
                if (!shouldAutoExpandGroup(toolMessageIds)) return false;
                if (toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id))) return false;
                applyToolCallsGroupExpanded({ toolCallsGroupId: it.id, toolMessageIds, expanded: true });
                return true;
            }
            if (it.kind === 'turn') {
                const content = it.turn?.content;
                if (!Array.isArray(content) || content.length === 0) return false;
                for (let j = content.length - 1; j >= 0; j -= 1) {
                    const c = content[j];
                    if (c.kind !== 'tool_calls') continue;
                    const toolMessageIds = c.toolMessageIds;
                    if (!shouldAutoExpandGroup(toolMessageIds)) continue;
                    if (toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id))) continue;
                    applyToolCallsGroupExpanded({ toolCallsGroupId: c.id, toolMessageIds, expanded: true });
                    return true;
                }
            }
            return false;
        };

        if (newestFirst) {
            for (let i = 0; i < items.length; i += 1) {
                if (visitItem(items[i])) return true;
            }
            return false;
        }
        for (let i = items.length - 1; i >= 0; i -= 1) {
            if (visitItem(items[i])) return true;
        }
        return false;
    }, [
        applyToolCallsGroupExpanded,
        expandedToolCallsAnchorMessageIds,
        listImplementation,
        props.maxTurnEntriesPerListItem,
        resolveToolCallsCollapsedPreviewCount,
    ]);

    React.useEffect(() => {
        // Intentionally runs after every render until the transcript becomes scrollable or we succeed.
        // The turns/grouping builder can update in-place as message bodies hydrate, so relying on
        // `items`/`listData` identity is not robust here.
        if (props.jumpToSeq != null) return;
        if (!props.sessionId) return;
        if (didAutoExpandToolCallsGroupsForSessionRef.current === props.sessionId) return;
        if (isScrollable()) return;

        const expanded = tryAutoExpandNewestToolCallsGroup();
        if (!expanded) return;

        didAutoExpandToolCallsGroupsForSessionRef.current = props.sessionId;
        fireAndForget((async () => {
            await Promise.resolve();
            await Promise.resolve();
            if (sessionEntryViewportRef.current?.shouldFollowBottom === false) return;
            pinToBottom();
        })(), { tag: 'ChatList.autoExpandToolCallsGroup' });
    });

    const resolveJumpIndex = React.useCallback((): number | null => {
        const target = props.jumpToSeq;
        if (typeof target !== 'number' || !Number.isFinite(target) || target < 0) return null;

        let exact: number | null = null;
        let nextAfter: { idx: number; seq: number } | null = null;
        let prevBefore: { idx: number; seq: number } | null = null;
        const items = itemsRef.current;

        const considerSeq = (idx: number, seq: number) => {
            const normalizedSeq = Math.trunc(seq);
            if (normalizedSeq === target) {
                exact = idx;
                return;
            }
            if (normalizedSeq > target) {
                if (!nextAfter || normalizedSeq < nextAfter.seq) nextAfter = { idx, seq: normalizedSeq };
            } else if (normalizedSeq < target) {
                if (!prevBefore || normalizedSeq > prevBefore.seq) prevBefore = { idx, seq: normalizedSeq };
            }
        };

        for (let i = 0; i < items.length; i++) {
            const it = items[i]!;
            if (it.kind === 'message') {
                const seq = it.seq ?? resolveSeqForMessageId(it.messageId);
                if (typeof seq === 'number' && Number.isFinite(seq)) considerSeq(i, seq);
            } else if (it.kind === 'turn') {
                const userSeq = it.turn.userMessageId ? resolveSeqForMessageId(it.turn.userMessageId) : null;
                if (typeof userSeq === 'number' && Number.isFinite(userSeq)) considerSeq(i, userSeq);
                for (const c of it.turn.content) {
                    if (c.kind === 'message') {
                        const seq = resolveSeqForMessageId(c.messageId);
                        if (typeof seq === 'number' && Number.isFinite(seq)) considerSeq(i, seq);
                    } else if (c.kind === 'tool_calls') {
                        for (const toolMessageId of c.toolMessageIds) {
                            const seq = resolveSeqForMessageId(toolMessageId);
                            if (typeof seq === 'number' && Number.isFinite(seq)) considerSeq(i, seq);
                        }
                    }
                    if (exact != null) break;
                }
            }
            if (exact != null) break;
        }
        if (exact != null) return exact;
        if (nextAfter) return nextAfter.idx;
        if (prevBefore) return prevBefore.idx;
        return null;
    }, [props.jumpToSeq, resolveSeqForMessageId]);

    React.useEffect(() => {
        const target = props.jumpToSeq;
        if (typeof target !== 'number' || !Number.isFinite(target) || target < 0) return;
        if (!props.isLoaded) return;
        if (lastJumpSeqRef.current === target) return;
        if (!props.sessionId) return;

        lastJumpSeqRef.current = target;
        fireAndForget((async () => {
            await jumpToTranscriptSeq({
                targetSeq: target,
                getIndex: resolveJumpIndex,
                loadOlder: async () => {
                    const syncLoadOlderOptions = resolveSyncLoadOlderOptions();
                    const result = props.forkedTranscriptEnabled
                        ? (syncLoadOlderOptions
                            ? await sync.loadOlderMessagesForkAware(props.sessionId, syncLoadOlderOptions)
                            : await sync.loadOlderMessagesForkAware(props.sessionId))
                        : (syncLoadOlderOptions
                            ? await sync.loadOlderMessages(props.sessionId, syncLoadOlderOptions)
                            : await sync.loadOlderMessages(props.sessionId));
                    if (result.status === 'no_more') return { status: 'no_more' as const };
                    return { status: 'loaded' as const, hasMore: result.hasMore };
                },
                afterLoadOlder: async () => {
                    // Yield to allow store updates + list re-render before re-checking `getIndex`.
                    await Promise.resolve();
                    await Promise.resolve();
                },
                scrollToIndex: (index) => {
                    if (shouldUseWebHotColdSplit) {
                        const decision = resolveWebHotColdScrollDecision({
                            fullIndex: index,
                            coldCount: transcriptHotColdSegments.coldItems.length,
                        });
                        if (decision.kind === 'pin_to_bottom') {
                            pinToBottom('jump-to-seq');
                            return;
                        }
                        const command = resolveViewportCommand({
                            type: 'jump-to-seq',
                            sessionId: props.sessionId,
                            seq: target,
                            index: decision.index,
                        });
                        executeViewportCommand(withTranscriptViewportCommandAnimation(command, true));
                        return;
                    }
                    const command = resolveViewportCommand({
                        type: 'jump-to-seq',
                        sessionId: props.sessionId,
                        seq: target,
                        index,
                    });
                    executeViewportCommand(withTranscriptViewportCommandAnimation(command, true));
                },
                maxLoads: 25,
            });
        })(), { tag: 'ChatList.jumpToTranscriptSeq' });
    }, [
        executeViewportCommand,
        pinToBottom,
        props.forkedTranscriptEnabled,
        props.isLoaded,
        props.jumpToSeq,
        props.sessionId,
        resolveJumpIndex,
        resolveSyncLoadOlderOptions,
        resolveViewportCommand,
        shouldUseWebHotColdSplit,
        transcriptHotColdSegments.coldItems.length,
    ]);

    React.useEffect(() => {
        if (!props.isLoaded) return;
        if (props.jumpToSeq != null) return;
        if (!props.sessionId) return;
        if (initialFillStatusRef.current !== 'idle') return;

        // Wait for at least one layout + content measurement pass before deciding whether to fill.
        if (listLayoutHeight <= 0 || listContentHeight <= 0) return;

        initialFillStatusRef.current = 'in_progress';
        initialFillAbortRef.current?.abort();
        const controller = new AbortController();
        initialFillAbortRef.current = controller;
        const signal = controller.signal;
        const shouldPinDuringInitialFill = sessionEntryViewportRef.current?.shouldFollowBottom !== false;
        fireAndForget((async () => {
            if (shouldPinDuringInitialFill) {
                // Pin once up front; this protects against initial layout anchoring quirks on web.
                pinToBottomRespectingNativeMountSettle('initial-open');
                if (Platform.OS === 'web') {
                    // D5 (evidence E10): rAF starvation must not stall the initial fill.
                    await waitForVisualUpdateWithTimeout({
                        waitForNextVisualUpdate,
                        timeoutMs: TRANSCRIPT_VISUAL_UPDATE_FALLBACK_TIMEOUT_MS,
                    });
                }
            }

            const tuning = sync.getSyncTuning();
            const startedAtMs = Date.now();
            const { budgetMs, maxNoProgressLoads } = resolveTranscriptInitialFillTuning({
                transcriptInitialFillBudgetMs: tuning.transcriptInitialFillBudgetMs,
                transcriptInitialFillMaxNoProgressLoads: tuning.transcriptInitialFillMaxNoProgressLoads,
            });
            let consecutiveNoProgressLoads = 0;

            while (true) {
                if (signal.aborted) return;
                // If the transcript is scrollable and we have at least one visible committed message,
                // stop prefetching older pages.
                if (isScrollable() && props.committedMessagesCount > 0) break;
                if (Date.now() - startedAtMs >= budgetMs) break;

                const result = await loadOlder({ preservePrependViewport: false, showLoadingIndicator: false });
                if (!result) break;
                if (result.status === 'no_more') break;

                const madeProgress = result.status === 'loaded' && result.loaded > 0;
                consecutiveNoProgressLoads = madeProgress ? 0 : consecutiveNoProgressLoads + 1;

                // Yield to allow store updates + list re-render + content size update.
                await Promise.resolve();
                await Promise.resolve();
                if (shouldPinDuringInitialFill && wantsPinnedRef.current) {
                    pinToBottomRespectingNativeMountSettle('initial-open');
                }
                if (consecutiveNoProgressLoads >= maxNoProgressLoads) break;
            }
            if (signal.aborted) return;
            initialFillStatusRef.current = 'done';
            if (!shouldPinDuringInitialFill) {
                // Fill settled: resolve (and verify on web) the entry-restore transaction.
                attemptEntryRestore();
                verifyWebEntryRestoreTransaction();
            }
        })(), { tag: 'ChatList.initialFillOlderMessages' });
    }, [
        attemptEntryRestore,
        isScrollable,
        listContentHeight,
        listLayoutHeight,
        loadOlder,
        pinToBottomRespectingNativeMountSettle,
        props.committedMessagesCount,
        props.isLoaded,
        props.jumpToSeq,
        props.sessionId,
        verifyWebEntryRestoreTransaction,
        waitForNextVisualUpdate,
    ]);

    return (
        <TranscriptMotionProvider sessionKey={props.sessionId} config={motionConfig}>
            <View
              style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}
              {...(Platform.OS === 'web'
                ? ({
                                        onWheel: stopScrollEventPropagationOnWeb,
                                        onTouchMove: stopScrollEventPropagationOnWeb,
                                        onPointerDown: markUserScrollIntentOnWeb,
                                        onMouseDown: markUserScrollIntentOnWeb,
                                  } as any)
                : ({
                                        onTouchMove: recordNativeTranscriptTouchIntent,
                                  } as any))}
            >
          {listImplementation === 'flatlist_legacy' ? (
          <FlatList<ChatTranscriptListItem>
          ref={(node) => {
            // react-test-renderer does not provide a stable ref object; we store it manually.
            listRef.current = node as unknown as ScrollableChatListRef | null;
          }}
            {...(Platform.OS === 'web'
              ? ({
                                    onWheel: stopScrollEventPropagationOnWeb,
                                    onTouchMove: stopScrollEventPropagationOnWeb,
                                    onPointerDown: markUserScrollIntentOnWeb,
                                    onMouseDown: markUserScrollIntentOnWeb,
                              } as any)
              : ({
                                    onTouchMove: recordNativeTranscriptTouchIntent,
                              } as any))}
          testID="transcript-chat-list"
          data={listData}
          extraData={transcriptMessageSelection.selectionVersion}
          inverted={true}
          nativeID={chatListNativeId}
                  keyExtractor={keyExtractor}
          maintainVisibleContentPosition={
                        flatListMaintainVisibleContentPosition
                      }
                onLayout={(e) => {
                    const h = e?.nativeEvent?.layout?.height;
                    const w = e?.nativeEvent?.layout?.width;
                    if (typeof w === 'number' && Number.isFinite(w)) {
                        listLayoutWidthRef.current = w;
                        setListLayoutWidth(w);
                    }
                    if (typeof h === 'number' && Number.isFinite(h)) {
                        const layoutHeightChanged = listLayoutHeightRef.current !== h;
                        listLayoutHeightRef.current = h;
                        setListLayoutHeight(h);
                        if (layoutHeightChanged) {
                            recordViewportTelemetryEvent({
                                type: 'layout-measured',
                                mode: resolveViewportTelemetryMode(),
                                reason: 'layout-change',
                                layoutHeight: h,
                                contentHeight: listContentHeightRef.current,
                            });
                        }
                    }
                }}
                onContentSizeChange={(_, h) => {
                    if (typeof h === 'number' && Number.isFinite(h)) {
                        const contentHeightChanged = listContentHeightRef.current !== h;
                        listContentHeightRef.current = h;
                        setListContentHeight(h);
                        if (contentHeightChanged) {
                            recordViewportTelemetryEvent({
                                type: 'content-measured',
                                mode: resolveViewportTelemetryMode(),
                                reason: 'content-size-change',
                                layoutHeight: listLayoutHeightRef.current,
                                contentHeight: h,
                            });
                        }
                    }
                }}
                onScroll={(e) => {
	                    const y = e?.nativeEvent?.contentOffset?.y;
	                    if (typeof y !== 'number' || !Number.isFinite(y)) return;
	                    const nowMs = Date.now();
	                    const isTrusted = (e as any)?.nativeEvent?.isTrusted === true;
                    const shouldIgnoreInvalidNativeScroll = shouldIgnoreNativeInvalidScrollObservation(
                        y,
                        y,
                        listLayoutHeightRef.current,
                        listContentHeightRef.current,
                    );
	                    if (Platform.OS !== 'web') {
	                        recordScrollObservedTelemetry({
	                            offsetY: y,
	                            layoutHeight: listLayoutHeightRef.current,
	                            contentHeight: listContentHeightRef.current,
	                            distanceFromBottom: y,
                            reason: shouldIgnoreInvalidNativeScroll
                                ? 'invalid-native-offset'
                                : 'observed',
	                        });
	                    }
                    // Invalid (NaN/negative) observations are dropped only (plan B5):
                    // no recovery repin side effects.
                    if (shouldIgnoreInvalidNativeScroll) return;
                    if (isTrusted) {
                        recordNativeUserScrollIntent(nowMs);
                    }
                    const shouldSuppressPassiveNativeAnchorCapture =
                        Platform.OS !== 'web' && !isTrusted && !wantsPinnedRef.current && y > pinThresholdPx;
	                    const flatListPreviousScrollOffset =
	                        lastScrollOffsetForIntentRef.current ?? (wantsPinnedRef.current ? 0 : null);
	                    const flatListMovedAwayFromBottom =
	                        flatListPreviousScrollOffset !== null && y > flatListPreviousScrollOffset;
	                    const flatListMovedTowardBottom =
	                        flatListPreviousScrollOffset !== null && y < flatListPreviousScrollOffset;
	                    const recentUserIntent = isTrusted || nowMs - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_RECENT_MS;
	                    const followIntent = resolveTranscriptBottomFollowIntent({
	                        // Plan B6 trusted-gate: on native only trusted scrolls release follow;
	                        // web keeps gesture-derived recent intent as release authority.
	                        canRelease: Platform.OS === 'web' ? recentUserIntent : isTrusted,
	                        direction: 'toward-zero',
	                        distanceFromBottom: y,
	                        pinThresholdPx,
	                        previousScrollOffset: flatListPreviousScrollOffset,
	                        scrollOffset: y,
	                        wantsPinned: wantsPinnedRef.current,
	                    });
	                    updateNativeBottomFollowModeFromScrollObservation({
	                        distanceFromBottom: followIntent.nextDistanceFromBottom,
	                        isTrusted,
	                        movedAwayFromBottom: flatListMovedAwayFromBottom,
	                        movedTowardBottom: flatListMovedTowardBottom,
	                        recentUserIntent,
	                    });
                    if (
                        Platform.OS !== 'web' &&
                        !isTrusted &&
                        bottomFollowModeStateRef.current.mode !== 'following' &&
                        followIntent.isPinned &&
                        followIntent.wantsPinned
                    ) {
                        return;
                    }
                    lastPinOffsetForIntentRef.current = followIntent.nextDistanceFromBottom;
                    lastScrollOffsetForIntentRef.current = followIntent.nextScrollOffset;
                    wantsPinnedRef.current = followIntent.wantsPinned;

                    const distanceFromBottom = followIntent.nextDistanceFromBottom;
                    const effectiveThresholdPx = followIntent.effectivePinnedOffsetThresholdPx;
                    const pinned = followIntent.isPinned;
                    if (
                        !pinned &&
                        wantsPinnedRef.current &&
                        pinEnabled &&
                        autoFollowWhenPinned &&
	                                    props.jumpToSeq == null &&
	                                    canAutoFollowForReason('stream-append') &&
	                                    Platform.OS !== 'web' &&
                        nowMs - lastAutoRepinAtMsRef.current > TRANSCRIPT_SCROLL_AUTO_REPIN_THROTTLE_MS &&
                        nowMs - lastUserScrollIntentAtMsRef.current >= TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS
                    ) {
                        // Web/virtualization can sometimes drift the scroll position even without user intent.
                        // If we still "want pinned", repin opportunistically.
                        lastAutoRepinAtMsRef.current = nowMs;
                        pinToBottom('stream-append');
                    }
                    isPinnedRef.current = pinned;
                    const viewportState = {
                        isPinned: pinned,
                        offsetY: distanceFromBottom,
                        shouldRestoreViewport: !wantsPinnedRef.current,
                    };
                    emitViewportChange(viewportState);
                    scheduleViewportAnchorCapture(viewportState, {
                        suppressAnchorCapture: shouldSuppressPassiveNativeAnchorCapture,
                    });
                    commitJumpToBottomDistanceForVisibility(distanceFromBottom);
                    setScrollPin((prev) =>
                        reduceTranscriptScrollPinState(prev, {
                            type: 'scroll',
                            enabled: pinEnabled,
                            offsetY: distanceFromBottom,
                            pinnedOffsetThresholdPx: effectiveThresholdPx,
                        })
                    );

                    drainDeferredNewerMessages({ distanceFromBottom, pinned });
                }}
	                onScrollBeginDrag={recordNativeListDragEscapeIntent}
	                onScrollEndDrag={recordNativeListDragEndIntent}
                scrollEventThrottle={TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS}
                keyboardShouldPersistTaps="handled"
          keyboardDismissMode="none"
                renderItem={renderItem}
                onEndReachedThreshold={0.2}
                onEndReached={() => {
                    if (initialFillStatusRef.current !== 'done') return;
                    void loadOlder();
                }}
                onScrollToIndexFailed={(info: { index: number; averageItemLength: number }) => {
                    if (handleNativeRestoreIndexFailure(info.index)) return;
                    if (props.jumpToSeq == null) return;
                    // Best-effort fallback for dynamic-height explicit jump targets.
                    const offset = Math.max(0, Math.trunc(info.averageItemLength * info.index));
                    executeViewportCommand(resolveViewportCommand({
                        type: 'scroll-offset',
                        sessionId: props.sessionId,
                        reason: 'jump-to-seq',
                        mode: 'jump-to-seq',
                        offsetY: offset,
                        animated: true,
                    }));
                }}
                  ListHeaderComponent={listHeaderNode}
                  ListFooterComponent={
                        listFooterNode
                    }
              />
              ) : (
                <LayoutCommitObserver onCommitLayoutEffect={recordLayoutCommitObserved}>
                  <FlashList
                      ref={(node: ScrollableChatListRef | null) => {
                          listRef.current = node as unknown as ScrollableChatListRef | null;
                      }}
                        {...(Platform.OS === 'web'
                            ? ({
                                        onWheel: stopScrollEventPropagationOnWeb,
                                        onTouchMove: stopScrollEventPropagationOnWeb,
                                        onPointerDown: markUserScrollIntentOnWeb,
                                        onMouseDown: markUserScrollIntentOnWeb,
                                  } as any)
                            : ({
                                        onTouchMove: recordNativeTranscriptTouchIntent,
                                  } as any))}
                        testID="transcript-chat-list"
                      data={listData}
                      extraData={transcriptMessageSelection.selectionVersion}
                      nativeID={chatListNativeId}
                      keyExtractor={keyExtractor}
                        overrideProps={nativeFlashListScrollOverrideProps}
                        getItemType={getItemType}
                      drawDistance={flashListDrawDistance}
                      onLoad={recordFirstListPaint}
                      maintainVisibleContentPosition={
                          flashListMaintainVisibleContentPosition
                      }
                      onLayout={(e: LayoutChangeEvent) => {
                          const h = e?.nativeEvent?.layout?.height;
                          const w = e?.nativeEvent?.layout?.width;
                          if (typeof w === 'number' && Number.isFinite(w)) {
                              listLayoutWidthRef.current = w;
                              setListLayoutWidth(w);
                          }
                          if (typeof h === 'number' && Number.isFinite(h)) {
                              const layoutHeightChanged = listLayoutHeightRef.current !== h;
                              const previousWebMetrics = captureWebBottomFollowPreviousMetrics();
                              listLayoutHeightRef.current = h;
                              setListLayoutHeight(h);
                              if (layoutHeightChanged) {
                                  recordViewportTelemetryEvent({
                                      type: 'layout-measured',
                                      mode: resolveViewportTelemetryMode(),
                                      reason: 'layout-change',
                                      layoutHeight: h,
                                      contentHeight: listContentHeightRef.current,
                                  });
                              }
                              pinNativeInitialFollowBottomViewportIfReady('layout-change');
                              if (Platform.OS !== 'web' && listImplementation === 'flash_v2') {
                                  observeNativePrependTransaction();
                              }
                              if (Platform.OS !== 'web' && sessionEntryViewportRef.current?.shouldFollowBottom === false) {
                                  // One transaction per entry: this only resolves while no
                                  // transaction exists yet (no E1 reapply on layout change).
                                  attemptEntryRestore();
                              }
                                if (layoutHeightChanged && listContentHeightRef.current > 0) {
                                    schedulePinToBottom(previousWebMetrics, 'layout-change');
                                }
                                observeMountSettleMetrics();
                          }
                      }}
                      onContentSizeChange={(_: number, h: number) => {
                          if (typeof h === 'number' && Number.isFinite(h)) {
                              const measuredContentHeight = resolveMeasuredContentHeight(h);
                              const previousMeasuredContentHeight = listContentHeightRef.current;
                              const contentHeightChanged = previousMeasuredContentHeight !== measuredContentHeight;
                              const contentHeightGrew = measuredContentHeight > previousMeasuredContentHeight;
                              const previousMeasuredActivityKey = lastMeasuredContentActivityKeyRef.current;
                              const latestActivityKey = props.latestCommittedActivityKey;
                              const contentSizeScrollReason: TranscriptViewportTelemetryScrollReason =
                                  props.sessionActive &&
                                  previousMeasuredActivityKey != null &&
                                  latestActivityKey != null &&
                                  (
                                      previousMeasuredActivityKey !== latestActivityKey ||
                                      (previousMeasuredActivityKey === latestActivityKey && contentHeightGrew)
                                  )
                                      ? 'stream-append'
                                      : 'content-size-change';
                              const materializationLayoutHeight = listLayoutHeightRef.current;
                              const materializationDeltaHeight = measuredContentHeight - previousMeasuredContentHeight;
                              const materializationPreviousTargetOffsetY =
                                  Number.isFinite(materializationLayoutHeight) && materializationLayoutHeight > 0
                                      ? Math.max(0, Math.trunc(previousMeasuredContentHeight - materializationLayoutHeight))
                                      : 0;
                              const lastNativeBottomFollowPinCommand = lastNativeBottomFollowPinCommandRef.current;
                              const hasNativeBottomFollowPinCommandForCurrentSession =
                                  lastNativeBottomFollowPinCommand?.sessionId === props.sessionId;
                              const shouldAllowNativeContentMaterializationAutoPin =
                                  Platform.OS !== 'web' &&
                                  usesNativeFlashListBottomMaintenance &&
                                  contentSizeScrollReason === 'content-size-change' &&
                                  wantsPinnedRef.current &&
                                  (
                                      hasNativeInitialViewportAppliedForCurrentSession() ||
                                      hasNativeBottomFollowPinCommandForCurrentSession
                                  ) &&
                                  previousMeasuredContentHeight > 0 &&
                                  Number.isFinite(materializationLayoutHeight) &&
                                  materializationLayoutHeight > 0 &&
                                  materializationDeltaHeight >= materializationLayoutHeight &&
                                  materializationPreviousTargetOffsetY <= Math.max(
                                      pinThresholdPx,
                                      materializationLayoutHeight * 0.5,
                                  );
                              nativeContentMaterializationAutoPinRef.current =
                                  shouldAllowNativeContentMaterializationAutoPin
                                      ? { sessionId: props.sessionId, contentHeight: measuredContentHeight }
                                      : null;
                              const previousWebMetrics = captureWebBottomFollowPreviousMetrics();
                              markNativeContentMeasurementForCurrentSession();
                              listContentHeightRef.current = measuredContentHeight;
                              lastMeasuredContentActivityKeyRef.current = props.latestCommittedActivityKey;
                                if (shouldCommitContentHeightState()) {
                                    setListContentHeight(measuredContentHeight);
                                }
                                if (
                                    contentHeightChanged &&
                                    contentSizeScrollReason === 'stream-append' &&
                                    Platform.OS !== 'web'
                                ) {
                                    releaseNativeBottomFollowIfFlashListOffsetEscaped({
                                        contentHeight: measuredContentHeight,
                                        layoutHeight: listLayoutHeightRef.current,
                                    });
                                }
                                if (contentHeightChanged) {
                                    recordViewportTelemetryEvent({
                                        type: 'content-measured',
                                        mode: resolveViewportTelemetryMode(),
                                        reason: contentSizeScrollReason,
                                        layoutHeight: listLayoutHeightRef.current,
                                        contentHeight: measuredContentHeight,
                                    });
                                }
                                pinNativeInitialFollowBottomViewportIfReady(contentSizeScrollReason);
                                if (Platform.OS !== 'web' && listImplementation === 'flash_v2') {
                                    observeNativePrependTransaction();
                                }
                                if (Platform.OS !== 'web' && sessionEntryViewportRef.current?.shouldFollowBottom === false) {
                                    // One transaction per entry: content-size changes can only
                                    // resolve a not-yet-issued restore, never re-issue one (E1).
                                    attemptEntryRestore();
                                }
                                if (contentHeightChanged && listLayoutHeightRef.current > 0) {
                                    schedulePinToBottom(previousWebMetrics, contentSizeScrollReason);
                                }
                                observeMountSettleMetrics();
                          }
                      }}
                        onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
                            const y = e?.nativeEvent?.contentOffset?.y;
                            if (typeof y !== 'number' || !Number.isFinite(y)) return;
                                const nowMs = Date.now();
                                const isTrusted = (e as any)?.nativeEvent?.isTrusted === true;
                              const eventLayoutH =
                                  Platform.OS !== 'web'
                                      ? resolveNativeScrollEventMetric(e?.nativeEvent?.layoutMeasurement?.height)
                                      : null;
                              const eventContentH =
                                  Platform.OS !== 'web'
                                      ? resolveNativeScrollEventMetric(e?.nativeEvent?.contentSize?.height)
                                      : null;
                              const layoutH = eventLayoutH ?? listLayoutHeightRef.current;
                              const contentH = eventContentH ?? listContentHeightRef.current;
                              const refDistanceFromBottom =
                                  layoutH > 0 && contentH >= layoutH
                                      ? Math.max(0, Math.trunc(contentH - layoutH - y))
                                      : 0;
                                const refVisualBottomScrollOffset =
                                    layoutH > 0 && contentH >= layoutH
                                        ? Math.max(0, Math.trunc(contentH - layoutH))
                                        : null;
                                const recordNativeScrollObservation = (
                                    reason: TranscriptViewportTelemetryObservationReason = 'observed',
                                ) => {
                                    if (Platform.OS === 'web') return;
                                    recordScrollObservedTelemetry({
                                        offsetY: y,
                                        layoutHeight: layoutH,
                                        contentHeight: contentH,
                                        distanceFromBottom: refDistanceFromBottom,
                                        reason,
                                    });
                                };
                                const shouldIgnoreInvalidNativeScroll = shouldIgnoreNativeInvalidScrollObservation(
                                    y,
                                    refDistanceFromBottom,
                                    layoutH,
                                    contentH,
                                );
                                if (shouldIgnoreInvalidNativeScroll) {
                                    // Drop-only (plan B5): no recovery repin side effects.
                                    recordNativeScrollObservation('invalid-native-offset');
                                    return;
                                }
                                const shouldSuppressPassiveNativeAnchorCapture =
                                    Platform.OS !== 'web' &&
                                    !isTrusted &&
                                    !wantsPinnedRef.current &&
                                    refDistanceFromBottom > pinThresholdPx;
                                const entryRestoreTransaction = entryRestoreTransactionRef.current;
                                const hasOpenNativeEntryRestoreTransaction =
                                    Platform.OS !== 'web' &&
                                    entryRestoreTransaction != null &&
                                    entryRestoreTransaction.sessionId === props.sessionId &&
                                    !entryRestoreTransaction.isClosed();
                                const commitOpenEntryRestoreVisibleState = () => {
                                    if (Platform.OS === 'web' || !hasOpenNativeEntryRestoreTransaction) return;
                                    const entryRestoreWriteContext = entryRestoreWriteContextRef.current;
                                    if (props.isLoaded && listDataRef.current.length > 0) {
                                        updateNativeViewportPaintObserved(true);
                                        if (firstPaintTelemetryRef.current?.recorded === false) {
                                            recordFirstListPaint();
                                        }
                                    }
                                    const visibleDistanceFromBottom = Math.max(
                                        0,
                                        Math.trunc(Math.max(
                                            entryRestoreWriteContext?.distanceFromBottom ?? 0,
                                            refDistanceFromBottom,
                                        )),
                                    );
                                    commitJumpToBottomDistanceForVisibility(visibleDistanceFromBottom);
                                    setScrollPin((prev) =>
                                        reduceTranscriptScrollPinState(prev, {
                                            type: 'scroll',
                                            enabled: pinEnabled,
                                            offsetY: visibleDistanceFromBottom,
                                            pinnedOffsetThresholdPx: pinThresholdPx,
                                        })
                                    );
                                };
                                // Entry-restore transaction observation forwarding (plan F2):
                                // trusted scrolls preempt; conclusive aligned|misaligned
                                // observations drive confirm / the single correction; any
                                // other frame holds ownership without writing.
                                let entryRestoreConfirmedByThisObservation = false;
                                if (hasOpenNativeEntryRestoreTransaction && entryRestoreTransaction) {
                                    if (isTrusted) {
                                        preemptEntryRestoreTransaction();
                                    } else {
                                        const alignmentObservation = resolveNativeEntryRestoreAlignmentObservation({
                                            contentHeight: contentH,
                                            distanceFromBottom: refDistanceFromBottom,
                                            offsetY: y,
                                        });
                                        if (alignmentObservation == null) {
                                            commitOpenEntryRestoreVisibleState();
                                            recordNativeScrollObservation('pending');
                                            return;
                                        }
                                        const entryRestoreDirective = entryRestoreTransaction.onObservation(alignmentObservation, nowMs);
                                        if (entryRestoreTransaction.isClosed()) {
                                            entryRestoreConfirmedByThisObservation =
                                                entryRestoreTransaction.outcome() === 'confirmed';
                                            finishEntryRestoreTransaction(entryRestoreTransaction);
                                            if (entryRestoreConfirmedByThisObservation) {
                                                updateNativeViewportPaintObserved(true);
                                            }
                                        } else {
                                            if (entryRestoreDirective.action === 'issue-correction-write') {
                                                issueNativeEntryRestoreCorrection({
                                                    contentHeight: contentH,
                                                    layoutHeight: layoutH,
                                                });
                                            }
                                            commitOpenEntryRestoreVisibleState();
                                            recordNativeScrollObservation('pending');
                                            return;
                                        }
                                    }
                                }
                                if (Platform.OS === 'web') {
                                    verifyWebEntryRestoreTransaction();
                                }
                                const nativePrependTransaction =
                                    Platform.OS !== 'web' ? nativePrependTransactionRef.current : null;
                                if (
                                    nativePrependTransaction != null &&
                                    nativePrependTransaction.sessionId === props.sessionId &&
                                    !nativePrependTransaction.isClosed()
                                ) {
                                    if (isTrusted) {
                                        // Trusted scrolls preempt the transaction with zero writes;
                                        // MVCP alone holds the position under the finger (LC-R #5).
                                        nativePrependTransaction.onTrustedUserScroll();
                                        finishNativePrependTransaction(nativePrependTransaction);
                                    } else {
                                        observeNativePrependTransaction();
                                        if (!nativePrependTransaction.isClosed()) {
                                            recordNativeScrollObservation('pending');
                                            return;
                                        }
                                    }
                                }
                                const pendingExplicitJump = pendingNativeExplicitJumpConfirmRef.current;
                                if (Platform.OS !== 'web' && pendingExplicitJump) {
                                    if (pendingExplicitJump.sessionId !== props.sessionId || isTrusted) {
                                        pendingNativeExplicitJumpConfirmRef.current = null;
                                    } else if (refDistanceFromBottom <= pinThresholdPx) {
                                        // Bottom reached: the explicit jump is confirmed;
                                        // MVCP bottom maintenance owns it from here.
                                        pendingNativeExplicitJumpConfirmRef.current = null;
                                    } else if (contentH !== pendingExplicitJump.issuedContentHeight) {
                                        // Plan B7: the content height churned under the explicit
                                        // jump before the bottom was observed. Spend the ONE
                                        // bounded re-confirm (snap) inside the explicit phase —
                                        // never a correction loop.
                                        pendingNativeExplicitJumpConfirmRef.current = null;
                                        executeViewportCommand(withTranscriptViewportCommandAnimation(
                                            resolveViewportCommand({
                                                type: 'jump-to-bottom',
                                                sessionId: props.sessionId,
                                            }),
                                            false,
                                        ));
                                    }
                                }
                                const pendingEntrySettle = pendingNativeEntrySettleConfirmRef.current;
                                if (Platform.OS !== 'web' && pendingEntrySettle) {
                                    if (
                                        pendingEntrySettle.sessionId !== props.sessionId ||
                                        isTrusted ||
                                        !wantsPinnedRef.current ||
                                        bottomFollowModeStateRef.current.mode !== 'following'
                                    ) {
                                        pendingNativeEntrySettleConfirmRef.current = null;
                                    } else if (refDistanceFromBottom <= pinThresholdPx) {
                                        // Bottom-confirmed frame: refresh the event-source
                                        // baseline (the entry bottom holds at this content
                                        // version); the one-shot stays armed for late settle.
                                        pendingNativeEntrySettleConfirmRef.current = {
                                            ...pendingEntrySettle,
                                            issuedContentHeight: contentH,
                                        };
                                    } else if (pendingEntrySettle.issuedContentHeight == null) {
                                        // First observed frame after a (warm) entry: record the
                                        // event-source baseline; only GROWTH from here can spend
                                        // the one-shot (bogus recycled offsets carry no growth).
                                        pendingNativeEntrySettleConfirmRef.current = {
                                            ...pendingEntrySettle,
                                            issuedContentHeight: contentH,
                                        };
                                    } else if (
                                        pendingEntrySettle.issuedContentHeight != null &&
                                        contentH > pendingEntrySettle.issuedContentHeight &&
                                        (
                                            nativeMountSettleStable ||
                                            nativeMountSettleDeadlineReachedRef.current
                                        )
                                    ) {
                                        // Plan P3: LATE content settle (after the mount window —
                                        // the coordinator owns pins inside it) GREW the content
                                        // and left the viewport above the bottom while still
                                        // 'following'. Spend the ONE bounded settle re-confirm
                                        // (mirror of B7) — never a loop. Bogus recycled offsets
                                        // never spend it: they carry no event-source growth.
                                        pendingNativeEntrySettleConfirmRef.current = null;
                                        pinNativeFlashListToBottomIfMeasured({
                                            force: true,
                                            reason: 'mount-settle',
                                        });
                                    }
                                }
                                const hasRecentNativeUserScrollIntent =
                                    nowMs - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_RECENT_MS;
                                const shouldIgnoreNativePassiveBottomDrift =
                                    Platform.OS !== 'web' &&
                                    !isTrusted &&
                                    !hasRecentNativeUserScrollIntent &&
                                    !wantsPinnedRef.current &&
                                    refDistanceFromBottom <= resolveNativePassiveBottomDriftNoiseFloorPx({
                                        configuredBottomDistanceNoiseFloorPx: resolveTranscriptMountSettleTuning().bottomDistanceNoiseFloorPx,
                                        pinThresholdPx,
                                    });
                                recordNativeScrollObservation(
                                    shouldIgnoreNativePassiveBottomDrift ? 'skipped' : 'observed',
                                );
                                const observedPendingNativeBottomPinTarget =
                                    Platform.OS !== 'web' &&
                                    usesNativeFlashListBottomMaintenance &&
                                    pendingNativeMountSettleBottomPinRef.current &&
                                    nativeBottomFollowPinTargetObserved({
                                        lastNativePinOffset: lastNativePinOffsetRef.current,
                                        pinThresholdPx,
                                        visualBottomScrollOffset: refVisualBottomScrollOffset,
                                    });
                                const canCompletePendingNativeBottomFollow = nativeBottomFollowCanCompletePendingPin({
                                    mountSettleDeadlineReached: nativeMountSettleDeadlineReachedRef.current,
                                    mountSettleStable: nativeMountSettleStable,
                                    pendingBottomPin: pendingNativeMountSettleBottomPinRef.current,
                                    pinTargetObserved: observedPendingNativeBottomPinTarget,
                                });
                                if (nativeBottomFollowCanApplyCompletion({
                                    canCompletePendingPin: canCompletePendingNativeBottomFollow,
                                    distanceFromBottom: refDistanceFromBottom,
                                    isNative: Platform.OS !== 'web',
                                    pinThresholdPx,
                                    wantsPinned: wantsPinnedRef.current,
                                })) {
                                    pendingNativeMountSettleBottomPinRef.current = false;
                                    markNativeInitialViewportAppliedForCurrentSession({
                                        // Plan P3: the applying frame's event content height is
                                        // the settle-confirm baseline (event source only, E7).
                                        entrySettleBaselineContentHeight: contentH,
                                    });
                                }
                                if (shouldIgnoreNativePassiveBottomDrift) {
                                    return;
                                }
                                if (isTrusted) {
                                    recordNativeUserScrollIntent(nowMs);
                                    markNativeInitialViewportAppliedForCurrentSession();
                                }
                                // On web the FlashList content height can be stale or collapsed (the hot/cold
                                // split renders the tail in the footer), so the ref-based distance can read 0
                                // even while the user is scrolled up. Prefer the live DOM scroller metrics so
                                // the released/observed viewport intent is not discarded by a measurement zero.
                                const liveWebMetrics = Platform.OS === 'web' ? resolveWebScrollMetrics() : null;
                                const distanceFromBottom = liveWebMetrics
                                    ? getWebTranscriptDistanceFromBottom(liveWebMetrics)
                                    : refDistanceFromBottom;
                                const visualBottomScrollOffset = liveWebMetrics
                                    ? resolveWebTranscriptMaxScrollTop(liveWebMetrics)
                                    : refVisualBottomScrollOffset;
                                let webObservedUserScrollMovement = false;
                                if (liveWebMetrics) {
                                    // Plan E3: genuine web scroll movement (scrollbar drag / keyboard) fires
                                    // no wheel/pointer/touch handler and is not reliably `isTrusted`, so it is
                                    // detected as "scroll moved without a recent programmatic write".
                                    // Programmatic pin/restore scroll writes update
                                    // `lastObservedWebScrollTopRef` to their own target, so they are not
                                    // misread as user movement. A single upward frame counts only beyond the
                                    // pin threshold (legacy behavior); SUSTAINED movement counts anywhere,
                                    // and upward movement unpins, mirroring the wheel path.
                                    const liveScrollTop = liveWebMetrics.scrollTop;
                                    const previousObservedScrollTop =
                                        lastObservedWebScrollTopRef.current
                                        ?? (wantsPinnedRef.current ? visualBottomScrollOffset : null);
                                    if (previousObservedScrollTop != null && liveScrollTop !== previousObservedScrollTop) {
                                        const movementDirection: -1 | 1 = liveScrollTop < previousObservedScrollTop ? -1 : 1;
                                        const previousStreak = webNonProgrammaticScrollStreakRef.current;
                                        const streakCount = previousStreak?.direction === movementDirection
                                            ? previousStreak.count + 1
                                            : 1;
                                        webNonProgrammaticScrollStreakRef.current = {
                                            direction: movementDirection,
                                            count: streakCount,
                                        };
                                        const beyondPinThreshold = distanceFromBottom > pinThresholdPx;
                                        const sustainedMovement =
                                            streakCount >= TRANSCRIPT_WEB_NON_PROGRAMMATIC_SCROLL_SUSTAIN_FRAMES;
                                        const upwardIntent = movementDirection === -1 && (beyondPinThreshold || sustainedMovement);
                                        const downwardIntent = movementDirection === 1 && beyondPinThreshold && sustainedMovement;
                                        if (upwardIntent || downwardIntent) {
                                            webObservedUserScrollMovement = true;
                                            lastUserScrollIntentAtMsRef.current = nowMs;
                                            if (upwardIntent) {
                                                // Mirror the wheel path: upward movement is explicit
                                                // intent to unpin, even within the pinned threshold.
                                                wantsPinnedRef.current = false;
                                                preemptEntryRestoreTransaction();
                                            }
                                        }
                                    }
                                    lastObservedWebScrollTopRef.current = liveScrollTop;
                                }
                                const recentUserIntent =
                                    isTrusted || nowMs - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_RECENT_MS;
                                mountSettleCoordinatorRef.current?.sample({
                                    sessionId: props.sessionId,
                                    nowMs,
                                });
                                observeMountSettleMetrics({ distanceFromBottom, nowMs });
                                // Plan B2 (evidence E8): passive-drift repin and the
                                // `effectiveDistanceFromBottom = 0` ground-truth falsification are deleted.
                                // Decisions below read the observed distance as-is.
                                const effectiveDistanceFromBottom = distanceFromBottom;
                                const effectiveScrollOffset = liveWebMetrics ? liveWebMetrics.scrollTop : y;
                                observeOlderPaginationScroll({
                                    offsetY: effectiveScrollOffset,
                                    layoutHeight: layoutH,
                                    contentHeight: contentH,
                                    distanceFromBottom: effectiveDistanceFromBottom,
                                });
                                if (loadOlderInFlight.current) {
                                    refreshInFlightWebPrependAnchor({
                                        userScrolledDuringLoad: isTrusted || webObservedUserScrollMovement,
                                    });
                                }
                                if (recentUserIntent && (Platform.OS !== 'web' || isTrusted)) {
                                    retargetPendingWebPrependAnchorForUserScroll();
                                }
	                                const flashListPreviousScrollOffset =
	                                    lastScrollOffsetForIntentRef.current ?? (wantsPinnedRef.current ? visualBottomScrollOffset : null);
	                                const flashListMovedAwayFromBottom =
	                                    flashListPreviousScrollOffset !== null &&
	                                    typeof effectiveScrollOffset === 'number' &&
	                                    effectiveScrollOffset < flashListPreviousScrollOffset;
	                                const flashListMovedTowardBottom =
	                                    flashListPreviousScrollOffset !== null &&
	                                    typeof effectiveScrollOffset === 'number' &&
	                                    effectiveScrollOffset > flashListPreviousScrollOffset;
	                                const followIntent = resolveTranscriptBottomFollowIntent({
	                                    // Plan B6 trusted-gate: on native only trusted scrolls release
	                                    // follow; web keeps gesture-derived recent intent as release
	                                    // authority (wheel/pointer paths own web unpinning).
	                                    // Plan B9: untrusted momentum frames inside the post-drag
	                                    // attribution window (active momentum + retained trusted drag
	                                    // session) carry the drag's release authority — height churn
	                                    // without a drag still never releases.
	                                    canRelease: Platform.OS === 'web'
	                                        ? recentUserIntent
	                                        : isTrusted ||
	                                            (
	                                                nativeMomentumScrollActiveRef.current &&
	                                                bottomFollowModeStateRef.current.dragSession?.trusted === true
	                                            ),
	                                    direction: 'toward-max',
	                                    distanceFromBottom: effectiveDistanceFromBottom,
	                                    pinThresholdPx,
	                                    previousScrollOffset: flashListPreviousScrollOffset,
	                                    scrollOffset: effectiveScrollOffset,
	                                    wantsPinned: wantsPinnedRef.current,
	                                });
	                                updateNativeBottomFollowModeFromScrollObservation({
	                                    distanceFromBottom: followIntent.nextDistanceFromBottom,
	                                    isTrusted,
	                                    movedAwayFromBottom: flashListMovedAwayFromBottom,
	                                    movedTowardBottom: flashListMovedTowardBottom,
	                                    recentUserIntent,
	                                });
                                if (
                                    Platform.OS !== 'web' &&
                                    !isTrusted &&
                                    bottomFollowModeStateRef.current.mode !== 'following' &&
                                    followIntent.isPinned &&
                                    followIntent.wantsPinned
                                ) {
                                    // The mode machine only re-follows on trusted movement, but the
                                    // viewport visibly sits at the bottom: keep read-only UI state
                                    // (jump button, pin badge) honest without writes or mode changes.
                                    // Plan P3: also record the observed distance so the exit-flush
                                    // live-tail fallback sees the visible bottom truth.
                                    lastPinOffsetForIntentRef.current = followIntent.nextDistanceFromBottom;
                                    commitJumpToBottomDistanceForVisibility(followIntent.nextDistanceFromBottom);
                                    setScrollPin((prev) =>
                                        reduceTranscriptScrollPinState(prev, {
                                            type: 'scroll',
                                            enabled: pinEnabled,
                                            offsetY: followIntent.nextDistanceFromBottom,
                                            pinnedOffsetThresholdPx: followIntent.effectivePinnedOffsetThresholdPx,
                                        })
                                    );
                                    return;
                                }
                                if (
                                    Platform.OS !== 'web' &&
                                    !isTrusted &&
                                    bottomFollowModeStateRef.current.mode === 'following' &&
                                    followIntent.wantsPinned &&
                                    !followIntent.isPinned
                                ) {
                                    // Passive height-churn drift while the mode machine still says
                                    // 'following' (plan B1/E8): MVCP owns bottom maintenance, so a
                                    // drift frame never surfaces released UI state, emits viewport
                                    // changes, or schedules writes.
                                    return;
                                }
                                lastPinOffsetForIntentRef.current = followIntent.nextDistanceFromBottom;
                                lastScrollOffsetForIntentRef.current = followIntent.nextScrollOffset;
                                wantsPinnedRef.current = followIntent.wantsPinned;

                                const effectiveThresholdPx = followIntent.effectivePinnedOffsetThresholdPx;
                                const pinned = followIntent.isPinned;
                                isPinnedRef.current = pinned;
                                const viewportState = {
                                    isPinned: pinned,
                                    offsetY: effectiveDistanceFromBottom,
                                    shouldRestoreViewport: !wantsPinnedRef.current,
                                };
                                emitViewportChange(viewportState);
	                                // Plan P2: momentum frames inside the post-drag attribution window
	                                // (B9) are USER movement — they must schedule/refresh the anchor
	                                // capture so a dwell after a fling captures the reading position.
	                                const momentumCarriesUserAttribution =
	                                    nativeMomentumScrollActiveRef.current &&
	                                    bottomFollowModeStateRef.current.dragSession?.trusted === true;
	                                scheduleViewportAnchorCapture(viewportState, {
	                                    // Open prepend transactions never reach this point (the
	                                    // pending branch above returns), so no prepend term is needed.
	                                    suppressAnchorCapture:
	                                        shouldSuppressPassiveNativeAnchorCapture && !momentumCarriesUserAttribution,
	                                });
                                commitJumpToBottomDistanceForVisibility(effectiveDistanceFromBottom);
                                setScrollPin((prev) =>
                                    reduceTranscriptScrollPinState(prev, {
                                        type: 'scroll',
                                        enabled: pinEnabled,
                                        offsetY: effectiveDistanceFromBottom,
                                        pinnedOffsetThresholdPx: effectiveThresholdPx,
                                    })
                                );

                                const nativeFollowBottomObservationCanReleasePaint =
                                    refDistanceFromBottom <= effectiveThresholdPx &&
                                    (
                                        !usesNativeFlashListBottomMaintenance ||
                                        nativeMountSettleStable ||
                                        nativeMountSettleDeadlineReachedRef.current ||
                                        (
                                            isWarmKeepAliveInstance &&
                                            sessionEntryViewportRef.current?.shouldFollowBottom !== false
                                        )
                                    );
                                const nativeAcceptedViewportPaintObservation =
                                    Platform.OS !== 'web' &&
                                    props.isLoaded &&
                                    listDataRef.current.length > 0 &&
                                    !isTrusted &&
                                    (
                                        nativeFollowBottomObservationCanReleasePaint ||
                                        entryRestoreConfirmedByThisObservation ||
                                        (!wantsPinnedRef.current && refDistanceFromBottom > effectiveThresholdPx)
                                    );
                                if (nativeAcceptedViewportPaintObservation) {
                                    updateNativeViewportPaintObserved(true);
                                    if (firstPaintTelemetryRef.current?.recorded === false) {
                                        recordFirstListPaint();
                                    }
                                    if (!showFirstPaintPlaceholder) {
                                        const paintMetrics = resolveEffectiveListPaintMetrics() ?? {
                                            contentHeight: Math.max(0, Math.trunc(contentH)),
                                            distanceFromBottom: Math.max(0, Math.trunc(refDistanceFromBottom)),
                                            layoutHeight: Math.max(0, Math.trunc(layoutH)),
                                        };
                                        recordStablePaintTelemetry(paintMetrics, {
                                            nativeViewportObserved: true,
                                        });
                                    }
                                }

                                drainDeferredNewerMessages({
                                    distanceFromBottom: effectiveDistanceFromBottom,
                                    pinned,
                                });
                            }}
	                            onScrollBeginDrag={recordNativeListDragEscapeIntent}
	                            onScrollEndDrag={recordNativeListDragEndIntent}
                            onMomentumScrollBegin={recordNativeMomentumScrollBeginIntent}
                            onMomentumScrollEnd={recordNativeMomentumScrollEndSettle}
                            scrollEventThrottle={
                                Platform.OS === 'web'
                                    ? TRANSCRIPT_WEB_FLASH_LIST_SCROLL_EVENT_THROTTLE_MS
                                    : TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS
                            }
                            keyboardShouldPersistTaps="handled"
                            keyboardDismissMode="none"
                            renderItem={renderItem}
                      onStartReachedThreshold={flashListStartReachedThreshold}
                      onStartReached={() => {
                          // FlashList can miss onStartReached (#1785); treat it as one more
                          // scroll observation for the pagination machine.
                          const startReachedOffset = Platform.OS === 'web'
                              ? resolveWebScrollMetrics()?.scrollTop ?? null
                              : (() => {
                                  try {
                                      const value = listRef.current?.getAbsoluteLastScrollOffset?.();
                                      return typeof value === 'number' && Number.isFinite(value) ? value : null;
                                  } catch {
                                      return null;
                                  }
                              })();
                          if (typeof startReachedOffset !== 'number') return;
                          const layoutH = listLayoutHeightRef.current;
                          const contentH = listContentHeightRef.current;
                          observeOlderPaginationScroll({
                              offsetY: startReachedOffset,
                              layoutHeight: layoutH,
                              contentHeight: contentH,
                              distanceFromBottom: Math.max(0, Math.trunc(contentH - layoutH - startReachedOffset)),
                          });
                      }}
	                      onScrollToIndexFailed={(info: { index: number; averageItemLength: number }) => {
	                          if (handleNativeRestoreIndexFailure(info.index)) return;
	                          if (props.jumpToSeq == null) return;
	                          const offset = Math.max(0, Math.trunc(info.averageItemLength * info.index));
	                          executeViewportCommand(resolveViewportCommand({
	                              type: 'scroll-offset',
	                              sessionId: props.sessionId,
	                              reason: 'jump-to-seq',
	                              mode: 'jump-to-seq',
	                              offsetY: offset,
	                              animated: true,
	                          }));
                      }}
                      ListHeaderComponent={listHeaderNode}
                      ListFooterComponent={
                            flashListFooterNode
                        }
                  />
                </LayoutCommitObserver>
              )}
              {showFirstPaintPlaceholder ? (
                  <TranscriptFirstPaintPlaceholder reducedMotion={reducedMotionPreferred} />
              ) : null}
              {(olderPagination.isLoadingOlder || isLoadingOlder) && !showFirstPaintPlaceholder ? (
                  <OlderLoadProgressOverlay />
              ) : null}
              {showJumpToBottom ? (
                  <ComposerKeyboardFloatingInset
                      testID="transcript-jump-to-bottom-keyboard-offset"
                      baseBottom={12}
                      style={{ position: 'absolute', right: 12 }}
                  >
                      <JumpToBottomButton
                          testID="transcript-jump-to-bottom"
                          count={scrollPin.newActivityCount >= jumpMinNewCount ? scrollPin.newActivityCount : 0}
                          onPress={jumpToBottom}
                    />
                </ComposerKeyboardFloatingInset>
            ) : null}
            </View>
        </TranscriptMotionProvider>
    )
});
