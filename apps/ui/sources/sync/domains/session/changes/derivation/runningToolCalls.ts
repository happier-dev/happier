import type { Message } from '@happier-dev/session-core/messages';

/**
 * A root transcript row that carries live write activity: a tool call still running, itself or in its sidechain
 * children. The transcript store keeps the ids of these rows as an incremental index, so live-write readers
 * select the few running calls instead of walking the whole transcript on every delta.
 */
export function hasRunningToolCall(message: Message): boolean {
    if (message.kind !== 'tool-call') return false;
    return message.tool.state === 'running' || message.children.some(hasRunningToolCall);
}
