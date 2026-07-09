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
    hasMoreNewerBeyondRenderedWindow?: boolean;
    isPinned: boolean;
    minNewActivityCount: number;
    newActivityCount: number;
    revealThresholdPx: number;
}>): JumpToBottomAffordanceState {
    if (!params.enabled || params.isPinned) return HIDDEN_JUMP_TO_BOTTOM_AFFORDANCE;

    const distanceFromBottom = normalizeNonNegativeInteger(params.distanceFromBottom);
    const revealThresholdPx = normalizeNonNegativeInteger(params.revealThresholdPx);
    const minNewActivityCount = Math.max(1, normalizeNonNegativeInteger(params.minNewActivityCount));
    const newActivityCount = normalizeNonNegativeInteger(params.newActivityCount);
    const hasNewActivityBadge = newActivityCount >= minNewActivityCount;
    const hasStandardReveal = params.hasMoreNewerBeyondRenderedWindow === true || distanceFromBottom >= revealThresholdPx;

    if (!hasStandardReveal && !hasNewActivityBadge) {
        return HIDDEN_JUMP_TO_BOTTOM_AFFORDANCE;
    }

    return {
        count: hasNewActivityBadge ? newActivityCount : 0,
        isVisible: true,
        presentation: hasStandardReveal ? 'standard' : 'activity',
    };
}
