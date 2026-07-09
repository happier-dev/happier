import type { TranscriptBottomFollowMode } from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';

export type NativeEntrySettleConfirmationState = Readonly<{
    issuedContentHeight: number | null;
    sessionId: string;
}>;

export type NativeEntrySettleConfirmationObservation = Readonly<{
    bottomFollowMode: TranscriptBottomFollowMode;
    contentHeight: number;
    distanceFromBottom: number;
    isTrusted: boolean;
    mountSettleDeadlineReached: boolean;
    mountSettleStable: boolean;
    pinThresholdPx: number;
    sessionId: string;
    wantsPinned: boolean;
}>;

export type NativeEntrySettleConfirmationEffect = Readonly<{
    type: 'issue-entry-settle-reconfirm-pin';
    sessionId: string;
}>;

export type NativeEntrySettleConfirmationResult = Readonly<{
    effects: readonly NativeEntrySettleConfirmationEffect[];
    pending: NativeEntrySettleConfirmationState | null;
}>;

export function createNativeEntrySettleConfirmationState(params: Readonly<{
    baselineContentHeight?: number;
    sessionId: string;
}>): NativeEntrySettleConfirmationState {
    return {
        issuedContentHeight: typeof params.baselineContentHeight === 'number' && Number.isFinite(params.baselineContentHeight)
            ? params.baselineContentHeight
            : null,
        sessionId: params.sessionId,
    };
}

export function resolveNativeEntrySettleConfirmationEffects(params: Readonly<{
    observation: NativeEntrySettleConfirmationObservation;
    pending: NativeEntrySettleConfirmationState | null;
}>): NativeEntrySettleConfirmationResult {
    const { observation, pending } = params;
    if (pending === null) {
        return { effects: [], pending: null };
    }
    if (
        pending.sessionId !== observation.sessionId ||
        observation.isTrusted ||
        !observation.wantsPinned ||
        observation.bottomFollowMode !== 'following'
    ) {
        return { effects: [], pending: null };
    }
    if (observation.distanceFromBottom <= observation.pinThresholdPx) {
        return {
            effects: [],
            pending: {
                ...pending,
                issuedContentHeight: observation.contentHeight,
            },
        };
    }
    if (pending.issuedContentHeight == null) {
        return {
            effects: [],
            pending: {
                ...pending,
                issuedContentHeight: observation.contentHeight,
            },
        };
    }
    if (
        observation.contentHeight > pending.issuedContentHeight &&
        (observation.mountSettleStable || observation.mountSettleDeadlineReached)
    ) {
        return {
            effects: [{
                type: 'issue-entry-settle-reconfirm-pin',
                sessionId: observation.sessionId,
            }],
            pending: null,
        };
    }
    return { effects: [], pending };
}
