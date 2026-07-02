import type { SessionDraftTextSnapshot } from './useDraft';

export type OutboundHandoffComposerClearParams = Readonly<{
    snapshot: SessionDraftTextSnapshot;
    clearDraftForSessionIfCurrentValueMatches: (snapshot: SessionDraftTextSnapshot) => boolean;
    clearTransientInputState: () => void;
    isSemanticSnapshotCurrent?: () => boolean;
    clearSemanticDraftValues?: () => void;
}>;

export type FailedOutboundHandoffRestoreParams = Readonly<{
    snapshot: SessionDraftTextSnapshot;
    wasClearedAtHandoff: boolean;
    isSemanticRestoreSafe?: () => boolean;
    restoreDraftForSessionIfCurrentValueMatches: (
        snapshot: SessionDraftTextSnapshot,
        expectedCurrentValue: string,
    ) => boolean;
    restoreTransientInputState?: () => void;
    restoreSemanticDraftValues?: () => void;
}>;

export function clearComposerAfterOutboundHandoff({
    snapshot,
    clearDraftForSessionIfCurrentValueMatches,
    clearTransientInputState,
    isSemanticSnapshotCurrent,
    clearSemanticDraftValues,
}: OutboundHandoffComposerClearParams): boolean {
    if (isSemanticSnapshotCurrent && !isSemanticSnapshotCurrent()) {
        return false;
    }

    const didClearDraft = clearDraftForSessionIfCurrentValueMatches(snapshot);
    if (!didClearDraft) return false;

    clearSemanticDraftValues?.();
    clearTransientInputState();
    return true;
}

export function restoreComposerAfterFailedOutboundHandoff({
    snapshot,
    wasClearedAtHandoff,
    isSemanticRestoreSafe,
    restoreDraftForSessionIfCurrentValueMatches,
    restoreTransientInputState,
    restoreSemanticDraftValues,
}: FailedOutboundHandoffRestoreParams): boolean {
    if (!wasClearedAtHandoff) return false;
    if (isSemanticRestoreSafe && !isSemanticRestoreSafe()) {
        return false;
    }

    const didRestoreDraft = restoreDraftForSessionIfCurrentValueMatches(snapshot, '');
    if (!didRestoreDraft) return false;

    restoreSemanticDraftValues?.();
    restoreTransientInputState?.();
    return true;
}
