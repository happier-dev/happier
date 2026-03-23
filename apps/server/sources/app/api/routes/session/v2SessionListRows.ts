import type { Prisma } from "@prisma/client";
import type { V2SessionRecord } from "@happier-dev/protocol";

function encodeSessionDataEncryptionKey(value: Uint8Array | null): string | null {
    return value ? Buffer.from(value).toString("base64") : null;
}

const V2_SESSION_LIST_SHARE_SELECT = {
    encryptedDataKey: true,
    accessLevel: true,
    canApprovePermissions: true,
} as const satisfies Prisma.SessionShareSelect;

const V2_SESSION_LIST_ROW_BASE_SELECT = {
    id: true,
    seq: true,
    accountId: true,
    createdAt: true,
    updatedAt: true,
    archivedAt: true,
    encryptionMode: true,
    metadata: true,
    metadataVersion: true,
    agentState: true,
    agentStateVersion: true,
    lastViewedSessionSeq: true,
    pendingPermissionRequestCount: true,
    pendingUserActionRequestCount: true,
    pendingCount: true,
    pendingVersion: true,
    dataEncryptionKey: true,
    active: true,
    lastActiveAt: true,
    shares: {
        select: V2_SESSION_LIST_SHARE_SELECT,
    },
} as const satisfies Prisma.SessionSelect;

export type V2SessionListRow = Prisma.SessionGetPayload<{
    select: typeof V2_SESSION_LIST_ROW_BASE_SELECT;
}>;

export function createV2SessionListVisibilityWhere(params: Readonly<{ userId: string }>): Prisma.SessionWhereInput {
    return {
        OR: [
            { accountId: params.userId },
            { shares: { some: { sharedWithUserId: params.userId } } },
        ],
    };
}

export function createV2SessionListRowSelect(params: Readonly<{ userId: string }>) {
    return {
        ...V2_SESSION_LIST_ROW_BASE_SELECT,
        shares: {
            where: { sharedWithUserId: params.userId },
            select: V2_SESSION_LIST_SHARE_SELECT,
        },
    } as const satisfies Prisma.SessionSelect;
}

export function mapV2SessionListRow(params: Readonly<{ row: V2SessionListRow; userId: string }>): V2SessionRecord {
    const { row, userId } = params;
    const viewerShare = row.shares[0] ?? null;
    const isOwner = row.accountId === userId;

    return {
        id: row.id,
        seq: row.seq,
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
        active: row.active,
        activeAt: row.lastActiveAt.getTime(),
        archivedAt: row.archivedAt?.getTime() ?? null,
        encryptionMode: row.encryptionMode === "plain" ? "plain" : "e2ee",
        metadata: row.metadata,
        metadataVersion: row.metadataVersion,
        agentState: row.agentState,
        agentStateVersion: row.agentStateVersion,
        lastViewedSessionSeq: row.lastViewedSessionSeq ?? null,
        pendingPermissionRequestCount: row.pendingPermissionRequestCount,
        pendingUserActionRequestCount: row.pendingUserActionRequestCount,
        pendingCount: row.pendingCount,
        pendingVersion: row.pendingVersion,
        dataEncryptionKey: isOwner
            ? encodeSessionDataEncryptionKey(row.dataEncryptionKey)
            : (viewerShare?.encryptedDataKey ? Buffer.from(viewerShare.encryptedDataKey).toString("base64") : null),
        share: isOwner
            ? null
            : (viewerShare
                ? {
                    accessLevel: viewerShare.accessLevel,
                    canApprovePermissions: viewerShare.canApprovePermissions,
                }
                : null),
    };
}

export { encodeSessionDataEncryptionKey };
