import type {
    BoundReviewCommentEventSensitiveEnvelopeV1,
    ReviewCommentAnchorIndexV1,
    ReviewCommentAccountEncryptionMigrationInventoryResponseV1,
    ReviewCommentEventV1,
    ReviewCommentStructuralV1,
    ReviewCommentSensitiveMigrationSourceV1,
    StoredReviewCommentV1,
    StoredJsonContentEnvelope,
} from "@happier-dev/protocol";
import {
    BoundReviewCommentEventSensitiveEnvelopeV1Schema,
    ReviewCommentAccountEncryptionMigrationInventoryResponseV1Schema,
    ReviewCommentAnchorIndexV1Schema,
    ReviewCommentAnchorV1Schema,
    ReviewCommentEventV1Schema,
    ReviewCommentEventRequestBindingV1Schema,
    ReviewCommentStructuralV1Schema,
    ReviewCommentSensitiveMigrationSourceV1Schema,
    StoredJsonContentEnvelopeSchema,
    StoredReviewCommentV1Schema,
    bindReviewCommentEventSensitiveEnvelopeV1,
    classifyReviewCommentEventSensitiveMigrationLayoutV1,
    openReviewCommentSensitiveEnvelopeV1,
    reviewCommentEventSensitiveBindingMatchesV1,
} from "@happier-dev/protocol";

import type { Tx } from "@/storage/inTx";
import { prismaRuntime as Prisma } from "@/storage/prisma";
import type {
    ReviewCommentAccountEncryptionMigrationPersistence,
    ReviewCommentAccountEncryptionMigrationStoredComment,
    ReviewCommentAccountEncryptionMigrationStoredEvent,
} from "./accountEncryptionMigration";
import {
    REVIEW_COMMENT_ACCOUNT_ENCRYPTION_MIGRATION_MAX_COMMENTS,
    REVIEW_COMMENT_ACCOUNT_ENCRYPTION_MIGRATION_MAX_EVENTS,
} from "./accountEncryptionMigration";

export const REVIEW_COMMENT_CANONICAL_SENSITIVE_LAYOUT_MARKER_JSON =
    '{"v":1,"layout":"review_comment_sensitive_in_body_v1"}';

export type ReviewCommentMigrationStorageCommentRow = {
    id: string;
    account_id: string;
    project_id: string;
    workspace_id: string | null;
    session_id: string | null;
    run_id: string | null;
    engine_id: string | null;
    finding_id: string | null;
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

export type ReviewCommentMigrationStorageEventRow = {
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

export type ReviewCommentCanonicalStorageValues = Readonly<{
    anchorJson: string;
    snapshotEnvelopeJson: string;
    bodyEnvelopeJson: string;
    editsJson: string;
    evidenceJson: null;
    transitionsJson: string;
    fingerprintJson: string | null;
    linkedRefsJson: null;
    suggestedFixJson: null;
    metadataJson: null;
    tombstoneJson: string | null;
}>;

function parseJson(value: string): unknown {
    return JSON.parse(value);
}

function toNumber(value: number | bigint): number {
    return typeof value === "bigint" ? Number(value) : value;
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    return `{${Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
        .join(",")}}`;
}

function exactJson(left: unknown, right: unknown): boolean {
    return canonicalJson(left) === canonicalJson(right);
}

export function isReviewCommentCanonicalSensitiveLayout(
    row: ReviewCommentMigrationStorageCommentRow,
): boolean {
    try {
        return exactJson(
            parseJson(row.snapshot_envelope_json),
            parseJson(REVIEW_COMMENT_CANONICAL_SENSITIVE_LAYOUT_MARKER_JSON),
        );
    } catch {
        return false;
    }
}

function anchorIndexFromLegacy(value: unknown): ReviewCommentAnchorIndexV1 {
    const anchor = ReviewCommentAnchorV1Schema.parse(value);
    return ReviewCommentAnchorIndexV1Schema.parse({
        kind: anchor.kind,
        ...("filePath" in anchor ? { filePath: anchor.filePath } : {}),
        ...("folderPath" in anchor ? { folderPath: anchor.folderPath } : {}),
    });
}

function structuralEditHistory(value: unknown): unknown[] {
    if (!Array.isArray(value)) throw new Error("review_comment_migration_inventory_mismatch");
    return value.map((item) => {
        if (!item || typeof item !== "object") {
            throw new Error("review_comment_migration_inventory_mismatch");
        }
        const edit = item as Record<string, unknown>;
        return {
            editId: edit.editId,
            editedAt: edit.editedAt,
            editedBy: edit.editedBy,
        };
    });
}

function structuralTransitionHistory(value: unknown): unknown[] {
    if (!Array.isArray(value)) throw new Error("review_comment_migration_inventory_mismatch");
    return value.map((item) => {
        if (!item || typeof item !== "object") {
            throw new Error("review_comment_migration_inventory_mismatch");
        }
        const {
            reason: _reason,
            evidence: _evidence,
            ...structural
        } = item as Record<string, unknown>;
        return structural;
    });
}

function structuralTombstone(value: unknown): unknown {
    if (!value || typeof value !== "object") {
        throw new Error("review_comment_migration_inventory_mismatch");
    }
    const { reason: _reason, ...structural } = value as Record<string, unknown>;
    return structural;
}

function fingerprintIndex(value: unknown): unknown {
    if (!value || typeof value !== "object") {
        throw new Error("review_comment_migration_inventory_mismatch");
    }
    return {
        normalizedMessageHash: (value as Record<string, unknown>).normalizedMessageHash,
    };
}

export function buildReviewCommentStructuralFromStorageRow(
    row: ReviewCommentMigrationStorageCommentRow,
): ReviewCommentStructuralV1 {
    const current = isReviewCommentCanonicalSensitiveLayout(row);
    return ReviewCommentStructuralV1Schema.parse({
        v: 1,
        id: row.id,
        accountId: row.account_id,
        projectId: row.project_id,
        workspaceId: row.workspace_id ?? undefined,
        sessionId: row.session_id ?? undefined,
        runId: row.run_id ?? undefined,
        engineId: row.engine_id ?? undefined,
        findingId: row.finding_id ?? undefined,
        anchorIndex: current
            ? ReviewCommentAnchorIndexV1Schema.parse(parseJson(row.anchor_json))
            : anchorIndexFromLegacy(parseJson(row.anchor_json)),
        bodyVersion: toNumber(row.body_version),
        editHistory: structuralEditHistory(parseJson(row.edits_json)),
        author: parseJson(row.author_json),
        state: row.state,
        flags: parseJson(row.flags_json),
        dispositions: parseJson(row.dispositions_json),
        parentCommentId: row.parent_comment_id ?? undefined,
        threadId: row.thread_id,
        transitionHistory: structuralTransitionHistory(parseJson(row.transitions_json)),
        tombstone: row.tombstone_json
            ? structuralTombstone(parseJson(row.tombstone_json))
            : undefined,
        fingerprintIndex: row.fingerprint_json
            ? fingerprintIndex(parseJson(row.fingerprint_json))
            : undefined,
        createdAt: toNumber(row.created_at),
        updatedAt: toNumber(row.updated_at),
        serverRevision: toNumber(row.server_revision),
    });
}

export function readReviewCommentMigrationSourceFromStorageRow(
    row: ReviewCommentMigrationStorageCommentRow,
): ReviewCommentSensitiveMigrationSourceV1 {
    if (isReviewCommentCanonicalSensitiveLayout(row)) {
        return ReviewCommentSensitiveMigrationSourceV1Schema.parse({
            v: 1,
            layout: "canonical_v1",
            envelope: StoredJsonContentEnvelopeSchema.parse(parseJson(row.body_envelope_json)),
        });
    }
    const snapshotEnvelope = StoredJsonContentEnvelopeSchema.parse(parseJson(row.snapshot_envelope_json));
    const bodyEnvelope = StoredJsonContentEnvelopeSchema.parse(parseJson(row.body_envelope_json));
    if (snapshotEnvelope.t !== bodyEnvelope.t) {
        throw new Error("review_comment_migration_envelope_mismatch");
    }
    return ReviewCommentSensitiveMigrationSourceV1Schema.parse({
        v: 1,
        layout: "legacy_split_v1",
        sourceMode: bodyEnvelope.t === "encrypted" ? "e2ee" : "plain",
        anchor: parseJson(row.anchor_json),
        snapshotEnvelope,
        bodyEnvelope,
        edits: parseJson(row.edits_json),
        ...(row.evidence_json ? { evidence: parseJson(row.evidence_json) } : {}),
        transitions: parseJson(row.transitions_json),
        ...(row.tombstone_json ? { tombstone: parseJson(row.tombstone_json) } : {}),
        ...(row.fingerprint_json ? { fingerprint: parseJson(row.fingerprint_json) } : {}),
        ...(row.linked_refs_json ? { linkedRefs: parseJson(row.linked_refs_json) } : {}),
        ...(row.suggested_fix_json ? { suggestedFix: parseJson(row.suggested_fix_json) } : {}),
        ...(row.metadata_json ? { metadata: parseJson(row.metadata_json) } : {}),
    });
}

export function buildStoredReviewCommentFromStorageRow(
    row: ReviewCommentMigrationStorageCommentRow,
): StoredReviewCommentV1 {
    const source = readReviewCommentMigrationSourceFromStorageRow(row);
    if (source.layout !== "canonical_v1") {
        throw new Error("review_comment_legacy_sensitive_layout");
    }
    return StoredReviewCommentV1Schema.parse({
        v: 1,
        structural: buildReviewCommentStructuralFromStorageRow(row),
        sensitiveEnvelope: source.envelope,
    });
}

function eventFromStorageRow(
    row: ReviewCommentMigrationStorageEventRow,
    details: Record<string, unknown>,
): ReviewCommentEventV1 {
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
        event: details,
    });
}

export function buildReviewCommentStoredEventFromStorageRow(
    row: ReviewCommentMigrationStorageEventRow,
): ReviewCommentAccountEncryptionMigrationStoredEvent {
    const raw = parseJson(row.event_envelope_json);
    const current = BoundReviewCommentEventSensitiveEnvelopeV1Schema.safeParse(raw);
    if (current.success) {
        const event = eventFromStorageRow(
            row,
            row.client_mutation_id ? { clientMutationId: row.client_mutation_id } : {},
        );
        if (!reviewCommentEventSensitiveBindingMatchesV1({ event, bound: current.data })) {
            throw new Error("review_comment_migration_event_binding_mismatch");
        }
        return {
            event,
            sensitiveEnvelope: current.data,
            sourceLayout:
                classifyReviewCommentEventSensitiveMigrationLayoutV1(
                    current.data.sensitive,
                ),
        };
    }
    const legacySensitive = StoredJsonContentEnvelopeSchema.parse(raw);
    const details = legacySensitive.t === "plain"
        ? legacySensitive.v
        : row.client_mutation_id
            ? { clientMutationId: row.client_mutation_id }
            : {};
    if (!details || typeof details !== "object" || Array.isArray(details)) {
        throw new Error("review_comment_migration_event_binding_mismatch");
    }
    const event = eventFromStorageRow(row, {
        ...(details as Record<string, unknown>),
        ...(row.client_mutation_id ? { clientMutationId: row.client_mutation_id } : {}),
    });
    return {
        event,
        sensitiveEnvelope: bindReviewCommentEventSensitiveEnvelopeV1({
            event,
            requestBinding: ReviewCommentEventRequestBindingV1Schema.parse({
                v: 1,
                accountId: event.accountId,
                projectId: event.projectId,
                actionId: event.eventKind === "created"
                    ? "reviews.comments.create"
                    : event.eventKind === "edited"
                        ? "reviews.comments.edit"
                        : event.eventKind === "transitioned"
                            ? "reviews.comments.transition"
                            : event.eventKind === "replied"
                                ? "reviews.comments.reply"
                                : event.eventKind === "redacted"
                                    ? "reviews.comments.redact"
                                    : event.eventKind === "disposition_set"
                                        ? "reviews.comments.setDisposition"
                                        : "reviews.comments.attachEvidence",
                eventKind: event.eventKind,
                actor: event.actor,
                clientMutationId: row.client_mutation_id ?? `legacy:${event.eventId}`,
                target: event.eventKind === "created"
                    ? { kind: "create" }
                    : { kind: "comment", commentId: event.commentId },
                expectedCurrentness: event.eventKind === "created"
                    ? { kind: "create" }
                    : {
                        kind: "comment",
                        expectedServerRevision: Math.max(1, event.serverRevision - 1),
                    },
            }),
            sensitive: legacySensitive,
        }),
        sourceLayout: "legacy_split_v1",
    };
}

export function buildReviewCommentAccountEncryptionMigrationInventory(params: Readonly<{
    accountId: string;
    commentRows: readonly ReviewCommentMigrationStorageCommentRow[];
    eventRows: readonly ReviewCommentMigrationStorageEventRow[];
}>): readonly ReviewCommentAccountEncryptionMigrationStoredComment[] {
    const eventsByCommentId = new Map<string, ReviewCommentAccountEncryptionMigrationStoredEvent[]>();
    for (const eventRow of params.eventRows) {
        if (eventRow.account_id !== params.accountId) {
            throw new Error("review_comment_migration_inventory_mismatch");
        }
        const current = eventsByCommentId.get(eventRow.comment_id) ?? [];
        current.push(buildReviewCommentStoredEventFromStorageRow(eventRow));
        eventsByCommentId.set(eventRow.comment_id, current);
    }
    const seen = new Set<string>();
    const inventory = params.commentRows.map((row) => {
        if (row.account_id !== params.accountId || seen.has(row.id)) {
            throw new Error("review_comment_migration_inventory_mismatch");
        }
        seen.add(row.id);
        return {
            commentId: row.id,
            accountId: row.account_id,
            serverRevision: toNumber(row.server_revision),
            bodyVersion: toNumber(row.body_version),
            structural: buildReviewCommentStructuralFromStorageRow(row),
            sensitiveSource: readReviewCommentMigrationSourceFromStorageRow(row),
            events: eventsByCommentId.get(row.id) ?? [],
        };
    });
    for (const commentId of eventsByCommentId.keys()) {
        if (!seen.has(commentId)) {
            throw new Error("review_comment_migration_inventory_mismatch");
        }
    }
    return inventory;
}

export function buildReviewCommentAccountEncryptionMigrationInventoryResponse(
    inventory: readonly ReviewCommentAccountEncryptionMigrationStoredComment[],
): ReviewCommentAccountEncryptionMigrationInventoryResponseV1 {
    return ReviewCommentAccountEncryptionMigrationInventoryResponseV1Schema.parse({
        v: 1,
        items: inventory.map((item) => ({
            structural: item.structural,
            sensitiveSource: item.sensitiveSource,
            events: item.events,
        })),
    });
}

export function buildReviewCommentCanonicalStorageValues(params: Readonly<{
    row: ReviewCommentMigrationStorageCommentRow;
    targetSensitiveEnvelope: StoredJsonContentEnvelope;
}>): ReviewCommentCanonicalStorageValues {
    const structural = buildReviewCommentStructuralFromStorageRow(params.row);
    const target = StoredJsonContentEnvelopeSchema.parse(params.targetSensitiveEnvelope);
    if (
        target.t === "plain"
        && openReviewCommentSensitiveEnvelopeV1({
            structural,
            envelope: target,
            mode: "plain",
        }).status !== "available"
    ) {
        throw new Error("review_comment_migration_comment_binding_mismatch");
    }
    return {
        anchorJson: JSON.stringify(structural.anchorIndex),
        snapshotEnvelopeJson: REVIEW_COMMENT_CANONICAL_SENSITIVE_LAYOUT_MARKER_JSON,
        bodyEnvelopeJson: JSON.stringify(target),
        editsJson: JSON.stringify(structural.editHistory),
        evidenceJson: null,
        transitionsJson: JSON.stringify(structural.transitionHistory),
        fingerprintJson: structural.fingerprintIndex
            ? JSON.stringify(structural.fingerprintIndex)
            : null,
        linkedRefsJson: null,
        suggestedFixJson: null,
        metadataJson: null,
        tombstoneJson: structural.tombstone
            ? JSON.stringify(structural.tombstone)
            : null,
    };
}

const COMMENT_MIGRATION_SELECT_COLUMNS = Prisma.raw([
    "id",
    "account_id",
    "project_id",
    "workspace_id",
    "session_id",
    "run_id",
    "engine_id",
    "finding_id",
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

const EVENT_MIGRATION_SELECT_COLUMNS = Prisma.raw([
    "event_id",
    "comment_id",
    "account_id",
    "project_id",
    "event_kind",
    "event_envelope_json",
    "bulk_action_id",
    "client_mutation_id",
    "actor_json",
    "author_device_id",
    "client_lamport",
    "server_revision",
    "created_at",
].join(", "));

async function readCommentRow(
    tx: Tx,
    accountId: string,
    commentId: string,
): Promise<ReviewCommentMigrationStorageCommentRow | null> {
    const rows = await tx.$queryRaw<ReviewCommentMigrationStorageCommentRow[]>(Prisma.sql`
        SELECT ${COMMENT_MIGRATION_SELECT_COLUMNS}
        FROM review_comments
        WHERE account_id = ${accountId} AND id = ${commentId}
        LIMIT 1
    `);
    return rows[0] ?? null;
}

async function readEventRow(
    tx: Tx,
    accountId: string,
    commentId: string,
    eventId: string,
): Promise<ReviewCommentMigrationStorageEventRow | null> {
    const rows = await tx.$queryRaw<ReviewCommentMigrationStorageEventRow[]>(Prisma.sql`
        SELECT ${EVENT_MIGRATION_SELECT_COLUMNS}
        FROM review_comment_events
        WHERE account_id = ${accountId} AND comment_id = ${commentId} AND event_id = ${eventId}
        LIMIT 1
    `);
    return rows[0] ?? null;
}

function assertExactEnvelope(left: unknown, right: unknown): void {
    if (!exactJson(left, right)) {
        throw new Error("review_comment_migration_envelope_mismatch");
    }
}

function assertTargetEventBinding(
    event: ReviewCommentEventV1,
    target: BoundReviewCommentEventSensitiveEnvelopeV1,
): BoundReviewCommentEventSensitiveEnvelopeV1 {
    const parsed = BoundReviewCommentEventSensitiveEnvelopeV1Schema.parse(target);
    if (!reviewCommentEventSensitiveBindingMatchesV1({ event, bound: parsed })) {
        throw new Error("review_comment_migration_event_binding_mismatch");
    }
    return parsed;
}

export function createReviewCommentAccountEncryptionMigrationPersistenceInTx(
    tx: Tx,
): ReviewCommentAccountEncryptionMigrationPersistence {
    return {
        async readInventory(accountId) {
            const commentRows = await tx.$queryRaw<ReviewCommentMigrationStorageCommentRow[]>(Prisma.sql`
                SELECT ${COMMENT_MIGRATION_SELECT_COLUMNS}
                FROM review_comments
                WHERE account_id = ${accountId}
                ORDER BY id ASC
                LIMIT ${REVIEW_COMMENT_ACCOUNT_ENCRYPTION_MIGRATION_MAX_COMMENTS + 1}
            `);
            const eventRows = await tx.$queryRaw<ReviewCommentMigrationStorageEventRow[]>(Prisma.sql`
                SELECT ${EVENT_MIGRATION_SELECT_COLUMNS}
                FROM review_comment_events
                WHERE account_id = ${accountId}
                ORDER BY comment_id ASC, server_revision ASC, event_id ASC
                LIMIT ${REVIEW_COMMENT_ACCOUNT_ENCRYPTION_MIGRATION_MAX_EVENTS + 1}
            `);
            return buildReviewCommentAccountEncryptionMigrationInventory({
                accountId,
                commentRows,
                eventRows,
            });
        },
        async rewriteCommentSensitiveEnvelope(params) {
            const row = await readCommentRow(tx, params.accountId, params.commentId);
            if (
                !row
                || toNumber(row.server_revision) !== params.expectedServerRevision
                || toNumber(row.body_version) !== params.expectedBodyVersion
            ) {
                throw new Error("review_comment_migration_inventory_mismatch");
            }
            assertExactEnvelope(
                readReviewCommentMigrationSourceFromStorageRow(row),
                params.expectedSensitiveSource,
            );
            const values = buildReviewCommentCanonicalStorageValues({
                row,
                targetSensitiveEnvelope: params.targetSensitiveEnvelope,
            });
            const affected = await tx.$executeRaw(Prisma.sql`
                UPDATE review_comments
                SET anchor_json = ${values.anchorJson},
                    snapshot_envelope_json = ${values.snapshotEnvelopeJson},
                    body_envelope_json = ${values.bodyEnvelopeJson},
                    edits_json = ${values.editsJson},
                    evidence_json = ${values.evidenceJson},
                    transitions_json = ${values.transitionsJson},
                    fingerprint_json = ${values.fingerprintJson},
                    linked_refs_json = ${values.linkedRefsJson},
                    suggested_fix_json = ${values.suggestedFixJson},
                    metadata_json = ${values.metadataJson},
                    tombstone_json = ${values.tombstoneJson}
                WHERE account_id = ${params.accountId}
                    AND id = ${params.commentId}
                    AND server_revision = ${params.expectedServerRevision}
                    AND body_version = ${params.expectedBodyVersion}
                    AND snapshot_envelope_json = ${row.snapshot_envelope_json}
                    AND body_envelope_json = ${row.body_envelope_json}
            `);
            if (affected !== 1) {
                throw new Error("review_comment_migration_inventory_mismatch");
            }
        },
        async rewriteEventSensitiveEnvelope(params) {
            const row = await readEventRow(tx, params.accountId, params.commentId, params.eventId);
            if (!row) {
                throw new Error("review_comment_migration_inventory_mismatch");
            }
            const current = buildReviewCommentStoredEventFromStorageRow(row);
            assertExactEnvelope(current.sensitiveEnvelope, params.expectedSensitiveEnvelope);
            const target = assertTargetEventBinding(current.event, params.targetSensitiveEnvelope);
            const affected = await tx.$executeRaw(Prisma.sql`
                UPDATE review_comment_events
                SET event_envelope_json = ${JSON.stringify(target)}
                WHERE account_id = ${params.accountId}
                    AND comment_id = ${params.commentId}
                    AND event_id = ${params.eventId}
                    AND event_envelope_json = ${row.event_envelope_json}
            `);
            if (affected !== 1) {
                throw new Error("review_comment_migration_inventory_mismatch");
            }
        },
    };
}
