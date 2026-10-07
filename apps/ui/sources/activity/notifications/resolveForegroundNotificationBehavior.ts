import { ACTIVITY_REMOTE_ALERT_POLICY_EVENT_V1, ActivityRemoteAlertEventV2Schema, resolveActivityEventIdentityV2 } from '@happier-dev/protocol/push/activityRemoteAlert';
import { PUSH_NOTIFICATION_CATEGORY_IDS } from '@happier-dev/protocol/push/pushNotificationActions';
import { resolveActivityRequestEventIdentityV1, resolveActivityTranscriptLocalIdEventIdentityV1 } from '@happier-dev/protocol/activity/eventIdentity';

import { localSettingsParse, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

import type { ActivityAttentionDeliveryChannel, ActivityAttentionDeliveryEventKind } from '../delivery/activityAttentionDeliveryPlanTypes';
import { readExactHomeAccountSettings } from '../delivery/useExactHomeAccountSettings';
import { resolveActivityAttentionDeliveryPlan } from '../delivery/resolveActivityAttentionDeliveryPlan';
import { consumeOtherLegActivityAlertPresentation, noteActivityAlertPresented } from './remoteAlerts/activityAlertPresentationNotes';
import { REMOTE_ALERT_EVENT_KIND, type ActivityAlertEventKind } from './remoteAlerts/activityRemoteAlertRouting';
import { resolveRemoteAlertForegroundPresentation } from './remoteAlerts/resolveRemoteAlertForegroundPresentation';
import { resolveNotificationSavedHome } from './resolveNotificationSavedHome';

export type ForegroundNotificationBehavior = 'full' | 'silent' | 'off';

type ForegroundNotificationArrival = Readonly<{
    serverId: string;
    sessionId: string | null;
    event: ActivityAttentionDeliveryEventKind;
    channel: ActivityAttentionDeliveryChannel;
    personalEvent: ActivityAlertEventKind;
    eventIdentity?: string;
    committedLocalId?: string;
}>;

function readTrimmedString(record: Readonly<Record<string, unknown>>, key: string): string | null {
    const value = record[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** A request notification carries its kind as the native category both producers set. */
function readArrivalEvent(categoryIdentifier: unknown): ActivityAttentionDeliveryEventKind {
    if (categoryIdentifier === PUSH_NOTIFICATION_CATEGORY_IDS.permissionRequestV1) return 'permission_request';
    if (categoryIdentifier === PUSH_NOTIFICATION_CATEGORY_IDS.userActionRequestV1) return 'user_action_request';
    return 'ready';
}

/**
 * Names a non-Home-alert arrival: its exact Home, event and the channel it
 * actually arrived on.
 *
 * A device-local notification carries the saved Home id this device named when
 * it scheduled it. The daemon rich push names its Home only by client URL
 * (`withServerUrlInPushData`), so it resolves through the saved-Home rule and is
 * judged on the push channel. An arrival whose Home cannot be named exactly
 * fails closed; it is never judged by the focused Home.
 */
function resolveArrival(content: Readonly<{ data?: unknown; categoryIdentifier?: unknown }>): ForegroundNotificationArrival | null {
    const data = content.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const record = data as Readonly<Record<string, unknown>>;
    const sessionId = readTrimmedString(record, 'sessionId');
    const parsedEvent = ActivityRemoteAlertEventV2Schema.safeParse(record.activityEvent);
    if (record.activityEvent !== undefined && !parsedEvent.success) return null;
    const event = parsedEvent.success
        ? ACTIVITY_REMOTE_ALERT_POLICY_EVENT_V1[parsedEvent.data.type]
        : readArrivalEvent(content.categoryIdentifier);
    const personalEvent = parsedEvent.success
        ? REMOTE_ALERT_EVENT_KIND[parsedEvent.data.type]
        : event === 'permission_request' ? 'permission_required'
            : event === 'user_action_request' ? 'user_action_required' : 'ready';
    const committedLocalId = personalEvent === 'ready' ? readTrimmedString(record, 'activityEventLocalId') ?? undefined : undefined;
    const requestId = readTrimmedString(record, 'requestId');
    const eventIdentity = parsedEvent.success ? resolveActivityEventIdentityV2(parsedEvent.data)
        : requestId && (personalEvent === 'permission_required' || personalEvent === 'user_action_required')
            ? resolveActivityRequestEventIdentityV1(requestId)
            : committedLocalId ? resolveActivityTranscriptLocalIdEventIdentityV1(committedLocalId) : undefined;
    const identity = { personalEvent, eventIdentity, committedLocalId };
    const localServerId = readTrimmedString(record, 'serverId');
    if (localServerId) return { serverId: localServerId, sessionId, event, channel: 'local_notification', ...identity };
    const serverUrl = readTrimmedString(record, 'serverUrl');
    const home = serverUrl ? resolveNotificationSavedHome({ serverId: null, serverUrl }) : null;
    return home ? { serverId: home.id, sessionId, event, channel: 'expo_push', ...identity } : null;
}

/**
 * How an arriving notification may present while Happier is in the foreground.
 *
 * One owner normalizes every current arrival — a Home remote alert, a device-local
 * notification, or the daemon rich push — into its exact Home, event and arrival
 * channel, suppresses it only while that exact Home Session is visible, and asks
 * the canonical delivery-plan owner. The active Home's Account policy is never a
 * substitute, and a Home whose Account settings this device cannot name fails
 * closed. Every presented committed event is noted so another transport leg
 * does not repeat it, including a rich push sent before the transcript ACK.
 */
export async function resolveForegroundNotificationBehavior(params: Readonly<{
    /** The arriving Expo notification content. */
    content: Readonly<{ data?: unknown; categoryIdentifier?: unknown }>;
    localSettings: Partial<LocalSettings> | null | undefined;
    now: Date;
    isSessionVisible: (address: SessionAddress) => boolean;
}>): Promise<ForegroundNotificationBehavior> {
    const remoteAlert = resolveRemoteAlertForegroundPresentation({
        data: params.content.data,
        isSessionVisible: params.isSessionVisible,
    });
    if (remoteAlert.kind === 'suppress') return 'off';
    const target = remoteAlert.kind === 'present' ? remoteAlert.target : null;
    const arrival: ForegroundNotificationArrival | null = target
        ? {
            serverId: target.address.serverId,
            sessionId: target.address.sessionId,
            event: ACTIVITY_REMOTE_ALERT_POLICY_EVENT_V1[target.alert.event.type],
            channel: 'expo_push',
            personalEvent: target.event,
            eventIdentity: target.eventIdentity,
        }
        : resolveArrival(params.content);
    if (!arrival) return 'off';
    // Same-Session suppression is exact-Home: the same Session id visible on
    // another Home never hides this one.
    if (!target && arrival.sessionId && params.isSessionVisible({ serverId: arrival.serverId, sessionId: arrival.sessionId })) {
        return 'off';
    }

    const resolution = await resolveServerCredentialAccountScope(arrival.serverId);
    // A Home alert names its recipient Account. When this device now holds a
    // different Account for that Home, the alert is not this Account's to present.
    if (target && resolution.kind === 'bound' && resolution.scope.accountId !== target.alert.accountId) return 'off';
    const accountSettings = resolution.kind === 'bound'
        ? readExactHomeAccountSettings(resolution.scope)
        : null;
    if (!accountSettings || resolution.kind !== 'bound') return 'off';

    const plan = resolveActivityAttentionDeliveryPlan({
        localSettings: localSettingsParse(params.localSettings ?? {}),
        accountSettings,
        event: arrival.event,
        // A push is judged on the push channel: disabling this device's own local
        // notifications must not silence a permitted push, and vice versa.
        channel: arrival.channel,
        foregroundState: 'foreground',
        now: params.now,
    });
    // Quiet hours weaken, never strengthen, the configured foreground behavior.
    const behavior: ForegroundNotificationBehavior = plan.delivery === 'suppress'
        ? 'off'
        : plan.delivery === 'silent' && plan.foregroundBehavior === 'full'
            ? 'silent'
            : plan.foregroundBehavior;
    if (arrival.sessionId && arrival.eventIdentity && behavior !== 'off') {
        const presentation = {
            address: { serverId: arrival.serverId, sessionId: arrival.sessionId },
            accountId: resolution.scope.accountId,
            event: arrival.personalEvent,
            identity: arrival.eventIdentity,
            committedLocalId: arrival.committedLocalId,
            source: target ? 'home_remote_alert' as const
                : arrival.channel === 'local_notification' ? 'local_notification' as const : 'rich_push' as const,
        };
        // This synchronous decision follows the async policy read, so concurrent
        // local and remote arrivals cannot both win foreground presentation.
        if (consumeOtherLegActivityAlertPresentation(presentation)) return 'off';
        noteActivityAlertPresented(presentation);
    }
    return behavior;
}
