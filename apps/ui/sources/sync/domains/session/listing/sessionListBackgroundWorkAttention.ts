export const SESSION_LIST_BACKGROUND_WORK_ATTENTION_MODE_VALUES = ['keepWorking', 'keepWorkingUnread', 'showUnread'] as const;

export type SessionListBackgroundWorkAttentionMode = typeof SESSION_LIST_BACKGROUND_WORK_ATTENTION_MODE_VALUES[number];

export function normalizeSessionListBackgroundWorkAttentionMode(value: unknown): SessionListBackgroundWorkAttentionMode {
    return value === 'showUnread' || value === 'keepWorkingUnread' ? value : 'keepWorking';
}

/**
 * Shared by placement and row presentation, after actionable requests and failures.
 * A foreground reply can be unread while background work continues; it cannot
 * establish that the session's work is ready for review.
 */
export function resolveSessionListBackgroundWorkAttention(input: Readonly<{
    backgroundActive: boolean;
    hasUnreadMessages: boolean;
    mode?: SessionListBackgroundWorkAttentionMode;
}>): Readonly<{ placement: 'working' | 'unread'; attentionState: 'thinking' | 'unread' }> | null {
    if (!input.backgroundActive) return null;
    const presentsUnread = input.hasUnreadMessages && (input.mode === 'showUnread' || input.mode === 'keepWorkingUnread');
    return {
        placement: input.mode === 'showUnread' && presentsUnread ? 'unread' : 'working',
        attentionState: presentsUnread ? 'unread' : 'thinking',
    };
}
