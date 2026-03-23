const IGNORED_CLAUDE_LIFECYCLE_EVENT_TYPES = new Set([
    'idle_notification',
    'shutdown_approved',
]);

function parseJsonObject(raw: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
        if (typeof parsed === 'string') {
            const reparsed = JSON.parse(parsed);
            if (reparsed && typeof reparsed === 'object' && !Array.isArray(reparsed)) {
                return reparsed as Record<string, unknown>;
            }
        }
    } catch {
        return null;
    }
    return null;
}

export function readClaudeIgnoredLifecycleEventType(rawText: string | null | undefined): string | null {
    if (typeof rawText !== 'string') return null;
    const normalized = rawText.trim();
    if (normalized.length === 0) return null;

    const parsed = parseJsonObject(normalized);
    const eventType = typeof parsed?.type === 'string' ? parsed.type.trim() : '';
    if (!eventType) return null;

    return IGNORED_CLAUDE_LIFECYCLE_EVENT_TYPES.has(eventType) ? eventType : null;
}
