import type { AttentionDeliveryDecision } from '@happier-dev/protocol';

import type { ActivitySurfaceSelectionSpec } from '../selection/activitySurfaceSelectionTypes';

export type ActivityAttentionDeliveryEventKind =
    | 'ready'
    | 'permission_request'
    | 'user_action_request';

export type ActivityAttentionDeliveryChannel =
    | 'expo_push'
    | 'webhook'
    | 'local_notification'
    | 'badge'
    | 'desktop_overlay'
    | 'live_activity'
    | 'home_widget';

export type ActivityAttentionSurface = Extract<
    ActivityAttentionDeliveryChannel,
    'desktop_overlay' | 'live_activity' | 'home_widget'
>;

export type ActivityAttentionUpdateBudgetHint = Readonly<{
    minUpdateIntervalMs: number;
    maxUpdatesPerWindow: number | null;
    windowMs: number | null;
    reason: string;
}>;

export type ActivityAttentionDeliveryPlan = AttentionDeliveryDecision & Readonly<{
    channelDecision: Readonly<{
        channel: ActivityAttentionDeliveryChannel;
        delivery: AttentionDeliveryDecision['delivery'];
        reason: AttentionDeliveryDecision['reason'];
    }>;
    surfacePolicy: Readonly<{
        surface: ActivityAttentionSurface | null;
        selection: ActivitySurfaceSelectionSpec | null;
        privacyMode: AttentionDeliveryDecision['previewBehavior'];
        staleAfterMs: number | null;
        dwellMs: number | null;
        updateBudget: ActivityAttentionUpdateBudgetHint | null;
    }>;
}>;
