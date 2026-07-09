export type NativeExplicitJumpConfirmationState = Readonly<{
    issuedContentHeight: number;
    reconfirmSpent: boolean;
    sessionId: string;
}>;

export type NativeExplicitJumpConfirmationObservation = Readonly<{
    contentHeight: number;
    distanceFromBottom: number;
    isTrusted: boolean;
    pinThresholdPx: number;
    sessionId: string;
}>;

export type NativeExplicitJumpConfirmationEffect =
    | Readonly<{
        distanceFromBottom: number;
        sessionId: string;
        type: 'adopt-live-tail-arrival';
    }>
    | Readonly<{
        sessionId: string;
        type: 'issue-reconfirm-jump-to-bottom';
    }>;

export type NativeExplicitJumpConfirmationResult = Readonly<{
    consumed: boolean;
    effects: readonly NativeExplicitJumpConfirmationEffect[];
    pending: NativeExplicitJumpConfirmationState | null;
}>;

export function resolveNativeExplicitJumpConfirmationEffects(params: Readonly<{
    observation: NativeExplicitJumpConfirmationObservation;
    pending: NativeExplicitJumpConfirmationState | null;
}>): NativeExplicitJumpConfirmationResult {
    const { observation, pending } = params;
    if (pending === null) {
        return { consumed: false, effects: [], pending: null };
    }
    if (pending.sessionId !== observation.sessionId || observation.isTrusted) {
        return { consumed: false, effects: [], pending: null };
    }

    if (observation.distanceFromBottom <= observation.pinThresholdPx) {
        return {
            consumed: true,
            effects: [{
                distanceFromBottom: observation.distanceFromBottom,
                sessionId: observation.sessionId,
                type: 'adopt-live-tail-arrival',
            }],
            pending: null,
        };
    }

    if (observation.contentHeight !== pending.issuedContentHeight) {
        if (pending.reconfirmSpent) {
            return { consumed: true, effects: [], pending };
        }
        return {
            consumed: true,
            effects: [{
                sessionId: observation.sessionId,
                type: 'issue-reconfirm-jump-to-bottom',
            }],
            pending: {
                ...pending,
                issuedContentHeight: observation.contentHeight,
                reconfirmSpent: true,
            },
        };
    }

    return { consumed: false, effects: [], pending };
}

export function createNativeExplicitJumpConfirmationState(params: Readonly<{
    issuedContentHeight: number;
    sessionId: string;
}>): NativeExplicitJumpConfirmationState {
    return {
        issuedContentHeight: params.issuedContentHeight,
        reconfirmSpent: false,
        sessionId: params.sessionId,
    };
}
