export type PendingMessageRow = {
    localId: string;
    content: PrismaJson.SessionPendingMessageContent;
    status: "queued" | "discarded";
    position: number;
    createdAt: Date;
    updatedAt: Date;
    discardedAt: Date | null;
    discardedReason: string | null;
    authorAccountId: string | null;
};

export type PendingMessageRowRaw = {
    localId: string;
    content: PrismaJson.SessionPendingMessageContent;
    status: "queued" | "discarded";
    position: number;
    createdAt: Date;
    updatedAt: Date;
    discardedAt: Date | null;
    discardedReason: string | null;
    authorAccountId: string | null;
};

export function mapPendingMessageRow(row: PendingMessageRowRaw): PendingMessageRow {
    return {
        localId: row.localId,
        content: row.content,
        status: row.status,
        position: row.position,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        discardedAt: row.discardedAt,
        discardedReason: row.discardedReason,
        authorAccountId: row.authorAccountId,
    };
}
