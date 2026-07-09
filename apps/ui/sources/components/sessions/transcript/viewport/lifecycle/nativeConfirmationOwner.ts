import {
    createNativeExplicitJumpConfirmationState,
    resolveNativeExplicitJumpConfirmationEffects,
    type NativeExplicitJumpConfirmationEffect,
    type NativeExplicitJumpConfirmationObservation,
    type NativeExplicitJumpConfirmationState,
} from './nativeExplicitJumpConfirmation';
import {
    createNativeEntrySettleConfirmationState,
    resolveNativeEntrySettleConfirmationEffects,
    type NativeEntrySettleConfirmationEffect,
    type NativeEntrySettleConfirmationObservation,
    type NativeEntrySettleConfirmationState,
} from './nativeEntrySettleConfirmation';

export type { NativeEntrySettleConfirmationEffect, NativeExplicitJumpConfirmationEffect };

export type NativeConfirmationOwnerExplicitJumpArmInput = Readonly<{
    issuedContentHeight: number;
    sessionId: string;
}>;

export type NativeConfirmationOwnerExplicitJumpClearInput = Readonly<{
    sessionId: string;
}>;

export type NativeConfirmationOwnerEntrySettleArmInput = Readonly<{
    baselineContentHeight?: number;
    sessionId: string;
}>;

export type NativeConfirmationOwnerEntrySettleResetInput = Readonly<{
    sessionId: string;
    shouldArmConfirmation: boolean;
}>;

export type NativeConfirmationOwnerScrollInput =
    NativeExplicitJumpConfirmationObservation &
    NativeEntrySettleConfirmationObservation;

export type NativeConfirmationOwnerScrollPlan = Readonly<{
    consumed: boolean;
    entrySettleEffects: readonly NativeEntrySettleConfirmationEffect[];
    explicitJumpEffects: readonly NativeExplicitJumpConfirmationEffect[];
}>;

export type NativeConfirmationOwner = Readonly<{
    armEntrySettle(input: NativeConfirmationOwnerEntrySettleArmInput): void;
    armExplicitJump(input: NativeConfirmationOwnerExplicitJumpArmInput): void;
    clearExplicitJump(input: NativeConfirmationOwnerExplicitJumpClearInput): void;
    observeScroll(input: NativeConfirmationOwnerScrollInput): NativeConfirmationOwnerScrollPlan;
    resetEntrySettle(input: NativeConfirmationOwnerEntrySettleResetInput): void;
}>;

export function createNativeConfirmationOwner(): NativeConfirmationOwner {
    let pendingExplicitJump: NativeExplicitJumpConfirmationState | null = null;
    let pendingEntrySettle: NativeEntrySettleConfirmationState | null = null;

    return {
        armEntrySettle(input) {
            pendingEntrySettle = createNativeEntrySettleConfirmationState({
                baselineContentHeight: input.baselineContentHeight,
                sessionId: input.sessionId,
            });
        },
        armExplicitJump(input) {
            pendingExplicitJump = createNativeExplicitJumpConfirmationState(input);
        },
        clearExplicitJump(_input) {
            pendingExplicitJump = null;
        },
        observeScroll(input) {
            const explicitResult = resolveNativeExplicitJumpConfirmationEffects({
                observation: {
                    contentHeight: input.contentHeight,
                    distanceFromBottom: input.distanceFromBottom,
                    isTrusted: input.isTrusted,
                    pinThresholdPx: input.pinThresholdPx,
                    sessionId: input.sessionId,
                },
                pending: pendingExplicitJump,
            });
            pendingExplicitJump = explicitResult.pending;
            if (explicitResult.consumed) {
                return {
                    consumed: true,
                    entrySettleEffects: [],
                    explicitJumpEffects: explicitResult.effects,
                };
            }

            const entrySettleResult = resolveNativeEntrySettleConfirmationEffects({
                observation: {
                    bottomFollowMode: input.bottomFollowMode,
                    contentHeight: input.contentHeight,
                    distanceFromBottom: input.distanceFromBottom,
                    isTrusted: input.isTrusted,
                    mountSettleDeadlineReached: input.mountSettleDeadlineReached,
                    mountSettleStable: input.mountSettleStable,
                    pinThresholdPx: input.pinThresholdPx,
                    sessionId: input.sessionId,
                    wantsPinned: input.wantsPinned,
                },
                pending: pendingEntrySettle,
            });
            pendingEntrySettle = entrySettleResult.pending;
            return {
                consumed: false,
                entrySettleEffects: entrySettleResult.effects,
                explicitJumpEffects: explicitResult.effects,
            };
        },
        resetEntrySettle(input) {
            pendingEntrySettle = input.shouldArmConfirmation
                ? createNativeEntrySettleConfirmationState({ sessionId: input.sessionId })
                : null;
        },
    };
}
