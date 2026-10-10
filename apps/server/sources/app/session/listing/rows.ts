import type { Prisma } from "@prisma/client";
import {
    PrimaryTurnStatusV1Schema,
    SessionAwarenessOriginV1Schema,
    parseSessionRuntimeActivityProjectionFields,
    projectLegacyViewerLastViewedSessionSeqV1,
    projectLegacyViewerUnreadSinceV1,
    type V2SessionRecord,
} from "@happier-dev/protocol";

import {
    createSessionRollbackEligibleTurnsSelect,
    readSessionTurnRollbackEligibleStarts,
} from "@/app/session/turns/sessionRollbackEligibilityProjection";
import {
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
import { mapPendingActivationAuthorization } from "@/app/session/pending/pendingActivationAuthorization";
import {
    createSessionDataKeyEnvelopeViewerSelect,
    projectViewerSessionDataKey,
} from "@/app/session/encryption/sessionDataKeyEnvelopePersistence";
import {
    QUIET_SESSION_PERSONAL_DISCUSSION_FACTS,
    type SessionPersonalDiscussionFacts,
} from "@/app/session/personal/discussionFacts";
import { createSessionPersonalProjectionSelect, projectSessionViewer } from "@/app/session/personal/projection";
import {
    projectEffectiveSessionAccess,
    projectSessionEffectiveAccessV1,
    type EffectiveSessionAccess,
} from "@/app/session/access/sessionAccess";
import {
    ACCOUNT_DISPLAY_PROFILE_SELECT,
    projectAccountDisplayProfileV1,
} from "@/app/account/profile/accountDisplayProfile";
import { parseStoredSessionRuntimeIssue } from "@/app/session/turns/parseSessionTurnState";
export { parseStoredSessionRuntimeIssue } from "@/app/session/turns/parseSessionTurnState";

export function parseStoredSessionLatestTurnStatus(value: string | null | undefined): V2SessionRecord["latestTurnStatus"] {
    const parsed = PrimaryTurnStatusV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

/** Stored creation origin is shared by initial creation and current row projections. */
export function projectStoredSessionOrigin(row: Readonly<{
    originKind: string;
    originRunId: string | null;
}>): V2SessionRecord["origin"] {
    const origin = SessionAwarenessOriginV1Schema.safeParse({
        kind: row.originKind,
        ...(row.originRunId ? { runId: row.originRunId } : {}),
    });
    return origin.success ? origin.data : undefined;
}

function isTerminalTurnStatus(status: V2SessionRecord["latestTurnStatus"]): boolean {
    return status === "completed" || status === "cancelled" || status === "failed";
}

const V2_SESSION_LIST_ROW_BASE_SELECT = {
    id: true,
    originKind: true,
    originRunId: true,
    workDepth: true,
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
    pendingActivationRequestId: true,
    pendingActivationRequestedAt: true,
    pendingActivationStatus: true,
    pendingActivationFailureCode: true,
    pendingActivationManagedTarget: true,
    responsibleAccountId: true,
    responsibleAccount: { select: ACCOUNT_DISPLAY_PROFILE_SELECT },
    active: true,
    lastActiveAt: true,
} as const satisfies Prisma.SessionSelect;

const {
    turns: _ownerSelectTurns,
    ...V2_SESSION_OWNER_ROW_SELECT
} = V2_SESSION_LIST_ROW_BASE_SELECT;

const {
    turns: _legacySelectTurns,
    responsibleAccountId: _legacySelectResponsibleAccountId,
    responsibleAccount: _legacySelectResponsibleAccount,
    pendingActivationRequestId: _legacySelectPendingActivationRequestId,
    pendingActivationRequestedAt: _legacySelectPendingActivationRequestedAt,
    pendingActivationStatus: _legacySelectPendingActivationStatus,
    pendingActivationFailureCode: _legacySelectPendingActivationFailureCode,
    pendingActivationManagedTarget: _legacySelectPendingActivationManagedTarget,
    ...V2_SESSION_LIST_ROW_LEGACY_SELECT
} = V2_SESSION_LIST_ROW_BASE_SELECT;

export const SESSION_LIST_PROJECTION_FALLBACK_COLUMNS: readonly string[] =
    Object.keys(V2_SESSION_LIST_ROW_BASE_SELECT).filter(
        (column) => !(column in V2_SESSION_LIST_ROW_LEGACY_SELECT),
    );

const SESSION_LIST_PROJECTION_FALLBACK_COLUMN_SET = new Set(SESSION_LIST_PROJECTION_FALLBACK_COLUMNS);

export function omitSessionListProjectionFallbackColumns(select: Prisma.SessionSelect): Prisma.SessionSelect {
    return Object.fromEntries(
        Object.entries(select).filter(([column]) => !SESSION_LIST_PROJECTION_FALLBACK_COLUMN_SET.has(column)),
    );
}

export type V2SessionListRow = Prisma.SessionGetPayload<{
    select: ReturnType<typeof createV2SessionListRowSelect>;
}>;

export type V2SessionOwnerRow = Prisma.SessionGetPayload<{
    select: ReturnType<typeof createV2SessionOwnerRowSelect>;
}>;

type V2SessionListLegacyRow = Prisma.SessionGetPayload<{
    select: ReturnType<typeof createV2SessionListLegacyRowSelect>;
}>;

export type V2SessionListRowCompat = V2SessionListRow | V2SessionListLegacyRow;
type V2SessionRowCompat = V2SessionListRowCompat | V2SessionOwnerRow;

/**
 * The personal projection plus this viewer's own data-key envelope.
 *
 * The envelope is a filtered relation on the canonical tuple, so owner and
 * shared rows resolve their key the same way and the list stays one query. The
 * direct-share row no longer carries key material at all.
 */
function createSessionPersonalListProjectionSelect(accountId: string) {
    return {
        ...createSessionPersonalProjectionSelect(accountId),
        ...createSessionDataKeyEnvelopeViewerSelect({ viewerAccountId: accountId }),
    } as const satisfies Prisma.SessionSelect;
}

export function createV2SessionListRowSelect(params: Readonly<{ userId: string }>) {
    return {
        ...V2_SESSION_LIST_ROW_BASE_SELECT,
        ...createSessionPersonalListProjectionSelect(params.userId),
    } as const satisfies Prisma.SessionSelect;
}

export function createV2SessionListLegacyRowSelect(params: Readonly<{ userId: string }>) {
    const { responsibleAccountId: _responsibility, ...personalSelect } = createSessionPersonalListProjectionSelect(params.userId);
    return {
        ...V2_SESSION_LIST_ROW_LEGACY_SELECT,
        ...personalSelect,
    } as const satisfies Prisma.SessionSelect;
}

export function createV2SessionOwnerRowSelect(accountId: string) {
    return { ...V2_SESSION_OWNER_ROW_SELECT, ...createSessionPersonalListProjectionSelect(accountId) };
}

export function getV2SessionListEffectiveActivityAt(row: Pick<V2SessionRowCompat, "createdAt" | "meaningfulActivityAt">): Date {
    return new Date(resolveSessionTranscriptPublicationRecencyMs({
        createdAt: row.createdAt,
        liveRecencyAt: row.meaningfulActivityAt,
    }, row));
}

function readNullableDateField(row: V2SessionRowCompat, field: keyof V2SessionRowCompat): Date | null {
    const value = row[field];
    return value instanceof Date ? value : null;
}

function readNullableNumberField(row: V2SessionRowCompat, field: keyof V2SessionRowCompat): number | null {
    const value = row[field];
    return typeof value === "number" ? value : null;
}

function readNullableStringField(row: V2SessionRowCompat, field: keyof V2SessionRowCompat): string | null {
    const value = row[field];
    return typeof value === "string" && value.length > 0 ? value : null;
}

function readNullableTimestampField(row: V2SessionRowCompat, field: keyof V2SessionRowCompat): number | null {
    const value = row[field];
    if (typeof value === "bigint") return Number(value);
    return typeof value === "number" ? value : null;
}

export function readSessionTranscriptAuthorityFields(row: Readonly<Partial<Pick<
    V2SessionListRow,
    "currentStorageState" | "acceptedThroughServerSeq" | "materializedThroughSourceAt"
    | "publishedThroughServerSeq" | "materializationPublicationId"
>>>): Partial<Pick<
    V2SessionRecord,
    | 'currentStorageState'
    | 'acceptedThroughServerSeq'
    | 'materializedThroughSourceAt'
    | 'publishedThroughServerSeq'
    | 'transcriptShareable'
>> {
    const currentStorageState = row.currentStorageState;
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
    const materializedThroughSourceAt = readLatestTurnStatusObservedAt(row.materializedThroughSourceAt);
    return {
        currentStorageState,
        acceptedThroughServerSeq: readNullableSequence(row.acceptedThroughServerSeq),
        materializedThroughSourceAt: Number.isSafeInteger(materializedThroughSourceAt)
            && (materializedThroughSourceAt ?? -1) >= 0
            ? materializedThroughSourceAt
            : null,
        publishedThroughServerSeq: readNullableSequence(row.publishedThroughServerSeq),
        transcriptShareable: isSessionTranscriptShareable(row),
    };
}

function readSessionResponsibilityProjection(
    row: V2SessionRowCompat,
): Partial<Pick<V2SessionRecord, "responsibleAccountId" | "responsibleAccount">> {
    if (!("responsibleAccountId" in row)) return {};
    const value = row.responsibleAccountId;
    const responsibleAccountId = typeof value === "string" && value.length > 0 ? value : null;
    if (responsibleAccountId === null) return { responsibleAccountId: null, responsibleAccount: null };
    const relation = "responsibleAccount" in row ? (row as { responsibleAccount?: { id: string; firstName: string | null; lastName: string | null; username: string | null; avatar: unknown } | null }).responsibleAccount : undefined;
    if (!relation || relation.id !== responsibleAccountId) {
        throw new Error("Current Session responsibility projection requires its matching Account summary");
    }
    const profile = projectAccountDisplayProfileV1(relation);
    return {
        responsibleAccountId,
        responsibleAccount: { kind: "account" as const, accountId: relation.id, ...profile },
    };
}

function readBooleanField(row: V2SessionRowCompat, field: keyof V2SessionRowCompat): boolean {
    return row[field] === true;
}

function readRuntimeActivityInteger(value: unknown): number | null {
    if (typeof value === "bigint") {
        const numberValue = Number(value);
        return Number.isSafeInteger(numberValue) && numberValue >= 0 ? numberValue : null;
    }
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readRuntimeActivityProjection(row: V2SessionRowCompat): Partial<V2SessionRecord> {
    const parsed = parseSessionRuntimeActivityProjectionFields({
        runtimeActivityState: row.runtimeActivityState,
        runtimeActivityActiveCount: readRuntimeActivityInteger(row.runtimeActivityActiveCount),
        runtimeActivityObservedAt: row.runtimeActivityObservedAt === null
            ? null
            : readRuntimeActivityInteger(row.runtimeActivityObservedAt),
        runtimeActivityRevision: readRuntimeActivityInteger(row.runtimeActivityRevision),
        ...("runtimeActivitySourceClass" in row
            ? { runtimeActivitySourceClass: row.runtimeActivitySourceClass }
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
    /**
     * Lane 05 conversation facts for this page, loaded once beside the owner
     * account modes. A Session without an entry genuinely has no discussion
     * relevance or unread for this viewer.
     */
    discussionFacts?: ReadonlyMap<string, SessionPersonalDiscussionFacts>;
    hasOtherNamedCollaborator?: boolean;
    effectiveAccess?: EffectiveSessionAccess;
    /**
     * The caller has already verified the exact Session-scoped runtime
     * principal through `resolveSessionAccessForOperation`. Runtime credentials
     * receive shared Session state, never their hosting Account's personal
     * Follow/read/attention/authorship projection.
     */
    verifiedSessionRuntimePrincipal?: boolean;
    qualifiedTeamIds?: ReadonlySet<string>;
    accessMode?: "effective_access_v1" | "legacy_owner_or_direct";
    now?: number;
}>): V2SessionRecord {
    const { row, userId } = params;
    const ownerAccountMode = params.ownerAccountModes?.get(row.accountId)
        ?? params.ownerAccountMode;
    const viewerShare = "shares" in row ? row.shares[0] ?? null : null;
    const isOwner = row.accountId === userId;
    const receivesOwnerMetadata = isOwner
        && (params.effectiveAccess === undefined || params.effectiveAccess.level === "owner");
    const publicationProjection = projectSessionTranscriptPublicationPreview({
        seq: row.seq,
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
    const pendingActivationAuthorization = hasLiveFacts
        ? mapPendingActivationAuthorization(row)
        : undefined;
    const metadataProjection = projectSessionMetadataForRecipient({
        session: row,
        recipient: receivesOwnerMetadata
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
                // A Session-scoped runtime can use the hosting Account's
                // credential without inheriting owner metadata authority.
                // Passing no recipient Account identity keeps the existing
                // metadata projector on its shared projection for that case.
                accountId: isOwner ? null : userId,
                ownerAccountMode,
              },
    });

    // Query admission carries the exact Team qualification result from the
    // canonical compiler. A point reader may instead pass its already-resolved
    // access decision; mapping never broadens either fact from the selected row.
    const effectiveAccess = params.effectiveAccess
        ?? projectEffectiveSessionAccess(row, userId, {
            mode: params.accessMode,
            qualifiedTeamIds: params.qualifiedTeamIds,
        });
    if (!effectiveAccess) {
        throw new Error("Session list row lacks effective viewer access");
    }
    const viewer = params.verifiedSessionRuntimePrincipal
        ? undefined
        : projectSessionViewer({
            row,
            viewerAccountId: userId,
            discussion: params.discussionFacts?.get(row.id) ?? QUIET_SESSION_PERSONAL_DISCUSSION_FACTS,
            qualifiedTeamIds: params.qualifiedTeamIds,
            effectiveAccess,
            now: params.now,
        });
    const origin = projectStoredSessionOrigin(row);
    return {
        id: row.id,
        ...(origin ? { origin } : {}),
        workDepth: row.workDepth,
        seq: publicationProjection.seq,
        createdAt: row.createdAt.getTime(),
        updatedAt: publicationProjection.updatedAt,
        meaningfulActivityAt: publicationProjection.meaningfulActivityAt,
        active: hasLiveFacts && row.active,
        activeAt: publicationProjection.activeAt,
        archivedAt: row.archivedAt?.getTime() ?? null,
        encryptionMode: row.encryptionMode === "plain" ? "plain" : "e2ee",
        ...metadataProjection,
        effectiveAccess: projectSessionEffectiveAccessV1(effectiveAccess),
        ...(params.hasOtherNamedCollaborator !== undefined
            ? { hasOtherNamedCollaborator: params.hasOtherNamedCollaborator }
            : {}),
        ...(viewer
            ? {
                viewer,
                lastViewedSessionSeq: projectLegacyViewerLastViewedSessionSeqV1({
                    readState: viewer.readState,
                    visibleSessionSeq: publicationProjection.seq,
                }),
                unreadSince: projectLegacyViewerUnreadSinceV1(viewer.readState),
              }
            : {}),
        ...(hasLiveFacts
            ? {
                pendingPermissionRequestCount: row.pendingPermissionRequestCount,
                pendingUserActionRequestCount: row.pendingUserActionRequestCount,
                pendingRequestObservedAt: pendingRequestObservedAt?.getTime() ?? null,
                latestTurnId: readNullableStringField(row, "latestTurnId"),
                latestTurnStatus,
                latestTurnStatusObservedAt,
                lastRuntimeIssue: parseStoredSessionRuntimeIssue(row.lastRuntimeIssue),
                ...runtimeActivityProjection,
                thinking,
                thinkingAt,
                pendingCount: row.pendingCount,
                pendingBlockedCount: row.pendingBlockedCount,
                pendingVersion: row.pendingVersion,
                ...(pendingActivationAuthorization
                    ? { pendingActivationAuthorization }
                    : {}),
              }
            : {}),
        rollbackEligibleTurnStarts: filterSessionTranscriptPublicationSequenceFacts(
            readSessionTurnRollbackEligibleStarts(row),
            row,
        ),
        latestReadyEventSeq: publicationProjection.latestReadyEventSeq ?? null,
        latestReadyEventAt: publicationProjection.latestReadyEventAt?.getTime() ?? null,
        ...readSessionTranscriptAuthorityFields(row),
        acceptedThroughServerSeq: publicationProjection.acceptedThroughServerSeq,
        // One projector for every viewer. Access was already decided by the
        // canonical predicate that produced this row; ownership no longer
        // selects a different key column.
        dataEncryptionKey: "dataKeyEnvelopes" in row
            ? projectViewerSessionDataKey(row)
            : null,
        // A supporting producer always states the current value, including `null`.
        // The field stays absent only on the pre-migration projection fallback,
        // where omitted truthfully means "not projected" rather than "nobody".
        ...readSessionResponsibilityProjection(row),
        ...(receivesOwnerMetadata
            ? { share: null }
            : viewerShare
                ? { share: {
                    accessLevel: viewerShare.accessLevel,
                    canApprovePermissions: viewerShare.canApprovePermissions,
                } }
                : {}),
    };
}

export function mapV2SessionOwnerRow(
    row: V2SessionOwnerRow,
    ownerAccountMode?: SessionMetadataOwnerAccountMode,
    discussionFacts?: ReadonlyMap<string, SessionPersonalDiscussionFacts>,
): V2SessionRecord {
    const {
        rollbackEligibleTurnStarts: _rollbackEligibleTurnStarts,
        ...session
    } = mapV2SessionListRow({
        row,
        userId: row.accountId,
        ownerAccountMode,
        discussionFacts,
    });
    return session;
}

export function readLatestTurnStatusObservedAt(value: bigint | number | null | undefined): number | null {
    if (typeof value === "bigint") return Number(value);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function projectSessionListingPublicationPreview<T extends Readonly<{
    seq: number;
    lastViewedSessionSeq?: number | null;
    createdAt: Date;
    updatedAt: Date;
    meaningfulActivityAt?: Date | null;
    lastActiveAt: Date;
}>>(session: T) {
    return projectSessionTranscriptPublicationPreview({
        seq: session.seq,
        lastViewedSessionSeq: session.lastViewedSessionSeq,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        meaningfulActivityAt: session.meaningfulActivityAt,
        lastActiveAt: session.lastActiveAt,
    }, session);
}
