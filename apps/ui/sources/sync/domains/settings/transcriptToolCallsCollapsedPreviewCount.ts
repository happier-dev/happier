export const DEFAULT_TRANSCRIPT_TOOL_CALLS_COLLAPSED_PREVIEW_COUNT = 3;

const MAX_TRANSCRIPT_TOOL_CALLS_COLLAPSED_PREVIEW_COUNT = 15;

export function resolveTranscriptToolCallsCollapsedPreviewCount(value: unknown): number {
    const raw = typeof value === 'number'
        ? value
        : DEFAULT_TRANSCRIPT_TOOL_CALLS_COLLAPSED_PREVIEW_COUNT;
    if (!Number.isFinite(raw)) return DEFAULT_TRANSCRIPT_TOOL_CALLS_COLLAPSED_PREVIEW_COUNT;
    return Math.max(0, Math.min(MAX_TRANSCRIPT_TOOL_CALLS_COLLAPSED_PREVIEW_COUNT, Math.trunc(raw)));
}
