import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import { collectExpoPushTokensMarkedUnregistered } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { log } from "@/utils/logging/log";

import { computeAccountActivityBadgeCounts } from "./accountActivityBadge";

const expo = new Expo();
const BADGE_REFRESH_COALESCE_MS = 25;
const pendingBadgeRefreshAccountIds = new Set<string>();
let pendingBadgeRefreshTimer: NodeJS.Timeout | null = null;

type BadgeRefreshDelivery = Readonly<{
    accountId: string;
    token: string;
    message: ExpoPushMessage;
}>;

async function deleteInvalidAccountPushTokens(deliveries: ReadonlyArray<BadgeRefreshDelivery>): Promise<void> {
    if (deliveries.length === 0) return;
    await db.accountPushToken.deleteMany({
        where: {
            OR: deliveries.map((delivery) => ({
                accountId: delivery.accountId,
                token: delivery.token,
            })),
        },
    });
}

async function sendExpoBadgeRefreshMessages(deliveries: ReadonlyArray<BadgeRefreshDelivery>): Promise<void> {
    const validDeliveries = deliveries.filter((delivery) => Expo.isExpoPushToken(delivery.message.to));
    if (validDeliveries.length === 0) return;
    const invalidDeliveries = new Map<string, BadgeRefreshDelivery>();
    let deliveryOffset = 0;

    for (const chunk of expo.chunkPushNotifications(validDeliveries.map((delivery) => delivery.message))) {
        const chunkDeliveries = validDeliveries.slice(deliveryOffset, deliveryOffset + chunk.length);
        deliveryOffset += chunk.length;
        try {
            const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
            const invalidTokens = new Set(
                collectExpoPushTokensMarkedUnregistered({
                    messages: chunk,
                    tickets: ticketChunk,
                }),
            );
            if (invalidTokens.size > 0) {
                for (const delivery of chunkDeliveries) {
                    if (!invalidTokens.has(delivery.token)) continue;
                    invalidDeliveries.set(`${delivery.accountId}:${delivery.token}`, delivery);
                }
            }
        } catch (error) {
            log({ module: "activity-badges", level: "warn" }, "failed to send Expo badge refresh chunk", error);
        }
    }

    await deleteInvalidAccountPushTokens([...invalidDeliveries.values()]);
}

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

    const deliveries: BadgeRefreshDelivery[] = [];
    for (const pushToken of pushTokens) {
        deliveries.push({
            accountId: pushToken.accountId,
            token: pushToken.token,
            message: {
                to: pushToken.token,
                badge: badgeCounts.get(pushToken.accountId) ?? 0,
                data: { type: "badge_refresh" },
            },
        });
    }

    await sendExpoBadgeRefreshMessages(deliveries);
}

export async function refreshSessionParticipantBadgePushes(params: Readonly<{
    badgeAttentionChanged: boolean;
    participantCursors: ReadonlyArray<{ accountId: string }>;
}>): Promise<void> {
    if (!params.badgeAttentionChanged) return;
    scheduleCoalescedBadgeRefresh(params.participantCursors.map(({ accountId }) => accountId));
}
