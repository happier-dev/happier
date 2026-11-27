import { ACTIVITY_REMOTE_ALERT_POLICY_EVENT_V1, ActivityRemoteAlertV2Schema, resolveActivityRemoteAlertEventForPersonalEventV2, type ActivityRemoteAlertCommittedMessageV2, type ActivityRemoteAlertEventV2 } from '@happier-dev/protocol/push/activityRemoteAlert';
import { SESSION_CHANGED_WAKE_TYPE, SessionChangedWakeV1Schema } from '@happier-dev/protocol/push/sessionChangedWake';
import { resolveAccountRemoteAlertPolicyCurrentness, resolveRemoteAlertPolicyDecision } from '@happier-dev/protocol/account/settings/accountRemoteAlertPolicy';
import { resolveExpoNotificationSoundName, resolvePushNotificationAndroidChannelId, resolvePushNotificationAndroidChannelKind } from '@happier-dev/protocol/push/pushNotificationActions';
import { resolveAttentionPushSoundId } from '@happier-dev/protocol/account/settings/attentionDeliveryPolicyDecision';
import { shouldMuteMobileAlertsForComputerFocus } from '@happier-dev/protocol/account/settings/attentionDeliveryPolicyDecision';
import { resolveSessionPersonalFollowEventV1, type SessionPersonalEventKindV1 } from '@happier-dev/protocol/sessions/personal/eventEligibility';
import type { PersonalFollowOnceOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import type { FollowEventV1, ResolveFollowDeliveryV1Params } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';

import { listSessionPersonalEventRecipients } from "@/app/session/personal/eventEligibility";
import { acceptAccountSessionFollowOnceDelivery } from '@/app/session/follow/accountFollowService';
import { isServerFeatureEnabledForHome } from "@/app/features/catalog/serverFeatureGate";
import type { CurrentSessionPublisherAuthority } from "@/app/presence/sessionPublisherPresence";
import { hasExactCurrentPublisherAuthorityInTx } from "@/app/session/pending/hasExactCurrentPublisherAuthorityInTx";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { db } from "@/storage/db";
import { eventRouter } from '@/app/events/eventRouter';
import { inTx } from "@/storage/inTx";
import { isSessionPersonalStalledOccurrenceCurrent } from '@/app/session/personal/publishPersonalEvent';
import type { SessionFollowStalledOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceOccurrenceV1';
import { log } from "@/utils/logging/log";

import { sendAccountExpoPushMessages, type AccountPushDelivery } from "../accountPushTransport";

/**
 * Generic Happier copy for the OS-visible fallback.
 *
 * No Session title, author, or message text crosses the Home or the push
 * provider on this leg. The native consumer enriches the alert locally, within
 * the stricter of the submitted preview ceiling and its current local policy.
 */
const REMOTE_ALERT_FALLBACK_BODY: Record<ActivityRemoteAlertEventV2["type"], string> = {
    ready: "A session you follow is ready.",
    permission_request: "A session you follow needs permission.",
    user_action_request: "A session you follow needs your input.",
    assigned: "A session was assigned to you.",
    failed: "A session you follow failed.",
    cancelled: "A session you follow was cancelled.",
    human_message: "A session you follow has a new message.",
    message: "A session you follow has a new message.",
    discussion_mention: "You were mentioned in a session discussion.",
    source_unavailable: "A followed session source is unavailable.",
};

function resolveRemoteAlertFallbackBody(
    event: ActivityRemoteAlertEventV2,
    assignmentAutoFollowed: boolean | undefined,
): string {
    if (event.type === "assigned" && assignmentAutoFollowed === true) {
        return "Following because you were assigned.";
    }
    return REMOTE_ALERT_FALLBACK_BODY[event.type];
}

/**
 * What this leg does with one committed personal event.
 *
 * `personal_only` is a decision, not a gap: access "never creates tracking,
 * unread or notifications by itself" (`LANE-09-BRIEF.md:68` item 16), so a
 * direct share is a relevance fact at effective level `none` — it earns no
 * OS-visible alert and no content-free wake, and adding either would notify
 * about exactly the thing item 16 says access never notifies about.
 *
 * `no_alert_event` is the different, non-deliberate outcome: an alerting kind
 * whose committed producer this Home does not own, which submits nothing
 * because there is nothing valid to submit.
 */
export type SessionActivityRemoteAlertDisposition =
    | Readonly<{ kind: "alert"; event: ActivityRemoteAlertEventV2 }>
    | Readonly<{ kind: "personal_only" }>
    | Readonly<{ kind: "no_alert_event" }>;

const PERSONAL_ONLY_DISPOSITION: SessionActivityRemoteAlertDisposition = Object.freeze({ kind: "personal_only" as const });
const NO_ALERT_EVENT_DISPOSITION: SessionActivityRemoteAlertDisposition = Object.freeze({ kind: "no_alert_event" as const });

export function resolveSessionActivityRemoteAlertDisposition(
    event: SessionPersonalEventKindV1,
    committedMessage?: ActivityRemoteAlertCommittedMessageV2,
    committedTurnId?: string,
    committedRequestId?: string,
): SessionActivityRemoteAlertDisposition {
    if (event === "directly_shared") return PERSONAL_ONLY_DISPOSITION;
    const alertEvent = resolveActivityRemoteAlertEventForPersonalEventV2(
        event,
        committedMessage,
        committedTurnId,
        committedRequestId,
    );
    return alertEvent ? { kind: "alert", event: alertEvent } : NO_ALERT_EVENT_DISPOSITION;
}

export type SubmitSessionActivityRemoteAlertsParams = Readonly<{
    sessionId: string;
    event: SessionPersonalEventKindV1;
    /** Required for sequence-backed events: the committed sequence and its canonical owner. */
    committedMessage?: ActivityRemoteAlertCommittedMessageV2;
    /** Captured source turn for a committed request or terminal turn event. */
    committedTurnId?: string;
    /**
     * The Agent-allocated request id of a committed permission/user-action
     * request. It carries the cross-leg identity a recipient device uses to show
     * exactly one alert for one request, whichever leg observed it first.
     */
    committedRequestId?: string;
    /** Exact committed source witness; never dated from a later Session snapshot. */
    onceOccurrence?: PersonalFollowOnceOccurrenceV1;
    /** Terminal success supplements the existing ready producer only for an armed one-shot. */
    onceOnly?: boolean;
    /** The canonical Session readiness owner admitted this committed Finished marker. */
    settledFinished?: true;
    /** Request-owner projection, including continue mode and current handler. */
    followEvent?: FollowEventV1;
    /** Only the committed presence owner supplies this exact in-flight Turn/fence. */
    stalledOccurrence?: SessionFollowStalledOccurrenceV1;
    /** One-shot targets established by the committed semantic mutation owner. */
    targetAccountIds?: readonly string[];
    /** Ephemeral winners of the original source transaction's Inbox CAS. */
    acceptedOnceAccountIds?: readonly string[];
    /** True only when this committed assignment inserted the recipient's automatic Follow. */
    assignmentAutoFollowed?: boolean;
    /** Authenticated human source of a committed post; never alert that Account about its own post. */
    sourceAccountId?: string;
    /** Accounts receiving a more specific alert for this same committed fact. */
    excludeAccountIds?: readonly string[];
    runtimeComposition?: Readonly<{
        /** Authenticated publisher authority captured by the socket owner for the committed event. */
        publisherAuthority: CurrentSessionPublisherAuthority;
        /** Actual sender composition established by the runtime host before commit. */
        ownerActivityDelivery: "rich_sender" | "home_required";
        /** Distinguishes current explicit composition from released publishers' omitted rich default. */
        ownerActivityDeliveryWasReported?: true;
    }>;
    now?: Date;
}>;

/**
 * The Home leg of the approved closed-app collaborator alert (Lane 09C §10.4 C5b).
 *
 * It composes the existing owners only: Lane 09B decides recipient eligibility,
 * the recipient's own published remote-alert projection plus its device
 * registration decide whether an OS-visible alert is permitted, and the existing
 * Account push transport submits it. Mute and quiet hours are applied **before**
 * submission; no OS fallback is ever the enforcement point.
 *
 * The installed native consumer may enrich the permitted generic fallback
 * after an exact-Home access/key recheck. Missing, locked, timed-out or
 * unsupported enrichment always retains this already-policy-approved copy.
 */
export async function submitSessionActivityRemoteAlerts(
    params: SubmitSessionActivityRemoteAlertsParams,
): Promise<readonly string[]> {
    if (!await isServerFeatureEnabledForHome("sessions.following")) return [];
    if (params.stalledOccurrence && !await isSessionPersonalStalledOccurrenceCurrent(params)) return [];
    const disposition = resolveSessionActivityRemoteAlertDisposition(
        params.event,
        params.committedMessage,
        params.committedTurnId,
        params.committedRequestId,
    );
    // The exact source-backed Inbox effect does not require an OS-alert
    // transcript pointer. A successful turn may legitimately have no message.
    if (disposition.kind !== "alert" && !params.onceOccurrence) return [];
    const alertEvent = disposition.kind === 'alert' ? disposition.event.type === 'source_unavailable' && params.stalledOccurrence
        ? { ...disposition.event, stalledOccurrence: params.stalledOccurrence } : disposition.event : null;

    const acceptedOnceAccountIds = new Set(params.acceptedOnceAccountIds ?? []);

    const readDevices = (accountIds: readonly string[]) => db.accountPushToken.findMany({
        where: { accountId: { in: [...accountIds] } },
        select: { accountId: true, token: true, remoteAlerts: true },
    });
    // Without a one-shot Follow occurrence a recipient's only effect here is a
    // push to its devices, so Accounts without one are not evaluated at all.
    const narrowed: { devices?: Awaited<ReturnType<typeof readDevices>> } = {};
    const recipients = await listSessionPersonalEventRecipients({
        sessionId: params.sessionId,
        event: params.event,
        onceOccurrence: params.onceOccurrence,
        followEvent: params.followEvent,
        settledFinished: params.settledFinished,
        targetAccountIds: [...new Set([...(params.targetAccountIds ?? []), ...acceptedOnceAccountIds])],
    }, alertEvent !== null && !params.onceOccurrence && acceptedOnceAccountIds.size === 0 ? {
        narrowCandidates: async accountIds => {
            const devices = await readDevices(accountIds);
            narrowed.devices = devices;
            return [...new Set(devices.map(device => device.accountId))];
        },
    } : undefined);
    // Every transcript line submits here; most reach nobody, so the Session is read only for recipients.
    if (recipients.length === 0) return [];
    const session = await db.session.findUnique({ where: { id: params.sessionId }, select: { accountId: true, agentStateVersion: true } });
    if (!session) return [];
    const richOwnerSenderOwnsDelivery = alertEvent !== null && await resolveRichOwnerSenderResponsibility({
        sessionId: params.sessionId,
        sessionOwnerAccountId: session.accountId,
        alertEventType: alertEvent.type,
        runtimeComposition: params.runtimeComposition,
    });
    const excluded = new Set(params.excludeAccountIds ?? []);
    const followByAccountId = new Map<string, ResolveFollowDeliveryV1Params>();
    const candidates: string[] = [];
    for (const recipient of recipients) {
        const accountId = recipient.accountId;
        if (accountId === params.sourceAccountId || excluded.has(accountId)) continue;
        let follow = recipient.follow;
        let acceptedOnce = acceptedOnceAccountIds.has(accountId);
        if (recipient.once && !acceptedOnce) {
            acceptedOnce = await acceptAccountSessionFollowOnceDelivery({
                accountId, sessionId: params.sessionId, ...recipient.once,
            });
            if (!acceptedOnce && recipient.reason === 'follow_once') continue;
        }
        if (acceptedOnce) {
            const event = params.followEvent ?? follow?.event ?? resolveSessionPersonalFollowEventV1(params.event);
            if (event) follow = { event, policies: [...(follow?.policies ?? []), { preset: 'everything' }] };
            // Acceptance retains the Inbox reference; it does not authorize a
            // stale encrypted request to interrupt after a newer state commit.
            if ((params.onceOccurrence?.event === 'permission_required' || params.onceOccurrence?.event === 'user_action_required')
                && session.agentStateVersion !== params.onceOccurrence.agentStateVersion) continue;
        }
        if (params.onceOnly && !acceptedOnce) continue;
        // The rich sender owns only its supported ongoing topics. It does not
        // perform the Account-private one-shot CAS or deliver that override.
        if (richOwnerSenderOwnsDelivery && accountId === session.accountId && !acceptedOnce
            && follow?.settledSessionPerson !== 'offline_manager_pass_up') continue;
        if (follow) followByAccountId.set(accountId, { ...follow, event: params.followEvent ?? follow.event });
        candidates.push(accountId);
    }
    if (!alertEvent || candidates.length === 0) return [];

    const policyEvent = ACTIVITY_REMOTE_ALERT_POLICY_EVENT_V1[alertEvent.type];
    const now = params.now ?? new Date();
    const serverId = await getOrCreateServerIdentityId(process.env);
    const accounts = await db.account.findMany({
        where: { id: { in: candidates } },
        select: { id: true, settingsVersion: true, remoteAlertPolicy: true },
    });
    const candidateSet = new Set(candidates);
    const tokens = narrowed.devices
        ? narrowed.devices.filter(device => candidateSet.has(device.accountId))
        : await readDevices(candidates);

    const deliveries: AccountPushDelivery[] = [];
    const alerted = new Set<string>();
    const alertedTokens = new Set<string>();
    const mutedTokens = new Set<string>();
    for (const account of accounts) {
        // An absent or stale projection means the recipient's current policy is
        // unknown here, so this leg stays unavailable rather than guessing.
        const currentness = resolveAccountRemoteAlertPolicyCurrentness(account.remoteAlertPolicy, account.settingsVersion);
        if (currentness.status !== "current") continue;
        const muteMobileAlerts = currentness.policy.mutePhoneWhenComputerFocused === true
            && shouldMuteMobileAlertsForComputerFocus({
                mutePhoneWhenComputerFocused: currentness.policy.mutePhoneWhenComputerFocused,
                computerFocused: await eventRouter.hasFocusedComputerUi(account.id),
            });
        for (const token of tokens.filter((row) => row.accountId === account.id)) {
            if (muteMobileAlerts) {
                mutedTokens.add(token.token);
                continue;
            }
            const decision = resolveRemoteAlertPolicyDecision({
                accountPolicy: currentness.policy,
                devicePolicy: token.remoteAlerts,
                event: policyEvent,
                now,
                follow: followByAccountId.get(account.id),
                inboxItemType: params.event === 'discussion_mention' ? 'mention'
                    : params.event === 'source_unavailable' ? 'update' : undefined,
            });
            if (!decision || decision.delivery === "suppress") continue;
            const soundId = resolveAttentionPushSoundId(decision);
            const sound = resolveExpoNotificationSoundName(soundId);
            const data = ActivityRemoteAlertV2Schema.parse({
                type: "activity_alert", v: 2,
                serverId, sessionId: params.sessionId, accountId: account.id,
                event: alertEvent,
                previewBehavior: decision.previewBehavior,
            });
            deliveries.push({
                accountId: account.id,
                token: token.token,
                message: {
                    to: token.token,
                    title: "Happier",
                    body: resolveRemoteAlertFallbackBody(alertEvent, params.assignmentAutoFollowed),
                    ...(sound === null ? {} : { sound }),
                    channelId: resolvePushNotificationAndroidChannelId({
                        kind: resolvePushNotificationAndroidChannelKind(policyEvent),
                        soundId,
                    }),
                    priority: decision.delivery === "silent" ? "normal" : "high",
                    mutableContent: true,
                    data,
                },
            });
            alerted.add(account.id);
            alertedTokens.add(token.token);
        }
    }

    // Every eligible recipient device this leg did not alert gets the
    // content-free wake instead, so exactly one leg is responsible for each
    // device and this event. A device the Home could not decide for — no
    // published projection, a stale one, or a policy that declined an OS-visible
    // alert — still reaches its own Activity policy and content builder locally
    // after synchronizing this exact Home.
    const wakeData = SessionChangedWakeV1Schema.parse({
        type: SESSION_CHANGED_WAKE_TYPE,
        serverId,
        sessionId: params.sessionId,
    });
    for (const token of tokens) {
        if (alertedTokens.has(token.token)) continue;
        deliveries.push({
            accountId: token.accountId,
            token: token.token,
            message: {
                to: token.token,
                priority: "normal",
                // A background notification with no alert content: iOS treats it as
                // `content-available`, which the OS may throttle, delay or discard
                // and never delivers to a user-terminated app, and Android receives
                // it as a plain data message. It is best effort by platform
                // contract and never renders anything by itself.
                _contentAvailable: true,
                data: mutedTokens.has(token.token) ? { ...wakeData, alert: 'muted' } : wakeData,
            },
        });
    }

    if (deliveries.length === 0) return [];
    // All asynchronous recipient/policy/device preparation precedes this final
    // original-source check. Recovery/replacement/archive withdraws the effect.
    if (params.stalledOccurrence && !await isSessionPersonalStalledOccurrenceCurrent(params)) return [];
    await sendAccountExpoPushMessages(deliveries, "activity-remote-alerts");
    return [...alerted];
}

/**
 * The alert categories the rich owner sender can actually deliver.
 *
 * Released publishers omitted sender composition and handled only ready and
 * request alerts. Current explicitly reported rich publishers additionally
 * deliver committed failure/cancellation and message originals through the
 * source daemon's personal Follow adapter. Authenticated Account human writes
 * remain Home-owned: their socket/HTTP ingress has no runtime sender custody.
 */
const RICH_OWNER_SENDER_ALERT_EVENTS: ReadonlySet<ActivityRemoteAlertEventV2["type"]> = new Set([
    "ready",
    "permission_request",
    "user_action_request",
]);
const REPORTED_RICH_OWNER_SEMANTIC_ALERT_EVENTS: ReadonlySet<ActivityRemoteAlertEventV2["type"]> = new Set([
    "failed",
    "cancelled",
    "message",
]);

async function resolveRichOwnerSenderResponsibility(params: Readonly<{
    sessionId: string;
    sessionOwnerAccountId: string;
    alertEventType: ActivityRemoteAlertEventV2["type"];
    runtimeComposition?: SubmitSessionActivityRemoteAlertsParams["runtimeComposition"];
}>): Promise<boolean> {
    const composition = params.runtimeComposition;
    if (!composition || composition.ownerActivityDelivery !== "rich_sender") return false;
    if (!RICH_OWNER_SENDER_ALERT_EVENTS.has(params.alertEventType)
        && !(composition.ownerActivityDeliveryWasReported === true
            && REPORTED_RICH_OWNER_SEMANTIC_ALERT_EVENTS.has(params.alertEventType))) return false;
    const authority = composition.publisherAuthority;
    if (authority.sessionId !== params.sessionId || authority.accountId !== params.sessionOwnerAccountId) return false;
    return await inTx(async (tx) => {
        if (!await hasExactCurrentPublisherAuthorityInTx(
            tx,
            authority,
            params.sessionOwnerAccountId,
            params.sessionId,
        )) return false;
        const machine = await tx.machine.findUnique({
            where: { id: authority.machineId },
            select: { kind: true },
        });
        return machine?.kind === "persistent";
    });
}

/** Fire-and-forget wrapper for committed mutation owners that must not await transport. */
export function scheduleSessionActivityRemoteAlerts(params: SubmitSessionActivityRemoteAlertsParams): void {
    void submitSessionActivityRemoteAlerts(params).catch((error) => {
        log({ module: "activity-remote-alerts", level: "warn" }, "failed to submit session remote alerts", error);
    });
}
