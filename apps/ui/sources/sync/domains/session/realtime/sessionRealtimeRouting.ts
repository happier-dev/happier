import type { Session } from '@/sync/domains/state/storageTypes';

export type SessionRealtimeProjectionMode = 'disabled' | 'shadow' | 'enabled';
export type DurableSessionUpdateType = 'new-message' | 'message-updated';

export type SessionRealtimeRoute =
    | 'fullTranscriptApply'
    | 'projectionOnly'
    | 'markTranscriptStale'
    | 'legacyFallback';

export type SessionRealtimeRouteReason =
    | 'routing-disabled'
    | 'visible-full-apply'
    | 'full-content-consumer'
    | 'legacy-missing-projection'
    | 'hidden-projection-only'
    | 'message-updated-stale';

export type DurableSessionRealtimeDecision = Readonly<{
    route: SessionRealtimeRoute;
    reason: SessionRealtimeRouteReason;
}>;

export type SessionRealtimeProjectionCandidate = Pick<Session, 'latestTurnStatus' | 'latestTurnStatusObservedAt'>;

export function decideDurableSessionRealtimeRoute(params: Readonly<{
    updateType: DurableSessionUpdateType;
    mode: SessionRealtimeProjectionMode;
    session: Session | undefined;
    sessionProjection?: SessionRealtimeProjectionCandidate | undefined;
    visible: boolean;
    fullContentConsumerActive: boolean;
}>): DurableSessionRealtimeDecision {
    if (params.mode === 'disabled') {
        return { route: 'fullTranscriptApply', reason: 'routing-disabled' };
    }
    if (params.visible) {
        return { route: 'fullTranscriptApply', reason: 'visible-full-apply' };
    }
    if (params.fullContentConsumerActive) {
        return { route: 'fullTranscriptApply', reason: 'full-content-consumer' };
    }
    if (params.updateType === 'message-updated') {
        return { route: 'markTranscriptStale', reason: 'message-updated-stale' };
    }
    return { route: 'projectionOnly', reason: 'hidden-projection-only' };
}
