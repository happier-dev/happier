export const SESSION_LIST_PLACEMENT_MODE_VALUES = ['off', 'global', 'withinGroups'] as const;

export type SessionListPlacementMode = typeof SESSION_LIST_PLACEMENT_MODE_VALUES[number];

export function normalizeSessionListPlacementMode(value: unknown): SessionListPlacementMode {
    return value === 'global' || value === 'withinGroups' ? value : 'off';
}

export const SESSION_LIST_ATTENTION_PROMOTION_MODE_VALUES = SESSION_LIST_PLACEMENT_MODE_VALUES;
export const SESSION_LIST_WORKING_PLACEMENT_MODE_VALUES = SESSION_LIST_PLACEMENT_MODE_VALUES;

export type SessionListAttentionPromotionMode = SessionListPlacementMode;
export type SessionListWorkingPlacementMode = SessionListPlacementMode;

export type SessionListAttentionPromotionReason =
    | 'action_required'
    | 'permission_required'
    | 'failed'
    | 'ready'
    | 'unread'
    | 'standing';

export function normalizeSessionListAttentionPromotionMode(value: unknown): SessionListAttentionPromotionMode {
    return normalizeSessionListPlacementMode(value);
}

export function normalizeSessionListWorkingPlacementMode(value: unknown): SessionListWorkingPlacementMode {
    return normalizeSessionListPlacementMode(value);
}
