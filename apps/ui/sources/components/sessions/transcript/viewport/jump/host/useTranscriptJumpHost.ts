import * as React from 'react';

import { sync, type SessionViewportAnchorSnapshot } from '@/sync/sync';
import {
    getStorage,
    useSetting,
} from '@/sync/domains/state/storage';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { buildSessionMessageRouteId } from '@/sync/domains/messages/messageRouteIds';
import { resolveJumpToBottomAffordanceState } from '@/components/sessions/transcript/scroll/jumpToBottomAffordanceState';
import { resolveNextJumpToBottomDistanceVisibilityState } from '@/components/sessions/transcript/scroll/jumpToBottomVisibilityDistanceState';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import {
    getWebTranscriptDistanceFromBottom,
    type WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import type { TranscriptViewportTelemetryScrollReason } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type { WebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import type {
    PendingJumpSeqViewportPromotion,
    PromotedJumpSeqViewportProtection,
    ChatTranscriptListItem,
    TranscriptViewportChangeState,
} from '@/components/sessions/transcript/chatListTypes';
import {
    resolveJumpSeqViewportPromotion,
    resolveJumpSeqViewportPromotionState,
} from '@/components/sessions/transcript/viewport/entryRestore/jumpSeqViewportPromotion';
import { normalizeDurableViewportSeq } from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreAnchorUtilities';
import { resolveTranscriptViewportAnchorDescriptor } from '@/components/sessions/transcript/viewport/entryRestore/transcriptViewportAnchorResolution';
import type {
    TranscriptBottomFollowModeState,
    TranscriptScrollPinState,
} from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';
import type {
    TranscriptViewportCommand,
    TranscriptViewportControllerInput,
    TranscriptViewportJumpAlignment,
} from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import type { TranscriptLifecycleHost } from '@/components/sessions/transcript/viewport/lifecycle/lifecycleHost';
import type { ScrollableChatListRef } from '@/components/sessions/transcript/viewport/transcriptScrollableListTypes';
import type { LastNativeRestoreIndexCommand } from '@/components/sessions/transcript/viewport/transcriptScrollableListTypes';
import type { TranscriptPrependOlderLoadSyncOptions } from '@/components/sessions/transcript/viewport/prepend/host/runTranscriptPrependOlderLoad';
import {
    executeTranscriptTargetWindowJump,
    isTranscriptSeqMountedInWebRenderedWindow,
    resolveTranscriptJumpTargetRequest,
    resolveTranscriptNavigationJumpPlan,
    resolveTranscriptNavigationPaneJumpRequest,
    resolveTranscriptNavigationTargetInRenderedWindow,
    resolveTranscriptRouteJumpSeqPlan,
    resolveTranscriptTargetWindowLoadTarget,
} from '@/components/sessions/transcript/viewport/window/useTranscriptTargetWindowHostAdapter';
import type {
    TranscriptJumpResult,
    TranscriptJumpTarget,
    TranscriptJumpTargetIndexResult,
    TranscriptJumpTargetRole,
} from '@/components/sessions/transcript/viewport/jump/transcriptJumpTargetTypes';
import {
    resolveTranscriptJumpSeqIndex,
    resolveTranscriptJumpTargetIndex,
} from '@/components/sessions/transcript/viewport/jump/resolveTranscriptJumpTargetIndex';
import {
    type TranscriptNavigationEntry,
    type TranscriptNavigationJumpRequest,
} from '@/components/sessions/transcript/navigation/transcriptNavigationTypes';
import { deriveTranscriptNavigationRailLayout } from '@/components/sessions/transcript/navigation/deriveTranscriptNavigationRailLayout';
import {
    transcriptNavigationPaneStore,
    useTranscriptNavigationPaneOpen,
} from '@/components/sessions/transcript/navigation/transcriptNavigationPaneStore';
import {
    deriveTranscriptNavigationRuntimeAnchors,
    type TranscriptNavigationRuntimeAnchor,
} from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationRuntimeAnchors';
import {
    collectTranscriptNavigationMessageIdsForItem,
    transcriptNavigationRoleForMessage,
} from '@/components/sessions/transcript/viewport/lifecycle/transcriptRowClassification';
import {
    getTranscriptNavigationVisibilityStore,
    useTranscriptNavigationVisibilitySnapshot,
} from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationVisibilityStore';
import {
    hasAnyWebTranscriptDataTestId,
    scheduleWebTranscriptNavigationVisibilityObservation,
} from '@/components/sessions/transcript/viewport/visibility/webTranscriptNavigationVisibilityObserver';
import {
    TRANSCRIPT_WEB_HOT_TAIL_ITEM_TEST_ID_PREFIX,
} from '@/components/sessions/transcript/web/WebTranscriptSplitFooter';
import {
    TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX,
} from '@/components/sessions/transcript/viewport/prepend/webTranscriptPrependAnchor';
import { TRANSCRIPT_VISUAL_UPDATE_FALLBACK_TIMEOUT_MS } from '@/components/sessions/transcript/_constants';
import { waitForVisualUpdateWithTimeout } from '@/components/sessions/transcript/pagination/waitForVisualUpdateWithTimeout';

type MutableRef<T> = { current: T };
type PlatformOS = 'web' | 'ios' | 'android' | 'windows' | 'macos' | 'native';
type ExplicitJumpTakeoverEffects = ReturnType<TranscriptLifecycleHost['planExplicitJumpTakeover']>['explicitJumpTakeoverEffects'];
const TRANSCRIPT_WEB_NON_PROGRAMMATIC_SCROLL_SUSTAIN_FRAMES = 2;
const TRANSCRIPT_SCROLL_JUMP_TO_BOTTOM_REVEAL_VIEWPORT_RATIO_MAX = 4;

export function useTranscriptJumpWindowFacts(params: Readonly<{
    getMessageById(messageId: string): Message | null | undefined;
    messagesById: Readonly<Record<string, Message>>;
    sessionId: string;
}>): Readonly<{
    isSeqLoaded(seq: number): boolean;
    resolveTargetWindowItemSeq(item: ChatTranscriptListItem): number | null;
    sessionTargetWindowState: ReturnType<typeof sync.getSessionTargetWindowState>;
}> {
    const resolveTargetWindowItemSeq = React.useCallback((item: ChatTranscriptListItem): number | null => {
        const directSeq = (item as { seq?: unknown }).seq;
        if (typeof directSeq === 'number' && Number.isFinite(directSeq)) return Math.trunc(directSeq);
        const descriptor = resolveTranscriptViewportAnchorDescriptor(item);
        const messageId = descriptor?.messageId;
        if (!messageId) return null;
        const seq = params.getMessageById(messageId)?.seq;
        return typeof seq === 'number' && Number.isFinite(seq) ? Math.trunc(seq) : null;
    }, [params.getMessageById]);
    const subscribeSessionTargetWindowState = React.useCallback(
        (listener: () => void) => sync.subscribeSessionTargetWindowState(params.sessionId, listener),
        [params.sessionId],
    );
    const readSessionTargetWindowState = React.useCallback(
        () => sync.getSessionTargetWindowState(params.sessionId),
        [params.sessionId],
    );
    const sessionTargetWindowState = React.useSyncExternalStore(
        subscribeSessionTargetWindowState,
        readSessionTargetWindowState,
        readSessionTargetWindowState,
    );
    const loadedTranscriptSeqSet = React.useMemo(() => {
        const seqs = new Set<number>();
        for (const message of Object.values(params.messagesById)) {
            const seq = (message as { seq?: unknown } | undefined)?.seq;
            if (typeof seq === 'number' && Number.isFinite(seq)) seqs.add(Math.trunc(seq));
        }
        return seqs;
    }, [params.messagesById]);
    const isSeqLoaded = React.useCallback((seq: number): boolean => {
        if (loadedTranscriptSeqSet.has(seq)) return true;
        return sessionTargetWindowState.isWindowMode
            && typeof sessionTargetWindowState.windowMinSeq === 'number'
            && typeof sessionTargetWindowState.windowMaxSeq === 'number'
            && seq >= sessionTargetWindowState.windowMinSeq
            && seq <= sessionTargetWindowState.windowMaxSeq;
    }, [loadedTranscriptSeqSet, sessionTargetWindowState]);

    return React.useMemo(() => ({
        isSeqLoaded,
        resolveTargetWindowItemSeq,
        sessionTargetWindowState,
    }), [
        isSeqLoaded,
        resolveTargetWindowItemSeq,
        sessionTargetWindowState,
    ]);
}

export function useTranscriptJumpTargetWindowActiveBridge(params: Readonly<{
    activeTargetWindowTargetRef: MutableRef<TranscriptJumpTarget | null>;
    targetWindowActive: boolean;
    targetWindowActiveRef: MutableRef<boolean>;
}>): void {
    params.targetWindowActiveRef.current = params.targetWindowActive;
    React.useEffect(() => {
        if (!params.targetWindowActive) {
            params.activeTargetWindowTargetRef.current = null;
        }
    }, [
        params.activeTargetWindowTargetRef,
        params.targetWindowActive,
    ]);
}

export type TranscriptJumpHostDeps = Readonly<{
    activeTargetWindowTargetRef: MutableRef<TranscriptJumpTarget | null>;
    applyExplicitJumpTakeoverApplyEffects(effects: ExplicitJumpTakeoverEffects): void;
    beginExplicitJumpWriteBarrier(): void;
    canonicalWindowedItemsRef: MutableRef<readonly { id: string }[]>;
    committedMessagesCount: number;
    commitBottomFollowModeState(next: TranscriptBottomFollowModeState): void;
    commitExplicitReturnToLiveTailState(reason: 'jump-to-bottom'): void;
    commitScrollPinState(next: TranscriptScrollPinState): void;
    currentSessionIdRef: MutableRef<string>;
    emitViewportChange(state: TranscriptViewportChangeState): boolean;
    endExplicitJumpWriteBarrier(): void;
    executeViewportCommand(command: TranscriptViewportCommand): boolean;
    executeViewportCommandWithAnimation(command: TranscriptViewportCommand, animated: boolean): boolean;
    forkedTranscriptEnabled: boolean;
    hasMoreOlderRef: MutableRef<boolean | null>;
    invalidateViewportAnchorCapture(): void;
    isLoaded: boolean;
    isPinnedRef: MutableRef<boolean>;
    jumpToSeq: number | null | undefined;
    lastPinOffsetForIntentRef: MutableRef<number | null>;
    lastRouteJumpProtectionClearingWebMovementAtMsRef: MutableRef<number>;
    lastScrollOffsetForIntentRef: MutableRef<number | null>;
    lastNativeRestoreIndexCommandRef: MutableRef<LastNativeRestoreIndexCommand | null>;
    lifecycleHost: Pick<
        TranscriptLifecycleHost,
        | 'armNativeExplicitJumpConfirmation'
        | 'clearNativeExplicitJumpConfirmation'
        | 'planExplicitJumpTakeover'
    >;
    listContentHeight: number;
    listContentHeightRef: MutableRef<number>;
    listData: readonly ChatTranscriptListItem[];
    listLayoutHeight: number;
    listLayoutWidthPx: number;
    listRef: MutableRef<ScrollableChatListRef | null>;
    itemsRef: MutableRef<readonly ChatTranscriptListItem[]>;
    messagesById: Readonly<Record<string, Message>>;
    onJumpLanded?: (result: Extract<TranscriptJumpResult, { status: 'scrolled' | 'window-rendered' }>) => void;
    onViewportChangeRef: MutableRef<((state: TranscriptViewportChangeState) => void) | undefined>;
    pendingJumpSeqViewportPromotionRef: MutableRef<PendingJumpSeqViewportPromotion | null>;
    pinThresholdPxRef: MutableRef<number>;
    pinToBottom(reason?: TranscriptViewportTelemetryScrollReason): boolean;
    platformOS: PlatformOS;
    promotedJumpSeqViewportProtectionRef: MutableRef<PromotedJumpSeqViewportProtection | null>;
    readCurrentNativeDistanceFromBottom(): number | null;
    resolveJumpToSeqIndexForCommandRef: MutableRef<(
        seq: number,
        routeMessageId?: string | null,
        transcriptBlockIndex?: number | null,
        role?: TranscriptJumpTargetRole | null,
    ) => number | null>;
    resolveSeqForMessageId(messageId: string): number | null;
    resolveSyncLoadOlderOptions(): TranscriptPrependOlderLoadSyncOptions | undefined;
    resolveTargetWindowItemSeq(item: { id: string }): number | null | undefined;
    resolveViewportCommand(input: TranscriptViewportControllerInput): TranscriptViewportCommand;
    resolveWebScrollMetrics(): WebTranscriptScrollMetrics | null;
    scrollPin: TranscriptScrollPinState;
    scrollPinRef: MutableRef<TranscriptScrollPinState>;
    sessionId: string;
    stampViewportAnchorForEmit(anchor: SessionViewportAnchorSnapshot | null | undefined): SessionViewportAnchorSnapshot | null | undefined;
    targetWindowHasMoreNewer: boolean;
    targetWindowIsWindowMode: boolean;
    transcriptContentMaxWidth: number;
    transcriptNavigationEntries: readonly TranscriptNavigationEntry[];
    transcriptNavigationRuntimeAnchorsRef: MutableRef<readonly TranscriptNavigationRuntimeAnchor[]>;
    usesNativeFlashListBottomMaintenance: boolean;
    waitForNextVisualUpdate(): Promise<void>;
    webDomObservation: WebDomScrollObservation;
    wantsPinnedRef: MutableRef<boolean>;
}>;

export type TranscriptJumpHost = Readonly<{
    commitJumpToBottomDistanceForVisibility(distanceFromBottom: number): void;
    flushPendingJumpSeqViewportPromotionForExit(): void;
    handleTranscriptNavigationPaneEntryPress(entry: TranscriptNavigationEntry): Promise<TranscriptJumpResult> | undefined;
    handleTranscriptNavigationRailJump(
        entry: TranscriptNavigationEntry,
        request: TranscriptNavigationJumpRequest,
    ): Promise<TranscriptJumpResult> | undefined;
    jumpToBottom(): void;
    jumpToBottomAffordance: ReturnType<typeof resolveJumpToBottomAffordanceState>;
    jumpToTranscriptTarget(
        target: TranscriptJumpTarget,
        options?: Readonly<{ align?: TranscriptViewportJumpAlignment; preferTargetWindow?: boolean }>,
    ): Promise<TranscriptJumpResult>;
    observeWebTranscriptNavigationVisibilityForSession(
        metrics: WebTranscriptScrollMetrics,
        scrollIntent: Readonly<{ isTrusted: boolean }> | null,
    ): void;
    observeWebGenuineScrollMovement(params: Readonly<{
        distanceFromBottom: number;
        isTrusted: boolean;
        metrics: WebTranscriptScrollMetrics | null;
        pinThresholdPx: number;
        visualBottomScrollOffset: number | null;
    }>): Readonly<{
        webMovedSinceLastObservation: boolean | null;
        webObservedUpwardIntent: boolean;
        webObservedUserScrollMovement: boolean;
    }>;
    onScrollToIndexFailed(info: Readonly<{ index: number; averageItemLength: number }>): void;
    promotePendingJumpSeqViewportSnapshot(params: Readonly<{
        distanceFromBottom: number;
        metrics: WebTranscriptScrollMetrics;
        phase?: 'interim' | 'settled';
        requireRestorableAnchor?: boolean;
        scrollOffsetPx: number;
    }>): boolean;
    shouldSuppressGenericViewportStateForProtectedJumpSeq(): boolean;
    transcriptNavigationRailVisibilitySnapshot: Readonly<{
        currentAnchorId: string | null;
        visibleAnchorIds: readonly string[];
    }>;
}>;

export function useTranscriptJumpHost(deps: TranscriptJumpHostDeps): TranscriptJumpHost {
    const {
        activeTargetWindowTargetRef,
        applyExplicitJumpTakeoverApplyEffects,
        beginExplicitJumpWriteBarrier,
        canonicalWindowedItemsRef,
        committedMessagesCount,
        commitBottomFollowModeState,
        commitExplicitReturnToLiveTailState,
        commitScrollPinState,
        currentSessionIdRef,
        emitViewportChange,
        endExplicitJumpWriteBarrier,
        executeViewportCommand,
        executeViewportCommandWithAnimation,
        forkedTranscriptEnabled,
        hasMoreOlderRef,
        invalidateViewportAnchorCapture,
        isLoaded,
        isPinnedRef,
        jumpToSeq,
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
        itemsRef,
        messagesById,
        onJumpLanded,
        onViewportChangeRef,
        pendingJumpSeqViewportPromotionRef,
        pinThresholdPxRef,
        pinToBottom,
        platformOS,
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
        sessionId,
        stampViewportAnchorForEmit,
        targetWindowHasMoreNewer,
        targetWindowIsWindowMode,
        transcriptContentMaxWidth,
        transcriptNavigationEntries,
        transcriptNavigationRuntimeAnchorsRef,
        usesNativeFlashListBottomMaintenance,
        waitForNextVisualUpdate,
        webDomObservation,
        wantsPinnedRef,
    } = deps;

    const [jumpToBottomDistanceFromBottom, setJumpToBottomDistanceFromBottom] = React.useState(0);
    const jumpToBottomDistanceFromBottomRef = React.useRef(0);
    const lastJumpSeqRef = React.useRef<number | null>(null);
    const inFlightJumpSeqRef = React.useRef<number | null>(null);
    const transcriptScrollJumpToBottomEnabled = useSetting('transcriptScrollJumpToBottomEnabled');
    const transcriptScrollJumpToBottomMinNewCount = useSetting('transcriptScrollJumpToBottomMinNewCount');
    const transcriptScrollJumpToBottomRevealViewportRatio = useSetting('transcriptScrollJumpToBottomRevealViewportRatio');
    const transcriptScrollJumpToBottomAnimateScroll = useSetting('transcriptScrollJumpToBottomAnimateScroll');
    const jumpEnabled = transcriptScrollJumpToBottomEnabled !== false;
    const jumpMinNewCount =
        typeof transcriptScrollJumpToBottomMinNewCount === 'number' && Number.isFinite(transcriptScrollJumpToBottomMinNewCount)
            ? Math.max(1, Math.trunc(transcriptScrollJumpToBottomMinNewCount))
            : 1;
    const jumpRevealViewportRatio =
        typeof transcriptScrollJumpToBottomRevealViewportRatio === 'number' && Number.isFinite(transcriptScrollJumpToBottomRevealViewportRatio)
            ? Math.max(0, Math.min(TRANSCRIPT_SCROLL_JUMP_TO_BOTTOM_REVEAL_VIEWPORT_RATIO_MAX, transcriptScrollJumpToBottomRevealViewportRatio))
            : settingsDefaults.transcriptScrollJumpToBottomRevealViewportRatio;
    const jumpRevealOffsetThresholdPx = Math.max(pinThresholdPxRef.current, Math.trunc(listLayoutHeight * jumpRevealViewportRatio));
    const jumpAnimateScroll = transcriptScrollJumpToBottomAnimateScroll !== false;

    const resolveRouteMessageIdForMessageId = React.useCallback((messageId: string): string | null => {
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[sessionId];
        const stateMessagesById = (session?.messagesById ?? session?.messagesMap ?? {}) as Readonly<Record<string, Message>>;
        return buildSessionMessageRouteId({
            messageId,
            messagesById: stateMessagesById,
            reducerState: session?.reducerState ?? null,
        });
    }, [sessionId]);

    const resolveTranscriptBlockIndexForMessageId = React.useCallback((messageId: string): number | null => {
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[sessionId];
        const message = session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
        const index = message?.transcriptBlockIndex;
        return typeof index === 'number' && Number.isFinite(index) ? Math.trunc(index) : null;
    }, [sessionId]);

    const resolveRoleForMessageId = React.useCallback((messageId: string): TranscriptJumpTargetRole | null => {
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[sessionId];
        const storedMessage = session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
        if (storedMessage?.kind === 'user-text') return 'user';
        if (storedMessage?.kind === 'agent-text') return 'assistant';
        if (storedMessage?.kind === 'tool-call') return 'tool';
        if (storedMessage?.kind === 'agent-event') return 'system';
        return storedMessage ? 'unknown' : null;
    }, [sessionId]);

    const resolveJumpToSeqIndexFromLoadedItems = React.useCallback((
        targetSeq: number,
        routeMessageId?: string | null,
        transcriptBlockIndex?: number | null,
        role?: TranscriptJumpTargetRole | null,
    ): number | null => {
        if (typeof targetSeq !== 'number' || !Number.isFinite(targetSeq) || targetSeq < 0) return null;
        const normalizedSeq = Math.trunc(targetSeq);
        const normalizedRouteMessageId = typeof routeMessageId === 'string' && routeMessageId.trim().length > 0
            ? routeMessageId.trim()
            : null;
        if (normalizedRouteMessageId) {
            const result = resolveTranscriptJumpTargetIndex({
                target: {
                    kind: 'route-message-id',
                    routeMessageId: normalizedRouteMessageId,
                    seqHint: normalizedSeq,
                    transcriptBlockIndex,
                    role,
                },
                items: itemsRef.current as readonly Record<string, unknown>[],
                resolveSeqForMessageId,
                resolveRouteMessageIdForMessageId,
                resolveTranscriptBlockIndexForMessageId,
                resolveRoleForMessageId,
                hasMoreOlder: hasMoreOlderRef.current !== false,
                hasMoreNewer: targetWindowHasMoreNewer,
            });
            return result.status === 'found' ? result.index : null;
        }
        return resolveTranscriptJumpSeqIndex({
            targetSeq: normalizedSeq,
            items: itemsRef.current,
            resolveSeqForMessageId,
            hasMoreOlder: hasMoreOlderRef.current !== false,
        });
    }, [
        hasMoreOlderRef,
        itemsRef,
        resolveRoleForMessageId,
        resolveRouteMessageIdForMessageId,
        resolveSeqForMessageId,
        resolveTranscriptBlockIndexForMessageId,
        targetWindowHasMoreNewer,
    ]);
    resolveJumpToSeqIndexForCommandRef.current = resolveJumpToSeqIndexFromLoadedItems;

    const resolveJumpTargetIndexFromRenderedWindow = React.useCallback((target: TranscriptJumpTarget): TranscriptJumpTargetIndexResult => {
        return resolveTranscriptJumpTargetIndex({
            target,
            items: canonicalWindowedItemsRef.current as readonly Record<string, unknown>[],
            resolveSeqForMessageId,
            resolveRouteMessageIdForMessageId,
            resolveTranscriptBlockIndexForMessageId,
            resolveRoleForMessageId,
            hasMoreOlder: hasMoreOlderRef.current !== false,
            hasMoreNewer: targetWindowHasMoreNewer,
        });
    }, [
        canonicalWindowedItemsRef,
        hasMoreOlderRef,
        resolveRoleForMessageId,
        resolveRouteMessageIdForMessageId,
        resolveSeqForMessageId,
        resolveTranscriptBlockIndexForMessageId,
        targetWindowHasMoreNewer,
    ]);

    const isTranscriptJumpTargetInRenderedWindow = React.useCallback((target: TranscriptJumpTarget): boolean => {
        return resolveJumpTargetIndexFromRenderedWindow(target).status === 'found';
    }, [resolveJumpTargetIndexFromRenderedWindow]);

    const transcriptNavigationRenderedSources = React.useMemo(() => {
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[sessionId];
        const stateMessagesById = (session?.messagesById ?? session?.messagesMap ?? {}) as Readonly<Record<string, Message>>;
        const reducerState = session?.reducerState ?? null;
        return listData.flatMap((item, sourceIndex) => {
            const messageIds = collectTranscriptNavigationMessageIdsForItem(item);
            const messages = messageIds.flatMap((messageId) => {
                const message = messagesById[messageId] ?? stateMessagesById[messageId] ?? null;
                if (!message) return [];
                return [{
                    messageId,
                    routeMessageId: buildSessionMessageRouteId({
                        messageId,
                        messagesById: { [messageId]: message },
                        reducerState,
                    }),
                    seq: typeof message.seq === 'number' && Number.isFinite(message.seq)
                        ? Math.trunc(message.seq)
                        : null,
                    transcriptBlockIndex:
                        typeof message.transcriptBlockIndex === 'number' && Number.isFinite(message.transcriptBlockIndex)
                            ? Math.trunc(message.transcriptBlockIndex)
                            : null,
                    role: transcriptNavigationRoleForMessage(message),
                }];
            });
            if (messages.length === 0) return [];
            return [{
                sourceIndex,
                messageIds,
                messages,
            }];
        });
    }, [listData, messagesById, sessionId]);

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

    const promotePendingJumpSeqViewportSnapshot = React.useCallback((params: Readonly<{
        distanceFromBottom: number;
        metrics: WebTranscriptScrollMetrics;
        phase?: 'interim' | 'settled';
        requireRestorableAnchor?: boolean;
        scrollOffsetPx: number;
    }>): boolean => {
        const pending = pendingJumpSeqViewportPromotionRef.current;
        if (!pending) return false;
        const promotion = resolveJumpSeqViewportPromotion({
            currentSessionId: sessionId,
            distanceFromBottom: params.distanceFromBottom,
            metrics: params.metrics,
            pendingSeq: pending.seq,
            pendingSessionId: pending.sessionId,
            pinThresholdPx: pinThresholdPxRef.current,
            requireRestorableAnchor: params.requireRestorableAnchor,
            resolveAnchorSeq: (anchor) => normalizeDurableViewportSeq(anchor?.seq),
            scrollOffsetPx: params.scrollOffsetPx,
            stampAnchor: (anchor) => stampViewportAnchorForEmit(anchor) ?? null,
        });
        if (promotion.status === 'wrong-session') {
            pendingJumpSeqViewportPromotionRef.current = null;
            return false;
        }
        if (promotion.status === 'wrong-space-anchor') {
            return false;
        }
        const { state: viewportState } = promotion;
        if (promotion.status === 'needs-restorable-anchor' || params.phase === 'interim') {
            const distanceFromBottom = viewportState.offsetY;
            const interimIsPinned = params.phase === 'interim' && viewportState.isPinned;
            wantsPinnedRef.current = interimIsPinned;
            isPinnedRef.current = interimIsPinned;
            lastPinOffsetForIntentRef.current = distanceFromBottom;
            lastScrollOffsetForIntentRef.current = promotion.scrollOffsetPx;
            commitBottomFollowModeState({ dragSession: null, mode: interimIsPinned ? 'following' : 'released' });
            commitJumpToBottomDistanceForVisibility(distanceFromBottom);
            commitScrollPinState({ ...scrollPinRef.current, isPinned: interimIsPinned });
            return false;
        }
        pendingJumpSeqViewportPromotionRef.current = null;
        const distanceFromBottom = viewportState.offsetY;
        const isPinned = viewportState.isPinned;
        invalidateViewportAnchorCapture();
        promotedJumpSeqViewportProtectionRef.current = isPinned
            ? null
            : {
                promotedAtMs: Date.now(),
                seq: pending.seq,
                sessionId,
        };
        wantsPinnedRef.current = isPinned;
        isPinnedRef.current = isPinned;
        lastPinOffsetForIntentRef.current = distanceFromBottom;
        lastScrollOffsetForIntentRef.current = promotion.scrollOffsetPx;
        commitBottomFollowModeState({ dragSession: null, mode: isPinned ? 'following' : 'released' });
        commitJumpToBottomDistanceForVisibility(distanceFromBottom);
        commitScrollPinState({
            ...scrollPinRef.current,
            isPinned,
            newActivityCount: isPinned ? 0 : scrollPinRef.current.newActivityCount,
        });
        pending.emitViewportChange?.(viewportState);
        return true;
    }, [
        commitBottomFollowModeState,
        commitJumpToBottomDistanceForVisibility,
        commitScrollPinState,
        invalidateViewportAnchorCapture,
        isPinnedRef,
        lastPinOffsetForIntentRef,
        lastScrollOffsetForIntentRef,
        pendingJumpSeqViewportPromotionRef,
        pinThresholdPxRef,
        promotedJumpSeqViewportProtectionRef,
        scrollPinRef,
        sessionId,
        stampViewportAnchorForEmit,
        wantsPinnedRef,
    ]);

    const flushPendingJumpSeqViewportPromotionForExit = React.useCallback(() => {
        const pending = pendingJumpSeqViewportPromotionRef.current;
        if (!pending) return;
        if (pending.sessionId !== currentSessionIdRef.current) return;
        if (platformOS !== 'web') return;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return;
        const viewportState = resolveJumpSeqViewportPromotionState({
            distanceFromBottom: getWebTranscriptDistanceFromBottom(metrics),
            metrics,
            pinThresholdPx: pinThresholdPxRef.current,
        });
        pendingJumpSeqViewportPromotionRef.current = null;
        invalidateViewportAnchorCapture();
        promotedJumpSeqViewportProtectionRef.current = viewportState.isPinned
            ? null
            : {
                promotedAtMs: Date.now(),
                seq: pending.seq,
                sessionId: pending.sessionId,
            };
        const emit = pending.emitViewportChange;
        queueMicrotask(() => {
            emit?.(viewportState);
        });
    }, [
        currentSessionIdRef,
        invalidateViewportAnchorCapture,
        pendingJumpSeqViewportPromotionRef,
        pinThresholdPxRef,
        platformOS,
        promotedJumpSeqViewportProtectionRef,
        resolveWebScrollMetrics,
    ]);

    const shouldSuppressGenericViewportStateForProtectedJumpSeq = React.useCallback((): boolean => {
        if (platformOS !== 'web') return false;
        const protection = promotedJumpSeqViewportProtectionRef.current;
        const routeJumpSeq = typeof jumpToSeq === 'number' && Number.isFinite(jumpToSeq)
            ? Math.trunc(jumpToSeq)
            : null;
        if (
            routeJumpSeq != null &&
            pendingJumpSeqViewportPromotionRef.current === null &&
            lastRouteJumpProtectionClearingWebMovementAtMsRef.current === Number.NEGATIVE_INFINITY
        ) {
            return true;
        }
        if (!protection) return false;
        if (protection.sessionId !== sessionId) {
            promotedJumpSeqViewportProtectionRef.current = null;
            return false;
        }
        if (
            routeJumpSeq != null &&
            routeJumpSeq !== protection.seq
        ) {
            promotedJumpSeqViewportProtectionRef.current = null;
            return false;
        }
        if (lastRouteJumpProtectionClearingWebMovementAtMsRef.current > protection.promotedAtMs) {
            promotedJumpSeqViewportProtectionRef.current = null;
            return false;
        }
        return true;
    }, [
        jumpToSeq,
        lastRouteJumpProtectionClearingWebMovementAtMsRef,
        pendingJumpSeqViewportPromotionRef,
        platformOS,
        promotedJumpSeqViewportProtectionRef,
        sessionId,
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

    const jumpToBottomAffordance = resolveJumpToBottomAffordanceState({
        distanceFromBottom: jumpToBottomDistanceFromBottom,
        enabled: jumpEnabled,
        hasMoreNewerBeyondRenderedWindow: targetWindowIsWindowMode,
        isPinned: scrollPin.isPinned,
        minNewActivityCount: jumpMinNewCount,
        newActivityCount: scrollPin.newActivityCount,
        revealThresholdPx: jumpRevealOffsetThresholdPx,
    });

    const transcriptNavigationRuntimeAnchors = React.useMemo(
        () => deriveTranscriptNavigationRuntimeAnchors({
            entries: transcriptNavigationEntries,
            renderedSources: transcriptNavigationRenderedSources,
        }),
        [transcriptNavigationEntries, transcriptNavigationRenderedSources],
    );
    transcriptNavigationRuntimeAnchorsRef.current = transcriptNavigationRuntimeAnchors;

    const transcriptNavigationRailVisible = React.useMemo(() => deriveTranscriptNavigationRailLayout({
        entryCount: transcriptNavigationEntries.length,
        paneHeightPx: listLayoutHeight,
        paneWidthPx: listLayoutWidthPx,
        platformOS: platformOS === 'web' || platformOS === 'ios' || platformOS === 'android'
            ? platformOS
            : 'native-other',
        transcriptContentWidthPx: Math.min(listLayoutWidthPx, transcriptContentMaxWidth),
        transcriptMaxWidthPx: transcriptContentMaxWidth,
    }).visible, [
        listLayoutHeight,
        listLayoutWidthPx,
        platformOS,
        transcriptContentMaxWidth,
        transcriptNavigationEntries.length,
    ]);
    const transcriptNavigationPaneOpen = useTranscriptNavigationPaneOpen(sessionId);
    const transcriptNavigationVisibilitySnapshot = useTranscriptNavigationVisibilitySnapshot(sessionId, {
        enabled: transcriptNavigationRailVisible || transcriptNavigationPaneOpen,
    });
    const transcriptNavigationRailVisibilitySnapshot = React.useMemo(() => {
        const entryIds = new Set(transcriptNavigationEntries.map((entry) => entry.id));
        const currentAnchorId = transcriptNavigationVisibilitySnapshot.currentAnchorId &&
            entryIds.has(transcriptNavigationVisibilitySnapshot.currentAnchorId)
            ? transcriptNavigationVisibilitySnapshot.currentAnchorId
            : null;
        const visibleAnchorIds = transcriptNavigationVisibilitySnapshot.visibleAnchorIds.filter((id) => entryIds.has(id));
        return {
            currentAnchorId,
            visibleAnchorIds,
        };
    }, [transcriptNavigationEntries, transcriptNavigationVisibilitySnapshot]);

    const observeWebTranscriptNavigationVisibilityForSession = React.useCallback((
        metrics: WebTranscriptScrollMetrics,
        scrollIntent: Readonly<{ isTrusted: boolean }> | null,
    ) => {
        if (platformOS !== 'web') return;
        scheduleWebTranscriptNavigationVisibilityObservation({
            anchors: transcriptNavigationRuntimeAnchorsRef.current,
            metrics,
            scrollIntent,
            store: getTranscriptNavigationVisibilityStore(sessionId),
        });
    }, [
        platformOS,
        sessionId,
        transcriptNavigationRuntimeAnchorsRef,
    ]);

    const observeWebGenuineScrollMovement = React.useCallback((params: Readonly<{
        distanceFromBottom: number;
        isTrusted: boolean;
        metrics: WebTranscriptScrollMetrics | null;
        pinThresholdPx: number;
        visualBottomScrollOffset: number | null;
    }>): Readonly<{
        webMovedSinceLastObservation: boolean | null;
        webObservedUpwardIntent: boolean;
        webObservedUserScrollMovement: boolean;
    }> => {
        const metrics = params.metrics;
        if (!metrics) {
            return {
                webMovedSinceLastObservation: null,
                webObservedUpwardIntent: false,
                webObservedUserScrollMovement: false,
            };
        }
        const movement = webDomObservation.observeGenuineScrollMovement({
            metrics,
            fallbackObservedScrollTop: wantsPinnedRef.current ? params.visualBottomScrollOffset : null,
            distanceFromBottom: params.distanceFromBottom,
            pinThresholdPx: params.pinThresholdPx,
            sustainFrames: TRANSCRIPT_WEB_NON_PROGRAMMATIC_SCROLL_SUSTAIN_FRAMES,
            isTrusted: params.isTrusted,
        });
        if (!movement.isGenuineUserMovement) {
            return {
                webMovedSinceLastObservation: movement.movedSinceLastObservation,
                webObservedUpwardIntent: false,
                webObservedUserScrollMovement: false,
            };
        }
        if (!movement.upwardIntent) {
            return {
                webMovedSinceLastObservation: movement.movedSinceLastObservation,
                webObservedUpwardIntent: false,
                webObservedUserScrollMovement: true,
            };
        }
        return {
            webMovedSinceLastObservation: movement.movedSinceLastObservation,
            webObservedUpwardIntent: true,
            webObservedUserScrollMovement: true,
        };
    }, [
        wantsPinnedRef,
        webDomObservation,
    ]);

    const isWebTranscriptSeqMounted = React.useCallback((seq: number): boolean => {
        return isTranscriptSeqMountedInWebRenderedWindow({
            hasAnyTestId: hasAnyWebTranscriptDataTestId,
            hotTailTestIdPrefix: TRANSCRIPT_WEB_HOT_TAIL_ITEM_TEST_ID_PREFIX,
            items: canonicalWindowedItemsRef.current,
            platformOS,
            prependAnchorTestIdPrefix: TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX,
            resolveContainer: () => resolveWebScrollMetrics()?.element,
            resolveItemId: (item) => item.id,
            resolveSeq: resolveTargetWindowItemSeq,
            seq,
        });
    }, [
        canonicalWindowedItemsRef,
        platformOS,
        resolveTargetWindowItemSeq,
        resolveWebScrollMetrics,
    ]);

    const jumpToBottom = React.useCallback(() => {
        const plan = lifecycleHost.planExplicitJumpTakeover({
            reason: 'jump-to-bottom',
            sessionId,
        });
        commitBottomFollowModeState(plan.state.bottomFollowState);
        applyExplicitJumpTakeoverApplyEffects(plan.explicitJumpTakeoverEffects);
        if (usesNativeFlashListBottomMaintenance) {
            const distanceFromBottom = readCurrentNativeDistanceFromBottom();
            if (distanceFromBottom != null && distanceFromBottom <= pinThresholdPxRef.current) {
                lifecycleHost.clearNativeExplicitJumpConfirmation({ sessionId });
                commitExplicitReturnToLiveTailState('jump-to-bottom');
                invalidateViewportAnchorCapture();
                return;
            }
        }
        if (usesNativeFlashListBottomMaintenance) {
            lifecycleHost.armNativeExplicitJumpConfirmation({
                sessionId,
                issuedContentHeight: listContentHeightRef.current,
            });
        }
        const command = resolveViewportCommand({
            type: 'jump-to-bottom',
            sessionId,
        });
        if (!executeViewportCommandWithAnimation(command, jumpAnimateScroll)) {
            pinToBottom('jump-to-bottom');
        }
        commitExplicitReturnToLiveTailState('jump-to-bottom');
        invalidateViewportAnchorCapture();
    }, [
        applyExplicitJumpTakeoverApplyEffects,
        commitBottomFollowModeState,
        commitExplicitReturnToLiveTailState,
        executeViewportCommandWithAnimation,
        invalidateViewportAnchorCapture,
        jumpAnimateScroll,
        lifecycleHost,
        listContentHeightRef,
        pinThresholdPxRef,
        pinToBottom,
        readCurrentNativeDistanceFromBottom,
        resolveViewportCommand,
        sessionId,
        usesNativeFlashListBottomMaintenance,
    ]);

    const jumpToTranscriptTarget = React.useCallback(async (
        target: TranscriptJumpTarget,
        options?: Readonly<{ align?: TranscriptViewportJumpAlignment; preferTargetWindow?: boolean }>,
    ): Promise<TranscriptJumpResult> => {
        const targetRequest = resolveTranscriptJumpTargetRequest(target);
        if (!targetRequest) return { status: 'not-found', reason: 'invalid-target' };
        const { normalizedTargetSeq, routeMessageId, transcriptBlockIndex, role } = targetRequest;
        if (!sessionId) return { status: 'not-found', reason: 'unavailable' };
        beginExplicitJumpWriteBarrier();
        const scrollToTarget = (): boolean => {
            const command = resolveViewportCommand({
                type: 'jump-to-seq',
                sessionId,
                seq: normalizedTargetSeq,
                routeMessageId,
                transcriptBlockIndex,
                role,
                ...(options?.align ? { align: options.align } : {}),
            });
            const applied = executeViewportCommandWithAnimation(command, true);
            if (applied && platformOS === 'web') {
                pendingJumpSeqViewportPromotionRef.current = {
                    emitViewportChange: onViewportChangeRef.current,
                    seq: normalizedTargetSeq,
                    sessionId,
                };
                const metrics = resolveWebScrollMetrics();
                if (metrics) {
                    promotePendingJumpSeqViewportSnapshot({
                        distanceFromBottom: getWebTranscriptDistanceFromBottom(metrics),
                        metrics,
                        phase: 'interim',
                        requireRestorableAnchor: true,
                        scrollOffsetPx: metrics.scrollTop,
                    });
                }
            }
            return applied;
        };
        try {
            const result = await executeTranscriptTargetWindowJump({
                align: options?.align,
                canRenderTargetWindow: options?.preferTargetWindow === true && !forkedTranscriptEnabled,
                forceTargetWindow: options?.preferTargetWindow === true,
                isTargetInRenderedWindow: () => isTranscriptJumpTargetInRenderedWindow(target),
                isTargetMounted: () => platformOS === 'web'
                    ? isWebTranscriptSeqMounted(normalizedTargetSeq)
                    : true,
                loadTargetWindow: async ({ target: windowTarget, direction }) => {
                    const loadTarget = resolveTranscriptTargetWindowLoadTarget(windowTarget, normalizedTargetSeq);
                    const result = await sync.loadTargetWindowMessages(sessionId, loadTarget, {
                        direction: direction ?? 'initial',
                    });
                    if (result?.status === 'stale') return { status: 'stale' as const };
                    if (result?.status === 'loaded' && result.targetPresent) {
                        activeTargetWindowTargetRef.current = windowTarget;
                        return {
                            windowId: result.windowId,
                            targetSeq: result.targetSeq,
                            newerCursor: result.newerCursor,
                            hasMoreNewer: result.hasMoreNewer,
                        };
                    }
                    return null;
                },
                nudgeScrollForGap: platformOS === 'web' ? () => {
                    const element = resolveWebScrollMetrics()?.element;
                    if (!element) return;
                    const st = (element as HTMLElement).scrollTop;
                    if (st > 0) (element as HTMLElement).scrollTop = st - 1;
                } : undefined,
                onJumpLanded,
                pageTowardTarget: async () => {
                    const syncLoadOlderOptions = resolveSyncLoadOlderOptions();
                    const loadOlderResult = forkedTranscriptEnabled
                        ? (syncLoadOlderOptions
                            ? await sync.loadOlderMessagesForkAware(sessionId, syncLoadOlderOptions)
                            : await sync.loadOlderMessagesForkAware(sessionId))
                        : (syncLoadOlderOptions
                            ? await sync.loadOlderMessages(sessionId, syncLoadOlderOptions)
                            : await sync.loadOlderMessages(sessionId));
                    if (loadOlderResult.status === 'no_more') {
                        return { status: 'not-found', reason: 'exhausted' };
                    }
                    await Promise.resolve();
                    await Promise.resolve();
                    return scrollToTarget()
                        ? { status: 'scrolled', target }
                        : { status: 'not-found', reason: 'unavailable' };
                },
                platformOS,
                readScrollTop: () => resolveWebScrollMetrics()?.scrollTop ?? null,
                resolveTargetIndex: () => resolveJumpTargetIndexFromRenderedWindow(target),
                scrollToTarget,
                target,
                targetSeq: normalizedTargetSeq,
                hasGenuineUserMovementSince: (sinceMs) =>
                    lastRouteJumpProtectionClearingWebMovementAtMsRef.current > sinceMs,
                waitForNextLandingFrame: async () => {
                    await waitForVisualUpdateWithTimeout({
                        waitForNextVisualUpdate,
                        timeoutMs: TRANSCRIPT_VISUAL_UPDATE_FALLBACK_TIMEOUT_MS,
                    });
                },
            });
            if (
                platformOS === 'web' &&
                (result.status === 'scrolled' || result.status === 'window-rendered') &&
                pendingJumpSeqViewportPromotionRef.current !== null
            ) {
                const settledMetrics = resolveWebScrollMetrics();
                if (settledMetrics) {
                    promotePendingJumpSeqViewportSnapshot({
                        distanceFromBottom: getWebTranscriptDistanceFromBottom(settledMetrics),
                        metrics: settledMetrics,
                        requireRestorableAnchor: true,
                        scrollOffsetPx: settledMetrics.scrollTop,
                    });
                }
            }
            return result;
        } finally {
            endExplicitJumpWriteBarrier();
        }
    }, [
        activeTargetWindowTargetRef,
        beginExplicitJumpWriteBarrier,
        endExplicitJumpWriteBarrier,
        executeViewportCommandWithAnimation,
        forkedTranscriptEnabled,
        isTranscriptJumpTargetInRenderedWindow,
        isWebTranscriptSeqMounted,
        lastRouteJumpProtectionClearingWebMovementAtMsRef,
        onJumpLanded,
        onViewportChangeRef,
        pendingJumpSeqViewportPromotionRef,
        platformOS,
        promotePendingJumpSeqViewportSnapshot,
        resolveJumpTargetIndexFromRenderedWindow,
        resolveSyncLoadOlderOptions,
        resolveViewportCommand,
        resolveWebScrollMetrics,
        sessionId,
        waitForNextVisualUpdate,
    ]);

    const isTranscriptNavigationTargetInRenderedWindow = React.useCallback((target: TranscriptJumpTarget): boolean => {
        return resolveTranscriptNavigationTargetInRenderedWindow({
            platformOS,
            isTargetInItemSpace: isTranscriptJumpTargetInRenderedWindow(target),
            isTargetMountedInDom: () => {
                const targetRequest = resolveTranscriptJumpTargetRequest(target);
                return targetRequest ? isWebTranscriptSeqMounted(targetRequest.normalizedTargetSeq) : false;
            },
        });
    }, [
        isTranscriptJumpTargetInRenderedWindow,
        isWebTranscriptSeqMounted,
        platformOS,
    ]);

    const handleTranscriptNavigationRailJump = React.useCallback((
        entry: TranscriptNavigationEntry,
        request: TranscriptNavigationJumpRequest,
    ): Promise<TranscriptJumpResult> | undefined => {
        const plan = resolveTranscriptNavigationJumpPlan({
            entry,
            isTargetInRenderedWindow: isTranscriptNavigationTargetInRenderedWindow,
            request,
            sessionId,
        });
        if (!plan) return;
        const result = jumpToTranscriptTarget(plan.target, {
            align: plan.align,
            preferTargetWindow: plan.preferTargetWindow,
        });
        fireAndForget(result, { tag: 'ChatList.transcriptNavigationRailJump' });
        return result;
    }, [
        isTranscriptNavigationTargetInRenderedWindow,
        jumpToTranscriptTarget,
        sessionId,
    ]);

    const handleTranscriptNavigationPaneEntryPress = React.useCallback((entry: TranscriptNavigationEntry): Promise<TranscriptJumpResult> | undefined => {
        const request = resolveTranscriptNavigationPaneJumpRequest(entry, sessionId);
        return request ? handleTranscriptNavigationRailJump(entry, request) : undefined;
    }, [handleTranscriptNavigationRailJump, sessionId]);

    React.useLayoutEffect(() => {
        transcriptNavigationPaneStore.set(sessionId, {
            activeEntryId: transcriptNavigationRailVisibilitySnapshot.currentAnchorId,
            entries: transcriptNavigationEntries,
            onEntryPress: handleTranscriptNavigationPaneEntryPress,
        });
        return () => {
            transcriptNavigationPaneStore.set(sessionId, null);
        };
    }, [
        handleTranscriptNavigationPaneEntryPress,
        sessionId,
        transcriptNavigationEntries,
        transcriptNavigationRailVisibilitySnapshot.currentAnchorId,
    ]);

    React.useEffect(() => {
        const normalizedTarget = resolveTranscriptRouteJumpSeqPlan({
            committedMessagesCount,
            hasUsableWebMetrics: () => {
                const metrics = resolveWebScrollMetrics();
                return !!metrics && metrics.clientHeight > 0 && metrics.scrollHeight > 0;
            },
            inFlightJumpSeq: inFlightJumpSeqRef.current,
            isLoaded,
            jumpToSeq,
            lastJumpSeq: lastJumpSeqRef.current,
            listContentHeight,
            listLayoutHeight,
            platformOS,
            sessionId,
        });
        if (normalizedTarget == null) return;
        inFlightJumpSeqRef.current = normalizedTarget;
        fireAndForget((async () => {
            try {
                const result = await jumpToTranscriptTarget(
                    { kind: 'seq', seq: normalizedTarget },
                    { preferTargetWindow: true },
                );
                if (result.status === 'scrolled' || result.status === 'window-rendered') {
                    lastJumpSeqRef.current = normalizedTarget;
                }
            } finally {
                if (inFlightJumpSeqRef.current === normalizedTarget) {
                    inFlightJumpSeqRef.current = null;
                }
            }
        })(), { tag: 'ChatList.jumpToTranscriptSeq' });
    }, [
        committedMessagesCount,
        isLoaded,
        jumpToSeq,
        jumpToTranscriptTarget,
        listContentHeight,
        listLayoutHeight,
        platformOS,
        resolveWebScrollMetrics,
        sessionId,
    ]);

    const onScrollToIndexFailed = React.useCallback((info: Readonly<{ index: number; averageItemLength: number }>) => {
        if (platformOS !== 'web') {
            const lastCommand = lastNativeRestoreIndexCommandRef.current;
            if (
                lastCommand &&
                lastCommand.sessionId === sessionId &&
                lastCommand.index === info.index &&
                lastCommand.reason === 'entry-restore'
            ) {
                return;
            }
        }
        if (jumpToSeq == null) return;
        executeViewportCommand(resolveViewportCommand({
            type: 'recover-jump-to-seq',
            sessionId,
            failedRenderedIndex: info.index,
            averageItemLengthPx: info.averageItemLength,
            animated: true,
        }));
    }, [
        executeViewportCommand,
        jumpToSeq,
        lastNativeRestoreIndexCommandRef,
        platformOS,
        resolveViewportCommand,
        sessionId,
    ]);

    return React.useMemo(() => ({
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
    }), [
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
    ]);
}
