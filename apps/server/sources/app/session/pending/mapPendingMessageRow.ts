import { parseSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import {
    normalizePendingDeliveryStatusV1,
    PendingRequestedActionV1Schema,
    type PendingDeliveryStatusV1,
    type PendingRequestedActionV1,
} from "@happier-dev/protocol";

export type PendingMessageRow = {
    localId: string;
    messageRole: import("@happier-dev/protocol").SessionMessageRole | null;
    content: PrismaJson.SessionPendingMessageContent;
    requestedAction?: PendingRequestedActionV1;
    requestedActionMalformed?: true;
    status: "queued" | "discarded";
    deliveryState: string | null;
    deliveryBlockedReason: string | null;
    deliveryStatus: PendingDeliveryStatusV1;
    position: number;
    createdAt: Date;
    updatedAt: Date;
    discardedAt: Date | null;
    discardedReason: string | null;
    authorAccountId: string | null;
};

export type PendingMessageRowRaw = {
    localId: string;
    messageRole?: unknown;
    content: PrismaJson.SessionPendingMessageContent;
    requestedAction?: unknown;
    status: "queued" | "discarded";
    deliveryState?: string | null;
    deliveryBlockedReason?: string | null;
    position: number;
    createdAt: Date;
    updatedAt: Date;
    discardedAt: Date | null;
    discardedReason: string | null;
    authorAccountId: string | null;
};

export function mapPendingMessageRow(row: PendingMessageRowRaw): PendingMessageRow {
    const parsedRequestedAction = row.requestedAction == null
        ? PendingRequestedActionV1Schema.safeParse({ v: 1, kind: "enqueue" })
        : PendingRequestedActionV1Schema.safeParse(row.requestedAction);
    const requestedActionMalformed = !parsedRequestedAction.success;
    const deliveryState = typeof row.deliveryState === "string" && row.deliveryState.length > 0 ? row.deliveryState : null;
    const deliveryBlockedReason =
        typeof row.deliveryBlockedReason === "string" && row.deliveryBlockedReason.length > 0 ? row.deliveryBlockedReason : null;
    return {
        localId: row.localId,
        messageRole: parseSessionMessageRole(row.messageRole),
        content: row.content,
        ...(parsedRequestedAction.success ? { requestedAction: parsedRequestedAction.data } : {}),
        ...(requestedActionMalformed ? { requestedActionMalformed: true as const } : {}),
        status: row.status,
        deliveryState,
        deliveryBlockedReason,
        deliveryStatus: requestedActionMalformed && row.status !== "discarded"
            ? { status: "blocked", reason: "unsupported_action" }
            : normalizePendingDeliveryStatusV1({
                status: row.status,
                deliveryState,
                deliveryBlockedReason,
                discardedReason: row.discardedReason,
            }),
        position: row.position,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        discardedAt: row.discardedAt,
        discardedReason: row.discardedReason,
        authorAccountId: row.authorAccountId,
    };
}
