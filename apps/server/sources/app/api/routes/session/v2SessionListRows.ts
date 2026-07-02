import type { Prisma } from "@prisma/client";
import {
    PrimaryTurnStatusV1Schema,
    SessionRuntimeIssueV1Schema,
    type V2SessionRecord,
} from "@happier-dev/protocol";

import { resolveSessionRollbackEligibleTurnRelationLimit } from "./v2SessionHotReadLimits";

export function createSessionRollbackEligibleTurnsSelect(
    params: Readonly<{ limit?: number }> = {},
): Prisma.Session$turnsArgs {
    return {
        where: { rollbackState: "eligible" },
        orderBy: [
            { updatedAt: "desc" },
            { createdAt: "desc" },
            { id: "desc" },
        ],
        take: params.limit ?? resolveSessionRollbackEligibleTurnRelationLimit(),
        select: {
            transcriptAnchorsJson: true,
            rollbackState: true,
        },
    };
}

function encodeSessionDataEncryptionKey(value: Uint8Array | null): string | null {
    return value ? Buffer.from(value).toString("base64") : null;
}

export function parseStoredSessionRuntimeIssue(value: string | null | undefined): V2SessionRecord["lastRuntimeIssue"] {
    if (typeof value !== "string" || value.trim().length === 0) return null;
    try {
        const parsed = SessionRuntimeIssueV1Schema.safeParse(JSON.parse(value));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

export function parseStoredSessionLatestTurnStatus(value: string | null | undefined): V2SessionRecord["latestTurnStatus"] {
    const parsed = PrimaryTurnStatusV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function isTerminalTurnStatus(status: V2SessionRecord["latestTurnStatus"]): boolean {
    return status === "completed" || status === "cancelled" || status === "failed";
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
    meaningfulActivityAt: true,
    archivedAt: true,
    encryptionMode: true,
    metadata: true,
    metadataVersion: true,
    agentState: true,
    agentStateVersion: true,
    lastViewedSessionSeq: true,
    pendingPermissionRequestCount: true,
    pendingUserActionRequestCount: true,
    pendingRequestObservedAt: true,
    latestTurnId: true,
    latestTurnStatus: true,
    latestTurnStatusObservedAt: true,
    lastRuntimeIssue: true,
    latestReadyEventSeq: true,
    latestReadyEventAt: true,
    turns: createSessionRollbackEligibleTurnsSelect(),
    thinking: true,
    thinkingAt: true,
    pendingCount: true,
    pendingVersion: true,
    dataEncryptionKey: true,
    active: true,
    lastActiveAt: true,
    shares: {
        select: V2_SESSION_LIST_SHARE_SELECT,
    },
} as const satisfies Prisma.SessionSelect;

const {
    pendingRequestObservedAt: _legacySelectPendingRequestObservedAt,
    latestTurnId: _legacySelectLatestTurnId,
    latestTurnStatusObservedAt: _legacySelectLatestTurnStatusObservedAt,
    turns: _legacySelectTurns,
    latestReadyEventSeq: _legacySelectLatestReadyEventSeq,
    latestReadyEventAt: _legacySelectLatestReadyEventAt,
    thinking: _legacySelectThinking,
    thinkingAt: _legacySelectThinkingAt,
    ...V2_SESSION_LIST_ROW_LEGACY_SELECT
} = V2_SESSION_LIST_ROW_BASE_SELECT;

export type V2SessionListRow = Prisma.SessionGetPayload<{
    select: typeof V2_SESSION_LIST_ROW_BASE_SELECT;
}>;

export type V2SessionListLegacyRow = Prisma.SessionGetPayload<{
    select: typeof V2_SESSION_LIST_ROW_LEGACY_SELECT;
}>;

export type V2SessionListRowCompat = V2SessionListRow | V2SessionListLegacyRow;

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

export function createV2SessionListLegacyRowSelect(params: Readonly<{ userId: string }>) {
    return {
        ...V2_SESSION_LIST_ROW_LEGACY_SELECT,
        shares: {
            where: { sharedWithUserId: params.userId },
            select: V2_SESSION_LIST_SHARE_SELECT,
        },
    } as const satisfies Prisma.SessionSelect;
}

export function getV2SessionListEffectiveActivityAt(row: Pick<V2SessionListRowCompat, "createdAt" | "meaningfulActivityAt">): Date {
    return row.meaningfulActivityAt ?? row.createdAt;
}

function readNullableDateField(row: V2SessionListRowCompat, field: string): Date | null {
    const value = (row as Record<string, unknown>)[field];
    return value instanceof Date ? value : null;
}

function readNullableNumberField(row: V2SessionListRowCompat, field: string): number | null {
    const value = (row as Record<string, unknown>)[field];
    return typeof value === "number" ? value : null;
}

function readNullableStringField(row: V2SessionListRowCompat, field: string): string | null {
    const value = (row as Record<string, unknown>)[field];
    return typeof value === "string" && value.length > 0 ? value : null;
}

function readNullableTimestampField(row: V2SessionListRowCompat, field: string): number | null {
    const value = (row as Record<string, unknown>)[field];
    if (typeof value === "bigint") return Number(value);
    return typeof value === "number" ? value : null;
}

export function readSessionTurnRollbackEligibleStarts(row: unknown): number[] {
    const turns = (row as { turns?: readonly { transcriptAnchorsJson?: string | null; rollbackState?: string | null }[] }).turns ?? [];
    const starts = new Set<number>();
    for (const turn of turns) {
        if (turn.rollbackState !== "eligible") continue;
        if (typeof turn.transcriptAnchorsJson !== "string" || turn.transcriptAnchorsJson.trim().length === 0) continue;
        try {
            const parsed = JSON.parse(turn.transcriptAnchorsJson) as { startUserMessageSeq?: unknown };
            const startUserMessageSeq = parsed.startUserMessageSeq;
            if (typeof startUserMessageSeq !== "number" || !Number.isFinite(startUserMessageSeq) || startUserMessageSeq < 0) continue;
            starts.add(Math.trunc(startUserMessageSeq));
        } catch {
            continue;
        }
    }
    return [...starts].sort((a, b) => a - b);
}

function readBooleanField(row: V2SessionListRowCompat, field: string): boolean {
    return (row as Record<string, unknown>)[field] === true;
}

export function mapV2SessionListRow(params: Readonly<{ row: V2SessionListRowCompat; userId: string }>): V2SessionRecord {
    const { row, userId } = params;
    const viewerShare = row.shares[0] ?? null;
    const isOwner = row.accountId === userId;
    const pendingRequestObservedAt = readNullableDateField(row, "pendingRequestObservedAt");
    const latestReadyEventAt = readNullableDateField(row, "latestReadyEventAt");
    const rawThinkingAt = readNullableDateField(row, "thinkingAt")?.getTime() ?? null;
    const latestTurnStatus = parseStoredSessionLatestTurnStatus(row.latestTurnStatus);
    const latestTurnStatusObservedAt = readNullableTimestampField(row, "latestTurnStatusObservedAt");
    const thinking = isTerminalTurnStatus(latestTurnStatus) ? false : readBooleanField(row, "thinking");
    const thinkingAt = isTerminalTurnStatus(latestTurnStatus)
        ? (latestTurnStatusObservedAt ?? rawThinkingAt)
        : rawThinkingAt;

    return {
        id: row.id,
        seq: row.seq,
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
        meaningfulActivityAt: getV2SessionListEffectiveActivityAt(row).getTime(),
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
        pendingRequestObservedAt: pendingRequestObservedAt?.getTime() ?? null,
        latestTurnId: readNullableStringField(row, "latestTurnId"),
        latestTurnStatus,
        latestTurnStatusObservedAt,
        lastRuntimeIssue: parseStoredSessionRuntimeIssue(row.lastRuntimeIssue),
        rollbackEligibleTurnStarts: readSessionTurnRollbackEligibleStarts(row),
        latestReadyEventSeq: readNullableNumberField(row, "latestReadyEventSeq"),
        latestReadyEventAt: latestReadyEventAt?.getTime() ?? null,
        thinking,
        thinkingAt,
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
