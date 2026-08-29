import type { SessionDraftTextSnapshot } from './useDraft';

export type ComposerTransientInputStateHandlers<TState> = Readonly<{
    captureTransientInputState: () => TState | null;
    clearTransientInputState: () => void;
    restoreTransientInputState: (state: TState | null) => void;
}>;

export type CapturedComposerTransientInputState<TState> = Readonly<{
    transientInputStateSnapshot: TState | null;
    clearTransientInputState: () => void;
    restoreTransientInputState: () => void;
}>;

export function captureComposerTransientInputStateForOutboundHandoff<TState>({
    captureTransientInputState,
    clearTransientInputState,
    restoreTransientInputState,
}: ComposerTransientInputStateHandlers<TState>): CapturedComposerTransientInputState<TState> {
    const transientInputStateSnapshot = captureTransientInputState();

    return {
        transientInputStateSnapshot,
        clearTransientInputState,
        restoreTransientInputState: () => {
            restoreTransientInputState(transientInputStateSnapshot);
        },
    };
}

export type OutboundHandoffComposerClearParams = Readonly<{
    snapshot: SessionDraftTextSnapshot;
    clearDraftForSessionIfCurrentValueMatches: (snapshot: SessionDraftTextSnapshot) => boolean;
    clearTransientInputState: () => void;
    /** The semantic-draft owner clears only fields still matching its capture. */
    clearSemanticDraftValuesMatchingSnapshot?: () => boolean;
}>;

export type FailedOutboundHandoffRestoreParams = Readonly<{
    snapshot: SessionDraftTextSnapshot;
    wasClearedAtHandoff: boolean;
    isCanonicalOutboundHandoffPresent: () => boolean;
    restoreDraftForSessionIfCurrentValueMatches: (
        snapshot: SessionDraftTextSnapshot,
        expectedCurrentValue: string,
    ) => boolean;
    /** Whether the canonical Composer owner actually cleared the text field. */
    restoreDraftText?: boolean;
    restoreTransientInputState?: () => void;
    /** The semantic-draft owner restores only fields unchanged since its clear. */
    restoreSemanticDraftValuesMatchingClearedSnapshot?: () => boolean;
}>;

export function clearComposerAfterOutboundHandoff({
    snapshot,
    clearDraftForSessionIfCurrentValueMatches,
    clearTransientInputState,
    clearSemanticDraftValuesMatchingSnapshot,
}: OutboundHandoffComposerClearParams): boolean {
    const didClearDraft = clearDraftForSessionIfCurrentValueMatches(snapshot);
    const didClearSemanticDraftValues = clearSemanticDraftValuesMatchingSnapshot?.() ?? false;

    if (didClearDraft) {
        clearTransientInputState();
    }
    return didClearDraft || didClearSemanticDraftValues;
}

export function restoreComposerAfterFailedOutboundHandoff({
    snapshot,
    wasClearedAtHandoff,
    isCanonicalOutboundHandoffPresent,
    restoreDraftForSessionIfCurrentValueMatches,
    restoreDraftText = true,
    restoreTransientInputState,
    restoreSemanticDraftValuesMatchingClearedSnapshot,
}: FailedOutboundHandoffRestoreParams): boolean {
    if (!wasClearedAtHandoff) return false;
    if (isCanonicalOutboundHandoffPresent()) return false;

    const didRestoreDraft = restoreDraftText
        ? restoreDraftForSessionIfCurrentValueMatches(snapshot, '')
        : false;
    const didRestoreSemanticDraftValues = restoreSemanticDraftValuesMatchingClearedSnapshot?.() ?? false;

    if (didRestoreDraft) {
        restoreTransientInputState?.();
    }
    return didRestoreDraft || didRestoreSemanticDraftValues;
}
