import {
    resolveTranscriptBottomFollowMode,
    type TranscriptBottomFollowMode,
    type TranscriptBottomFollowModeState,
} from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';
import type { TranscriptViewportScrollReason } from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import type {
    GenericScrollObservationAnchorCaptureCancellationEffect,
    GenericScrollObservationReadOnlyVisibleBottomState,
    GenericScrollObservationSuppressionReason,
    GenericScrollObservationViewportState,
} from './genericScrollObservationViewportState';

export type TranscriptViewportGesturePhase = 'settled' | 'dragging' | 'momentum';

export type TranscriptViewportLifecycleState = Readonly<{
    automaticPinAuthority: boolean;
    bottomFollowState: TranscriptBottomFollowModeState;
    fingerDown: boolean;
    followMode: TranscriptBottomFollowMode;
    gesturePhase: TranscriptViewportGesturePhase;
    sessionId: string | null;
}>;

export type TranscriptViewportLifecycleCommand = Readonly<{
    reason: TranscriptViewportScrollReason;
    type: 'scroll-to-live-tail';
}>;

export type TranscriptViewportExplicitJumpTakeoverReason = 'jump-to-bottom' | 'jump-to-seq';

export type TranscriptViewportLifecycleEffect =
    | Readonly<{
        command: TranscriptViewportLifecycleCommand;
        sessionId: string;
        type: 'command';
    }>
    | Readonly<{
        distanceFromLiveTailPx: number;
        isPinned: true;
        sessionId: string;
        source: 'explicit-return' | 'mode-following';
        type: 'viewport-change';
    }>
    | Readonly<{
        sessionId: string;
        type: 'explicit-return-clear-user-scroll-intent';
    }>
    | Readonly<{
        distanceFromLiveTailPx: number;
        isPinned: true;
        sessionId: string;
        type: 'drain-deferred-newer';
    }>
    | Readonly<{
        distanceFromLiveTailPx: number | null;
        isPinned: boolean;
        sessionId: string;
        shouldRestoreViewport: boolean;
        type: 'session-entry-viewport';
    }>
    | Readonly<{
        sessionId: string;
        type: 'session-entry-web-dom-observation-reset';
    }>
    | Readonly<{
        sessionId: string;
        type: 'session-entry-native-bottom-pin-command-cache-reset';
    }>
    | Readonly<{
        sessionId: string;
        type: 'session-entry-native-gesture-momentum-mirror-reset';
    }>
    | Readonly<{
        sessionId: string;
        type: 'session-entry-native-stream-append-content-version-record-reset';
    }>
    | Readonly<{
        sessionId: string;
        type: 'session-entry-activity-key-baseline-reset';
    }>
    | Readonly<{
        sessionId: string;
        type: 'session-entry-older-pagination-reset';
    }>
    | Readonly<{
        sessionId: string;
        type: 'session-entry-native-session-viewport-reset';
    }>
    | Readonly<{
        sessionId: string;
        type: 'session-entry-entry-restore-active-refs-reset';
    }>
    | Readonly<{
        sessionId: string;
        type: 'session-entry-entry-restore-local-state-reset';
    }>
    | Readonly<{
        sessionId: string;
        type: 'session-entry-entry-restore-timeout-cleanup';
    }>
    | Readonly<{
        sessionId: string;
        type: 'session-entry-native-prepend-transaction-invalidation';
    }>
    | Readonly<{
        sessionId: string;
        type: 'session-entry-native-explicit-jump-confirmation-reset';
    }>
    | Readonly<{
        sessionId: string;
        shouldArmConfirmation: boolean;
        type: 'session-entry-native-entry-settle-confirmation-reset';
    }>
    | Readonly<{
        sessionId: string;
        type: 'session-entry-native-index-scroll-command-cache-reset';
    }>
    | Readonly<{
        sessionId: string;
        type: 'session-entry-entry-restore-anchor-lookup-reset';
    }>
    | Readonly<{
        openEntryTransaction: boolean;
        sessionId: string;
        type: 'session-entry-command-controller-reset';
    }>
    | Readonly<{
        sessionId: string;
        type: 'session-entry-measurement-reset';
    }>
    | Readonly<{
        reason: TranscriptViewportExplicitJumpTakeoverReason;
        sessionId: string;
        type: 'explicit-jump-cancel-native-mount-settle-bottom-pin';
    }>
    | Readonly<{
        reason: TranscriptViewportExplicitJumpTakeoverReason;
        sessionId: string;
        type: 'explicit-jump-suppress-entry-restore';
    }>
    | Readonly<{
        reason: TranscriptViewportExplicitJumpTakeoverReason;
        sessionId: string;
        type: 'explicit-jump-preempt-entry-restore';
    }>
    | Readonly<{
        reason: TranscriptViewportExplicitJumpTakeoverReason;
        sessionId: string;
        type: 'explicit-jump-clear-native-entry-restore-paint-release-timeout';
    }>
    | Readonly<{
        reason: TranscriptViewportExplicitJumpTakeoverReason;
        sessionId: string;
        type: 'explicit-jump-invalidate-native-prepend-transaction';
    }>
    | Readonly<{
        reason: TranscriptViewportExplicitJumpTakeoverReason;
        sessionId: string;
        type: 'explicit-jump-clear-native-restore-index-command-cache';
    }>
    | Readonly<{
        reason: TranscriptViewportExplicitJumpTakeoverReason;
        sessionId: string;
        type: 'explicit-jump-close-native-prepend-transaction';
    }>
    | Readonly<{
        sessionId: string;
        type: 'follow-bottom-intent-preempt-entry-restore';
    }>
    | Readonly<{
        sessionId: string;
        type: 'follow-bottom-intent-clear-user-scroll-intent';
    }>
    | Readonly<{
        distanceFromLiveTailPx: number;
        sessionId: string;
        type: 'follow-bottom-intent-record-live-tail-pin-offset';
    }>
    | Readonly<{
        sessionId: string;
        type: 'native-user-scroll-preempt-entry-restore';
    }>
    | Readonly<{
        sessionId: string;
        type: 'native-user-scroll-cancel-native-mount-settle-bottom-pin';
    }>
    | Readonly<{
        sessionId: string;
        type: 'native-user-scroll-suppress-native-mount-settle-auto-pin';
    }>
    | Readonly<{
        sessionId: string;
        type: 'native-user-scroll-clear-native-initial-viewport-pending-observation';
    }>
    | Readonly<{
        sessionId: string;
        timestampMs: number;
        type: 'native-user-scroll-record-intent-timestamp';
    }>
    | Readonly<{
        sessionId: string;
        timestampMs: number;
        type: 'native-touch-record-intent-timestamp';
    }>
    | Readonly<{
        sessionId: string;
        type: 'native-touch-suppress-native-mount-settle-auto-pin';
    }>
    | Readonly<{
        sessionId: string;
        type: 'native-touch-cancel-native-mount-settle-bottom-pin';
    }>
    | Readonly<{
        sessionId: string;
        type: 'native-touch-cancel-scheduled-pin';
    }>
    | Readonly<{
        sessionId: string;
        timestampMs: number;
        type: 'local-interaction-record-intent-timestamp';
    }>
    | Readonly<{
        sessionId: string;
        type: 'local-interaction-suppress-native-mount-settle-auto-pin';
    }>
    | Readonly<{
        sessionId: string;
        type: 'local-interaction-cancel-scheduled-pin';
    }>
    | Readonly<{
        sessionId: string;
        type: 'web-user-scroll-preempt-entry-restore';
    }>
    | Readonly<{
        sessionId: string;
        type: 'web-user-scroll-preempt-explicit-jump';
    }>
    | Readonly<{
        sessionId: string;
        timestampMs: number;
        type: 'web-user-scroll-record-intent-timestamp';
    }>
    | Readonly<{
        distanceFromLiveTailPx: number;
        isPinned: false;
        sessionId: string;
        type: 'web-release-live-tail';
    }>
    | Readonly<{
        sessionId: string;
        type: 'web-immediate-release-live-tail';
    }>
    | Readonly<{
        distanceFromLiveTailPx: number;
        sessionId: string;
        type: 'native-touch-release-live-tail';
    }>
    | Readonly<{
        distanceFromLiveTailPx: number;
        sessionId: string;
        type: 'native-offset-release-live-tail';
    }>
    | Readonly<{
        distanceFromLiveTailPx: number;
        isPinned: false;
        sessionId: string;
        type: 'native-scroll-release-live-tail';
    }>
    | Readonly<{
        distanceFromLiveTailPx: number;
        isPinned: boolean;
        pinnedOffsetThresholdPx: number;
        sessionId: string;
        shouldRestoreViewport: boolean;
        type: 'native-observed-viewport-state';
        wantsPinned: boolean;
    }>
    | Readonly<{
        sessionId: string;
        state: GenericScrollObservationViewportState;
        type: 'apply-generic-observed-viewport-state';
    }>
    | Readonly<{
        sessionId: string;
        state: GenericScrollObservationReadOnlyVisibleBottomState;
        type: 'apply-generic-read-only-visible-bottom-state';
    }>
    | Readonly<{
        reason: GenericScrollObservationSuppressionReason;
        sessionId: string;
        type: 'suppress-generic-scroll-observation';
    }>
    | GenericScrollObservationAnchorCaptureCancellationEffect
    | Readonly<{
        distanceFromLiveTailPx: number;
        sessionId: string;
        type: 'native-momentum-settle-away-release-live-tail';
    }>
    | Readonly<{
        active: boolean;
        sessionId: string;
        type: 'native-momentum-active-mirror';
    }>
    | Readonly<{
        active: boolean;
        sessionId: string;
        type: 'native-drag-active-mirror';
    }>
    | Readonly<{
        sessionId: string;
        type: 'native-bottom-follow-rearm-reset';
    }>
    | Readonly<{
        distanceFromLiveTailPx: number;
        sessionId: string;
        type: 'native-bottom-follow-rearm';
    }>
    | Readonly<{
        distanceFromLiveTailPx: number;
        isPinned: boolean;
        pinnedOffsetThresholdPx: number;
        sessionId: string;
        shouldRestoreViewport: boolean;
        type: 'web-observed-viewport-state';
        wantsPinned: boolean;
    }>;

export type TranscriptViewportLifecycleTransition = Readonly<{
    effects: readonly TranscriptViewportLifecycleEffect[];
    state: TranscriptViewportLifecycleState;
}>;

export type TranscriptViewportLifecycleEvent =
    | Readonly<{
        entryDistanceFromLiveTailPx?: number | null;
        platform?: 'native' | 'web';
        sessionId: string;
        shouldFollowLiveTail: boolean;
        type: 'session-entry';
    }>
    | Readonly<{
        sessionId: string;
        type: 'gesture-start';
    }>
    | Readonly<{
        distanceFromLiveTailPx: number;
        movement: 'away-from-live-tail' | 'none' | 'toward-live-tail';
        pinThresholdPx: number;
        releaseAuthority?: 'web-genuine-movement';
        sessionId: string;
        source?: 'native-offset-escape' | 'native-scroll' | 'native-touch-escape' | 'web-scroll';
        trustedUserMovement: boolean;
        type: 'facts-observed';
    }>
    | Readonly<{
        distanceFromLiveTailPx: number | null;
        pinThresholdPx: number;
        sessionId: string;
        type: 'gesture-end';
    }>
    | Readonly<{
        distanceFromLiveTailPx: number | null;
        pinThresholdPx: number;
        sessionId: string;
        type: 'momentum-settle';
    }>
    | Readonly<{
        sessionId: string;
        type: 'native-momentum-scroll-begin';
    }>
    | Readonly<{
        sessionId: string;
        type: 'native-momentum-scroll-end';
    }>
    | Readonly<{
        reason: TranscriptViewportScrollReason;
        sessionId: string;
        type: 'content-growth';
        wantsLiveTail: boolean;
    }>
    | Readonly<{
        intent: 'follow-bottom-intent' | 'jump-to-bottom';
        sessionId: string;
        type: 'return-to-live-tail-intent';
    }>
    | Readonly<{
        sessionId: string;
        source: 'web-immediate-user-intent';
        type: 'release-live-tail-intent';
    }>
    | Readonly<{
        reason: TranscriptViewportExplicitJumpTakeoverReason;
        sessionId: string;
        type: 'explicit-jump-takeover';
    }>
    | Readonly<{
        sessionId: string;
        type: 'follow-bottom-intent-takeover';
    }>
    | Readonly<{
        sessionId: string;
        timestampMs: number;
        type: 'native-user-scroll-takeover';
    }>
    | Readonly<{
        hasActiveNativeViewportRestore: boolean;
        sessionId: string;
        timestampMs: number;
        type: 'native-touch-intent';
    }>
    | Readonly<{
        sessionId: string;
        timestampMs: number;
        type: 'local-transcript-interaction-auto-pin-deferral';
    }>
    | Readonly<{
        sessionId: string;
        type: 'web-user-scroll-takeover';
    }>
    | Readonly<{
        sessionId: string;
        timestampMs: number;
        type: 'web-user-scroll-intent-timestamp';
    }>;

export type TranscriptViewportLifecycle = Readonly<{
    dispatch(event: TranscriptViewportLifecycleEvent): TranscriptViewportLifecycleTransition;
    getState(): TranscriptViewportLifecycleState;
}>;

export type SessionEntryCommandControllerReset = Readonly<{
    openEntryTransaction: boolean;
}>;

type MutableLifecycleState = {
    bottomFollow: TranscriptBottomFollowModeState;
    gesturePhase: TranscriptViewportGesturePhase;
    modeBeforeGesture: TranscriptBottomFollowMode | null;
    sessionId: string | null;
};

export function resolveSessionEntryCommandControllerReset(params: Readonly<{
    platform: 'native' | 'web';
    shouldFollowLiveTail: boolean;
}>): SessionEntryCommandControllerReset {
    return {
        openEntryTransaction:
            !params.shouldFollowLiveTail ||
            params.platform !== 'web',
    };
}

export function createTranscriptViewportLifecycle(): TranscriptViewportLifecycle {
    const current: MutableLifecycleState = {
        bottomFollow: { dragSession: null, mode: 'following' },
        gesturePhase: 'settled',
        modeBeforeGesture: null,
        sessionId: null,
    };

    const getState = (): TranscriptViewportLifecycleState => snapshot(current);

    const dispatch = (event: TranscriptViewportLifecycleEvent): TranscriptViewportLifecycleTransition => {
        if (event.type === 'session-entry') {
            current.sessionId = event.sessionId;
            current.gesturePhase = 'settled';
            current.modeBeforeGesture = null;
            current.bottomFollow = resolveTranscriptBottomFollowMode(current.bottomFollow, {
                shouldFollowBottom: event.shouldFollowLiveTail,
                type: 'session-entry',
            });
            return {
                effects: sessionEntryViewportEffects(event),
                state: snapshot(current),
            };
        }

        if (current.sessionId !== event.sessionId) {
            return { effects: [], state: snapshot(current) };
        }

        switch (event.type) {
            case 'gesture-start': {
                const effects = [
                    ...nativeMomentumActiveMirrorEffects(event.sessionId, false),
                    ...nativeDragActiveMirrorEffects(event.sessionId, true),
                    ...nativeBottomFollowRearmResetEffects(event.sessionId),
                ];
                if (current.gesturePhase === 'dragging') {
                    return { effects, state: snapshot(current) };
                }
                current.gesturePhase = 'dragging';
                current.modeBeforeGesture = current.bottomFollow.mode;
                current.bottomFollow = resolveTranscriptBottomFollowMode(current.bottomFollow, {
                    type: 'list-drag-start',
                });
                return { effects, state: snapshot(current) };
            }
            case 'facts-observed':
                return observeFacts(current, event);
            case 'gesture-end': {
                const dragActiveMirrorEffects = nativeDragActiveMirrorEffects(event.sessionId, false);
                if (current.gesturePhase !== 'dragging') {
                    return { effects: dragActiveMirrorEffects, state: snapshot(current) };
                }
                const modeBeforeGesture = current.modeBeforeGesture;
                current.bottomFollow = resolveTranscriptBottomFollowMode(current.bottomFollow, {
                    distanceFromBottom: event.distanceFromLiveTailPx,
                    pinThresholdPx: event.pinThresholdPx,
                    sawAwayMovement: current.bottomFollow.dragSession?.sawAwayMovement === true,
                    type: 'drag-end',
                });
                current.gesturePhase = 'momentum';
                const returnedToLiveTail =
                    modeBeforeGesture !== null &&
                    modeBeforeGesture !== 'following' &&
                    current.bottomFollow.mode === 'following';
                const rearmedAlreadyFollowing =
                    modeBeforeGesture === 'following' &&
                    current.bottomFollow.mode === 'following';
                const effects = returnedToLiveTail
                    ? returnToLiveTailEffects(event.sessionId, event.distanceFromLiveTailPx ?? 0)
                    : rearmedAlreadyFollowing
                    ? nativeBottomFollowRearmEffects(event.sessionId, event.distanceFromLiveTailPx ?? 0)
                    : current.bottomFollow.mode !== 'following'
                    ? nativeBottomFollowRearmResetEffects(event.sessionId)
                    : [];
                if (returnedToLiveTail) {
                    current.modeBeforeGesture = null;
                } else if (rearmedAlreadyFollowing) {
                    current.modeBeforeGesture = 'following';
                }
                return { effects: [...dragActiveMirrorEffects, ...effects], state: snapshot(current) };
            }
            case 'momentum-settle': {
                const previousPhase = current.gesturePhase;
                const modeBeforeGesture = current.modeBeforeGesture;
                if (
                    (current.bottomFollow.mode !== 'released' && current.bottomFollow.mode !== 'following') ||
                    current.bottomFollow.dragSession?.trusted !== true
                ) {
                    return { effects: [], state: snapshot(current) };
                }
                const previousDragDistanceFromLiveTailPx =
                    current.bottomFollow.dragSession?.latestDistanceFromBottom ?? null;
                current.bottomFollow = resolveTranscriptBottomFollowMode(current.bottomFollow, {
                    distanceFromBottom: event.distanceFromLiveTailPx,
                    pinThresholdPx: event.pinThresholdPx,
                    type: 'momentum-settle',
                });
                current.gesturePhase = 'settled';
                current.modeBeforeGesture = null;
                const settledDistanceFromLiveTailPx =
                    event.distanceFromLiveTailPx ?? previousDragDistanceFromLiveTailPx ?? 0;
                const returnedToLiveTail =
                    previousPhase === 'momentum' &&
                    modeBeforeGesture !== null &&
                    modeBeforeGesture !== 'following' &&
                    current.bottomFollow.mode === 'following';
                const releasedFromMomentumSettle =
                    previousPhase === 'momentum' &&
                    modeBeforeGesture !== null &&
                    current.bottomFollow.mode === 'released';
                const rearmedAfterFollowingMomentum =
                    previousPhase === 'momentum' &&
                    modeBeforeGesture === 'following' &&
                    current.bottomFollow.mode === 'following';
                return {
                    effects: returnedToLiveTail
                        ? returnToLiveTailEffects(event.sessionId, settledDistanceFromLiveTailPx)
                    : releasedFromMomentumSettle
                        ? nativeMomentumSettleAwayReleaseLiveTailEffects(
                            event.sessionId,
                            settledDistanceFromLiveTailPx,
                        )
                    : rearmedAfterFollowingMomentum
                        ? nativeBottomFollowRearmEffects(event.sessionId, settledDistanceFromLiveTailPx)
                        : [],
                    state: snapshot(current),
                };
            }
            case 'native-momentum-scroll-begin':
                return {
                    effects: nativeMomentumActiveMirrorEffects(event.sessionId, true),
                    state: snapshot(current),
                };
            case 'native-momentum-scroll-end':
                return {
                    effects: nativeMomentumActiveMirrorEffects(event.sessionId, false),
                    state: snapshot(current),
                };
            case 'content-growth':
                return {
                    effects: automaticLiveTailPinAuthority(current) &&
                        current.bottomFollow.mode === 'following' &&
                        event.wantsLiveTail
                        ? [
                            {
                                command: {
                                    reason: event.reason,
                                    type: 'scroll-to-live-tail',
                                },
                                sessionId: event.sessionId,
                                type: 'command',
                            },
                        ]
                    : [],
                    state: snapshot(current),
                };
            case 'return-to-live-tail-intent':
                current.bottomFollow = resolveTranscriptBottomFollowMode(current.bottomFollow, {
                    type: event.intent,
                });
                current.gesturePhase = 'settled';
                current.modeBeforeGesture = null;
                return {
                    effects: explicitReturnToLiveTailEffects(event.sessionId),
                    state: snapshot(current),
                };
            case 'release-live-tail-intent':
                current.bottomFollow = resolveTranscriptBottomFollowMode(current.bottomFollow, {
                    type: 'release-live-tail-intent',
                });
                return {
                    effects: webImmediateReleaseLiveTailEffects(event.sessionId),
                    state: snapshot(current),
                };
            case 'explicit-jump-takeover':
                return {
                    effects: explicitJumpTakeoverEffects(event.sessionId, event.reason),
                    state: snapshot(current),
                };
            case 'follow-bottom-intent-takeover':
                return {
                    effects: followBottomIntentTakeoverEffects(event.sessionId),
                    state: snapshot(current),
                };
            case 'native-user-scroll-takeover':
                return {
                    effects: nativeUserScrollTakeoverEffects(event.sessionId, event.timestampMs),
                    state: snapshot(current),
                };
            case 'native-touch-intent':
                return {
                    effects: nativeTouchIntentEffects(
                        event.sessionId,
                        event.timestampMs,
                        event.hasActiveNativeViewportRestore,
                    ),
                    state: snapshot(current),
                };
            case 'local-transcript-interaction-auto-pin-deferral':
                return {
                    effects: localTranscriptInteractionAutoPinDeferralEffects(event.sessionId, event.timestampMs),
                    state: snapshot(current),
                };
            case 'web-user-scroll-takeover':
                return {
                    effects: webUserScrollTakeoverEffects(event.sessionId),
                    state: snapshot(current),
                };
            case 'web-user-scroll-intent-timestamp':
                return {
                    effects: webUserScrollIntentTimestampEffects(event.sessionId, event.timestampMs),
                    state: snapshot(current),
                };
        }
    };

    return {
        dispatch,
        getState,
    };
}

function observeFacts(
    current: MutableLifecycleState,
    event: Extract<TranscriptViewportLifecycleEvent, { type: 'facts-observed' }>,
): TranscriptViewportLifecycleTransition {
    if (event.source === 'web-scroll') {
        return observeWebScrollFacts(current, event);
    }

    const previousMode = current.bottomFollow.mode;
    const previousPhase = current.gesturePhase;
    const distanceFromLiveTailPx = normalizeDistance(event.distanceFromLiveTailPx);
    const pinThresholdPx = normalizeDistance(event.pinThresholdPx);
    if (
        event.trustedUserMovement &&
        (
            event.movement === 'toward-live-tail' ||
            distanceFromLiveTailPx <= pinThresholdPx
        )
    ) {
        current.bottomFollow = resolveTranscriptBottomFollowMode(current.bottomFollow, {
            distanceFromBottom: event.distanceFromLiveTailPx,
            movedTowardBottom: true,
            pinThresholdPx: event.pinThresholdPx,
            type: 'trusted-bottom-observation',
        });
    } else if (event.trustedUserMovement && event.movement === 'away-from-live-tail') {
        current.bottomFollow = resolveTranscriptBottomFollowMode(current.bottomFollow, {
            distanceFromBottom: event.distanceFromLiveTailPx,
            movedAwayFromBottom: true,
            pinThresholdPx: event.pinThresholdPx,
            type: 'trusted-away-observation',
        });
    } else {
        current.bottomFollow = resolveTranscriptBottomFollowMode(current.bottomFollow, {
            distanceFromBottom: event.distanceFromLiveTailPx,
            pinThresholdPx: event.pinThresholdPx,
            type: 'passive-bottom-observation',
        });
    }

    const returnedToLiveTail =
        previousPhase === 'settled' &&
        previousMode !== 'following' &&
        current.bottomFollow.mode === 'following';
    const releasedFromNativeTouch =
        event.source === 'native-touch-escape' &&
        previousPhase === 'dragging' &&
        event.movement === 'away-from-live-tail' &&
        current.bottomFollow.mode === 'released';
    const releasedFromNativeOffset =
        event.source === 'native-offset-escape' &&
        previousPhase === 'dragging' &&
        event.movement === 'away-from-live-tail' &&
        current.bottomFollow.mode === 'released';
    const releasedFromNativeScroll =
        event.source === 'native-scroll' &&
        previousMode !== 'released' &&
        (previousPhase === 'dragging' || previousPhase === 'momentum') &&
        event.movement === 'away-from-live-tail' &&
        current.bottomFollow.mode === 'released';
    const shouldEmitNativeObservedViewportState =
        event.source === 'native-scroll' &&
        event.movement !== 'away-from-live-tail' &&
        !(
            current.bottomFollow.mode !== 'following' &&
            distanceFromLiveTailPx <= pinThresholdPx
        );
    return {
        effects: returnedToLiveTail
            ? returnToLiveTailEffects(event.sessionId, event.distanceFromLiveTailPx)
            : releasedFromNativeTouch
                ? nativeTouchReleaseLiveTailEffects(event.sessionId, event.distanceFromLiveTailPx)
            : releasedFromNativeOffset
                ? nativeOffsetReleaseLiveTailEffects(event.sessionId, event.distanceFromLiveTailPx)
            : releasedFromNativeScroll
                ? nativeScrollReleaseLiveTailEffects(event.sessionId, event.distanceFromLiveTailPx)
            : shouldEmitNativeObservedViewportState
                ? nativeObservedViewportStateEffects(event.sessionId, {
                    distanceFromLiveTailPx: event.distanceFromLiveTailPx,
                    followMode: current.bottomFollow.mode,
                    pinThresholdPx: event.pinThresholdPx,
                })
            : [],
        state: snapshot(current),
    };
}

function observeWebScrollFacts(
    current: MutableLifecycleState,
    event: Extract<TranscriptViewportLifecycleEvent, { type: 'facts-observed' }>,
): TranscriptViewportLifecycleTransition {
    const previousMode = current.bottomFollow.mode;
    const distanceFromLiveTailPx = normalizeDistance(event.distanceFromLiveTailPx);
    const pinThresholdPx = normalizeDistance(event.pinThresholdPx);
    const nearLiveTail = distanceFromLiveTailPx <= pinThresholdPx;
    let returnedToLiveTail = false;

    if (event.releaseAuthority === 'web-genuine-movement' && event.movement === 'away-from-live-tail') {
        current.bottomFollow = {
            dragSession: null,
            mode: 'released',
        };
    } else if (
        distanceFromLiveTailPx === 0 ||
        (event.movement === 'toward-live-tail' && nearLiveTail)
    ) {
        current.bottomFollow = {
            dragSession: null,
            mode: 'following',
        };
        returnedToLiveTail =
            previousMode !== 'following' &&
            event.movement === 'toward-live-tail' &&
            nearLiveTail;
    }
    const releasedFromLiveTail =
        previousMode === 'following' &&
        current.bottomFollow.mode === 'released';

    return {
        effects: returnedToLiveTail
            ? returnToLiveTailEffects(event.sessionId, distanceFromLiveTailPx)
            : releasedFromLiveTail
                ? webReleaseLiveTailEffects(event.sessionId, distanceFromLiveTailPx)
                : webObservedViewportStateEffects(event.sessionId, {
                    distanceFromLiveTailPx,
                    followMode: current.bottomFollow.mode,
                    pinThresholdPx,
                }),
        state: snapshot(current),
    };
}

function webObservedViewportStateEffects(
    sessionId: string,
    params: Readonly<{
        distanceFromLiveTailPx: number;
        followMode: TranscriptBottomFollowMode;
        pinThresholdPx: number;
    }>,
): readonly TranscriptViewportLifecycleEffect[] {
    const wantsPinned = params.followMode === 'following';
    const pinnedOffsetThresholdPx = wantsPinned ? normalizeDistance(params.pinThresholdPx) : 0;
    const distanceFromLiveTailPx = normalizeDistance(params.distanceFromLiveTailPx);
    return [
        {
            distanceFromLiveTailPx,
            isPinned: wantsPinned && distanceFromLiveTailPx <= pinnedOffsetThresholdPx,
            pinnedOffsetThresholdPx,
            sessionId,
            shouldRestoreViewport: !wantsPinned,
            type: 'web-observed-viewport-state',
            wantsPinned,
        },
    ];
}

function webReleaseLiveTailEffects(
    sessionId: string,
    distanceFromLiveTailPx: number,
): readonly TranscriptViewportLifecycleEffect[] {
    return [
        {
            distanceFromLiveTailPx: normalizeDistance(distanceFromLiveTailPx),
            isPinned: false,
            sessionId,
            type: 'web-release-live-tail',
        },
    ];
}

function webImmediateReleaseLiveTailEffects(
    sessionId: string,
): readonly TranscriptViewportLifecycleEffect[] {
    return [
        {
            sessionId,
            type: 'web-immediate-release-live-tail',
        },
    ];
}

function nativeTouchReleaseLiveTailEffects(
    sessionId: string,
    distanceFromLiveTailPx: number,
): readonly TranscriptViewportLifecycleEffect[] {
    return [
        {
            distanceFromLiveTailPx: normalizeDistance(distanceFromLiveTailPx),
            sessionId,
            type: 'native-touch-release-live-tail',
        },
        {
            sessionId,
            type: 'native-bottom-follow-rearm-reset',
        },
    ];
}

function nativeOffsetReleaseLiveTailEffects(
    sessionId: string,
    distanceFromLiveTailPx: number,
): readonly TranscriptViewportLifecycleEffect[] {
    return [
        {
            distanceFromLiveTailPx: normalizeDistance(distanceFromLiveTailPx),
            sessionId,
            type: 'native-offset-release-live-tail',
        },
    ];
}

function nativeScrollReleaseLiveTailEffects(
    sessionId: string,
    distanceFromLiveTailPx: number,
): readonly TranscriptViewportLifecycleEffect[] {
    return [
        {
            distanceFromLiveTailPx: normalizeDistance(distanceFromLiveTailPx),
            isPinned: false,
            sessionId,
            type: 'native-scroll-release-live-tail',
        },
    ];
}

function nativeObservedViewportStateEffects(
    sessionId: string,
    params: Readonly<{
        distanceFromLiveTailPx: number;
        followMode: TranscriptBottomFollowMode;
        pinThresholdPx: number;
    }>,
): readonly TranscriptViewportLifecycleEffect[] {
    const wantsPinned = params.followMode === 'following';
    const pinnedOffsetThresholdPx = wantsPinned ? normalizeDistance(params.pinThresholdPx) : 0;
    const distanceFromLiveTailPx = normalizeDistance(params.distanceFromLiveTailPx);
    return [
        {
            distanceFromLiveTailPx,
            isPinned: wantsPinned && distanceFromLiveTailPx <= pinnedOffsetThresholdPx,
            pinnedOffsetThresholdPx,
            sessionId,
            shouldRestoreViewport: !wantsPinned,
            type: 'native-observed-viewport-state',
            wantsPinned,
        },
    ];
}

function nativeMomentumSettleAwayReleaseLiveTailEffects(
    sessionId: string,
    distanceFromLiveTailPx: number,
): readonly TranscriptViewportLifecycleEffect[] {
    return [
        {
            distanceFromLiveTailPx: normalizeDistance(distanceFromLiveTailPx),
            sessionId,
            type: 'native-momentum-settle-away-release-live-tail',
        },
        {
            sessionId,
            type: 'native-bottom-follow-rearm-reset',
        },
    ];
}

function nativeMomentumActiveMirrorEffects(
    sessionId: string,
    active: boolean,
): readonly TranscriptViewportLifecycleEffect[] {
    return [
        {
            active,
            sessionId,
            type: 'native-momentum-active-mirror',
        },
    ];
}

function nativeDragActiveMirrorEffects(
    sessionId: string,
    active: boolean,
): readonly TranscriptViewportLifecycleEffect[] {
    return [
        {
            active,
            sessionId,
            type: 'native-drag-active-mirror',
        },
    ];
}

function nativeBottomFollowRearmResetEffects(
    sessionId: string,
): readonly TranscriptViewportLifecycleEffect[] {
    return [
        {
            sessionId,
            type: 'native-bottom-follow-rearm-reset',
        },
    ];
}

function nativeBottomFollowRearmEffects(
    sessionId: string,
    distanceFromLiveTailPx: number,
): readonly TranscriptViewportLifecycleEffect[] {
    return [
        {
            distanceFromLiveTailPx: normalizeDistance(distanceFromLiveTailPx),
            sessionId,
            type: 'native-bottom-follow-rearm',
        },
    ];
}

function returnToLiveTailEffects(
    sessionId: string,
    distanceFromLiveTailPx: number,
): readonly TranscriptViewportLifecycleEffect[] {
    const normalizedDistance = normalizeDistance(distanceFromLiveTailPx);
    return [
        {
            distanceFromLiveTailPx: normalizedDistance,
            isPinned: true,
            sessionId,
            source: 'mode-following',
            type: 'viewport-change',
        },
        {
            distanceFromLiveTailPx: normalizedDistance,
            isPinned: true,
            sessionId,
            type: 'drain-deferred-newer',
        },
    ];
}

function explicitReturnToLiveTailEffects(sessionId: string): readonly TranscriptViewportLifecycleEffect[] {
    return [
        {
            sessionId,
            type: 'explicit-return-clear-user-scroll-intent',
        },
        {
            distanceFromLiveTailPx: 0,
            isPinned: true,
            sessionId,
            source: 'explicit-return',
            type: 'viewport-change',
        },
    ];
}

function explicitJumpTakeoverEffects(
    sessionId: string,
    reason: TranscriptViewportExplicitJumpTakeoverReason,
): readonly TranscriptViewportLifecycleEffect[] {
    if (reason === 'jump-to-bottom') {
        return [
            {
                reason,
                sessionId,
                type: 'explicit-jump-preempt-entry-restore',
            },
            {
                reason,
                sessionId,
                type: 'explicit-jump-close-native-prepend-transaction',
            },
        ];
    }

    return [
        {
            reason,
            sessionId,
            type: 'explicit-jump-cancel-native-mount-settle-bottom-pin',
        },
        {
            reason,
            sessionId,
            type: 'explicit-jump-suppress-entry-restore',
        },
        {
            reason,
            sessionId,
            type: 'explicit-jump-preempt-entry-restore',
        },
        {
            reason,
            sessionId,
            type: 'explicit-jump-clear-native-entry-restore-paint-release-timeout',
        },
        {
            reason,
            sessionId,
            type: 'explicit-jump-invalidate-native-prepend-transaction',
        },
        {
            reason,
            sessionId,
            type: 'explicit-jump-clear-native-restore-index-command-cache',
        },
    ];
}

function followBottomIntentTakeoverEffects(sessionId: string): readonly TranscriptViewportLifecycleEffect[] {
    return [
        {
            sessionId,
            type: 'follow-bottom-intent-preempt-entry-restore',
        },
        {
            sessionId,
            type: 'follow-bottom-intent-clear-user-scroll-intent',
        },
        {
            distanceFromLiveTailPx: 0,
            sessionId,
            type: 'follow-bottom-intent-record-live-tail-pin-offset',
        },
    ];
}

function nativeUserScrollTakeoverEffects(
    sessionId: string,
    timestampMs: number,
): readonly TranscriptViewportLifecycleEffect[] {
    return [
        {
            sessionId,
            type: 'native-user-scroll-preempt-entry-restore',
        },
        {
            sessionId,
            type: 'native-user-scroll-cancel-native-mount-settle-bottom-pin',
        },
        {
            sessionId,
            type: 'native-user-scroll-suppress-native-mount-settle-auto-pin',
        },
        {
            sessionId,
            type: 'native-user-scroll-clear-native-initial-viewport-pending-observation',
        },
        {
            sessionId,
            timestampMs,
            type: 'native-user-scroll-record-intent-timestamp',
        },
    ];
}

function nativeTouchIntentEffects(
    sessionId: string,
    timestampMs: number,
    hasActiveNativeViewportRestore: boolean,
): readonly TranscriptViewportLifecycleEffect[] {
    const effects: TranscriptViewportLifecycleEffect[] = [];
    if (!hasActiveNativeViewportRestore) {
        effects.push({
            sessionId,
            timestampMs,
            type: 'native-touch-record-intent-timestamp',
        });
    }
    effects.push(
        {
            sessionId,
            type: 'native-touch-suppress-native-mount-settle-auto-pin',
        },
        {
            sessionId,
            type: 'native-touch-cancel-native-mount-settle-bottom-pin',
        },
        {
            sessionId,
            type: 'native-touch-cancel-scheduled-pin',
        },
    );
    return effects;
}

function localTranscriptInteractionAutoPinDeferralEffects(
    sessionId: string,
    timestampMs: number,
): readonly TranscriptViewportLifecycleEffect[] {
    return [
        {
            sessionId,
            timestampMs,
            type: 'local-interaction-record-intent-timestamp',
        },
        {
            sessionId,
            type: 'local-interaction-suppress-native-mount-settle-auto-pin',
        },
        {
            sessionId,
            type: 'local-interaction-cancel-scheduled-pin',
        },
    ];
}

function webUserScrollTakeoverEffects(sessionId: string): readonly TranscriptViewportLifecycleEffect[] {
    return [
        {
            sessionId,
            type: 'web-user-scroll-preempt-entry-restore',
        },
        {
            sessionId,
            type: 'web-user-scroll-preempt-explicit-jump',
        },
    ];
}

function webUserScrollIntentTimestampEffects(
    sessionId: string,
    timestampMs: number,
): readonly TranscriptViewportLifecycleEffect[] {
    return [
        {
            sessionId,
            timestampMs,
            type: 'web-user-scroll-record-intent-timestamp',
        },
    ];
}

function sessionEntryViewportEffects(
    event: Extract<TranscriptViewportLifecycleEvent, { type: 'session-entry' }>,
): readonly TranscriptViewportLifecycleEffect[] {
    const shouldFollowLiveTail = event.shouldFollowLiveTail;
    const effects: TranscriptViewportLifecycleEffect[] = [
        {
            distanceFromLiveTailPx: shouldFollowLiveTail
                ? 0
                : normalizeNullableDistance(event.entryDistanceFromLiveTailPx ?? null),
            isPinned: shouldFollowLiveTail,
            sessionId: event.sessionId,
            shouldRestoreViewport: !shouldFollowLiveTail,
            type: 'session-entry-viewport',
        },
    ];
    if (event.platform) {
        effects.push({
            sessionId: event.sessionId,
            type: 'session-entry-web-dom-observation-reset',
        });
        effects.push({
            sessionId: event.sessionId,
            type: 'session-entry-native-bottom-pin-command-cache-reset',
        });
        effects.push({
            sessionId: event.sessionId,
            type: 'session-entry-native-gesture-momentum-mirror-reset',
        });
        effects.push({
            sessionId: event.sessionId,
            type: 'session-entry-native-stream-append-content-version-record-reset',
        });
        effects.push({
            sessionId: event.sessionId,
            type: 'session-entry-activity-key-baseline-reset',
        });
        effects.push({
            sessionId: event.sessionId,
            type: 'session-entry-older-pagination-reset',
        });
    }
    if (event.platform === 'native') {
        effects.push({
            sessionId: event.sessionId,
            type: 'session-entry-native-session-viewport-reset',
        });
    }
    if (event.platform) {
        effects.push({
            sessionId: event.sessionId,
            type: 'session-entry-entry-restore-active-refs-reset',
        });
        effects.push({
            sessionId: event.sessionId,
            type: 'session-entry-entry-restore-local-state-reset',
        });
        effects.push({
            sessionId: event.sessionId,
            type: 'session-entry-entry-restore-timeout-cleanup',
        });
        effects.push({
            sessionId: event.sessionId,
            type: 'session-entry-native-prepend-transaction-invalidation',
        });
        effects.push({
            sessionId: event.sessionId,
            type: 'session-entry-native-explicit-jump-confirmation-reset',
        });
        effects.push({
            sessionId: event.sessionId,
            shouldArmConfirmation:
                event.platform === 'native' &&
                shouldFollowLiveTail,
            type: 'session-entry-native-entry-settle-confirmation-reset',
        });
        effects.push({
            sessionId: event.sessionId,
            type: 'session-entry-native-index-scroll-command-cache-reset',
        });
        effects.push({
            sessionId: event.sessionId,
            type: 'session-entry-entry-restore-anchor-lookup-reset',
        });
        effects.push({
            ...resolveSessionEntryCommandControllerReset({
                platform: event.platform,
                shouldFollowLiveTail,
            }),
            sessionId: event.sessionId,
            type: 'session-entry-command-controller-reset',
        });
    }
    effects.push({
        sessionId: event.sessionId,
        type: 'session-entry-measurement-reset',
    });
    return effects;
}

function snapshot(state: MutableLifecycleState): TranscriptViewportLifecycleState {
    return {
        automaticPinAuthority: automaticPinAuthority(state),
        bottomFollowState: state.bottomFollow,
        fingerDown: state.gesturePhase === 'dragging',
        followMode: state.bottomFollow.mode,
        gesturePhase: state.gesturePhase,
        sessionId: state.sessionId,
    };
}

function automaticPinAuthority(state: MutableLifecycleState): boolean {
    return state.gesturePhase === 'settled';
}

function automaticLiveTailPinAuthority(state: MutableLifecycleState): boolean {
    return automaticPinAuthority(state) ||
        (
            state.gesturePhase === 'momentum' &&
            state.bottomFollow.mode === 'following' &&
            state.bottomFollow.dragSession?.returnedToBottom === true
        );
}

function normalizeDistance(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.trunc(value));
}

function normalizeNullableDistance(value: number | null): number | null {
    if (value === null || !Number.isFinite(value)) return null;
    return Math.max(0, Math.trunc(value));
}
