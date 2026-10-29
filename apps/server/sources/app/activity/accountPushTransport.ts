import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import { collectExpoPushTokensMarkedUnregistered, getExpoErrorCode } from '@happier-dev/protocol/push/expoPushDelivery';

import { db } from "@/storage/db";
import { log } from "@/utils/logging/log";

const expo = new Expo();

export type AccountPushSendResult = Readonly<{ acceptedCount: number; failedCount: number; invalidCredentials: boolean }>;

export type AccountPushDelivery = Readonly<{
    accountId: string;
    token: string;
    message: ExpoPushMessage;
}>;

async function deleteInvalidAccountPushTokens(deliveries: ReadonlyArray<AccountPushDelivery>): Promise<void> {
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

/**
 * The one Account push transport: chunking, ticket inspection, and invalid-token
 * cleanup for every Account-addressed Expo message this Home submits.
 *
 * Badge refresh and the remote-alert leg differ only in payload; a second copy
 * of this loop would let their token cleanup and chunking drift apart.
 */
export async function sendAccountExpoPushMessages(
    deliveries: ReadonlyArray<AccountPushDelivery>,
    logModule: string,
): Promise<AccountPushSendResult> {
    let acceptedCount = 0;
    let invalidCredentials = false;
    const validDeliveries = deliveries.filter((delivery) => Expo.isExpoPushToken(delivery.message.to));

    const invalidDeliveries = new Map<string, AccountPushDelivery>();
    let deliveryOffset = 0;

    for (const chunk of expo.chunkPushNotifications(validDeliveries.map((delivery) => delivery.message))) {
        const chunkDeliveries = validDeliveries.slice(deliveryOffset, deliveryOffset + chunk.length);
        deliveryOffset += chunk.length;
        try {
            const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
            acceptedCount += ticketChunk.slice(0, chunk.length).filter(ticket => ticket.status === 'ok').length;
            invalidCredentials ||= ticketChunk.some(ticket => getExpoErrorCode(ticket) === 'InvalidCredentials');
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
            log({ module: logModule, level: "warn" }, "failed to send Expo push chunk", error);
        }
    }

    await deleteInvalidAccountPushTokens([...invalidDeliveries.values()]);
    const failedCount = deliveries.length - acceptedCount;
    if (failedCount > 0) log({ module: logModule, level: 'warn', acceptedCount, failedCount }, 'Expo push service acceptance was not confirmed for every recipient');
    return { acceptedCount, failedCount, invalidCredentials };
}
