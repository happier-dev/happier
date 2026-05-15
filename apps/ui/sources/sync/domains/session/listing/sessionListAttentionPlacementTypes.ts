export const SESSION_LIST_ATTENTION_PLACEMENT_MODE_VALUES = ['off', 'global', 'withinGroups'] as const;

export type SessionListAttentionPlacementMode = typeof SESSION_LIST_ATTENTION_PLACEMENT_MODE_VALUES[number];

export type SessionListAttentionPlacementReason =
    | 'action_required'
    | 'permission_required'
    | 'failed'
    | 'ready';

export function normalizeSessionListAttentionPlacementMode(value: unknown): SessionListAttentionPlacementMode {
    return value === 'global' || value === 'withinGroups' ? value : 'off';
}
