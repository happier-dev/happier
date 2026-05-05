import { Expo } from "expo-server-sdk";

import {
    LIVE_ACTIVITY_CONTENT_STATE_MAX_BYTES,
    type LiveActivityRemoteUpdateRequestV1,
} from "@happier-dev/protocol";

export type SendExpoBackgroundWakeLiveActivityUpdateParams = Readonly<{
    expoPushToken: string;
    request: LiveActivityRemoteUpdateRequestV1;
}>;

export type ExpoBackgroundWakeLiveActivityDeliveryResult = Readonly<
    | { status: "sent_best_effort" }
    | { status: "failed"; reason: string }
>;

type ExpoPushTicket = Readonly<{
    status?: unknown;
}>;

function countJsonBytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function buildExpoBackgroundWakeMessage(params: SendExpoBackgroundWakeLiveActivityUpdateParams) {
    return {
        to: params.expoPushToken,
        _contentAvailable: true,
        data: {
            type: "happier.liveActivityRemoteUpdate.v1",
            v: params.request.v,
            requestId: params.request.requestId,
            createdAt: params.request.createdAt,
            event: params.request.event,
            activityKey: params.request.activityKey,
            snapshotFingerprint: params.request.snapshotFingerprint,
            contentState: params.request.contentState ?? null,
        },
    };
}

function hasExpoTicketError(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    return (value as ExpoPushTicket).status === "error";
}

export async function sendExpoBackgroundWakeLiveActivityUpdate(
    params: SendExpoBackgroundWakeLiveActivityUpdateParams,
): Promise<ExpoBackgroundWakeLiveActivityDeliveryResult> {
    if (!Expo.isExpoPushToken(params.expoPushToken)) {
        return { status: "failed", reason: "invalid_expo_push_token" };
    }

    const expo = new Expo();
    const message = buildExpoBackgroundWakeMessage(params);
    if (countJsonBytes(message) > LIVE_ACTIVITY_CONTENT_STATE_MAX_BYTES) {
        return { status: "failed", reason: "expo_background_wake_payload_too_large" };
    }

    try {
        for (const chunk of expo.chunkPushNotifications([message])) {
            const tickets = await expo.sendPushNotificationsAsync(chunk);
            if (tickets.some(hasExpoTicketError)) {
                return { status: "failed", reason: "expo_background_wake_ticket_error" };
            }
        }
    } catch {
        return { status: "failed", reason: "expo_background_wake_transport_error" };
    }
    return { status: "sent_best_effort" };
}
