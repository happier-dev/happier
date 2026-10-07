import { HAPPIER_FOCUS_LIVE_ACTIVITY_NAME } from '@happier-dev/protocol/activity/live/remoteUpdates';

import { activityInstanceKey } from '@/sync/domains/session/sessionAddress';

/**
 * `serverId` stays `null` for a Session with no Home binding. It is never substituted with a
 * placeholder id: a Home whose profile id is literally `local` is a real, addressable Home and
 * must not share an identity with an unbound Session (Lane 07.1 §4).
 */
export type LiveActivityIdentity = Readonly<{
    serverId: string | null;
    sessionId: string;
    activityName: typeof HAPPIER_FOCUS_LIVE_ACTIVITY_NAME;
}>;

export function normalizeLiveActivityServerId(serverId: string | null | undefined): string | null {
    const trimmed = typeof serverId === 'string' ? serverId.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
}

export function buildLiveActivityInstanceKey(identity: LiveActivityIdentity): string {
    return activityInstanceKey(identity, identity.activityName);
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
