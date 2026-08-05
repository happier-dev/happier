export type JumpToBottomAffordancePresentation = 'standard' | 'activity';

export type JumpToBottomAffordanceState = Readonly<{
    count: number;
    isVisible: boolean;
    presentation: JumpToBottomAffordancePresentation;
}>;

const HIDDEN_JUMP_TO_BOTTOM_AFFORDANCE: JumpToBottomAffordanceState = {
    count: 0,
    isVisible: false,
    presentation: 'standard',
};

function normalizeNonNegativeInteger(value: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : 0;
}

export function resolveJumpToBottomAffordanceState(params: Readonly<{
    distanceFromBottom: number;
    enabled: boolean;
    /**
     * Target-window mode with unloaded newer content: the session's live tail is below the
     * rendered window, so local pin/distance facts cannot justify hiding the affordance.
     */
    hasMoreNewerBeyondRenderedWindow?: boolean;
    isPinned: boolean;
    minNewActivityCount: number;
    newActivityCount: number;
    revealThresholdPx: number;
    /**
     * Viewport height, used only to falsify a stale pin claim. `isPinned` is DERIVED state: an
     * explicit jump or a landing at the end of a rendered window can leave it `true` while the
     * reader sits tens of thousands of pixels from the live tail, and hiding the affordance there
     * deletes their only way back (E-7). More than one full viewport of distance is not "at the
     * tail" whatever the pin bit says. 0/absent keeps the pin bit authoritative.
     */
    viewportHeightPx?: number;
}>): JumpToBottomAffordanceState {
    if (!params.enabled) return HIDDEN_JUMP_TO_BOTTOM_AFFORDANCE;
    if (params.hasMoreNewerBeyondRenderedWindow === true) {
        const windowNewActivityCount = normalizeNonNegativeInteger(params.newActivityCount);
        const windowMinNewActivityCount = Math.max(1, normalizeNonNegativeInteger(params.minNewActivityCount));
        const hasWindowActivityBadge = windowNewActivityCount >= windowMinNewActivityCount;
        return {
            count: hasWindowActivityBadge ? windowNewActivityCount : 0,
            isVisible: true,
            presentation: 'standard',
        };
    }
    const distanceFromBottom = normalizeNonNegativeInteger(params.distanceFromBottom);
    const viewportHeightPx = normalizeNonNegativeInteger(params.viewportHeightPx ?? 0);
    // "Am I at the live tail" has ONE answer, and past a full viewport it is physical distance,
    // not the derived pin bit. Inside a viewport the pin bit still owns it: renderer
    // maintain-at-end and the near-tail dead zone are exactly the band where a pinned reader
    // must see no pill.
    const pinClaimContradictedByDistance = viewportHeightPx > 0 && distanceFromBottom > viewportHeightPx;
    if (params.isPinned && !pinClaimContradictedByDistance) return HIDDEN_JUMP_TO_BOTTOM_AFFORDANCE;

    const revealThresholdPx = normalizeNonNegativeInteger(params.revealThresholdPx);
    const minNewActivityCount = Math.max(1, normalizeNonNegativeInteger(params.minNewActivityCount));
    const newActivityCount = normalizeNonNegativeInteger(params.newActivityCount);
    const hasNewActivityBadge = newActivityCount >= minNewActivityCount;
    const hasStandardReveal = distanceFromBottom >= revealThresholdPx;

    if (!hasStandardReveal && !hasNewActivityBadge) {
        return HIDDEN_JUMP_TO_BOTTOM_AFFORDANCE;
    }

    return {
        count: hasNewActivityBadge ? newActivityCount : 0,
        isVisible: true,
        presentation: hasStandardReveal ? 'standard' : 'activity',
    };
}
