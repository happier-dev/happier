export function resolveActiveThinkingMessageId(params: {
    sessionThinking: boolean;
    latestThinkingMessageId: string | null;
    latestThinkingMessageActivityAtMs: number | null;
    nowMs: number;
    staleMs: number;
}): string | null {
    if (params.sessionThinking !== true) return null;

    const messageId = params.latestThinkingMessageId;
    if (typeof messageId !== 'string' || messageId.length === 0) return null;

    const activityAtMs = params.latestThinkingMessageActivityAtMs;
    if (typeof activityAtMs !== 'number' || !Number.isFinite(activityAtMs)) return null;

    const staleMs = Math.max(0, Math.trunc(params.staleMs));
    const nowMs = params.nowMs;
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return null;

    if (staleMs > 0 && nowMs - activityAtMs > staleMs) return null;
    return messageId;
}
