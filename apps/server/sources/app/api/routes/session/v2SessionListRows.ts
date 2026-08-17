import type { Prisma } from "@prisma/client";
import {
    PrimaryTurnStatusV1Schema,
    parseSessionRuntimeActivityProjectionFields,
    sanitizeSessionRuntimeIssueV1,
    type V2SessionRecord,
} from "@happier-dev/protocol";

import { resolveSessionRollbackEligibleTurnRelationLimit } from "./v2SessionHotReadLimits";
import {
    createSessionTranscriptShareableWhere,
    filterSessionTranscriptPublicationSequenceFacts,
    isSessionTranscriptShareable,
    projectSessionTranscriptPublicationPreview,
    resolveSessionTranscriptPublicationRecencyMs,
    SESSION_TRANSCRIPT_PUBLICATION_SELECT,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import {
    projectSessionMetadataForRecipient,
    requiresSessionMetadataOwnerAccountMode,
    type SessionMetadataOwnerAccountMode,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";

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
        return sanitizeSessionRuntimeIssueV1(JSON.parse(value));
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
    ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
    accountId: true,
    createdAt: true,
    updatedAt: true,
    meaningfulActivityAt: true,
    archivedAt: true,
    encryptionMode: true,
    metadata: true,
    metadataVersion: true,
    metadataLayoutVersion: true,
    ownerMetadata: true,
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
    runtimeActivityState: true,
    runtimeActivityActiveCount: true,
    runtimeActivityObservedAt: true,
    runtimeActivityRevision: true,
    latestReadyEventSeq: true,
    latestReadyEventAt: true,
    turns: createSessionRollbackEligibleTurnsSelect(),
    thinking: true,
    thinkingAt: true,
    pendingCount: true,
    pendingBlockedCount: true,
    pendingVersion: true,
    dataEncryptionKey: true,
    active: true,
    lastActiveAt: true,
    shares: {
        select: V2_SESSION_LIST_SHARE_SELECT,
    },
} as const satisfies Prisma.SessionSelect;

const {
    turns: _ownerSelectTurns,
    shares: _ownerSelectShares,
    ...V2_SESSION_OWNER_ROW_SELECT
} = V2_SESSION_LIST_ROW_BASE_SELECT;

export type V2SessionListRow = Prisma.SessionGetPayload<{
    select: typeof V2_SESSION_LIST_ROW_BASE_SELECT;
}>;

export type V2SessionOwnerRow = Prisma.SessionGetPayload<{
    select: typeof V2_SESSION_OWNER_ROW_SELECT;
}>;

export type V2SessionListRowCompat = V2SessionListRow;
type V2SessionRowCompat = V2SessionListRowCompat | V2SessionOwnerRow;

export function createV2SessionListVisibilityWhere(params: Readonly<{ userId: string }>): Prisma.SessionWhereInput {
    return {
        OR: [
            { accountId: params.userId },
            {
                AND: [
                    { shares: { some: { sharedWithUserId: params.userId } } },
                    createSessionTranscriptShareableWhere(),
                ],
            },
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

export function createV2SessionOwnerRowSelect() {
    return V2_SESSION_OWNER_ROW_SELECT;
}

export function getV2SessionListEffectiveActivityAt(row: Pick<V2SessionRowCompat, "createdAt" | "meaningfulActivityAt">): Date {
    return new Date(resolveSessionTranscriptPublicationRecencyMs({
        createdAt: row.createdAt,
        liveRecencyAt: row.meaningfulActivityAt,
    }, row));
}

function readNullableDateField(row: V2SessionRowCompat, field: string): Date | null {
    const value = (row as Record<string, unknown>)[field];
    return value instanceof Date ? value : null;
}

function readNullableNumberField(row: V2SessionRowCompat, field: string): number | null {
    const value = (row as Record<string, unknown>)[field];
    return typeof value === "number" ? value : null;
}

function readNullableStringField(row: V2SessionRowCompat, field: string): string | null {
    const value = (row as Record<string, unknown>)[field];
    return typeof value === "string" && value.length > 0 ? value : null;
}

function readNullableTimestampField(row: V2SessionRowCompat, field: string): number | null {
    const value = (row as Record<string, unknown>)[field];
    if (typeof value === "bigint") return Number(value);
    return typeof value === "number" ? value : null;
}

export function readSessionTranscriptAuthorityFields(row: unknown): Partial<Pick<
    V2SessionRecord,
    | 'currentStorageState'
    | 'acceptedThroughServerSeq'
    | 'materializedThroughSourceAt'
    | 'publishedThroughServerSeq'
    | 'transcriptShareable'
>> {
    const record = row as Record<string, unknown>;
    const currentStorageState = record.currentStorageState;
    if (
        currentStorageState !== 'machine_only'
        && currentStorageState !== 'server_partial'
        && currentStorageState !== 'snapshot_complete'
        && currentStorageState !== 'hosted'
        && currentStorageState !== 'legacy_external_unknown'
    ) {
        return {};
    }
    const readNullableSequence = (value: unknown): number | null =>
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
    const materializedThroughSourceAt = readNullableTimestampField(
        row as V2SessionRowCompat,
        'materializedThroughSourceAt',
    );
    return {
        currentStorageState,
        acceptedThroughServerSeq: readNullableSequence(record.acceptedThroughServerSeq),
        materializedThroughSourceAt: Number.isSafeInteger(materializedThroughSourceAt)
            && (materializedThroughSourceAt ?? -1) >= 0
            ? materializedThroughSourceAt
            : null,
        publishedThroughServerSeq: readNullableSequence(record.publishedThroughServerSeq),
        transcriptShareable: isSessionTranscriptShareable(record),
    };
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

function readBooleanField(row: V2SessionRowCompat, field: string): boolean {
    return (row as Record<string, unknown>)[field] === true;
}

function readRuntimeActivityInteger(value: unknown): number | null {
    if (typeof value === "bigint") {
        const numberValue = Number(value);
        return Number.isSafeInteger(numberValue) && numberValue >= 0 ? numberValue : null;
    }
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readRuntimeActivityProjection(row: V2SessionRowCompat): Partial<V2SessionRecord> {
    const record = row as Record<string, unknown>;
    const parsed = parseSessionRuntimeActivityProjectionFields({
        runtimeActivityState: record.runtimeActivityState,
        runtimeActivityActiveCount: readRuntimeActivityInteger(record.runtimeActivityActiveCount),
        runtimeActivityObservedAt: record.runtimeActivityObservedAt === null
            ? null
            : readRuntimeActivityInteger(record.runtimeActivityObservedAt),
        runtimeActivityRevision: readRuntimeActivityInteger(record.runtimeActivityRevision),
        ...(Object.prototype.hasOwnProperty.call(record, "runtimeActivitySourceClass")
            ? { runtimeActivitySourceClass: record.runtimeActivitySourceClass }
            : {}),
    });
    if (parsed.kind !== "valid") return {};
    return {
        runtimeActivityState: parsed.projection.state,
        runtimeActivityActiveCount: parsed.projection.activeCount,
        runtimeActivityObservedAt: parsed.projection.observedAt,
        runtimeActivityRevision: parsed.projection.revision,
    };
}

export function mapV2SessionListRow(params: Readonly<{
    row: V2SessionRowCompat;
    userId: string;
    ownerAccountMode?: SessionMetadataOwnerAccountMode;
    ownerAccountModes?: ReadonlyMap<string, SessionMetadataOwnerAccountMode>;
}>): V2SessionRecord {
    const { row, userId } = params;
    const ownerAccountMode = params.ownerAccountModes?.get(row.accountId)
        ?? params.ownerAccountMode;
    const viewerShare = "shares" in row ? row.shares[0] ?? null : null;
    const isOwner = row.accountId === userId;
    const publicationProjection = projectSessionTranscriptPublicationPreview({
        seq: row.seq,
        lastViewedSessionSeq: row.lastViewedSessionSeq,
        latestReadyEventSeq: readNullableNumberField(row, "latestReadyEventSeq"),
        latestReadyEventAt: readNullableDateField(row, "latestReadyEventAt"),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        meaningfulActivityAt: row.meaningfulActivityAt,
        lastActiveAt: row.lastActiveAt,
    }, row);
    const hasLiveFacts = publicationProjection.hasLiveFacts;
    const pendingRequestObservedAt = hasLiveFacts
        ? readNullableDateField(row, "pendingRequestObservedAt")
        : null;
    const latestTurnStatus = hasLiveFacts
        ? parseStoredSessionLatestTurnStatus(row.latestTurnStatus)
        : null;
    const latestTurnStatusObservedAt = hasLiveFacts
        ? readNullableTimestampField(row, "latestTurnStatusObservedAt")
        : null;
    const rawThinkingAt = hasLiveFacts
        ? readNullableDateField(row, "thinkingAt")?.getTime() ?? null
        : null;
    const thinking = hasLiveFacts
        && !isTerminalTurnStatus(latestTurnStatus)
        && readBooleanField(row, "thinking");
    const thinkingAt = !hasLiveFacts
        ? null
        : isTerminalTurnStatus(latestTurnStatus)
            ? (latestTurnStatusObservedAt ?? rawThinkingAt)
            : rawThinkingAt;
    const runtimeActivityProjection = hasLiveFacts
        ? readRuntimeActivityProjection(row)
        : {};
    const metadataProjection = projectSessionMetadataForRecipient({
        session: row,
        recipient: isOwner
            ? requiresSessionMetadataOwnerAccountMode({
                session: row,
              }) && ownerAccountMode
                ? {
                    type: "owner",
                    accountId: userId,
                    accountMode: ownerAccountMode,
                  }
                : {
                    type: "legacy_owner",
                    accountId: userId,
                  }
            : {
                type: "shared",
                accountId: userId,
                ownerAccountMode,
              },
    });

    return {
        id: row.id,
        seq: publicationProjection.seq,
        createdAt: row.createdAt.getTime(),
        updatedAt: publicationProjection.updatedAt,
        meaningfulActivityAt: publicationProjection.meaningfulActivityAt,
        active: hasLiveFacts && row.active,
        activeAt: publicationProjection.activeAt,
        archivedAt: row.archivedAt?.getTime() ?? null,
        encryptionMode: row.encryptionMode === "plain" ? "plain" : "e2ee",
        ...metadataProjection,
        lastViewedSessionSeq: publicationProjection.lastViewedSessionSeq ?? null,
        pendingPermissionRequestCount: hasLiveFacts ? row.pendingPermissionRequestCount : 0,
        pendingUserActionRequestCount: hasLiveFacts ? row.pendingUserActionRequestCount : 0,
        pendingRequestObservedAt: pendingRequestObservedAt?.getTime() ?? null,
        latestTurnId: hasLiveFacts
            ? readNullableStringField(row, "latestTurnId")
            : null,
        latestTurnStatus,
        latestTurnStatusObservedAt,
        lastRuntimeIssue: hasLiveFacts ? parseStoredSessionRuntimeIssue(row.lastRuntimeIssue) : null,
        ...runtimeActivityProjection,
        rollbackEligibleTurnStarts: filterSessionTranscriptPublicationSequenceFacts(
            readSessionTurnRollbackEligibleStarts(row),
            row,
        ),
        latestReadyEventSeq: publicationProjection.latestReadyEventSeq ?? null,
        latestReadyEventAt: publicationProjection.latestReadyEventAt?.getTime() ?? null,
        thinking,
        thinkingAt,
        ...readSessionTranscriptAuthorityFields(row),
        acceptedThroughServerSeq: publicationProjection.acceptedThroughServerSeq,
        pendingCount: hasLiveFacts ? row.pendingCount : 0,
        pendingBlockedCount: hasLiveFacts ? row.pendingBlockedCount : 0,
        pendingVersion: hasLiveFacts ? row.pendingVersion : 0,
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

export function mapV2SessionOwnerRow(
    row: V2SessionOwnerRow,
    ownerAccountMode?: SessionMetadataOwnerAccountMode,
): V2SessionRecord {
    const {
        rollbackEligibleTurnStarts: _rollbackEligibleTurnStarts,
        ...session
    } = mapV2SessionListRow({
        row,
        userId: row.accountId,
        ownerAccountMode,
    });
    return session;
}

export { encodeSessionDataEncryptionKey };
