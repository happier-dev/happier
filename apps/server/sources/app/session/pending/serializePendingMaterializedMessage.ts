import type { MaterializeNextPendingMessageResult } from "@/app/session/pending/materializeNextPendingMessage";

type MaterializedPendingMessage = Extract<
    MaterializeNextPendingMessageResult,
    { ok: true; didMaterialize: true }
>["message"];

export function serializePendingMaterializedMessage(message: MaterializedPendingMessage) {
    return {
        id: message.id,
        seq: message.seq,
        localId: message.localId,
        ...(typeof message.messageRole === "string" ? { messageRole: message.messageRole } : {}),
        content: message.content,
        createdAt: message.createdAt.getTime(),
        updatedAt: message.updatedAt.getTime(),
    };
}
