const INPUT_EXPANSION_TOGGLE_SHOW_OFFSET_PX = 1;
const INPUT_EXPANSION_TOGGLE_HIDE_OFFSET_PX = 12;
export const INPUT_EXPANSION_TOGGLE_INPUT_PADDING_RIGHT = 32;

export function normalizeAgentInputExpansionCollapsedMaxHeight(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : null;
}

export function shouldReserveAgentInputExpansionToggleSpace(params: Readonly<{
    hasInputExpansion: boolean;
    collapsedMaxHeight: number | null;
}>): boolean {
    return params.hasInputExpansion && params.collapsedMaxHeight != null;
}

export function resolveAgentInputExpansionToggleVisible(params: Readonly<{
    currentVisible: boolean;
    hasInputExpansion: boolean;
    inputContentHeightPx: number | null;
    collapsedMaxHeight: number | null;
}>): boolean {
    const { currentVisible, hasInputExpansion, inputContentHeightPx, collapsedMaxHeight } = params;
    if (!hasInputExpansion || collapsedMaxHeight == null || inputContentHeightPx == null) {
        return false;
    }
    if (currentVisible) {
        return inputContentHeightPx >= collapsedMaxHeight - INPUT_EXPANSION_TOGGLE_HIDE_OFFSET_PX;
    }
    return inputContentHeightPx > collapsedMaxHeight + INPUT_EXPANSION_TOGGLE_SHOW_OFFSET_PX;
}
