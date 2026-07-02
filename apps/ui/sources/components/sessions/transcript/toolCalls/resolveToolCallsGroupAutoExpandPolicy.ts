const MIN_TOOL_CALLS_AUTO_EXPAND_LIMIT = 32;

function normalizeCount(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.trunc(value);
}

export function resolveToolCallsGroupAutoExpandLimit(params: {
    collapsedPreviewCount: number;
    maxTurnEntriesPerListItem: number;
}): number {
    const previewCount = normalizeCount(params.collapsedPreviewCount);
    const maxTurnEntriesPerListItem = normalizeCount(params.maxTurnEntriesPerListItem);
    return Math.max(
        MIN_TOOL_CALLS_AUTO_EXPAND_LIMIT,
        previewCount * 4,
        maxTurnEntriesPerListItem * 4,
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
