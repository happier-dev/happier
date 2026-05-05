import { HAPPIER_FOCUS_LIVE_ACTIVITY_NAME } from '@happier-dev/protocol';

export const LOCAL_LIVE_ACTIVITY_SERVER_ID = 'local';

export type LiveActivityIdentity = Readonly<{
    serverId: string;
    sessionId: string;
    activityName: typeof HAPPIER_FOCUS_LIVE_ACTIVITY_NAME;
}>;

export function normalizeLiveActivityServerId(serverId: string | null | undefined): string {
    const trimmed = typeof serverId === 'string' ? serverId.trim() : '';
    return trimmed.length > 0 ? trimmed : LOCAL_LIVE_ACTIVITY_SERVER_ID;
}

export function buildLiveActivityInstanceKey(identity: LiveActivityIdentity): string {
    return `${identity.serverId}:${identity.activityName}:${identity.sessionId}`;
}

export function buildHappierFocusLiveActivityIdentity(params: Readonly<{
    serverId: string | null | undefined;
    sessionId: string;
}>): LiveActivityIdentity {
    return {
        serverId: normalizeLiveActivityServerId(params.serverId),
        sessionId: params.sessionId,
        activityName: HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
    };
}
