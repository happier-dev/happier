import { db } from "@/storage/db";
import { log } from "@/utils/logging/log";

import { listSessionBadgeRefreshPushAccountIds } from "@/app/session/personal/backgroundDelivery";

import { sendAccountExpoPushMessages, type AccountPushDelivery } from "./accountPushTransport";
import { computeAccountActivityBadgeCounts } from "./accountActivityBadge";

const BADGE_REFRESH_COALESCE_MS = 25;

/**
 * Home owns remote badge updates. Remember the last count Expo accepted per
 * registration so unchanged attention doesn't resend it. Failed sends remain
 * eligible on the next refresh. This memory belongs to this Home process.
 */
const badgeDeliveryByDevice = new Map<string, {
    acceptedBadge?: number;
    inFlight: number;
    overlapped: boolean;
}>();

function badgeDeviceKey(accountId: string, token: string): string {
    return `${accountId}\u0000${token}`;
}
const pendingBadgeRefreshAccountIds = new Set<string>();
let pendingBadgeRefreshTimer: NodeJS.Timeout | null = null;

function scheduleCoalescedBadgeRefresh(accountIds: ReadonlyArray<string>): void {
    for (const accountId of accountIds) {
        if (typeof accountId === "string" && accountId.trim().length > 0) {
            pendingBadgeRefreshAccountIds.add(accountId);
        }
    }
    if (pendingBadgeRefreshAccountIds.size === 0 || pendingBadgeRefreshTimer !== null) return;
    pendingBadgeRefreshTimer = setTimeout(() => {
        pendingBadgeRefreshTimer = null;
        const accountIdsToRefresh = [...pendingBadgeRefreshAccountIds];
        pendingBadgeRefreshAccountIds.clear();
        void refreshAccountActivityBadgePushes({ accountIds: accountIdsToRefresh }).catch((error) => {
            log({ module: "activity-badges", level: "warn" }, "failed to refresh coalesced badge pushes", error);
        });
    }, BADGE_REFRESH_COALESCE_MS);
}

export async function refreshAccountActivityBadgePushes(params: Readonly<{ accountIds: ReadonlyArray<string> }>): Promise<void> {
    const accountIds = [...new Set(params.accountIds.filter((accountId) => typeof accountId === "string" && accountId.trim().length > 0))];
    if (accountIds.length === 0) return;

    const pushTokens = await db.accountPushToken.findMany({
        where: { accountId: { in: accountIds } },
        select: { accountId: true, token: true },
    });
    if (pushTokens.length === 0) return;

    const badgeCounts = await computeAccountActivityBadgeCounts(accountIds);

    const attempts = pushTokens.flatMap((pushToken) => {
        const badge = badgeCounts.get(pushToken.accountId) ?? 0;
        const key = badgeDeviceKey(pushToken.accountId, pushToken.token);
        const registration = badgeDeliveryByDevice.get(key) ?? { inFlight: 0, overlapped: false };
        if (registration.acceptedBadge === badge) return [];
        delete registration.acceptedBadge;
        if (registration.inFlight > 0) registration.overlapped = true;
        registration.inFlight += 1;
        badgeDeliveryByDevice.set(key, registration);
        const delivery: AccountPushDelivery = {
            accountId: pushToken.accountId,
            token: pushToken.token,
            message: {
                to: pushToken.token,
                badge,
                data: { type: "badge_refresh" },
            },
        };
        return [{ delivery, key, registration, badge }];
    });
    if (attempts.length === 0) return;

    let accepted: ReadonlySet<AccountPushDelivery> | undefined;
    try {
        ({ accepted } = await sendAccountExpoPushMessages(attempts.map(({ delivery }) => delivery), "activity-badges"));
    } finally {
        for (const { delivery, key, registration, badge } of attempts) {
            if (badgeDeliveryByDevice.get(key) !== registration) continue;
            registration.inFlight -= 1;
            if (registration.inFlight > 0) continue;
            // Overlapping sends can be accepted out of order. Let the next refresh send again.
            if (!registration.overlapped && accepted?.has(delivery)) registration.acceptedBadge = badge;
            else badgeDeliveryByDevice.delete(key);
        }
    }
}

export function resetAccountActivityBadgeDeliveryMemoryForTests(): void {
    badgeDeliveryByDevice.clear();
}

/** A (re-)registered device starts from an unknown badge, so its next refresh always sends. */
export function forgetAccountActivityBadgeDevice(accountId: string, token: string): void {
    badgeDeliveryByDevice.delete(badgeDeviceKey(accountId, token));
}

/**
 * Schedules the existing coalesced badge refresh for an exact Account set.
 * Recipient selection belongs to the personal candidate owner; this function
 * only batches and transports.
 */
export function scheduleAccountActivityBadgeRefresh(params: Readonly<{
    badgeAttentionChanged: boolean;
    accountIds: ReadonlyArray<string>;
}>): void {
    if (!params.badgeAttentionChanged) return;
    scheduleCoalescedBadgeRefresh(params.accountIds);
}

/**
 * The Session-scoped replacement for the removed projection-recipient helper.
 * Badge refresh follows the exact owner-or-active-Follow tracking relation
 * rather than every Account that can read the Session, so broad Team access can
 * no longer become badge fanout (L09B-R6), and the personal owner admits those
 * recipients through the one background-delivery decision — the push's arrival
 * says this Session changed, so an unqualified restricted-Team follower is not
 * a recipient at all rather than a recipient of a withheld count.
 */
export async function refreshTrackedSessionAccountBadgePushes(params: Readonly<{
    badgeAttentionChanged: boolean;
    sessionId: string;
}>): Promise<void> {
    if (!params.badgeAttentionChanged) return;
    const accountIds = await listSessionBadgeRefreshPushAccountIds(params.sessionId);
    scheduleCoalescedBadgeRefresh(accountIds);
}
