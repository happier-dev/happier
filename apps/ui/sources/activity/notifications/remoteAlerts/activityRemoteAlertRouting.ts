import { ActivityRemoteAlertSchema, resolveActivityRemoteAlertEventIdentity, type ActivityRemoteAlert } from '@happier-dev/protocol/push/activityRemoteAlert';
import type { SessionPersonalEventKindV1 } from '@happier-dev/protocol/sessions/personal/eventEligibility';

import { resolveServerProfileForPortableIdentity } from '@/sync/domains/server/serverProfiles';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';

/**
 * The device-local event vocabulary shared with `activityLocalNotificationBus`,
 * so one committed event has one identity on this device regardless of which
 * leg observed it.
 */
export type ActivityAlertEventKind = Exclude<SessionPersonalEventKindV1, 'directly_shared'>;

export type ActivityRemoteAlertTarget = Readonly<{
    alert: ActivityRemoteAlert;
    address: SessionAddress;
    serverUrl: string;
    event: ActivityAlertEventKind;
    /** Exact Discussion target for current Discussion-scoped events. */
    discussionId?: string;
    /** Stable identity of the committed event when the payload carries one. */
    eventIdentity?: string;
}>;

export const REMOTE_ALERT_EVENT_KIND: Record<ActivityRemoteAlert['event']['type'], ActivityAlertEventKind> = {
    ready: 'ready',
    permission_request: 'permission_required',
    user_action_request: 'user_action_required',
    assigned: 'assigned',
    failed: 'failed',
    cancelled: 'cancelled',
    human_message: 'human_message',
    message: 'message',
    discussion_mention: 'discussion_mention',
    source_unavailable: 'source_unavailable',
};

/**
 * Admit a Home-submitted collaborator alert (Lane 09C §10.4 C5b).
 *
 * The payload is the canonical committed event reference only: no title, author
 * or transcript text crosses this leg, and nothing here opens E2EE content.
 */
export function parseActivityRemoteAlertData(data: unknown): ActivityRemoteAlert | null {
    const parsed = ActivityRemoteAlertSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
}

/**
 * Resolve the alert's originating Home to this device's saved profile.
 *
 * The payload carries the Home's portable server identity, so the existing
 * portable-identity owner decides. An unknown or ambiguous identity fails
 * closed: an alert is never routed, presented or suppressed against the merely
 * active Home.
 */
export function resolveActivityRemoteAlertTarget(alert: ActivityRemoteAlert): ActivityRemoteAlertTarget | null {
    const resolution = resolveServerProfileForPortableIdentity(alert.serverId);
    if (resolution.kind !== 'resolved') return null;
    const address = normalizeSessionAddress(resolution.profile.id, alert.sessionId);
    if (!address) return null;
    const eventIdentity = resolveActivityRemoteAlertEventIdentity(alert);
    const discussionId = alert.v === 2
        && 'sequenceDomain' in alert.event
        && alert.event.sequenceDomain === 'discussion'
        ? alert.event.discussionId
        : undefined;
    return {
        alert,
        address,
        serverUrl: resolution.profile.serverUrl,
        event: REMOTE_ALERT_EVENT_KIND[alert.event.type],
        ...(discussionId ? { discussionId } : {}),
        ...(eventIdentity ? { eventIdentity } : {}),
    };
}

export type IncomingActivityRemoteAlert =
    | Readonly<{ kind: 'not_remote_alert' }>
    | Readonly<{ kind: 'unroutable' }>
    | Readonly<{ kind: 'routable'; target: ActivityRemoteAlertTarget }>;

/** One admission step for every consumer of an incoming notification payload. */
export function resolveIncomingActivityRemoteAlert(data: unknown): IncomingActivityRemoteAlert {
    const alert = parseActivityRemoteAlertData(data);
    if (!alert) return { kind: 'not_remote_alert' };
    const target = resolveActivityRemoteAlertTarget(alert);
    return target ? { kind: 'routable', target } : { kind: 'unroutable' };
}
