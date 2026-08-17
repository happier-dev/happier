import type { Prisma } from "@prisma/client";
import {
    PrimaryTurnStatusV1Schema,
    SessionInputAdmissionReceiptV1Schema,
    parseSessionMessageDeliveryResolutionV1,
    type PrimaryTurnStatusV1,
    type SessionRuntimeIssueV1,
} from "@happier-dev/protocol";

import {
    parseStoredSessionTurnTranscriptAnchors,
    type SessionTurnStoredRow,
} from "@/app/session/turns/parseSessionTurnState";
import { db } from "@/storage/db";

export const SESSION_TRANSCRIPT_PUBLICATION_SELECT = {
    accountId: true,
    seq: true,
    currentStorageState: true,
    acceptedThroughServerSeq: true,
    materializationPublicationId: true,
    materializedThroughSourceAt: true,
    publishedThroughServerSeq: true,
} as const;

/**
 * The one current session record used to project recipient-visible realtime
 * deltas. Keeping it at the publication owner prevents each emitter from
 * selecting a slightly different mix of live and durable facts.
 */
export const SESSION_TRANSCRIPT_PUBLICATION_RECIPIENT_PROJECTION_SELECT = {
    ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
    seq: true,
    lastViewedSessionSeq: true,
    latestReadyEventSeq: true,
    latestReadyEventAt: true,
    createdAt: true,
    updatedAt: true,
    meaningfulActivityAt: true,
    lastActiveAt: true,
} as const;

export type SessionTranscriptPublicationFields = Readonly<{
    accountId?: unknown;
    seq?: unknown;
    currentStorageState?: unknown;
    acceptedThroughServerSeq?: unknown;
    materializationPublicationId?: unknown;
    materializedThroughSourceAt?: unknown;
    publishedThroughServerSeq?: unknown;
}>;

export type SessionTranscriptPublicationRecipientProjectionRow =
    SessionTranscriptPublicationFields & Readonly<{
        accountId: string;
        seq: number;
        lastViewedSessionSeq: number | null;
        latestReadyEventSeq: number | null;
        latestReadyEventAt: Date | null;
        createdAt: Date;
        updatedAt: Date;
        meaningfulActivityAt: Date | null;
        lastActiveAt: Date;
    }>;

type SessionPublicationReader = Readonly<{
    session: Readonly<{
        findUnique(args: {
            where: { id: string };
            select: typeof SESSION_TRANSCRIPT_PUBLICATION_SELECT;
        }): Promise<SessionTranscriptPublicationFields | null>;
    }>;
}>;

type SessionTranscriptPublicationRow = SessionTranscriptPublicationFields & Readonly<{
    id: string;
}>;

export type SessionTranscriptPublicationRecipientDecision<T> =
    | Readonly<{ kind: "publish"; value: T }>
    | Readonly<{ kind: "suppress" }>;

function readServerSequence(value: unknown): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : null;
}

function readServerTimestamp(value: unknown): number | null {
    if (typeof value === "bigint") {
        return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(value)
            : null;
    }
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : null;
}

function publishSessionTranscriptPublicationRecipientValue<T>(
    value: T,
): SessionTranscriptPublicationRecipientDecision<T> {
    return { kind: "publish", value };
}

function suppressSessionTranscriptPublicationRecipientValue<T>(): SessionTranscriptPublicationRecipientDecision<T> {
    return { kind: "suppress" };
}

function isFiniteSessionTranscriptPublicationRecipient(
    publication: SessionTranscriptPublicationFields,
    recipientAccountId: string,
): boolean {
    return resolveSessionTranscriptPublicationCeiling(publication) !== null
        && publication.accountId !== recipientAccountId;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
    value: Readonly<Record<string, unknown>>,
    allowed: readonly string[],
    required: readonly string[],
): boolean {
    const keys = Object.keys(value);
    return keys.every((key) => allowed.includes(key))
        && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isPublishedSequence(value: unknown, ceiling: number): boolean {
    const sequence = readServerSequence(value);
    return sequence !== null && sequence <= ceiling;
}

function isPublishedSessionTranscriptChangeHint(hint: unknown, ceiling: number): boolean {
    if (!isRecord(hint)) return false;
    if (
        hasOnlyKeys(hint, ["lastMessageSeq", "lastMessageId"], ["lastMessageSeq"])
        && isPublishedSequence(hint.lastMessageSeq, ceiling)
    ) {
        return true;
    }
    if (
        hasOnlyKeys(hint, ["updatedMessageSeq", "updatedMessageId"], ["updatedMessageSeq"])
        && isPublishedSequence(hint.updatedMessageSeq, ceiling)
    ) {
        return true;
    }
    if (
        hasOnlyKeys(hint, ["lastViewedSessionSeq"], ["lastViewedSessionSeq"])
        && isPublishedSequence(hint.lastViewedSessionSeq, ceiling)
    ) {
        return true;
    }
    if (
        hasOnlyKeys(hint, ["latestReadyEventSeq", "latestReadyEventAt"], ["latestReadyEventSeq", "latestReadyEventAt"])
        && isPublishedSequence(hint.latestReadyEventSeq, ceiling)
        && readServerTimestamp(hint.latestReadyEventAt) !== null
    ) {
        return true;
    }
    if (
        hasOnlyKeys(hint, ["sharedMetadataVersion"], ["sharedMetadataVersion"])
        && readServerSequence(hint.sharedMetadataVersion) !== null
    ) {
        return true;
    }
    return hasOnlyKeys(hint, ["archivedAt"], ["archivedAt"])
        && (hint.archivedAt === null || readServerTimestamp(hint.archivedAt) !== null);
}

function hasCompletePublicationTuple(fields: SessionTranscriptPublicationFields): boolean {
    const publicationId = fields.materializationPublicationId;
    const publishedThroughServerSeq = readServerSequence(fields.publishedThroughServerSeq);
    const sessionSeq = readServerSequence(fields.seq);
    return typeof publicationId === "string"
        && publicationId.trim().length > 0
        && readServerTimestamp(fields.materializedThroughSourceAt) !== null
        && publishedThroughServerSeq !== null
        && sessionSeq !== null
        && publishedThroughServerSeq <= sessionSeq;
}

function createCompleteSnapshotPublicationWhere(): Prisma.SessionWhereInput {
    return {
        currentStorageState: "snapshot_complete",
        materializationPublicationId: { not: "" },
        materializedThroughSourceAt: {
            gte: 0,
            lte: BigInt(Number.MAX_SAFE_INTEGER),
        },
        publishedThroughServerSeq: {
            gte: 0,
            lte: db.session.fields.seq,
        },
    };
}

/**
 * Sharing is an authority transfer, not a ceiling-limited owner read. External
 * transcripts become shareable only after one complete snapshot publication.
 */
export function isSessionTranscriptShareable(publication: object): boolean {
    const fields = publication as SessionTranscriptPublicationFields;
    if (fields.currentStorageState === "hosted") {
        return true;
    }
    return fields.currentStorageState === "snapshot_complete"
        && hasCompletePublicationTuple(fields);
}

/**
 * Database-side share admission. Keep this at the publication-policy owner so
 * list queries exclude non-shareable rows before applying their page caps.
 * The runtime predicate remains the final defense for malformed rows that a
 * portable Prisma predicate cannot characterize (for example whitespace ids).
 */
export function createSessionTranscriptShareableWhere(): Prisma.SessionWhereInput {
    return {
        OR: createSessionTranscriptShareableRecencyQueryBranches()
            .map((branch) => branch.where),
    };
}

/**
 * A finite publication ceiling suppresses every live-work projection. Keep
 * this deciding predicate beside the ceiling so active-list membership cannot
 * depend on raw post-publication activity columns.
 */
export function createSessionTranscriptPublicationLiveFactsWhere(): Prisma.SessionWhereInput {
    return { currentStorageState: "hosted" };
}

/**
 * Non-owner list queries have two disjoint recency authorities. Taking the
 * bounded top-k from each branch before merging is equivalent to taking the
 * top-k from their union and prevents private snapshot catch-up writes from
 * affecting pagination through Prisma's physical `updatedAt`.
 */
export function createSessionTranscriptShareableRecencyQueryBranches(): readonly Readonly<{
    where: Prisma.SessionWhereInput;
    orderBy: readonly Prisma.SessionOrderByWithRelationInput[];
}>[] {
    return [
        {
            where: { currentStorageState: "hosted" },
            orderBy: [
                { updatedAt: "desc" },
                { id: "desc" },
            ],
        },
        {
            where: createCompleteSnapshotPublicationWhere(),
            orderBy: [
                { materializedThroughSourceAt: "desc" },
                { id: "desc" },
            ],
        },
    ];
}

/**
 * Owned list reads have the same single public-recency authority as every
 * other ordinary projection. Unlike share admission, finite rows remain
 * visible to their owner; their mutable `updatedAt` is never allowed to
 * decide a bounded database window.
 */
export function createSessionTranscriptPublicationRecencyQueryBranches(): readonly Readonly<{
    where: Prisma.SessionWhereInput;
    orderBy: readonly Prisma.SessionOrderByWithRelationInput[];
}>[] {
    const completeSnapshotWhere = createCompleteSnapshotPublicationWhere();
    return [
        {
            where: { currentStorageState: "hosted" },
            orderBy: [
                { updatedAt: "desc" },
                { id: "desc" },
            ],
        },
        {
            where: completeSnapshotWhere,
            orderBy: [
                { materializedThroughSourceAt: "desc" },
                { id: "desc" },
            ],
        },
        {
            where: {
                NOT: [
                    { currentStorageState: "hosted" },
                    completeSnapshotWhere,
                ],
            },
            orderBy: [
                { createdAt: "desc" },
                { id: "desc" },
            ],
        },
    ];
}

/**
 * Database-side admission for the ready-event attention arm. A ready event
 * can participate in attention only if its own sequence is within the same
 * publication ceiling as every other transcript-derived fact.
 */
export function createSessionTranscriptPublicationReadyEventWhere(): Prisma.SessionWhereInput {
    return {
        OR: [
            { currentStorageState: "hosted" },
            {
                ...createCompleteSnapshotPublicationWhere(),
                latestReadyEventSeq: { lte: db.session.fields.publishedThroughServerSeq },
            },
        ],
    };
}

export type SessionTranscriptPublicationActivityCursor = Readonly<{
    sessionId: string;
    activityAt: number;
}>;

/**
 * Database-side branches for the sole list activity authority. Every finite
 * publication state uses its durable public observation or creation time,
 * never the mutable operation-private activity columns. Taking a bounded
 * top-k from each disjoint branch before merging preserves the global page.
 */
export function createSessionTranscriptPublicationActivityQueryBranches(
    cursor?: SessionTranscriptPublicationActivityCursor | null,
): readonly Readonly<{
    where: Prisma.SessionWhereInput;
    cursorWhere: Prisma.SessionWhereInput;
    orderBy: readonly Prisma.SessionOrderByWithRelationInput[];
}>[] {
    const completeSnapshotWhere = createCompleteSnapshotPublicationWhere();
    return [
        {
            where: {
                currentStorageState: "hosted",
                meaningfulActivityAt: { not: null },
            },
            cursorWhere: createMeaningfulActivityCursorWhere(cursor),
            orderBy: [
                { meaningfulActivityAt: "desc" },
                { id: "desc" },
            ],
        },
        {
            where: {
                currentStorageState: "hosted",
                meaningfulActivityAt: null,
            },
            cursorWhere: createCreatedAtCursorWhere(cursor),
            orderBy: [
                { createdAt: "desc" },
                { id: "desc" },
            ],
        },
        {
            where: completeSnapshotWhere,
            cursorWhere: createMaterializedObservationCursorWhere(cursor),
            orderBy: [
                { materializedThroughSourceAt: "desc" },
                { id: "desc" },
            ],
        },
        {
            where: {
                NOT: [
                    { currentStorageState: "hosted" },
                    completeSnapshotWhere,
                ],
            },
            cursorWhere: createCreatedAtCursorWhere(cursor),
            orderBy: [
                { createdAt: "desc" },
                { id: "desc" },
            ],
        },
    ];
}

/**
 * Resolves the one activity/recency fact ordinary list projections may use.
 * Hosted rows retain their historical live activity. Every finite ceiling is
 * fixed at the completed snapshot observation when available, otherwise at
 * creation, so updates above the publication boundary cannot reorder pages.
 */
export function resolveSessionTranscriptPublicationRecencyMs(params: Readonly<{
    createdAt: Date;
    liveRecencyAt?: Date | null;
}>, publication: object): number {
    const createdAt = readDateMs(params.createdAt) ?? 0;
    if (resolveSessionTranscriptPublicationCeiling(publication) === null) {
        return readDateMs(params.liveRecencyAt) ?? createdAt;
    }
    return readPublishedObservationAtMs(publication) ?? createdAt;
}

/**
 * Resolves public/non-owner session recency without exposing operation-private
 * writes above a snapshot's immutable publication ceiling. Hosted sessions
 * preserve their historical `updatedAt` behavior; a complete snapshot uses
 * the observation time already committed in its publication tuple.
 */
export function resolveSessionTranscriptNonOwnerRecencyMs(
    publication: object,
    hostedUpdatedAt: Date,
): number {
    return resolveSessionTranscriptPublicationRecencyMs({
        createdAt: hostedUpdatedAt,
        liveRecencyAt: hostedUpdatedAt,
    }, publication);
}

/**
 * Portable database predicates cannot reject every malformed publication tuple
 * (notably whitespace-only publication ids). Refill a bounded read here so
 * fail-closed runtime admission cannot consume a caller's `take` or lookahead.
 */
export async function collectSessionTranscriptVisibleRowsBeforeTake<Row>(params: Readonly<{
    take: number | undefined;
    fetchPage: (page: Readonly<{ skip?: number; take?: number }>) => Promise<readonly Row[]>;
    isOwner: (row: Row) => boolean;
    readPublication: (row: Row) => object;
}>): Promise<Row[]> {
    const admits = (row: Row): boolean =>
        params.isOwner(row) || isSessionTranscriptShareable(params.readPublication(row));

    if (params.take === undefined) {
        return (await params.fetchPage({})).filter(admits);
    }
    if (!Number.isSafeInteger(params.take) || params.take <= 0) {
        return [];
    }

    const admitted: Row[] = [];
    let skip = 0;
    while (admitted.length < params.take) {
        const requested = params.take - admitted.length;
        const rows = await params.fetchPage({ skip: skip || undefined, take: requested });
        for (const row of rows) {
            if (admits(row)) admitted.push(row);
        }
        skip += rows.length;
        if (rows.length < requested) break;
    }
    return admitted;
}

/**
 * Resolves the only server-readable transcript publication boundary.
 *
 * Missing, malformed, or incomplete external state fails closed at sequence
 * zero. Only an explicit hosted state leaves the transcript unbounded.
 */
export function resolveSessionTranscriptPublicationCeiling(
    publication: object,
): number | null {
    const fields = publication as SessionTranscriptPublicationFields;
    switch (fields.currentStorageState) {
        case "hosted":
            return null;
        case "server_partial":
            return readServerSequence(fields.acceptedThroughServerSeq) ?? 0;
        case "snapshot_complete":
            return hasCompletePublicationTuple(fields)
                ? readServerSequence(fields.publishedThroughServerSeq) ?? 0
                : 0;
        case "machine_only":
        case "legacy_external_unknown":
        default:
            return 0;
    }
}

/**
 * External readers must not advance past rows that are currently hidden but
 * may become publication-eligible later. This is deliberately derived beside
 * the canonical publication ceiling rather than reconstructed by callers.
 */
export function isSessionTranscriptPublicationBlocked(publication: object): boolean {
    if (!isSessionTranscriptShareable(publication)) return true;
    const fields = publication as SessionTranscriptPublicationFields;
    const ceiling = resolveSessionTranscriptPublicationCeiling(publication);
    if (ceiling === null) return false;
    if (fields.acceptedThroughServerSeq === null || fields.acceptedThroughServerSeq === undefined) {
        return false;
    }
    const acceptedThroughServerSeq = readServerSequence(fields.acceptedThroughServerSeq);
    return acceptedThroughServerSeq === null || acceptedThroughServerSeq > ceiling;
}

/**
 * Shared external projection admission for stored turns. The message endpoint
 * and the legacy turns endpoint consume this same publication decision.
 */
export function isExternalShareableSessionTurnVisible(params: Readonly<{
    row: SessionTurnStoredRow;
    publication: object;
}>): boolean {
    if (!isSessionTranscriptShareable(params.publication)) return false;
    const ceiling = resolveSessionTranscriptPublicationCeiling(params.publication);
    if (ceiling === null) return true;

    const anchors = parseStoredSessionTurnTranscriptAnchors(params.row.transcriptAnchorsJson);
    if (!anchors || typeof anchors.endSeqInclusive !== "number") return false;
    const sequenceFacts = [
        anchors.startUserMessageSeq,
        ...(anchors.userMessageSeqs ?? []),
        anchors.startSeqInclusive,
        anchors.endSeqInclusive,
        anchors.finalAssistantMessageSeq,
    ].filter((value): value is number => typeof value === "number");
    return sequenceFacts.every((value) => value <= ceiling);
}

function resolveExternalShareableTurnStartSeq(row: SessionTurnStoredRow): number | null {
    const anchors = parseStoredSessionTurnTranscriptAnchors(row.transcriptAnchorsJson);
    if (!anchors) return null;
    const starts = [
        anchors.startUserMessageSeq,
        ...(anchors.userMessageSeqs ?? []),
        anchors.startSeqInclusive,
    ]
        .map(readServerSequence)
        .filter((value): value is number => value !== null);
    return starts.length > 0 ? Math.min(...starts) : null;
}

/**
 * Produces the earliest valid hidden-turn boundary for a transaction-local
 * external transcript snapshot. Malformed legacy turn rows deliberately do
 * not create a global cursor stall.
 */
export function resolveExternalShareableTranscriptBlockedFromSeq(params: Readonly<{
    rows: readonly SessionTurnStoredRow[];
    publication: object;
}>): number | null {
    const ceiling = resolveSessionTranscriptPublicationCeiling(params.publication);
    if (!isSessionTranscriptShareable(params.publication) || ceiling === null) return null;

    const starts = params.rows.flatMap((row) => {
        if (isExternalShareableSessionTurnVisible({ row, publication: params.publication })) return [];
        const start = resolveExternalShareableTurnStartSeq(row);
        return start !== null && start <= ceiling ? [start] : [];
    });
    return starts.length > 0 ? Math.min(...starts) : null;
}

/**
 * A page-local, already-published input can still gain a shareable completed
 * turn. The publication reader therefore holds its cursor until the same
 * transaction can prove a terminal turn owns it, or the Pending owner has
 * durably recorded its only terminal no-turn outcome.
 *
 * This intentionally consumes the Server's private turn-range projection;
 * clients only receive the one earliest barrier, never a second turn owner or
 * per-row withholding reason.
 */
export function resolveExternalShareableTranscriptTurnSettlementBlockedFromSeq(params: Readonly<{
    messages: readonly Readonly<{
        seq: unknown;
        inputAdmissionReceipt?: unknown;
        deliveryResolution?: unknown;
    }>[];
    turns: readonly SessionTurnStoredRow[];
    hasLegacyTurnProjection: boolean;
    turnSnapshotExhausted: boolean;
    hasInconsistentTurnProjection: boolean;
}>): number | null {
    const pageSeqs = params.messages
        .map((message) => readServerSequence(message.seq))
        .filter((seq): seq is number => seq !== null)
        .sort((left, right) => left - right);
    const firstPageSeq = pageSeqs[0] ?? null;
    if (firstPageSeq === null) return null;

    // A v0 row has no private range projection. It may own any page row, so
    // no cursor claim is safe until the approved writer/backfill boundary has
    // drained it. Likewise, a bounded snapshot at capacity cannot prove that
    // every overlapping turn was observed.
    if (
        params.hasLegacyTurnProjection
        || params.turnSnapshotExhausted
        || params.hasInconsistentTurnProjection
    ) {
        return firstPageSeq;
    }

    const isTerminalOwner = (row: SessionTurnStoredRow, seq: number): boolean => {
        const status = PrimaryTurnStatusV1Schema.safeParse(row.status);
        if (!status.success || status.data === "in_progress") return false;
        const anchors = parseStoredSessionTurnTranscriptAnchors(row.transcriptAnchorsJson);
        if (!anchors) return false;
        if (anchors.userMessageSeqs?.includes(seq)) return true;
        const start = readServerSequence(anchors.startSeqInclusive);
        const end = readServerSequence(anchors.endSeqInclusive);
        return start !== null && end !== null && seq >= start && seq <= end;
    };

    for (const message of [...params.messages].sort((left, right) => {
        const leftSeq = readServerSequence(left.seq) ?? Number.MAX_SAFE_INTEGER;
        const rightSeq = readServerSequence(right.seq) ?? Number.MAX_SAFE_INTEGER;
        return leftSeq - rightSeq;
    })) {
        const seq = readServerSequence(message.seq);
        if (seq === null) continue;
        if (!SessionInputAdmissionReceiptV1Schema.safeParse(message.inputAdmissionReceipt).success) continue;
        if (parseSessionMessageDeliveryResolutionV1(message.deliveryResolution) !== null) continue;
        if (params.turns.some((row) => isTerminalOwner(row, seq))) continue;

        // Even no current turn row is not proof of finality: this admission
        // can still be claimed by a future turn, so crossing it would
        // permanently skip a later exact final anchor.
        return seq;
    }

    return null;
}

export async function loadSessionTranscriptPublication(
    reader: SessionPublicationReader,
    sessionId: string,
): Promise<SessionTranscriptPublicationFields> {
    return await reader.session.findUnique({
        where: { id: sessionId },
        select: SESSION_TRANSCRIPT_PUBLICATION_SELECT,
    }) ?? { currentStorageState: "legacy_external_unknown" };
}

export function applySessionTranscriptPublicationCeiling(
    seq: number,
    publication: object,
): number {
    const normalizedSeq = readServerSequence(seq) ?? 0;
    const ceiling = resolveSessionTranscriptPublicationCeiling(publication);
    return ceiling === null ? normalizedSeq : Math.min(normalizedSeq, ceiling);
}

/**
 * A finite publication ceiling means the Session's current live-work tuple
 * belongs to an operation-private state. The tuple has no server sequence of
 * its own, so it cannot be proved to describe the published transcript and
 * must not be projected to ordinary readers. Snapshot observation time is the
 * one durable public recency fact; initial/unknown external states fall back
 * to the already-visible creation time.
 */
export function projectSessionTranscriptPublicationPreview(params: Readonly<{
    seq: number;
    lastViewedSessionSeq?: number | null;
    latestReadyEventSeq?: number | null;
    latestReadyEventAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
    meaningfulActivityAt?: Date | null;
    lastActiveAt: Date;
}>, publication: object): Readonly<{
    seq: number;
    lastViewedSessionSeq: number | null | undefined;
    latestReadyEventSeq: number | null | undefined;
    latestReadyEventAt: Date | null | undefined;
    updatedAt: number;
    meaningfulActivityAt: number;
    activeAt: number;
    acceptedThroughServerSeq: number | null;
    hasLiveFacts: boolean;
}> {
    const sequenceProjection = applySessionTranscriptPublicationCeilingToProjection({
        seq: params.seq,
        lastViewedSessionSeq: params.lastViewedSessionSeq,
        latestReadyEventSeq: params.latestReadyEventSeq,
        latestReadyEventAt: params.latestReadyEventAt,
    }, publication);
    const hasLiveFacts = resolveSessionTranscriptPublicationCeiling(publication) === null;
    const acceptedThroughServerSeq = readServerSequence(
        (publication as SessionTranscriptPublicationFields).acceptedThroughServerSeq,
    );
    const ceiling = resolveSessionTranscriptPublicationCeiling(publication);

    return {
        ...sequenceProjection,
        updatedAt: resolveSessionTranscriptPublicationRecencyMs({
            createdAt: params.createdAt,
            liveRecencyAt: params.updatedAt,
        }, publication),
        meaningfulActivityAt: resolveSessionTranscriptPublicationRecencyMs({
            createdAt: params.createdAt,
            liveRecencyAt: params.meaningfulActivityAt,
        }, publication),
        activeAt: resolveSessionTranscriptPublicationRecencyMs({
            createdAt: params.createdAt,
            liveRecencyAt: params.lastActiveAt,
        }, publication),
        acceptedThroughServerSeq: acceptedThroughServerSeq === null
            ? null
            : ceiling === null
                ? acceptedThroughServerSeq
                : Math.min(acceptedThroughServerSeq, ceiling),
        hasLiveFacts,
    };
}

/**
 * Change rows are themselves observable notifications. A finite recipient can
 * receive only a hint whose complete shape proves it is already published;
 * all other changes are suppressed rather than represented by a null hint.
 */
export function projectSessionTranscriptPublicationChangeHint(
    hint: unknown,
    publication: object,
    recipientAccountId: string,
): SessionTranscriptPublicationRecipientDecision<unknown> {
    const fields = publication as SessionTranscriptPublicationFields;
    if (!isFiniteSessionTranscriptPublicationRecipient(fields, recipientAccountId)) {
        return publishSessionTranscriptPublicationRecipientValue(hint);
    }

    const ceiling = resolveSessionTranscriptPublicationCeiling(fields);
    return ceiling !== null && isPublishedSessionTranscriptChangeHint(hint, ceiling)
        ? publishSessionTranscriptPublicationRecipientValue(hint)
        : suppressSessionTranscriptPublicationRecipientValue();
}

export type SessionTranscriptPublicationRealtimeProjection = Readonly<{
    active?: boolean;
    activeAt?: number;
    lastViewedSessionSeq?: number;
    pendingPermissionRequestCount?: number;
    pendingUserActionRequestCount?: number;
    pendingRequestObservedAt?: number | null;
    latestReadyEventSeq?: number | null;
    latestReadyEventAt?: number | null;
    latestTurnId?: string | null;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    latestTurnStatusObservedAt?: number | null;
    lastRuntimeIssue?: SessionRuntimeIssueV1 | null;
    runtimeActivityState?: "active" | "idle" | "unknown";
    runtimeActivityActiveCount?: number;
    runtimeActivityObservedAt?: number | null;
    runtimeActivityRevision?: number;
    meaningfulActivityAt?: number;
    archivedAt?: number | null;
}>;

function projectFiniteSessionTranscriptPublicationRealtimeProjection(
    projection: SessionTranscriptPublicationRealtimeProjection,
    ceiling: number,
): SessionTranscriptPublicationRealtimeProjection | null {
    const fields = projection as Readonly<Record<string, unknown>>;
    if (
        hasOnlyKeys(fields, ["lastViewedSessionSeq"], ["lastViewedSessionSeq"])
        && isPublishedSequence(fields.lastViewedSessionSeq, ceiling)
    ) {
        return projection;
    }
    if (
        hasOnlyKeys(fields, ["latestReadyEventSeq", "latestReadyEventAt"], ["latestReadyEventSeq", "latestReadyEventAt"])
        && isPublishedSequence(fields.latestReadyEventSeq, ceiling)
        && readServerTimestamp(fields.latestReadyEventAt) !== null
    ) {
        return projection;
    }
    if (Object.prototype.hasOwnProperty.call(fields, "archivedAt")) {
        const archivedAt = fields.archivedAt;
        if (archivedAt === null) {
            return { archivedAt: null };
        }
        const archivedAtTimestamp = readServerTimestamp(archivedAt);
        if (archivedAtTimestamp !== null) {
            return { archivedAt: archivedAtTimestamp };
        }
    }
    return null;
}

/**
 * The server-side recipient projection for direct session realtime payloads.
 * Hosted sessions and owners retain their live semantics. A finite
 * collaborator receives only a complete, already-published sequence fact or
 * the independently shareable archive state; private live tuples are omitted.
 */
export function projectSessionTranscriptPublicationRealtimeProjection(
    projection: SessionTranscriptPublicationRealtimeProjection,
    session: SessionTranscriptPublicationRecipientProjectionRow,
    recipientAccountId: string,
): SessionTranscriptPublicationRecipientDecision<SessionTranscriptPublicationRealtimeProjection> {
    if (!isFiniteSessionTranscriptPublicationRecipient(session, recipientAccountId)) {
        return publishSessionTranscriptPublicationRecipientValue(projection);
    }

    const ceiling = resolveSessionTranscriptPublicationCeiling(session);
    const published = ceiling === null
        ? projection
        : projectFiniteSessionTranscriptPublicationRealtimeProjection(projection, ceiling);
    return published
        ? publishSessionTranscriptPublicationRecipientValue(published)
        : suppressSessionTranscriptPublicationRecipientValue();
}

export type SessionTranscriptPublicationPendingProjection = Readonly<{
    pendingVersion: number;
    pendingCount: number;
    pendingBlockedCount?: number;
    changedByAccountId?: string;
    meaningfulActivityAt?: Date | number;
    pendingActivationRequestId?: string;
}>;

/**
 * Pending notifications have no sequence anchor. A finite collaborator cannot
 * be shown even an empty tuple because its presence and cadence are private.
 */
export function projectSessionTranscriptPublicationPendingProjection(
    projection: SessionTranscriptPublicationPendingProjection,
    publication: object,
    recipientAccountId: string,
): SessionTranscriptPublicationRecipientDecision<SessionTranscriptPublicationPendingProjection> {
    const fields = publication as SessionTranscriptPublicationFields;
    return isFiniteSessionTranscriptPublicationRecipient(fields, recipientAccountId)
        ? suppressSessionTranscriptPublicationRecipientValue()
        : publishSessionTranscriptPublicationRecipientValue(projection);
}

/**
 * Transcript stream segments carry no canonical server sequence, so only the
 * owner or a hosted session may receive them live.
 */
export function projectSessionTranscriptPublicationUnanchoredProjection<T>(
    projection: T,
    publication: SessionTranscriptPublicationFields,
    recipientAccountId: string,
): SessionTranscriptPublicationRecipientDecision<T> {
    return isFiniteSessionTranscriptPublicationRecipient(publication, recipientAccountId)
        ? suppressSessionTranscriptPublicationRecipientValue()
        : publishSessionTranscriptPublicationRecipientValue(projection);
}

export async function loadSessionTranscriptPublicationRecipientProjection(
    sessionId: string,
): Promise<SessionTranscriptPublicationRecipientProjectionRow | null> {
    if (typeof sessionId !== "string" || !sessionId) return null;
    return await db.session.findUnique({
        where: { id: sessionId },
        select: SESSION_TRANSCRIPT_PUBLICATION_RECIPIENT_PROJECTION_SELECT,
    });
}

/**
 * An anchored turn-derived fact is safe exactly when its source message is
 * within the same canonical publication ceiling as the rest of the transcript.
 */
export function filterSessionTranscriptPublicationSequenceFacts(
    values: readonly number[],
    publication: object,
): number[] {
    const ceiling = resolveSessionTranscriptPublicationCeiling(publication);
    return values.filter((value) =>
        Number.isSafeInteger(value)
        && value >= 0
        && (ceiling === null || value <= ceiling));
}

function intersectSequenceFilter(
    filter: Prisma.IntFilter<"SessionMessage"> | number | undefined,
    ceiling: number,
): Prisma.IntFilter<"SessionMessage"> {
    if (typeof filter === "number") {
        return { equals: filter, lte: ceiling };
    }
    const currentUpperBound = readServerSequence(filter?.lte);
    return {
        ...(filter ?? {}),
        lte: currentUpperBound === null ? ceiling : Math.min(currentUpperBound, ceiling),
    };
}

export function buildSessionMessagePublicationWhere(params: Readonly<{
    where: Prisma.SessionMessageWhereInput;
    publication: object;
}>): Prisma.SessionMessageWhereInput {
    const ceiling = resolveSessionTranscriptPublicationCeiling(params.publication);
    if (ceiling === null) return params.where;
    return {
        ...params.where,
        seq: intersectSequenceFilter(params.where.seq, ceiling),
    };
}

/**
 * Public/friend message reads must re-evaluate current shareability in the
 * message statement as well as applying the previously observed sequence
 * ceiling. This prevents a hosted-to-external transition between statements
 * from widening a stale hosted read.
 */
export function buildShareableSessionMessagePublicationWhere(params: Readonly<{
    where: Prisma.SessionMessageWhereInput;
    publication: object;
    additionalSessionWhere?: Prisma.SessionWhereInput;
}>): Prisma.SessionMessageWhereInput {
    return {
        ...buildSessionMessagePublicationWhere(params),
        session: params.additionalSessionWhere
            ? {
                AND: [
                    createSessionTranscriptShareableWhere(),
                    params.additionalSessionWhere,
                ],
            }
            : createSessionTranscriptShareableWhere(),
    };
}

export function buildSessionMessagesPublicationWhere(
    rows: readonly SessionTranscriptPublicationRow[],
): Prisma.SessionMessageWhereInput {
    const hostedIds: string[] = [];
    const idsByCeiling = new Map<number, string[]>();

    for (const row of rows) {
        const ceiling = resolveSessionTranscriptPublicationCeiling(row);
        if (ceiling === null) {
            hostedIds.push(row.id);
            continue;
        }
        if (ceiling === 0) continue;
        const ids = idsByCeiling.get(ceiling);
        if (ids) {
            ids.push(row.id);
        } else {
            idsByCeiling.set(ceiling, [row.id]);
        }
    }

    const OR: Prisma.SessionMessageWhereInput[] = [];
    if (hostedIds.length > 0) {
        OR.push({ sessionId: { in: hostedIds } });
    }
    for (const [ceiling, sessionIds] of idsByCeiling) {
        OR.push({
            sessionId: { in: sessionIds },
            seq: { lte: ceiling },
        });
    }

    return OR.length > 0 ? { OR } : { sessionId: { in: [] } };
}

export function applySessionTranscriptPublicationCeilingToProjection<
    T extends Readonly<{
        seq: number;
        lastViewedSessionSeq?: number | null;
        latestReadyEventSeq?: number | null;
        latestReadyEventAt?: Date | null;
    }>,
>(
    projection: T,
    publication: object,
): Pick<T, "seq" | "lastViewedSessionSeq" | "latestReadyEventSeq" | "latestReadyEventAt"> {
    const ceiling = resolveSessionTranscriptPublicationCeiling(publication);
    const seq = applySessionTranscriptPublicationCeiling(projection.seq, publication);
    const latestReadyEventSeq = readServerSequence(projection.latestReadyEventSeq);
    const readyEventIsPublished = latestReadyEventSeq !== null
        && (ceiling === null || latestReadyEventSeq <= ceiling);
    return {
        seq,
        lastViewedSessionSeq:
            projection.lastViewedSessionSeq === null || projection.lastViewedSessionSeq === undefined
                ? projection.lastViewedSessionSeq
                : ceiling === null
                    ? readServerSequence(projection.lastViewedSessionSeq) ?? 0
                    : Math.min(readServerSequence(projection.lastViewedSessionSeq) ?? 0, ceiling),
        latestReadyEventSeq:
            readyEventIsPublished
                ? latestReadyEventSeq
                : null,
        latestReadyEventAt:
            readyEventIsPublished
                ? projection.latestReadyEventAt
                : null,
    };
}

function readDateMs(value: unknown): number | null {
    if (!(value instanceof Date)) return null;
    const timestamp = value.getTime();
    return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

function createMeaningfulActivityCursorWhere(
    cursor: SessionTranscriptPublicationActivityCursor | null | undefined,
): Prisma.SessionWhereInput {
    if (!cursor) return {};
    const activityAt = createCursorDate(cursor.activityAt);
    if (!activityAt) return { id: { in: [] } };
    return {
        AND: [{
            OR: [
                { meaningfulActivityAt: { lt: activityAt } },
                { meaningfulActivityAt: activityAt, id: { lt: cursor.sessionId } },
            ],
        }],
    };
}

function createCreatedAtCursorWhere(
    cursor: SessionTranscriptPublicationActivityCursor | null | undefined,
): Prisma.SessionWhereInput {
    if (!cursor) return {};
    const activityAt = createCursorDate(cursor.activityAt);
    if (!activityAt) return { id: { in: [] } };
    return {
        AND: [{
            OR: [
                { createdAt: { lt: activityAt } },
                { createdAt: activityAt, id: { lt: cursor.sessionId } },
            ],
        }],
    };
}

function createMaterializedObservationCursorWhere(
    cursor: SessionTranscriptPublicationActivityCursor | null | undefined,
): Prisma.SessionWhereInput {
    if (!cursor || !Number.isSafeInteger(cursor.activityAt) || cursor.activityAt < 0) {
        return cursor ? { id: { in: [] } } : {};
    }
    const activityAt = BigInt(cursor.activityAt);
    return {
        AND: [{
            OR: [
                { materializedThroughSourceAt: { lt: activityAt } },
                { materializedThroughSourceAt: activityAt, id: { lt: cursor.sessionId } },
            ],
        }],
    };
}

function createCursorDate(value: number): Date | null {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function readPublishedObservationAtMs(publication: object): number | null {
    const fields = publication as SessionTranscriptPublicationFields;
    return fields.currentStorageState === "snapshot_complete"
        && hasCompletePublicationTuple(fields)
        ? readServerTimestamp(fields.materializedThroughSourceAt)
        : null;
}
