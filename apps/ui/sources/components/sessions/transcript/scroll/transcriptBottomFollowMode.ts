export type TranscriptBottomFollowMode = 'following' | 'escaping' | 'released';

export type TranscriptBottomFollowDragSession = Readonly<{
    latestDistanceFromBottom: number | null;
    returnedToBottom?: boolean;
    sawAwayMovement: boolean;
    trusted: boolean;
}>;

export type TranscriptBottomFollowModeState = Readonly<{
    dragSession: TranscriptBottomFollowDragSession | null;
    mode: TranscriptBottomFollowMode;
}>;

export type TranscriptScrollPinState = {
    isPinned: boolean;
    newActivityCount: number;
    lastActivityKey: string | null;
};

export type TranscriptScrollPinEvent =
    | {
        type: 'scroll';
        enabled: boolean;
        offsetY: number;
        pinnedOffsetThresholdPx: number;
    }
    | {
        type: 'newActivity';
        enabled: boolean;
        activityKey: string | null;
    }
    | {
        type: 'resetNewActivity';
    };

export type TranscriptBottomFollowModeEvent =
    | { type: 'session-entry'; shouldFollowBottom: boolean }
    | { type: 'list-drag-start' }
    | { type: 'trusted-away-observation'; distanceFromBottom: number; pinThresholdPx: number; movedAwayFromBottom: boolean }
    | { type: 'trusted-bottom-observation'; distanceFromBottom: number; pinThresholdPx: number; movedTowardBottom: boolean }
    | { type: 'passive-bottom-observation'; distanceFromBottom: number; pinThresholdPx: number }
    | { type: 'drag-end'; distanceFromBottom: number | null; pinThresholdPx: number; sawAwayMovement: boolean }
    | { type: 'momentum-settle'; distanceFromBottom: number | null; pinThresholdPx: number }
    | { type: 'release-live-tail-intent' }
    | { type: 'jump-to-bottom' }
    | { type: 'follow-bottom-intent' }
    | { type: 'content-growth' };

export function resolveTranscriptBottomFollowMode(
    state: TranscriptBottomFollowModeState,
    event: TranscriptBottomFollowModeEvent,
): TranscriptBottomFollowModeState {
    switch (event.type) {
        case 'session-entry':
            return {
                dragSession: null,
                mode: event.shouldFollowBottom ? 'following' : 'released',
            };
        case 'list-drag-start':
            return {
                dragSession: {
                    latestDistanceFromBottom: null,
                    returnedToBottom: false,
                    sawAwayMovement: false,
                    trusted: true,
                },
                mode: 'escaping',
            };
        case 'trusted-away-observation': {
            const distanceFromBottom = normalizeDistance(event.distanceFromBottom);
            const sawAwayMovement =
                event.movedAwayFromBottom &&
                distanceFromBottom > normalizeDistance(event.pinThresholdPx);
            const dragSession = {
                latestDistanceFromBottom: distanceFromBottom,
                returnedToBottom: state.dragSession?.returnedToBottom === true,
                sawAwayMovement: (state.dragSession?.sawAwayMovement ?? false) || sawAwayMovement,
                trusted: true,
            };
            if (state.mode === 'escaping' && sawAwayMovement) {
                return {
                    dragSession,
                    mode: 'released',
                };
            }
            return {
                dragSession: state.mode === 'escaping' ? dragSession : state.dragSession,
                mode: state.mode,
            };
        }
        case 'trusted-bottom-observation': {
            const distanceFromBottom = normalizeDistance(event.distanceFromBottom);
            const nearBottom = distanceFromBottom <= normalizeDistance(event.pinThresholdPx);
            if (
                state.mode === 'released' &&
                state.dragSession == null &&
                event.movedTowardBottom &&
                nearBottom
            ) {
                return {
                    dragSession: null,
                    mode: 'following',
                };
            }
            if (state.mode === 'released' && state.dragSession != null) {
                return {
                    dragSession: {
                        latestDistanceFromBottom: distanceFromBottom,
                        returnedToBottom: nearBottom || state.dragSession.returnedToBottom === true,
                        sawAwayMovement: state.dragSession.sawAwayMovement,
                        trusted: true,
                    },
                    mode: state.mode,
                };
            }
            if (state.mode === 'escaping') {
                return {
                    dragSession: {
                        latestDistanceFromBottom: distanceFromBottom,
                        returnedToBottom: nearBottom || state.dragSession?.returnedToBottom === true,
                        sawAwayMovement: state.dragSession?.sawAwayMovement ?? false,
                        trusted: true,
                    },
                    mode: state.mode,
                };
            }
            return state;
        }
        case 'passive-bottom-observation':
            if (state.mode !== 'escaping' && !(state.mode === 'released' && state.dragSession != null)) return state;
            return {
                dragSession: {
                    latestDistanceFromBottom: normalizeDistance(event.distanceFromBottom),
                    returnedToBottom:
                        normalizeDistance(event.distanceFromBottom) <= normalizeDistance(event.pinThresholdPx) ||
                        state.dragSession?.returnedToBottom === true,
                    sawAwayMovement: state.dragSession?.sawAwayMovement ?? false,
                    trusted: state.dragSession?.trusted ?? false,
                },
                mode: state.mode,
            };
        case 'drag-end': {
            const distanceFromBottom =
                event.distanceFromBottom == null
                    ? state.dragSession?.latestDistanceFromBottom
                    : event.distanceFromBottom;
            const nearBottom =
                typeof distanceFromBottom === 'number' &&
                normalizeDistance(distanceFromBottom) <= normalizeDistance(event.pinThresholdPx);
            const sawAwayMovement = event.sawAwayMovement || (state.dragSession?.sawAwayMovement ?? false);
            const nextTrustedDragSession = {
                latestDistanceFromBottom:
                    typeof distanceFromBottom === 'number' ? normalizeDistance(distanceFromBottom) : null,
                returnedToBottom: state.dragSession?.returnedToBottom === true,
                sawAwayMovement,
                trusted: state.dragSession?.trusted ?? true,
            };
            const confirmedReturnToBottom =
                nearBottom &&
                (!sawAwayMovement || state.dragSession?.returnedToBottom === true);
            if ((state.mode === 'escaping' || state.mode === 'released') && confirmedReturnToBottom) {
                // The fling's momentum may still be pending at finger-up (hard flicks have
                // short finger travel): keep the trusted session open as the release
                // attribution window until momentum-settle closes it (plan B9).
                return {
                    dragSession: {
                        ...nextTrustedDragSession,
                        returnedToBottom: true,
                    },
                    mode: 'following',
                };
            }
            if (state.mode === 'escaping' || (state.mode === 'released' && sawAwayMovement)) {
                return {
                    dragSession: nextTrustedDragSession,
                    mode: 'released',
                };
            }
            return state;
        }
        case 'momentum-settle': {
            // Post-drag momentum settle (plan B8): the retained trusted drag session is the
            // user-attribution for the fling. Landing near the bottom re-arms follow; either
            // way the attribution window closes so later passive churn can never claim it.
            // Plan B9: 'following' with a retained trusted session (drag ended near the
            // bottom while momentum was pending) settles through the same window — far from
            // the bottom the fling releases, near it follow stays armed.
            if (
                (state.mode !== 'released' && state.mode !== 'following') ||
                state.dragSession?.trusted !== true
            ) return state;
            const distanceFromBottom =
                event.distanceFromBottom == null
                    ? state.dragSession.latestDistanceFromBottom
                    : event.distanceFromBottom;
            const nearBottom =
                typeof distanceFromBottom === 'number' &&
                normalizeDistance(distanceFromBottom) <= normalizeDistance(event.pinThresholdPx);
            return {
                dragSession: null,
                mode: nearBottom ? 'following' : 'released',
            };
        }
        case 'release-live-tail-intent':
            return {
                dragSession: null,
                mode: 'released',
            };
        case 'jump-to-bottom':
        case 'follow-bottom-intent':
            return {
                dragSession: null,
                mode: 'following',
            };
        case 'content-growth':
            return state;
    }
}

export function resolveTranscriptScrollPinStateUpdate(
    state: TranscriptScrollPinState,
    event: TranscriptScrollPinEvent,
): TranscriptScrollPinState | null {
    const next = reduceTranscriptScrollPinState(state, event);
    return next === state ? null : next;
}

export function reduceTranscriptScrollPinState(
    state: TranscriptScrollPinState,
    event: TranscriptScrollPinEvent,
): TranscriptScrollPinState {
    if (event.type === 'resetNewActivity') {
        if (state.newActivityCount === 0) return state;
        return { ...state, newActivityCount: 0 };
    }

    if (event.type === 'scroll') {
        if (!event.enabled) {
            if (state.isPinned && state.newActivityCount === 0) return state;
            return { ...state, isPinned: true, newActivityCount: 0 };
        }

        const threshold = normalizeDistance(event.pinnedOffsetThresholdPx);
        const offsetY = Number.isFinite(event.offsetY) ? event.offsetY : 0;
        const nextPinned = offsetY <= threshold;

        if (nextPinned) {
            if (state.isPinned && state.newActivityCount === 0) return state;
            return { ...state, isPinned: true, newActivityCount: 0 };
        }

        if (!state.isPinned) return state;
        return { ...state, isPinned: false };
    }

    if (!event.enabled) return state;

    const key = typeof event.activityKey === 'string' && event.activityKey.length > 0 ? event.activityKey : null;
    if (!key) return state;
    if (state.lastActivityKey === key) return state;

    if (state.isPinned) {
        return { ...state, lastActivityKey: key };
    }

    return {
        ...state,
        lastActivityKey: key,
        newActivityCount: state.newActivityCount + 1,
    };
}

function normalizeDistance(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.trunc(value));
}
