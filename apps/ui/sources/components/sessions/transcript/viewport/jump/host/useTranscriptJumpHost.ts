import * as React from 'react';
import { useCommittedTranscriptRef } from '@/components/sessions/transcript/viewport/lifecycle/host/useCommittedTranscriptRef';
import type { TranscriptExitSnapshotSelection } from '@/components/sessions/transcript/viewport/lifecycle/transcriptSameSessionHandoff';

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
    isTranscriptTargetObservedAtAlignment,
    resolveTranscriptJumpTargetRequest,
    resolveTranscriptNavigationJumpPlan,
    resolveTranscriptNavigationPaneJumpRequest,
    resolveTranscriptNavigationTargetInRenderedWindow,
    resolveTranscriptRouteJumpSeqPlan,
    resolveTranscriptTargetWindowLoadTarget,
} from '@/components/sessions/transcript/viewport/window/useTranscriptTargetWindowHostAdapter';
import { queryExactWebTranscriptDataTestId } from '@/components/sessions/transcript/webTranscriptDomTestId';
import type {
    TranscriptExplicitJumpOperationId,
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
import {
    transcriptNavigationPaneStore,
} from '@/components/sessions/transcript/navigation/transcriptNavigationPaneStore';
import {
    deriveTranscriptNavigationRuntimeAnchors,
    resolveTranscriptNavigationAnchorIdForJumpTarget,
    type TranscriptNavigationRuntimeAnchor,
} from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationRuntimeAnchors';
import {
    resolveRetainedTranscriptNavigationLandedAnchor,
    type TranscriptNavigationLandedAnchor,
} from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationLandedAnchor';
import {
    collectTranscriptNavigationMessageIdsForItem,
    transcriptNavigationRoleForMessage,
} from '@/components/sessions/transcript/viewport/lifecycle/transcriptRowClassification';
import {
    getTranscriptNavigationVisibilityStore,
    useTranscriptNavigationVisibilityHasSubscribers,
} from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationVisibilityStore';
import {
    publishTranscriptNavigationVisibility,
    readRendererVisibleSourceIndexRange,
} from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationVisibilityPublish';
import {
    TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX,
} from '@/components/sessions/transcript/viewport/prepend/webTranscriptPrependAnchor';
import { TRANSCRIPT_VISUAL_UPDATE_FALLBACK_TIMEOUT_MS } from '@/components/sessions/transcript/_constants';
import { waitForVisualUpdateWithTimeout } from '@/components/sessions/transcript/pagination/waitForVisualUpdateWithTimeout';

type MutableRef<T> = { current: T };
type PlatformOS = 'web' | 'ios' | 'android' | 'windows' | 'macos' | 'native';
type ExplicitJumpTakeoverEffects = ReturnType<TranscriptLifecycleHost['planExplicitJumpTakeover']>['explicitJumpTakeoverEffects'];
const TRANSCRIPT_SCROLL_JUMP_TO_BOTTOM_REVEAL_VIEWPORT_RATIO_MAX = 4;

export function useTranscriptJumpWindowFacts(params: Readonly<{
    getMessageById(messageId: string): Message | null | undefined;
    messagesById: Readonly<Record<string, Message>>;
    sessionId: string;
}>): Readonly<{
    isSeqLoaded(seq: number): boolean;
    isSeqRangeLoaded(fromInclusive: number, toInclusive: number): boolean;
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
    const isSeqRangeLoaded = React.useCallback((fromInclusive: number, toInclusive: number): boolean => {
        if (
            !sessionTargetWindowState.isWindowMode ||
            typeof sessionTargetWindowState.windowMinSeq !== 'number' ||
            typeof sessionTargetWindowState.windowMaxSeq !== 'number'
        ) return false;
        const minSeq = Math.min(sessionTargetWindowState.windowMinSeq, sessionTargetWindowState.windowMaxSeq);
        const maxSeq = Math.max(sessionTargetWindowState.windowMinSeq, sessionTargetWindowState.windowMaxSeq);
        return fromInclusive >= minSeq && toInclusive <= maxSeq;
    }, [sessionTargetWindowState]);

    return React.useMemo(() => ({
        isSeqLoaded,
        isSeqRangeLoaded,
        resolveTargetWindowItemSeq,
        sessionTargetWindowState,
    }), [
        isSeqLoaded,
        isSeqRangeLoaded,
        resolveTargetWindowItemSeq,
        sessionTargetWindowState,
    ]);
}

export function useTranscriptJumpTargetWindowActiveBridge(params: Readonly<{
    activeTargetWindowTargetRef: MutableRef<TranscriptJumpTarget | null>;
    targetWindowActive: boolean;
    targetWindowActiveRef: MutableRef<boolean>;
}>): void {
    useCommittedTranscriptRef(
        params.targetWindowActiveRef,
        params.targetWindowActive,
    );
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
    listRef: MutableRef<ScrollableChatListRef | null>;
    itemsRef: MutableRef<readonly ChatTranscriptListItem[]>;
    messagesById: Readonly<Record<string, Message>>;
    onJumpLanded?: (result: Extract<TranscriptJumpResult, { status: 'scrolled' | 'window-rendered' }>) => void;
    onSuccessfulRouteJumpSettled(sessionId: string): void;
    onViewportChangeRef: MutableRef<((state: TranscriptViewportChangeState) => void) | undefined>;
    pendingJumpSeqViewportPromotionRef: MutableRef<PendingJumpSeqViewportPromotion | null>;
    pinThresholdPx: number;
    pinThresholdPxRef: MutableRef<number>;
    pinToBottom(): boolean;
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
    /**
     * Whether the session's live tail sits BELOW the rendered window — the target-window
     * adapter's own newer-gap answer (`gaps.newer !== null`), i.e. an unexhausted newer cursor
     * OR loaded rows the window range leaves out. Window PRESENCE is not that fact: a window
     * that has caught up renders the live tail at its bottom edge.
     */
    targetWindowHasNewerBeyondRenderedWindow: boolean;
    transcriptNavigationEntries: readonly TranscriptNavigationEntry[];
    transcriptNavigationRuntimeAnchorsRef: MutableRef<readonly TranscriptNavigationRuntimeAnchor[]>;
    waitForNextVisualUpdate(): Promise<void>;
    wantsPinnedRef: MutableRef<boolean>;
}>;

export type TranscriptJumpHost = Readonly<{
    commitJumpToBottomDistanceForVisibility(distanceFromBottom: number): void;
    flushPendingJumpSeqViewportPromotionForExit(): TranscriptExitSnapshotSelection | null;
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
    /**
     * The session's ONE navigation-visibility publication point. `input` carries
     * this frame's user-authority classification, which releases a jump landing's
     * claim on the current anchor. Called without it (layout change, consumer
     * arrival, viewability) the claim is preserved.
     */
    observeTranscriptNavigationVisibilityForSession(
        input?: Readonly<{ genuineUserMovement?: boolean }>,
    ): void;
    onScrollToIndexFailed(info: Readonly<{ index: number; averageItemLength: number }>): void;
    promotePendingJumpSeqViewportSnapshot(params: Readonly<{
        distanceFromBottom: number;
        metrics: WebTranscriptScrollMetrics;
        phase?: 'interim' | 'settled';
        requireRestorableAnchor?: boolean;
        scrollOffsetPx: number;
    }>): boolean;
    shouldSuppressGenericViewportStateForProtectedJumpSeq(): boolean;
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
        listRef,
        itemsRef,
        messagesById,
        onJumpLanded,
        onSuccessfulRouteJumpSettled,
        onViewportChangeRef,
        pendingJumpSeqViewportPromotionRef,
        pinThresholdPx,
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
        targetWindowHasNewerBeyondRenderedWindow,
        transcriptNavigationEntries,
        transcriptNavigationRuntimeAnchorsRef,
        waitForNextVisualUpdate,
        wantsPinnedRef,
    } = deps;

    const [jumpToBottomDistanceFromBottom, setJumpToBottomDistanceFromBottom] = React.useState(0);
    const jumpToBottomDistanceFromBottomRef = React.useRef(0);
    const lastJumpSeqRef = React.useRef<number | null>(null);
    const inFlightJumpSeqRef = React.useRef<number | null>(null);
    const currentExplicitJumpOperationRef = React.useRef<TranscriptExplicitJumpOperationId | null>(null);
    const resolveSeqForMessageIdRef = React.useRef(resolveSeqForMessageId);
    useCommittedTranscriptRef(
        resolveSeqForMessageIdRef,
        resolveSeqForMessageId,
    );
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
    const jumpRevealOffsetThresholdPx = Math.max(pinThresholdPx, Math.trunc(listLayoutHeight * jumpRevealViewportRatio));
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
                resolveSeqForMessageId: resolveSeqForMessageIdRef.current,
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
            resolveSeqForMessageId: resolveSeqForMessageIdRef.current,
            hasMoreOlder: hasMoreOlderRef.current !== false,
        });
    }, [
        hasMoreOlderRef,
        itemsRef,
        resolveRoleForMessageId,
        resolveRouteMessageIdForMessageId,
        resolveSeqForMessageIdRef,
        resolveTranscriptBlockIndexForMessageId,
        targetWindowHasMoreNewer,
    ]);
    useCommittedTranscriptRef(
        resolveJumpToSeqIndexForCommandRef,
        resolveJumpToSeqIndexFromLoadedItems,
    );

    const resolveJumpTargetIndexFromRenderedWindow = React.useCallback((target: TranscriptJumpTarget): TranscriptJumpTargetIndexResult => {
        return resolveTranscriptJumpTargetIndex({
            target,
            items: canonicalWindowedItemsRef.current as readonly Record<string, unknown>[],
            resolveSeqForMessageId: resolveSeqForMessageIdRef.current,
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
        resolveSeqForMessageIdRef,
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

    const flushPendingJumpSeqViewportPromotionForExit = React.useCallback((): TranscriptExitSnapshotSelection | null => {
        const pending = pendingJumpSeqViewportPromotionRef.current;
        if (!pending) return null;
        if (pending.sessionId !== currentSessionIdRef.current) return null;
        if (platformOS !== 'web') return null;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return null;
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
        if (viewportState.isPinned) {
            return {
                source: 'jump-promotion',
                viewport: {
                    anchor: null,
                    capturedAtMs: Date.now(),
                    isPinned: true,
                    offsetY: 0,
                    shouldRestoreViewport: false,
                },
            };
        }
        if (!viewportState.anchor) return null;
        return {
            source: 'jump-promotion',
            viewport: {
                anchor: viewportState.anchor,
                capturedAtMs: viewportState.anchor.capturedAtMs,
                isPinned: false,
                offsetY: viewportState.offsetY,
                shouldRestoreViewport: true,
            },
        };
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
        hasMoreNewerBeyondRenderedWindow: targetWindowHasNewerBeyondRenderedWindow,
        isPinned: scrollPin.isPinned,
        minNewActivityCount: jumpMinNewCount,
        newActivityCount: scrollPin.newActivityCount,
        revealThresholdPx: jumpRevealOffsetThresholdPx,
        viewportHeightPx: listLayoutHeight,
    });

    const transcriptNavigationRuntimeAnchors = React.useMemo(
        () => deriveTranscriptNavigationRuntimeAnchors({
            entries: transcriptNavigationEntries,
            renderedSources: transcriptNavigationRenderedSources,
        }),
        [transcriptNavigationEntries, transcriptNavigationRenderedSources],
    );
    useCommittedTranscriptRef(
        transcriptNavigationRuntimeAnchorsRef,
        transcriptNavigationRuntimeAnchors,
    );

    // Consumer PRESENCE only — never the anchor itself. Presence changes at
    // mount/unmount rate and gates publication below.
    const hasTranscriptNavigationVisibilityConsumers = useTranscriptNavigationVisibilityHasSubscribers(sessionId);

    const listDataRef = React.useRef(listData);
    useCommittedTranscriptRef(listDataRef, listData);

    // Jump-landing intent, held only until the reader takes the viewport back.
    // A ref, not a store: the single publication point below is still the only
    // thing that writes navigation visibility, and the host must not re-render
    // when this changes.
    const landedNavigationAnchorRef = React.useRef<TranscriptNavigationLandedAnchor | null>(null);

    /**
     * The ONE navigation-visibility publication point, in renderer index space on
     * every platform. `readVisibleSourceIndexRange` is the renderer seam's own
     * visible window (Legend list state) — no DOM query and no layout read, so
     * this stays free on the per-scroll-frame path, and it reports null rather
     * than row 0 while the renderer is still unmeasured.
     */
    const observeTranscriptNavigationVisibilityForSession = React.useCallback((
        input?: Readonly<{ genuineUserMovement?: boolean }>,
    ) => {
        const anchors = transcriptNavigationRuntimeAnchorsRef.current;
        // Retention is resolved HERE, immediately before the write, so the frame
        // that carries the reader's own movement already publishes containment.
        const landedNavigationAnchor = resolveRetainedTranscriptNavigationLandedAnchor({
            anchors,
            genuineUserMovement: input?.genuineUserMovement === true,
            landed: landedNavigationAnchorRef.current,
            sessionId,
        });
        landedNavigationAnchorRef.current = landedNavigationAnchor;
        publishTranscriptNavigationVisibility({
            anchors,
            itemCount: listDataRef.current.length,
            landedAnchorId: landedNavigationAnchor?.anchorId ?? null,
            // "Am I measured yet" is the RENDERER's fact, and its reader already
            // answers null while it cannot place a window. Gating on the host's
            // own layout height as well is wrong: on web that state stays 0 for
            // this shell, so a renderer reporting a perfectly good window would
            // be discarded as `unmeasured-viewport` and the rail never lights up.
            readVisibleSourceRange: () => readRendererVisibleSourceIndexRange(listRef.current),
            store: getTranscriptNavigationVisibilityStore(sessionId),
        });
    }, [
        listRef,
        sessionId,
        transcriptNavigationRuntimeAnchorsRef,
    ]);

    // Re-derive without a scroll: a consumer ARRIVING (rail mounted, pane opened)
    // is itself a trigger — publication is subscriber-gated, so without this the
    // store stays empty until the reader scrolls. Anchor/entry changes (pin
    // toggle, prepend, a new turn) and layout/content-size changes all move the
    // visible range too.
    React.useEffect(() => {
        observeTranscriptNavigationVisibilityForSession();
    }, [
        hasTranscriptNavigationVisibilityConsumers,
        listContentHeight,
        listLayoutHeight,
        observeTranscriptNavigationVisibilityForSession,
        transcriptNavigationRuntimeAnchors,
    ]);

    /**
     * The landing seam that already drives the jump highlight also records where
     * the reader was put, and publishes it. A target-window landing produces no
     * scroll frame of its own, so without publishing here the rail keeps showing
     * the pre-jump anchor indefinitely.
     */
    const handleJumpLanded = React.useCallback((
        result: Extract<TranscriptJumpResult, { status: 'scrolled' | 'window-rendered' }>,
    ) => {
        const anchorId = resolveTranscriptNavigationAnchorIdForJumpTarget({
            anchors: transcriptNavigationRuntimeAnchorsRef.current,
            target: result.target,
        });
        landedNavigationAnchorRef.current = anchorId ? { anchorId, sessionId } : null;
        observeTranscriptNavigationVisibilityForSession();
        onJumpLanded?.(result);
    }, [
        observeTranscriptNavigationVisibilityForSession,
        onJumpLanded,
        sessionId,
        transcriptNavigationRuntimeAnchorsRef,
    ]);

    const resolveWebTranscriptTargetObservation = React.useCallback((
        target: TranscriptJumpTarget,
    ): Readonly<{ item: Element; metrics: WebTranscriptScrollMetrics }> | null => {
        const targetIndex = resolveJumpTargetIndexFromRenderedWindow(target);
        if (targetIndex.status !== 'found') return null;
        const targetItem = canonicalWindowedItemsRef.current[targetIndex.index];
        if (!targetItem) return null;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return null;
        const testId = `${TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX}${targetItem.id}`;
        const lookup = queryExactWebTranscriptDataTestId(metrics.element, testId);
        return lookup.element ? { item: lookup.element, metrics } : null;
    }, [
        canonicalWindowedItemsRef,
        resolveJumpTargetIndexFromRenderedWindow,
        resolveWebScrollMetrics,
    ]);

    const isWebTranscriptTargetMounted = React.useCallback((target: TranscriptJumpTarget): boolean => (
        resolveWebTranscriptTargetObservation(target) !== null
    ), [resolveWebTranscriptTargetObservation]);

    const isWebTranscriptTargetAligned = React.useCallback((
        target: TranscriptJumpTarget,
        align: TranscriptViewportJumpAlignment | undefined,
    ): boolean => {
        const observation = resolveWebTranscriptTargetObservation(target);
        return observation !== null && isTranscriptTargetObservedAtAlignment({
            align,
            item: observation.item,
            metrics: observation.metrics,
        });
    }, [resolveWebTranscriptTargetObservation]);

    const jumpToBottom = React.useCallback(() => {
        const plan = lifecycleHost.planExplicitJumpTakeover({
            reason: 'jump-to-bottom',
            sessionId,
        });
        commitBottomFollowModeState(plan.state.bottomFollowState);
        applyExplicitJumpTakeoverApplyEffects(plan.explicitJumpTakeoverEffects);
        const command = resolveViewportCommand({
            type: 'jump-to-bottom',
            sessionId,
        });
        if (!executeViewportCommandWithAnimation(command, jumpAnimateScroll)) {
            pinToBottom();
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
        pinToBottom,
        resolveViewportCommand,
        sessionId,
    ]);

    const jumpToTranscriptTarget = React.useCallback(async (
        target: TranscriptJumpTarget,
        options?: Readonly<{ align?: TranscriptViewportJumpAlignment; preferTargetWindow?: boolean }>,
    ): Promise<TranscriptJumpResult> => {
        const targetRequest = resolveTranscriptJumpTargetRequest(target);
        if (!targetRequest) return { status: 'not-found', reason: 'invalid-target' };
        const { normalizedTargetSeq, routeMessageId, transcriptBlockIndex, role } = targetRequest;
        if (!sessionId) return { status: 'not-found', reason: 'unavailable' };
        const operationId: TranscriptExplicitJumpOperationId = Symbol('transcript-explicit-jump');
        currentExplicitJumpOperationRef.current = operationId;
        const isCurrentOperation = (): boolean => currentExplicitJumpOperationRef.current === operationId;
        const takeoverPlan = lifecycleHost.planExplicitJumpTakeover({
            reason: 'jump-to-seq',
            sessionId,
        });
        commitBottomFollowModeState(takeoverPlan.state.bottomFollowState);
        applyExplicitJumpTakeoverApplyEffects(takeoverPlan.explicitJumpTakeoverEffects);
        const acquiredRenderer = listRef.current;
        const releaseRendererTakeover = acquiredRenderer?.beginExplicitJumpTakeover?.(operationId);
        beginExplicitJumpWriteBarrier();
        const scrollToTarget = (): boolean => {
            if (!isCurrentOperation()) return false;
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
            if (!isCurrentOperation()) return false;
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
        const isTargetOwnedByRenderer = (): boolean => {
            const targetIndex = resolveJumpTargetIndexFromRenderedWindow(target);
            if (targetIndex.status !== 'found') return false;
            const targetItem = canonicalWindowedItemsRef.current[targetIndex.index];
            if (!targetItem) return false;
            return listRef.current?.hasLiveWebHold?.({
                kind: 'item',
                itemId: targetItem.id,
            }) === true;
        };
        try {
            const result = await executeTranscriptTargetWindowJump({
                align: options?.align,
                canRenderTargetWindow: options?.preferTargetWindow === true && !forkedTranscriptEnabled,
                forceTargetWindow: options?.preferTargetWindow === true,
                isCurrentOperation,
                isTargetAligned: platformOS === 'web'
                    ? () => isWebTranscriptTargetAligned(target, options?.align)
                    : undefined,
                isTargetInRenderedWindow: () => isTranscriptJumpTargetInRenderedWindow(target),
                isTargetMounted: () => platformOS === 'web'
                    ? isWebTranscriptTargetMounted(target)
                    : true,
                isTargetOwnedByRenderer: platformOS === 'web'
                    ? isTargetOwnedByRenderer
                    : undefined,
                loadTargetWindow: async ({ target: windowTarget, direction }) => {
                    const loadTarget = resolveTranscriptTargetWindowLoadTarget(windowTarget, normalizedTargetSeq);
                    const result = await sync.loadTargetWindowMessages(sessionId, loadTarget, {
                        direction: direction ?? 'initial',
                    });
                    if (!isCurrentOperation()) return { status: 'stale' as const };
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
                onJumpLanded: handleJumpLanded,
                pageTowardTarget: async () => {
                    const syncLoadOlderOptions = resolveSyncLoadOlderOptions();
                    const loadOlderResult = forkedTranscriptEnabled
                        ? (syncLoadOlderOptions
                            ? await sync.loadOlderMessagesForkAware(sessionId, syncLoadOlderOptions)
                            : await sync.loadOlderMessagesForkAware(sessionId))
                        : (syncLoadOlderOptions
                            ? await sync.loadOlderMessages(sessionId, syncLoadOlderOptions)
                            : await sync.loadOlderMessages(sessionId));
                    if (!isCurrentOperation()) return { status: 'aborted' };
                    if (loadOlderResult.status === 'no_more') {
                        return { status: 'not-found', reason: 'exhausted' };
                    }
                    await Promise.resolve();
                    if (!isCurrentOperation()) return { status: 'aborted' };
                    await Promise.resolve();
                    if (!isCurrentOperation()) return { status: 'aborted' };
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
            if (!isCurrentOperation()) return { status: 'aborted' };
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
            if (
                platformOS !== 'web' &&
                (result.status === 'scrolled' || result.status === 'window-rendered')
            ) {
                const distanceFromBottom = readCurrentNativeDistanceFromBottom();
                if (
                    distanceFromBottom !== null &&
                    Number.isFinite(distanceFromBottom) &&
                    distanceFromBottom > pinThresholdPxRef.current
                ) {
                    const measuredDistanceFromBottom = Math.max(0, distanceFromBottom);
                    invalidateViewportAnchorCapture();
                    wantsPinnedRef.current = false;
                    isPinnedRef.current = false;
                    lastPinOffsetForIntentRef.current = measuredDistanceFromBottom;
                    commitBottomFollowModeState({ dragSession: null, mode: 'released' });
                    commitJumpToBottomDistanceForVisibility(measuredDistanceFromBottom);
                    commitScrollPinState({
                        ...scrollPinRef.current,
                        isPinned: false,
                    });
                    emitViewportChange({
                        isPinned: false,
                        offsetY: measuredDistanceFromBottom,
                        shouldRestoreViewport: true,
                    });
                }
            }
            return result;
        } finally {
            endExplicitJumpWriteBarrier();
            releaseRendererTakeover?.();
            if (currentExplicitJumpOperationRef.current === operationId) {
                currentExplicitJumpOperationRef.current = null;
            }
        }
    }, [
        activeTargetWindowTargetRef,
        beginExplicitJumpWriteBarrier,
        canonicalWindowedItemsRef,
        commitJumpToBottomDistanceForVisibility,
        commitScrollPinState,
        emitViewportChange,
        endExplicitJumpWriteBarrier,
        executeViewportCommandWithAnimation,
        forkedTranscriptEnabled,
        invalidateViewportAnchorCapture,
        isPinnedRef,
        isTranscriptJumpTargetInRenderedWindow,
        isWebTranscriptTargetAligned,
        isWebTranscriptTargetMounted,
        lastPinOffsetForIntentRef,
        lastRouteJumpProtectionClearingWebMovementAtMsRef,
        handleJumpLanded,
        onViewportChangeRef,
        pendingJumpSeqViewportPromotionRef,
        pinThresholdPxRef,
        platformOS,
        promotePendingJumpSeqViewportSnapshot,
        readCurrentNativeDistanceFromBottom,
        resolveJumpTargetIndexFromRenderedWindow,
        resolveSyncLoadOlderOptions,
        resolveViewportCommand,
        resolveWebScrollMetrics,
        applyExplicitJumpTakeoverApplyEffects,
        commitBottomFollowModeState,
        lifecycleHost,
        listRef,
        scrollPinRef,
        sessionId,
        waitForNextVisualUpdate,
        wantsPinnedRef,
    ]);

    const isTranscriptNavigationTargetInRenderedWindow = React.useCallback((target: TranscriptJumpTarget): boolean => {
        return resolveTranscriptNavigationTargetInRenderedWindow({
            platformOS,
            isTargetInItemSpace: isTranscriptJumpTargetInRenderedWindow(target),
            isTargetMountedInDom: () => isWebTranscriptTargetMounted(target),
        });
    }, [
        isTranscriptJumpTargetInRenderedWindow,
        isWebTranscriptTargetMounted,
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
            onEntryPress: handleTranscriptNavigationPaneEntryPress,
        });
        return () => {
            transcriptNavigationPaneStore.set(sessionId, null);
        };
    }, [
        handleTranscriptNavigationPaneEntryPress,
        sessionId,
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
                if (
                    (result.status === 'scrolled' || result.status === 'window-rendered') &&
                    inFlightJumpSeqRef.current === normalizedTarget
                ) {
                    lastJumpSeqRef.current = normalizedTarget;
                    onSuccessfulRouteJumpSettled(sessionId);
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
        onSuccessfulRouteJumpSettled,
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
        observeTranscriptNavigationVisibilityForSession,
        onScrollToIndexFailed,
        promotePendingJumpSeqViewportSnapshot,
        shouldSuppressGenericViewportStateForProtectedJumpSeq,
    }), [
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
    ]);
}
