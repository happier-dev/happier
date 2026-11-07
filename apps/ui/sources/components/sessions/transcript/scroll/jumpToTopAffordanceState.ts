export type JumpToTopAffordanceState = Readonly<{
    isVisible: boolean;
}>;

/**
 * Mirror of `resolveJumpToBottomAffordanceState` for the other end of the transcript. Older
 * history is paged in lazily, so "at the top" is only true when the reader is at the top of the
 * loaded rows AND nothing older remains to load; unloaded history keeps the pill visible.
 */
export function resolveJumpToTopAffordanceState(params: Readonly<{
    distanceFromTop: number;
    enabled: boolean;
    hasMoreOlder: boolean;
    revealThresholdPx: number;
}>): JumpToTopAffordanceState {
    if (!params.enabled) return { isVisible: false };
    if (params.hasMoreOlder) return { isVisible: true };
    return { isVisible: params.distanceFromTop >= Math.max(0, params.revealThresholdPx) };
}
