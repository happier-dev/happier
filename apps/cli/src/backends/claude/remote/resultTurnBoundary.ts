/** Claude SDK 0.3.243 / Claude Code 2.1.243 result contract, including error results. */
export function hasClaudeQueuedUserTurns(message: unknown): boolean {
    if (!message || typeof message !== 'object') return false;
    const result = message as Readonly<Record<string, unknown>>;
    return result.type === 'result'
        && typeof result.queued_turn_count === 'number'
        && Number.isSafeInteger(result.queued_turn_count)
        && result.queued_turn_count > 0;
}

/** Native result attribution identifies sends answered by this turn, including folded input. */
export function readClaudeResultUserMessageUuids(message: unknown): readonly string[] {
    if (!message || typeof message !== 'object') return [];
    const result = message as Readonly<Record<string, unknown>>;
    if (result.type !== 'result' || result.isSynthetic === true || result.parent_tool_use_id != null) return [];
    if (Array.isArray(result.user_message_uuids)) {
        return result.user_message_uuids.filter((uuid): uuid is string => typeof uuid === 'string' && uuid.length > 0);
    }
    return typeof result.user_message_uuid === 'string' && result.user_message_uuid.length > 0
        ? [result.user_message_uuid]
        : [];
}
