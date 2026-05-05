import type { ActivityAttentionDeliveryEventKind } from './activityAttentionDeliveryPlanTypes';

export const ACTIVITY_ATTENTION_DELIVERY_EVENT_KINDS = [
    'ready',
    'permission_request',
    'user_action_request',
] as const satisfies readonly ActivityAttentionDeliveryEventKind[];
