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
    | 'ready';

export function normalizeSessionListAttentionPlacementMode(value: unknown): SessionListAttentionPlacementMode {
    return normalizeSessionListPlacementMode(value);
}

export function normalizeSessionListWorkingPlacementMode(value: unknown): SessionListWorkingPlacementMode {
    return normalizeSessionListPlacementMode(value);
}

export function normalizeSessionListPlacementMode(value: unknown): SessionListPlacementMode {
    return value === 'global' || value === 'withinGroups' ? value : 'off';
}
