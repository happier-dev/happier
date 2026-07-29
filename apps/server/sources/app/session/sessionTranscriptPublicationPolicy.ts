import type { Prisma } from "@prisma/client";

export const SESSION_TRANSCRIPT_PUBLICATION_SELECT = {
    currentStorageState: true,
    acceptedThroughServerSeq: true,
    materializationPublicationId: true,
    materializedThroughSourceAt: true,
    publishedThroughServerSeq: true,
} as const;

export type SessionTranscriptPublicationFields = Readonly<{
    currentStorageState?: unknown;
    acceptedThroughServerSeq?: unknown;
    materializationPublicationId?: unknown;
    materializedThroughSourceAt?: unknown;
    publishedThroughServerSeq?: unknown;
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

function hasCompletePublicationTuple(fields: SessionTranscriptPublicationFields): boolean {
    const publicationId = fields.materializationPublicationId;
    return typeof publicationId === "string"
        && publicationId.trim().length > 0
        && readServerTimestamp(fields.materializedThroughSourceAt) !== null;
}

/**
 * Sharing is an authority transfer, not a ceiling-limited owner read. External
 * transcripts become shareable only after one complete snapshot publication.
 * A row without the additive state column predates external import and remains
 * compatible with the historical hosted behavior.
 */
export function isSessionTranscriptShareable(publication: object): boolean {
    const fields = publication as SessionTranscriptPublicationFields;
    if (!Object.prototype.hasOwnProperty.call(publication, "currentStorageState")) {
        return true;
    }
    if (fields.currentStorageState === "hosted") {
        return true;
    }
    return fields.currentStorageState === "snapshot_complete"
        && hasCompletePublicationTuple(fields)
        && readServerSequence(fields.publishedThroughServerSeq) !== null;
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
            where: {
                currentStorageState: "snapshot_complete",
                materializationPublicationId: { not: "" },
                materializedThroughSourceAt: {
                    gte: 0,
                    lte: BigInt(Number.MAX_SAFE_INTEGER),
                },
                publishedThroughServerSeq: { gte: 0 },
            },
            orderBy: [
                { materializedThroughSourceAt: "desc" },
                { id: "desc" },
            ],
        },
    ];
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
    const fields = publication as SessionTranscriptPublicationFields;
    if (fields.currentStorageState !== "snapshot_complete") {
        return hostedUpdatedAt.getTime();
    }
    return readServerTimestamp(fields.materializedThroughSourceAt) ?? 0;
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
 * A row without `currentStorageState` is a pre-migration compatibility row.
 * No released producer could stage private import rows in that shape, so it is
 * equivalent to hosted. Once the column exists, malformed or incomplete
 * external state fails closed at sequence zero.
 */
export function resolveSessionTranscriptPublicationCeiling(
    publication: object,
): number | null {
    const fields = publication as SessionTranscriptPublicationFields;
    if (!Object.prototype.hasOwnProperty.call(publication, "currentStorageState")) {
        return null;
    }

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
}>): Prisma.SessionMessageWhereInput {
    return {
        ...buildSessionMessagePublicationWhere(params),
        session: createSessionTranscriptShareableWhere(),
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
