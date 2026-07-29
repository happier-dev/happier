import type { Prisma as PrismaTypes } from "@prisma/client";
import type {
    ReviewCommentAnchorV1,
    ReviewCommentEventV1,
    ReviewCommentListRequestV1,
    ReviewCommentV1,
    StoredJsonContentEnvelope,
} from "@happier-dev/protocol";
import { ReviewCommentEventV1Schema, ReviewCommentV1Schema, StoredJsonContentEnvelopeSchema } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { isPrismaErrorCode, prismaRuntime as Prisma } from "@/storage/prisma";
import { ReviewCommentOperationError } from "./errors";
import {
    applyReviewCommentListQuery,
    matchesReviewCommentListFilters,
    normalizeReviewCommentListFilters,
    type ReviewCommentListResult,
} from "./queries";

export type ReviewCommentStoreListParams = Readonly<{
    accountId: string;
    filters: ReviewCommentListRequestV1;
}>;

export type ReviewCommentStoreCommentParams = Readonly<{
    accountId: string;
    commentId: string;
}>;

export type ReviewCommentStoreCommitParams = Readonly<{
    accountId: string;
    comment: ReviewCommentV1;
    event: ReviewCommentEventV1;
    storageMode?: "plain" | "e2ee";
    eventEnvelope?: StoredJsonContentEnvelope;
}>;

export type ReviewCommentStoreCreateParams = ReviewCommentStoreCommitParams & Readonly<{
    createClientMutationId: string;
    createRequestFingerprint: string;
}>;

export type ReviewCommentStoreCreateResult = Readonly<{
    comment: ReviewCommentV1;
    replayed: boolean;
}>;

export interface ReviewCommentStore {
    get(params: ReviewCommentStoreCommentParams): Promise<ReviewCommentV1 | null>;
    list(params: ReviewCommentStoreListParams): Promise<ReviewCommentListResult>;
    listEvents(params: ReviewCommentStoreCommentParams): Promise<readonly ReviewCommentEventV1[]>;
    create(params: ReviewCommentStoreCreateParams): Promise<ReviewCommentStoreCreateResult>;
    commit(params: ReviewCommentStoreCommitParams): Promise<void>;
}

type ReviewCommentRow = {
    id: string;
    account_id: string;
    project_id: string;
    workspace_id: string | null;
    session_id: string | null;
    run_id: string | null;
    engine_id: string | null;
    finding_id: string | null;
    create_client_mutation_id: string | null;
    create_request_fingerprint: string | null;
    thread_id: string;
    parent_comment_id: string | null;
    state: string;
    flags_json: string;
    anchor_json: string;
    snapshot_envelope_json: string;
    body_envelope_json: string;
    body_version: number | bigint;
    author_json: string;
    edits_json: string;
    dispositions_json: string;
    evidence_json: string | null;
    transitions_json: string;
    fingerprint_json: string | null;
    linked_refs_json: string | null;
    suggested_fix_json: string | null;
    metadata_json: string | null;
    tombstone_json: string | null;
    server_revision: number | bigint;
    created_at: number | bigint;
    updated_at: number | bigint;
};

type ReviewCommentEventRow = {
    event_id: string;
    comment_id: string;
    account_id: string;
    project_id: string;
    event_kind: string;
    event_envelope_json: string;
    bulk_action_id: string | null;
    client_mutation_id: string | null;
    actor_json: string;
    author_device_id: string | null;
    client_lamport: number | bigint | null;
    server_revision: number | bigint;
    created_at: number | bigint;
};

const COMMENT_SELECT_COLUMNS = Prisma.raw([
    "id",
    "account_id",
    "project_id",
    "workspace_id",
    "session_id",
    "run_id",
    "engine_id",
    "finding_id",
    "create_client_mutation_id",
    "create_request_fingerprint",
    "thread_id",
    "parent_comment_id",
    "state",
    "flags_json",
    "anchor_json",
    "snapshot_envelope_json",
    "body_envelope_json",
    "body_version",
    "author_json",
    "edits_json",
    "dispositions_json",
    "evidence_json",
    "transitions_json",
    "fingerprint_json",
    "linked_refs_json",
    "suggested_fix_json",
    "metadata_json",
    "tombstone_json",
    "server_revision",
    "created_at",
    "updated_at",
].join(", "));

function parseJson(value: string): unknown {
    return JSON.parse(value);
}

function stringifyJson(value: unknown): string {
    return JSON.stringify(value);
}

function stringifyOptionalJson(value: unknown): string | null {
    return typeof value === "undefined" ? null : stringifyJson(value);
}

function storageMode(params: { storageMode?: "plain" | "e2ee" }): "plain" | "e2ee" {
    return params.storageMode ?? "plain";
}

function parseStoredEnvelope(value: unknown, fieldName: string): StoredJsonContentEnvelope {
    const parsed = StoredJsonContentEnvelopeSchema.safeParse(value);
    if (!parsed.success) {
        throw new Error(`Invalid review-comment ${fieldName} envelope`);
    }
    return parsed.data;
}

function maybeStoredEnvelope(value: unknown): StoredJsonContentEnvelope | null {
    const parsed = StoredJsonContentEnvelopeSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function assertEnvelopeStorageMode(params: Readonly<{
    envelope: StoredJsonContentEnvelope;
    fieldName: string;
    storageMode: "plain" | "e2ee";
}>): void {
    const envelopeMode = params.envelope.t === "encrypted" ? "e2ee" : "plain";
    if (envelopeMode === params.storageMode) return;
    throw new ReviewCommentOperationError(
        "review_comment_encryption_mode_mismatch",
        `Review comment ${params.fieldName} envelope does not match ${params.storageMode} storage mode`,
    );
}

function encodeStoredEnvelope(params: Readonly<{
    value: unknown;
    fieldName: string;
    storageMode: "plain" | "e2ee";
}>): string {
    const envelope = maybeStoredEnvelope(params.value);
    if (envelope) {
        assertEnvelopeStorageMode({ envelope, fieldName: params.fieldName, storageMode: params.storageMode });
        return stringifyJson(envelope);
    }
    if (params.storageMode === "e2ee") {
        throw new ReviewCommentOperationError(
            "review_comment_encryption_mode_mismatch",
            `Review comment ${params.fieldName} must be an encrypted envelope for e2ee storage mode`,
        );
    }
    return stringifyJson({ t: "plain", v: params.value } satisfies StoredJsonContentEnvelope);
}

function decodeStoredEnvelope(value: string, fieldName: string): unknown {
    const envelope = parseStoredEnvelope(parseJson(value), fieldName);
    return envelope.t === "plain" ? envelope.v : envelope;
}

function toNumber(value: number | bigint): number {
    return typeof value === "bigint" ? Number(value) : value;
}

function anchorFilePath(anchor: ReviewCommentAnchorV1): string | null {
    return "filePath" in anchor ? anchor.filePath : null;
}

function anchorFolderPath(anchor: ReviewCommentAnchorV1): string | null {
    return "folderPath" in anchor ? anchor.folderPath : null;
}

function rowToComment(row: ReviewCommentRow): ReviewCommentV1 {
    return ReviewCommentV1Schema.parse({
        v: 1,
        id: row.id,
        accountId: row.account_id,
        projectId: row.project_id,
        workspaceId: row.workspace_id ?? undefined,
        sessionId: row.session_id ?? undefined,
        runId: row.run_id ?? undefined,
        engineId: row.engine_id ?? undefined,
        findingId: row.finding_id ?? undefined,
        anchor: parseJson(row.anchor_json),
        snapshot: decodeStoredEnvelope(row.snapshot_envelope_json, "snapshot"),
        body: decodeStoredEnvelope(row.body_envelope_json, "body"),
        bodyVersion: toNumber(row.body_version),
        edits: parseJson(row.edits_json),
        author: parseJson(row.author_json),
        state: row.state,
        flags: parseJson(row.flags_json),
        dispositions: parseJson(row.dispositions_json),
        parentCommentId: row.parent_comment_id ?? undefined,
        threadId: row.thread_id,
        evidence: row.evidence_json ? parseJson(row.evidence_json) : undefined,
        transitions: parseJson(row.transitions_json),
        tombstone: row.tombstone_json ? parseJson(row.tombstone_json) : undefined,
        fingerprint: row.fingerprint_json ? parseJson(row.fingerprint_json) : undefined,
        linkedRefs: row.linked_refs_json ? parseJson(row.linked_refs_json) : undefined,
        suggestedFix: row.suggested_fix_json ? parseJson(row.suggested_fix_json) : undefined,
        metadata: row.metadata_json ? parseJson(row.metadata_json) : undefined,
        createdAt: toNumber(row.created_at),
        updatedAt: toNumber(row.updated_at),
        serverRevision: toNumber(row.server_revision),
    });
}

function rowToEvent(row: ReviewCommentEventRow): ReviewCommentEventV1 {
    return ReviewCommentEventV1Schema.parse({
        eventId: row.event_id,
        commentId: row.comment_id,
        accountId: row.account_id,
        projectId: row.project_id,
        eventKind: row.event_kind,
        actor: parseJson(row.actor_json),
        createdAt: toNumber(row.created_at),
        serverRevision: toNumber(row.server_revision),
        bulkActionId: row.bulk_action_id ?? undefined,
        authorDeviceId: row.author_device_id ?? undefined,
        clientLamport: row.client_lamport == null ? undefined : toNumber(row.client_lamport),
        event: decodeStoredEnvelope(row.event_envelope_json, "event"),
    });
}

function buildStoredCommentValues(comment: ReviewCommentV1, mode: "plain" | "e2ee") {
    const anchor = comment.anchor;
    return {
        flagsJson: stringifyJson(comment.flags),
        anchorJson: stringifyJson(anchor),
        anchorFilePath: anchorFilePath(anchor),
        anchorFolderPath: anchorFolderPath(anchor),
        snapshotEnvelopeJson: encodeStoredEnvelope({
            value: comment.snapshot,
            fieldName: "snapshot",
            storageMode: mode,
        }),
        bodyEnvelopeJson: encodeStoredEnvelope({
            value: comment.body,
            fieldName: "body",
            storageMode: mode,
        }),
        authorJson: stringifyJson(comment.author),
        editsJson: stringifyJson(comment.edits),
        dispositionsJson: stringifyJson(comment.dispositions),
        evidenceJson: stringifyOptionalJson(comment.evidence),
        transitionsJson: stringifyJson(comment.transitions),
        fingerprintJson: stringifyOptionalJson(comment.fingerprint),
        linkedRefsJson: stringifyOptionalJson(comment.linkedRefs),
        suggestedFixJson: stringifyOptionalJson(comment.suggestedFix),
        metadataJson: stringifyOptionalJson(comment.metadata),
        tombstoneJson: stringifyOptionalJson(comment.tombstone),
    };
}

function resolveCreateReplay(
    row: ReviewCommentRow,
    expectedRequestFingerprint: string,
): ReviewCommentStoreCreateResult {
    if (row.create_request_fingerprint !== expectedRequestFingerprint) {
        throw new ReviewCommentOperationError(
            "review_comment_idempotency_conflict",
            "Review comment create mutation was already used for a different request",
        );
    }
    return { comment: rowToComment(row), replayed: true };
}

function createMutationLookupQuery(accountId: string, createClientMutationId: string): PrismaTypes.Sql {
    return Prisma.sql`
        SELECT ${COMMENT_SELECT_COLUMNS}
        FROM review_comments
        WHERE account_id = ${accountId} AND create_client_mutation_id = ${createClientMutationId}
        LIMIT 1
    `;
}

export function createInMemoryReviewCommentStore(): ReviewCommentStore {
    const comments = new Map<string, ReviewCommentV1>();
    const events = new Map<string, ReviewCommentEventV1[]>();
    const creates = new Map<string, Readonly<{
        comment: ReviewCommentV1;
        requestFingerprint: string;
    }>>();

    return {
        async get(params) {
            return comments.get(`${params.accountId}:${params.commentId}`) ?? null;
        },
        async list(params) {
            return applyReviewCommentListQuery([...comments.values()]
                .filter((comment) => comment.accountId === params.accountId)
                .filter((comment) => matchesReviewCommentListFilters(comment, params.filters)), params.filters);
        },
        async listEvents(params) {
            return events.get(`${params.accountId}:${params.commentId}`) ?? [];
        },
        async create(params) {
            const createKey = `${params.accountId}:${params.createClientMutationId}`;
            const existing = creates.get(createKey);
            if (existing) {
                if (existing.requestFingerprint !== params.createRequestFingerprint) {
                    throw new ReviewCommentOperationError(
                        "review_comment_idempotency_conflict",
                        "Review comment create mutation was already used for a different request",
                    );
                }
                return { comment: existing.comment, replayed: true };
            }
            const comment = ReviewCommentV1Schema.parse(params.comment);
            const event = ReviewCommentEventV1Schema.parse(params.event);
            creates.set(createKey, { comment, requestFingerprint: params.createRequestFingerprint });
            comments.set(`${params.accountId}:${comment.id}`, comment);
            events.set(`${params.accountId}:${comment.id}`, [event]);
            return { comment, replayed: false };
        },
        async commit(params) {
            comments.set(`${params.accountId}:${params.comment.id}`, ReviewCommentV1Schema.parse(params.comment));
            const key = `${params.accountId}:${params.comment.id}`;
            const current = events.get(key) ?? [];
            events.set(key, [...current, ReviewCommentEventV1Schema.parse(params.event)]);
        },
    };
}

function eventClientMutationId(event: ReviewCommentEventV1): string | null {
    const value = event.event.clientMutationId;
    return typeof value === "string" ? value : null;
}

function escapeSqlLikePattern(value: string): string {
    return value
        .replace(/~/g, "~~")
        .replace(/%/g, "~%")
        .replace(/_/g, "~_");
}

function buildWhere(params: ReviewCommentStoreListParams): PrismaTypes.Sql[] {
    const filters = normalizeReviewCommentListFilters(params.filters);
    const where = [Prisma.sql`account_id = ${params.accountId}`];
    if (filters.projectId) where.push(Prisma.sql`project_id = ${filters.projectId}`);
    if (filters.workspaceId) where.push(Prisma.sql`workspace_id = ${filters.workspaceId}`);
    if (filters.sessionId) where.push(Prisma.sql`session_id = ${filters.sessionId}`);
    if (filters.runId) where.push(Prisma.sql`run_id = ${filters.runId}`);
    if (filters.engineId) where.push(Prisma.sql`engine_id = ${filters.engineId}`);
    if (filters.states.length === 1) {
        where.push(Prisma.sql`state = ${filters.states[0]}`);
    } else if (filters.states.length > 1) {
        where.push(Prisma.sql`state IN (${Prisma.join(filters.states)})`);
    }
    if (filters.filePath) where.push(Prisma.sql`anchor_file_path = ${filters.filePath}`);
    if (filters.folderPath) {
        where.push(Prisma.sql`(
            anchor_folder_path = ${filters.folderPath}
            OR anchor_file_path = ${filters.folderPath}
            OR anchor_file_path LIKE ${`${escapeSqlLikePattern(filters.folderPath)}/%`} ESCAPE '~'
        )`);
    }
    return where;
}

async function readCommentRows(params: ReviewCommentStoreListParams): Promise<ReviewCommentRow[]> {
    const where = buildWhere(params);
    return await db.$queryRaw<ReviewCommentRow[]>(Prisma.sql`
        SELECT ${COMMENT_SELECT_COLUMNS}
        FROM review_comments
        WHERE ${Prisma.join(where, " AND ")}
        ORDER BY updated_at DESC, server_revision DESC, id DESC
    `);
}

export function createSqlReviewCommentStore(): ReviewCommentStore {
    return {
        async get(params) {
            const rows = await db.$queryRaw<ReviewCommentRow[]>(Prisma.sql`
                SELECT ${COMMENT_SELECT_COLUMNS}
                FROM review_comments
                WHERE account_id = ${params.accountId} AND id = ${params.commentId}
                LIMIT 1
            `);
            const row = rows[0];
            return row ? rowToComment(row) : null;
        },
        async list(params) {
            const rows = await readCommentRows(params);
            return applyReviewCommentListQuery(rows
                .map(rowToComment)
                .filter((comment) => matchesReviewCommentListFilters(comment, params.filters)), params.filters);
        },
        async listEvents(params) {
            const rows = await db.$queryRaw<ReviewCommentEventRow[]>(Prisma.sql`
                SELECT event_id, comment_id, account_id, project_id, event_kind, event_envelope_json,
                    bulk_action_id, client_mutation_id, actor_json, author_device_id, client_lamport,
                    server_revision, created_at
                FROM review_comment_events
                WHERE account_id = ${params.accountId} AND comment_id = ${params.commentId}
                ORDER BY server_revision ASC
            `);
            return rows.map(rowToEvent);
        },
        async create(params) {
            const comment = ReviewCommentV1Schema.parse(params.comment);
            const event = ReviewCommentEventV1Schema.parse(params.event);
            const mode = storageMode(params);
            const values = buildStoredCommentValues(comment, mode);
            const eventEnvelopeJson = encodeStoredEnvelope({
                value: params.eventEnvelope ?? event.event,
                fieldName: "event",
                storageMode: mode,
            });
            try {
                return await inTx(async (tx) => {
                    const existingRows = await tx.$queryRaw<ReviewCommentRow[]>(
                        createMutationLookupQuery(params.accountId, params.createClientMutationId),
                    );
                    const existing = existingRows[0];
                    if (existing) {
                        return resolveCreateReplay(existing, params.createRequestFingerprint);
                    }

                    await tx.reviewComment.create({
                        data: {
                            id: comment.id,
                            accountId: params.accountId,
                            projectId: comment.projectId,
                            workspaceId: comment.workspaceId,
                            sessionId: comment.sessionId,
                            runId: comment.runId,
                            engineId: comment.engineId,
                            findingId: comment.findingId,
                            createClientMutationId: params.createClientMutationId,
                            createRequestFingerprint: params.createRequestFingerprint,
                            threadId: comment.threadId,
                            parentCommentId: comment.parentCommentId,
                            state: comment.state,
                            flagsJson: values.flagsJson,
                            anchorJson: values.anchorJson,
                            anchorFilePath: values.anchorFilePath,
                            anchorFolderPath: values.anchorFolderPath,
                            snapshotEnvelopeJson: values.snapshotEnvelopeJson,
                            bodyEnvelopeJson: values.bodyEnvelopeJson,
                            bodyVersion: comment.bodyVersion,
                            authorJson: values.authorJson,
                            editsJson: values.editsJson,
                            dispositionsJson: values.dispositionsJson,
                            evidenceJson: values.evidenceJson,
                            transitionsJson: values.transitionsJson,
                            fingerprintJson: values.fingerprintJson,
                            linkedRefsJson: values.linkedRefsJson,
                            suggestedFixJson: values.suggestedFixJson,
                            metadataJson: values.metadataJson,
                            tombstoneJson: values.tombstoneJson,
                            serverRevision: comment.serverRevision,
                            createdAt: BigInt(comment.createdAt),
                            updatedAt: BigInt(comment.updatedAt),
                        },
                    });
                    await tx.$executeRaw(Prisma.sql`
                        INSERT INTO review_comment_events (
                            event_id, comment_id, account_id, project_id, event_kind, event_envelope_json,
                            bulk_action_id, client_mutation_id, actor_json, author_device_id, client_lamport,
                            server_revision, created_at
                        ) VALUES (
                            ${event.eventId}, ${event.commentId}, ${params.accountId}, ${event.projectId},
                            ${event.eventKind}, ${eventEnvelopeJson}, ${event.bulkActionId ?? null},
                            ${eventClientMutationId(event)}, ${stringifyJson(event.actor)},
                            ${event.authorDeviceId ?? null}, ${event.clientLamport ?? null},
                            ${event.serverRevision}, ${event.createdAt}
                        )
                    `);
                    return { comment, replayed: false };
                });
            } catch (error) {
                if (!isPrismaErrorCode(error, "P2002")) throw error;
                const racedRows = await db.$queryRaw<ReviewCommentRow[]>(
                    createMutationLookupQuery(params.accountId, params.createClientMutationId),
                );
                const raced = racedRows[0];
                if (!raced) throw error;
                return resolveCreateReplay(raced, params.createRequestFingerprint);
            }
        },
        async commit(params) {
            const comment = ReviewCommentV1Schema.parse(params.comment);
            const event = ReviewCommentEventV1Schema.parse(params.event);
            await inTx(async (tx) => {
                const existingRows = await tx.$queryRaw<Array<{ server_revision: number | bigint }>>(Prisma.sql`
                    SELECT server_revision
                    FROM review_comments
                    WHERE account_id = ${params.accountId} AND id = ${comment.id}
                    LIMIT 1
                `);
                const existing = existingRows[0];
                if (!existing && comment.serverRevision !== 1) {
                    throw new ReviewCommentOperationError(
                        "review_comment_conflict",
                        "Cannot create a review comment at a non-initial serverRevision",
                    );
                }
                if (existing && toNumber(existing.server_revision) >= comment.serverRevision) {
                    throw new ReviewCommentOperationError(
                        "review_comment_conflict",
                        "Review comment serverRevision is stale",
                    );
                }

                const mode = storageMode(params);
                const values = buildStoredCommentValues(comment, mode);

                if (existing) {
                    await tx.$executeRaw(Prisma.sql`
                        UPDATE review_comments
                        SET project_id = ${comment.projectId},
                            workspace_id = ${comment.workspaceId ?? null},
                            session_id = ${comment.sessionId ?? null},
                            run_id = ${comment.runId ?? null},
                            engine_id = ${comment.engineId ?? null},
                            finding_id = ${comment.findingId ?? null},
                            thread_id = ${comment.threadId},
                            parent_comment_id = ${comment.parentCommentId ?? null},
                            state = ${comment.state},
                            flags_json = ${values.flagsJson},
                            anchor_json = ${values.anchorJson},
                            anchor_file_path = ${values.anchorFilePath},
                            anchor_folder_path = ${values.anchorFolderPath},
                            snapshot_envelope_json = ${values.snapshotEnvelopeJson},
                            body_envelope_json = ${values.bodyEnvelopeJson},
                            body_version = ${comment.bodyVersion},
                            author_json = ${values.authorJson},
                            edits_json = ${values.editsJson},
                            dispositions_json = ${values.dispositionsJson},
                            evidence_json = ${values.evidenceJson},
                            transitions_json = ${values.transitionsJson},
                            fingerprint_json = ${values.fingerprintJson},
                            linked_refs_json = ${values.linkedRefsJson},
                            suggested_fix_json = ${values.suggestedFixJson},
                            metadata_json = ${values.metadataJson},
                            tombstone_json = ${values.tombstoneJson},
                            server_revision = ${comment.serverRevision},
                            updated_at = ${comment.updatedAt}
                        WHERE account_id = ${params.accountId} AND id = ${comment.id}
                    `);
                } else {
                    await tx.$executeRaw(Prisma.sql`
                        INSERT INTO review_comments (
                            id, account_id, project_id, workspace_id, session_id, run_id, engine_id,
                            finding_id, thread_id, parent_comment_id, state, flags_json, anchor_json,
                            anchor_file_path, anchor_folder_path, snapshot_envelope_json, body_envelope_json,
                            body_version, author_json, edits_json, dispositions_json, evidence_json,
                            transitions_json, fingerprint_json, linked_refs_json, suggested_fix_json,
                            metadata_json, tombstone_json, server_revision, created_at, updated_at
                        ) VALUES (
                            ${comment.id}, ${params.accountId}, ${comment.projectId}, ${comment.workspaceId ?? null},
                            ${comment.sessionId ?? null}, ${comment.runId ?? null}, ${comment.engineId ?? null},
                            ${comment.findingId ?? null}, ${comment.threadId}, ${comment.parentCommentId ?? null},
                            ${comment.state}, ${values.flagsJson}, ${values.anchorJson}, ${values.anchorFilePath},
                            ${values.anchorFolderPath}, ${values.snapshotEnvelopeJson}, ${values.bodyEnvelopeJson},
                            ${comment.bodyVersion}, ${values.authorJson}, ${values.editsJson},
                            ${values.dispositionsJson}, ${values.evidenceJson}, ${values.transitionsJson},
                            ${values.fingerprintJson}, ${values.linkedRefsJson}, ${values.suggestedFixJson},
                            ${values.metadataJson}, ${values.tombstoneJson}, ${comment.serverRevision},
                            ${comment.createdAt}, ${comment.updatedAt}
                        )
                    `);
                }

                await tx.$executeRaw(Prisma.sql`
                    INSERT INTO review_comment_events (
                        event_id, comment_id, account_id, project_id, event_kind, event_envelope_json,
                        bulk_action_id, client_mutation_id, actor_json, author_device_id, client_lamport,
                        server_revision, created_at
                    ) VALUES (
                        ${event.eventId}, ${event.commentId}, ${params.accountId}, ${event.projectId},
                        ${event.eventKind}, ${encodeStoredEnvelope({
                            value: params.eventEnvelope ?? event.event,
                            fieldName: "event",
                            storageMode: mode,
                        })}, ${event.bulkActionId ?? null},
                        ${eventClientMutationId(event)}, ${stringifyJson(event.actor)}, ${event.authorDeviceId ?? null},
                        ${event.clientLamport ?? null}, ${event.serverRevision}, ${event.createdAt}
                    )
                `);
            });
        },
    };
}
