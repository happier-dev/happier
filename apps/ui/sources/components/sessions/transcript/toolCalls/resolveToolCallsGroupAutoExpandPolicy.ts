const MIN_TOOL_CALLS_AUTO_EXPAND_LIMIT = 6;

function normalizeCount(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.trunc(value);
}

/**
 * Upper band for the short-transcript tool-group auto-expand fallback. Only SMALL groups — a few
 * tools just above the collapsed preview — are auto-expanded so a short transcript does not look
 * sparse; medium/large groups (e.g. ~29 tool calls) stay collapsed to their summary, exactly like a
 * freshly-streamed group, so they do not dominate the bottom of the transcript with a tall rendered
 * block on reopen. The band tracks the collapsed preview only (`max(collapsedPreviewCount*2, 6)`);
 * `maxTurnEntriesPerListItem` (a list-virtualization grouping bound) no longer widens it, since it is
 * unrelated to how many tools a user wants rendered un-collapsed.
 */
export function resolveToolCallsGroupAutoExpandLimit(params: {
    collapsedPreviewCount: number;
    maxTurnEntriesPerListItem: number;
}): number {
    const previewCount = normalizeCount(params.collapsedPreviewCount);
    return Math.max(
        MIN_TOOL_CALLS_AUTO_EXPAND_LIMIT,
        previewCount * 2,
    );
}

export function shouldAutoExpandToolCallsGroupForShortTranscript(params: {
    toolMessageCount: number;
    collapsedPreviewCount: number;
    maxTurnEntriesPerListItem: number;
}): boolean {
    const toolMessageCount = normalizeCount(params.toolMessageCount);
    const collapsedPreviewCount = normalizeCount(params.collapsedPreviewCount);
    if (toolMessageCount <= collapsedPreviewCount) return false;

    return toolMessageCount <= resolveToolCallsGroupAutoExpandLimit({
        collapsedPreviewCount,
        maxTurnEntriesPerListItem: params.maxTurnEntriesPerListItem,
    });
}
