/** The one staleness rule for the thinking pulse: activity counts while inside its stale window. */
export function isThinkingActivityFresh(activityAtMs: number | null, nowMs: number, staleMs: number): boolean {
    if (typeof activityAtMs !== 'number' || !Number.isFinite(activityAtMs)) return false;
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return false;
    const window = Math.max(0, Math.trunc(staleMs));
    return window === 0 || nowMs - activityAtMs <= window;
}

export function resolveActiveThinkingMessageId(params: {
    sessionThinking: boolean;
    latestThinkingMessageId: string | null;
    latestCommittedMessageId: string | null;
    latestThinkingMessageActivityAtMs: number | null;
    nowMs: number;
    staleMs: number;
}): string | null {
    return resolveActiveThinkingMessageIdFromFreshness({
        ...params,
        thinkingActivityFresh: isThinkingActivityFresh(params.latestThinkingMessageActivityAtMs, params.nowMs, params.staleMs),
    });
}

export function resolveActiveThinkingMessageIdFromFreshness(params: {
    sessionThinking: boolean;
    latestThinkingMessageId: string | null;
    latestCommittedMessageId: string | null;
    thinkingActivityFresh: boolean;
}): string | null {
    if (params.sessionThinking !== true) return null;

    const messageId = params.latestThinkingMessageId;
    if (typeof messageId !== 'string' || messageId.length === 0) return null;

    // Only pulse the thinking title when the thinking message is the latest committed transcript item.
    // If newer tool calls or messages have arrived, the thinking chunk is no longer actively streaming.
    if (params.latestCommittedMessageId !== messageId) return null;

    return params.thinkingActivityFresh ? messageId : null;
}
