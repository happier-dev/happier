import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import { collectExpoPushTokensMarkedUnregistered } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { log } from "@/utils/logging/log";

import { computeAccountActivityBadgeCounts } from "./accountActivityBadge";

const expo = new Expo();

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
            let receipts: Record<string, unknown> | undefined;
            const receiptIds = ticketChunk
                .map((ticket) => (typeof (ticket as { id?: unknown })?.id === "string" ? (ticket as { id: string }).id : null))
                .filter((ticketId): ticketId is string => typeof ticketId === "string" && ticketId.length > 0);

            if (receiptIds.length > 0) {
                try {
                    receipts = await expo.getPushNotificationReceiptsAsync(receiptIds);
                } catch (error) {
                    log({ module: "activity-badges", level: "warn" }, "failed to fetch Expo push receipts", error);
                }
            }

            const invalidTokens = new Set(
                collectExpoPushTokensMarkedUnregistered({
                    messages: chunk,
                    tickets: ticketChunk,
                    receipts,
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

export async function refreshAccountActivityBadgePushes(params: Readonly<{ accountIds: ReadonlyArray<string> }>): Promise<void> {
    const accountIds = [...new Set(params.accountIds.filter((accountId) => typeof accountId === "string" && accountId.trim().length > 0))];
    if (accountIds.length === 0) return;

    const [badgeCounts, pushTokens] = await Promise.all([
        computeAccountActivityBadgeCounts(accountIds),
        db.accountPushToken.findMany({
            where: { accountId: { in: accountIds } },
            select: { accountId: true, token: true },
        }),
    ]);

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
    await refreshAccountActivityBadgePushes({
        accountIds: params.participantCursors.map(({ accountId }) => accountId),
    });
}
