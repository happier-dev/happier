import type { Prisma } from "@prisma/client";
import {
    PrimaryTurnStatusV1Schema,
    SessionRuntimeIssueV1Schema,
    type V2SessionRecord,
} from "@happier-dev/protocol";
import { normalizeStoredSessionRuntimeActivityProjection } from "@/app/session/runtimeActivity/projection";
import { mapPendingActivationAuthorization } from "@/app/session/pending/pendingActivationAuthorization";

export function parseStoredSessionRuntimeIssue(value: string | null | undefined): V2SessionRecord["lastRuntimeIssue"] {
    if (!value) return null;
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
    meaningfulActivityAt: true,
    archivedAt: true,
    encryptionMode: true,
    metadata: true,
    metadataVersion: true,
    agentState: true,
    agentStateVersion: true,
    lastViewedSessionSeq: true,
    unreadSince: true,
    // Selected, not mapped: no client reads it. It is here so that adding the column to the attention
    // predicate registers it with `SESSION_LIST_PROJECTION_FALLBACK_COLUMNS` below — a binary running
    // ahead of `prisma migrate deploy` must fall back to the legacy projection *and* the derived
    // attention predicate rather than failing the read outright.
    needsAttention: true,
    pendingPermissionRequestCount: true,
    pendingUserActionRequestCount: true,
    pendingRequestObservedAt: true,
    latestReadyEventSeq: true,
    latestReadyEventAt: true,
    thinking: true,
    thinkingAt: true,
    latestTurnId: true,
    latestTurnStatus: true,
    latestTurnStatusObservedAt: true,
    lastRuntimeIssue: true,
    runtimeActivityState: true,
    runtimeActivityRevision: true,
    runtimeActivityActiveCount: true,
    runtimeActivityObservedAt: true,
    pendingCount: true,
    pendingBlockedCount: true,
    pendingVersion: true,
    pendingActivationRequestId: true,
    pendingActivationRequestedAt: true,
    pendingActivationStatus: true,
    pendingActivationFailureCode: true,
    dataEncryptionKey: true,
    active: true,
    lastActiveAt: true,
    shares: {
        select: V2_SESSION_LIST_SHARE_SELECT,
    },
} as const satisfies Prisma.SessionSelect;

const {
    pendingRequestObservedAt: _legacySelectPendingRequestObservedAt,
    latestReadyEventSeq: _legacySelectLatestReadyEventSeq,
    latestReadyEventAt: _legacySelectLatestReadyEventAt,
    thinking: _legacySelectThinking,
    thinkingAt: _legacySelectThinkingAt,
    unreadSince: _legacySelectUnreadSince,
    needsAttention: _legacySelectNeedsAttention,
    pendingActivationRequestId: _legacySelectPendingActivationRequestId,
    pendingActivationRequestedAt: _legacySelectPendingActivationRequestedAt,
    pendingActivationStatus: _legacySelectPendingActivationStatus,
    pendingActivationFailureCode: _legacySelectPendingActivationFailureCode,
    ...V2_SESSION_LIST_ROW_LEGACY_SELECT
} = V2_SESSION_LIST_ROW_BASE_SELECT;

/**
 * The columns the primary session-list projection selects and the legacy projection does not — the
 * exact set a binary running ahead of `prisma migrate deploy` can be asked for and not get.
 *
 * Derived from the two projections instead of restated, because a hand-maintained copy is precisely
 * how `unreadSince` came to be selected by the primary projection while the missing-column matcher
 * still did not recognise it, turning a recoverable old-schema read into a hard failure.
 */
export const SESSION_LIST_PROJECTION_FALLBACK_COLUMNS: readonly string[] =
    Object.keys(V2_SESSION_LIST_ROW_BASE_SELECT).filter(
        (column) => !(column in V2_SESSION_LIST_ROW_LEGACY_SELECT),
    );

const SESSION_LIST_PROJECTION_FALLBACK_COLUMN_SET = new Set(SESSION_LIST_PROJECTION_FALLBACK_COLUMNS);

/**
 * Build the old-schema-safe counterpart of a session projection, so a caller that has one select
 * does not restate the fallback column list to obtain the other.
 */
export function omitSessionListProjectionFallbackColumns(select: Prisma.SessionSelect): Prisma.SessionSelect {
    return Object.fromEntries(
        Object.entries(select).filter(([column]) => !SESSION_LIST_PROJECTION_FALLBACK_COLUMN_SET.has(column)),
    );
}

export type V2SessionListRow = Prisma.SessionGetPayload<{
    select: typeof V2_SESSION_LIST_ROW_BASE_SELECT;
}>;

type V2SessionListLegacyRow = Prisma.SessionGetPayload<{
    select: typeof V2_SESSION_LIST_ROW_LEGACY_SELECT;
}>;

export type V2SessionListRowCompat = V2SessionListRow | V2SessionListLegacyRow;

/**
 * "Shared with this user" — the single definition of share membership.
 *
 * Both visibility expressions are built from it: the relation filter below, and the shared-session
 * id resolution in `v2SessionListPage.ts`. They are the same predicate reached from the two
 * different sides, so they must never be spelled out twice.
 */
export function createSessionSharedWithUserWhere(userId: string): Prisma.SessionShareWhereInput {
    return { sharedWithUserId: userId };
}

/**
 * The session-list visibility predicate, as one disjunction.
 *
 * Correct for callers that already bind a `Session` key — a single row by primary key, or a
 * caller-supplied `id IN (…)` — where the disjunction costs nothing because the access path is
 * already chosen.
 *
 * **Ordered list reads must not use it.** `accountId = ? OR EXISTS(shares…)` is a disjunction over
 * two different access paths, so no engine can bind `accountId` as an index key for it: every
 * `[accountId, …]` index on `Session` becomes unusable and the read degrades to a table-wide scan
 * (SQLite, MySQL) or a bitmap over every row of the table with the account membership re-checked as
 * a filter (PostgreSQL). Those reads ask each visibility arm separately instead — see
 * `resolveV2SessionListVisibilityWhereArms` in `v2SessionListPage.ts`, which also explains why the
 * shared arm cannot be a `shares` relation filter either.
 */
export function createV2SessionListVisibilityWhere(params: Readonly<{ userId: string }>): Prisma.SessionWhereInput {
    return {
        OR: [
            { accountId: params.userId },
            { shares: { some: createSessionSharedWithUserWhere(params.userId) } },
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

export function getV2SessionListEffectiveActivityAt(
    row: Readonly<Pick<V2SessionListRowCompat, "createdAt" | "meaningfulActivityAt">>,
): Date {
    return row.meaningfulActivityAt ?? row.createdAt;
}

function readNullableDateField(row: V2SessionListRowCompat, field: string): Date | null {
    const value = (row as Record<string, unknown>)[field];
    return value instanceof Date ? value : null;
}

function readNullableNumberField(row: object, field: string): number | null {
    const value = (row as Record<string, unknown>)[field];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "bigint") return Number(value);
    return null;
}

function readNullableStringField(row: V2SessionListRowCompat, field: string): string | null {
    const value = (row as Record<string, unknown>)[field];
    return typeof value === "string" && value ? value : null;
}

function readBooleanField(row: V2SessionListRowCompat, field: string): boolean {
    return (row as Record<string, unknown>)[field] === true;
}

export type SessionRuntimeActivityProjectionFields = Pick<
    V2SessionRecord,
    | "runtimeActivityState"
    | "runtimeActivityRevision"
    | "runtimeActivityActiveCount"
    | "runtimeActivityObservedAt"
>;

export function mapStoredSessionRuntimeActivityProjection(row: object): SessionRuntimeActivityProjectionFields {
    return normalizeStoredSessionRuntimeActivityProjection(row);
}

export function mapV2SessionListRow(params: Readonly<{ row: V2SessionListRowCompat; userId: string }>): V2SessionRecord {
    const { row, userId } = params;
    const viewerShare = row.shares[0] ?? null;
    const isOwner = row.accountId === userId;
    const latestTurnStatus = parseStoredSessionLatestTurnStatus(row.latestTurnStatus);
    const latestTurnStatusObservedAt = readNullableNumberField(row, "latestTurnStatusObservedAt");
    const rawThinkingAt = readNullableDateField(row, "thinkingAt")?.getTime() ?? null;
    const runtimeActivityProjection = mapStoredSessionRuntimeActivityProjection(row);
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
        // The materialized unread entry instant. Without it on the wire the client can only stamp
        // its own, which is stable per device but differs across devices and across boots — the
        // cross-device ordering this column exists for.
        unreadSince: readNullableDateField(row, "unreadSince")?.getTime() ?? null,
        pendingPermissionRequestCount: row.pendingPermissionRequestCount,
        pendingUserActionRequestCount: row.pendingUserActionRequestCount,
        pendingRequestObservedAt: readNullableDateField(row, "pendingRequestObservedAt")?.getTime() ?? null,
        latestReadyEventSeq: readNullableNumberField(row, "latestReadyEventSeq"),
        latestReadyEventAt: readNullableDateField(row, "latestReadyEventAt")?.getTime() ?? null,
        thinking,
        thinkingAt,
        latestTurnId: readNullableStringField(row, "latestTurnId"),
        latestTurnStatus,
        latestTurnStatusObservedAt,
        lastRuntimeIssue: parseStoredSessionRuntimeIssue(row.lastRuntimeIssue),
        ...runtimeActivityProjection,
        pendingCount: row.pendingCount,
        pendingBlockedCount: row.pendingBlockedCount,
        pendingVersion: row.pendingVersion,
        pendingActivationAuthorization: mapPendingActivationAuthorization(row),
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
