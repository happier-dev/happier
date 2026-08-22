export const SESSION_LIST_PLACEMENT_MODE_VALUES = ['off', 'global', 'withinGroups'] as const;

export type SessionListPlacementMode = typeof SESSION_LIST_PLACEMENT_MODE_VALUES[number];

export const SESSION_LIST_ATTENTION_PLACEMENT_MODE_VALUES = SESSION_LIST_PLACEMENT_MODE_VALUES;
export const SESSION_LIST_WORKING_PLACEMENT_MODE_VALUES = SESSION_LIST_PLACEMENT_MODE_VALUES;

export type SessionListAttentionPlacementMode = SessionListPlacementMode;
export type SessionListWorkingPlacementMode = SessionListPlacementMode;

export type SessionListAttentionPlacementReason =
    | 'action_required'
    | 'permission_required'
    | 'failed'
    | 'ready'
    | 'unread'
    /**
     * The user asked for this session to stay in Needs attention. It is a
     * FLOOR, never an override: it only reaches a session whose own signals
     * place it nowhere, so every reason above keeps its own placement and its
     * own ordering key.
     */
    | 'standing';

/**
 * Item-level projection of a 'working' placement: 'working' means live
 * foreground working signals, and 'working-retained' means the session
 * is held in the working group by retention while its signals are stale (rows
 * render a paused indicator for it). All count as working placement for grouping.
 */
export type SessionListWorkingPlacementReason = 'working' | 'working-retained';

export function isSessionListWorkingPlacementReason(value: unknown): value is SessionListWorkingPlacementReason {
    return value === 'working' || value === 'working-retained';
}

export function normalizeSessionListAttentionPlacementMode(value: unknown): SessionListAttentionPlacementMode {
    return normalizeSessionListPlacementMode(value);
}

export function normalizeSessionListWorkingPlacementMode(value: unknown): SessionListWorkingPlacementMode {
    return normalizeSessionListPlacementMode(value);
}

export function normalizeSessionListPlacementMode(value: unknown): SessionListPlacementMode {
    return value === 'global' || value === 'withinGroups' ? value : 'off';
}
