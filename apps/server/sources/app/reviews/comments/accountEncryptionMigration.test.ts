import { describe, expect, it, vi } from "vitest";

import {
    bindReviewCommentEventSensitiveEnvelopeV1,
    buildReviewCommentEventRequestBindingV1,
    sealReviewCommentEventSensitiveEnvelopeV1,
    type BoundReviewCommentEventSensitiveEnvelopeV1,
    type ReviewCommentEventV1,
    type ReviewCommentSensitiveMigrationSourceV1,
    type StoredJsonContentEnvelope,
} from "@happier-dev/protocol";

import {
    migrateReviewCommentAccountEncryptionInTx,
    reviewCommentAccountEncryptionPostStateMatches,
    type ReviewCommentAccountEncryptionMigrationPersistence,
    type ReviewCommentAccountEncryptionMigrationStoredComment,
} from "./accountEncryptionMigration";

function event(params: Readonly<{
    eventId: string;
    commentId: string;
    serverRevision: number;
}>): ReviewCommentEventV1 {
    return {
        eventId: params.eventId,
        commentId: params.commentId,
        accountId: "account-1",
        projectId: "project-1",
        eventKind: "edited",
        actor: { kind: "user", userId: "user-1" },
        createdAt: 2_000 + params.serverRevision,
        serverRevision: params.serverRevision,
        event: { clientMutationId: `mutation-${params.eventId}` },
    };
}

function requestBinding(eventValue: ReviewCommentEventV1) {
    return buildReviewCommentEventRequestBindingV1({
        accountId: eventValue.accountId,
        projectId: eventValue.projectId,
        actor: eventValue.actor,
        actionId: "reviews.comments.edit",
        input: {
            projectId: eventValue.projectId,
            commentId: eventValue.commentId,
            expectedServerRevision: eventValue.serverRevision,
            expectedBodyVersion: 1,
            clientMutationId: eventValue.event.clientMutationId,
        },
    });
}

function boundEvent(eventValue: ReviewCommentEventV1, value: string): BoundReviewCommentEventSensitiveEnvelopeV1 {
    const binding = requestBinding(eventValue);
    return bindReviewCommentEventSensitiveEnvelopeV1({
        event: eventValue,
        requestBinding: binding,
        sensitive: sealReviewCommentEventSensitiveEnvelopeV1({
            payload: { v: 1, requestBinding: binding, details: { value } },
            mode: "plain",
        }),
    });
}

function plain(value: unknown): StoredJsonContentEnvelope {
    return { t: "plain", v: value };
}

function storedComment(params: Readonly<{
    commentId: string;
    serverRevision?: number;
    bodyVersion?: number;
}>): ReviewCommentAccountEncryptionMigrationStoredComment {
    const currentEvent = event({
        eventId: `event-${params.commentId}`,
        commentId: params.commentId,
        serverRevision: params.serverRevision ?? 1,
    });
    return {
        commentId: params.commentId,
        accountId: "account-1",
        serverRevision: params.serverRevision ?? 1,
        bodyVersion: params.bodyVersion ?? 1,
        structural: {
            v: 1,
            id: params.commentId,
            accountId: "account-1",
            projectId: "project-1",
            anchorIndex: { kind: "file", filePath: "src/example.ts" },
            bodyVersion: params.bodyVersion ?? 1,
            editHistory: [],
            author: { kind: "user", userId: "user-1" },
            state: "open",
            flags: {},
            dispositions: {},
            threadId: params.commentId,
            transitionHistory: [],
            createdAt: 1_000,
            updatedAt: 1_000,
            serverRevision: params.serverRevision ?? 1,
        },
        sensitiveSource: {
            v: 1,
            layout: "canonical_v1",
            envelope: { t: "encrypted", c: `source-${params.commentId}` },
        },
        events: [{
            event: currentEvent,
            sensitiveEnvelope: boundEvent(currentEvent, `source-${params.commentId}`),
            sourceLayout: "canonical_v1",
        }],
    };
}

function migrationItem(
    row: ReviewCommentAccountEncryptionMigrationStoredComment,
    overrides: Partial<{
        commentId: string;
        expectedServerRevision: number;
        expectedBodyVersion: number;
        expectedSensitiveSource: ReviewCommentSensitiveMigrationSourceV1;
        targetSensitiveEnvelope: StoredJsonContentEnvelope;
        events: Array<{
            eventId: string;
            expectedSensitiveEnvelope: BoundReviewCommentEventSensitiveEnvelopeV1;
            targetSensitiveEnvelope: BoundReviewCommentEventSensitiveEnvelopeV1;
        }>;
    }> = {},
) {
    return {
        commentId: row.commentId,
        expectedServerRevision: row.serverRevision,
        expectedBodyVersion: row.bodyVersion,
        expectedSensitiveSource: row.sensitiveSource,
        targetSensitiveEnvelope: plain({ target: row.commentId }),
        events: row.events.map((item) => ({
            eventId: item.event.eventId,
            expectedSensitiveEnvelope: item.sensitiveEnvelope,
            targetSensitiveEnvelope: bindReviewCommentEventSensitiveEnvelopeV1({
                event: item.event,
                requestBinding: item.sensitiveEnvelope.binding.requestBinding,
                sensitive: sealReviewCommentEventSensitiveEnvelopeV1({
                    payload: {
                        v: 1,
                        requestBinding: item.sensitiveEnvelope.binding.requestBinding,
                        details: { target: row.commentId },
                    },
                    mode: "plain",
                }),
            }),
        })),
        ...overrides,
    };
}

function persistence(
    rows: ReviewCommentAccountEncryptionMigrationStoredComment[],
): ReviewCommentAccountEncryptionMigrationPersistence {
    return {
        readInventory: vi.fn(async () => rows),
        rewriteCommentSensitiveEnvelope: vi.fn(async (params) => {
            const row = rows.find((candidate) => candidate.commentId === params.commentId);
            if (!row) throw new Error("missing");
            (row as { sensitiveSource: ReviewCommentSensitiveMigrationSourceV1 }).sensitiveSource = {
                v: 1,
                layout: "canonical_v1",
                envelope: params.targetSensitiveEnvelope,
            };
        }),
        rewriteEventSensitiveEnvelope: vi.fn(async (params) => {
            const row = rows.find((candidate) => candidate.commentId === params.commentId);
            const eventRow = row?.events.find((candidate) => candidate.event.eventId === params.eventId);
            if (!eventRow) throw new Error("missing");
            (eventRow as { sensitiveEnvelope: BoundReviewCommentEventSensitiveEnvelopeV1 }).sensitiveEnvelope =
                params.targetSensitiveEnvelope;
        }),
    };
}

describe("Review Comment Account-encryption migration owner", () => {
    it("rewrites one complete exact comment/event inventory", async () => {
        const rows = [storedComment({ commentId: "comment-1" }), storedComment({ commentId: "comment-2" })];
        const store = persistence(rows);
        const items = rows.map((row) => migrationItem(row));

        const postState = await migrateReviewCommentAccountEncryptionInTx({
            accountId: "account-1",
            targetMode: "plain",
            directive: { action: "migrate", items },
            persistence: store,
        });

        expect(store.rewriteCommentSensitiveEnvelope).toHaveBeenCalledTimes(2);
        expect(store.rewriteEventSensitiveEnvelope).toHaveBeenCalledTimes(2);
        expect(postState).toEqual({
            comments: items.map((item) => ({
                commentId: item.commentId,
                serverRevision: item.expectedServerRevision,
                bodyVersion: item.expectedBodyVersion,
                sensitiveEnvelope: item.targetSensitiveEnvelope,
                events: item.events.map((eventItem) => ({
                    eventId: eventItem.eventId,
                    sensitiveEnvelope: eventItem.targetSensitiveEnvelope,
                })),
            })),
        });
    });

    it.each([
        ["missing", (rows: ReviewCommentAccountEncryptionMigrationStoredComment[]) => [migrationItem(rows[0]!)]] as const,
        ["duplicate", (rows: ReviewCommentAccountEncryptionMigrationStoredComment[]) => {
            const item = migrationItem(rows[0]!);
            return [item, item, migrationItem(rows[1]!)];
        }] as const,
        ["stale", (rows: ReviewCommentAccountEncryptionMigrationStoredComment[]) => [
            migrationItem(rows[0]!, { expectedServerRevision: 99 }),
            migrationItem(rows[1]!),
        ]] as const,
    ])("rejects a %s comment inventory before any rewrite", async (_label, buildItems) => {
        const rows = [storedComment({ commentId: "comment-1" }), storedComment({ commentId: "comment-2" })];
        const store = persistence(rows);

        await expect(migrateReviewCommentAccountEncryptionInTx({
            accountId: "account-1",
            targetMode: "plain",
            directive: { action: "migrate", items: buildItems(rows) },
            persistence: store,
        })).rejects.toThrow("review_comment_migration_inventory_mismatch");

        expect(store.rewriteCommentSensitiveEnvelope).not.toHaveBeenCalled();
        expect(store.rewriteEventSensitiveEnvelope).not.toHaveBeenCalled();
    });

    it("rejects stale, missing, duplicate, and transplanted event payloads before rewrite", async () => {
        const row = storedComment({ commentId: "comment-1" });
        const other = storedComment({ commentId: "comment-2" });
        const transplanted = migrationItem(row, {
            events: [{
                eventId: row.events[0]!.event.eventId,
                expectedSensitiveEnvelope: row.events[0]!.sensitiveEnvelope,
                targetSensitiveEnvelope: other.events[0]!.sensitiveEnvelope,
            }],
        });
        const store = persistence([row]);

        await expect(migrateReviewCommentAccountEncryptionInTx({
            accountId: "account-1",
            targetMode: "plain",
            directive: { action: "migrate", items: [transplanted] },
            persistence: store,
        })).rejects.toThrow("review_comment_migration_event_binding_mismatch");

        expect(store.rewriteCommentSensitiveEnvelope).not.toHaveBeenCalled();
        expect(store.rewriteEventSensitiveEnvelope).not.toHaveBeenCalled();
    });

    it("enforces target mode and exact source envelope bytes before rewrite", async () => {
        const row = storedComment({ commentId: "comment-1" });
        const item = migrationItem(row, {
            expectedSensitiveSource: {
                v: 1,
                layout: "canonical_v1",
                envelope: plain({ different: true }),
            },
            targetSensitiveEnvelope: { t: "encrypted", c: "opaque" },
        });
        const store = persistence([row]);

        await expect(migrateReviewCommentAccountEncryptionInTx({
            accountId: "account-1",
            targetMode: "plain",
            directive: { action: "migrate", items: [item] },
            persistence: store,
        })).rejects.toThrow("review_comment_migration_envelope_mismatch");

        expect(store.rewriteCommentSensitiveEnvelope).not.toHaveBeenCalled();
    });

    it("matches exact post-state without performing a rewrite", async () => {
        const row = storedComment({ commentId: "comment-1" });
        const item = migrationItem(row);
        (row as { sensitiveSource: ReviewCommentSensitiveMigrationSourceV1 }).sensitiveSource = {
            v: 1,
            layout: "canonical_v1",
            envelope: item.targetSensitiveEnvelope,
        };
        (row.events[0] as { sensitiveEnvelope: BoundReviewCommentEventSensitiveEnvelopeV1 }).sensitiveEnvelope =
            item.events[0]!.targetSensitiveEnvelope;
        const store = persistence([row]);

        await expect(reviewCommentAccountEncryptionPostStateMatches({
            accountId: "account-1",
            targetMode: "plain",
            directive: { action: "migrate", items: [item] },
            persistence: store,
        })).resolves.toBe(true);
        expect(store.rewriteCommentSensitiveEnvelope).not.toHaveBeenCalled();
    });

    it("assert_empty counts the authoritative inventory", async () => {
        const nonEmpty = persistence([storedComment({ commentId: "comment-1" })]);
        await expect(migrateReviewCommentAccountEncryptionInTx({
            accountId: "account-1",
            targetMode: "plain",
            directive: { action: "assert_empty" },
            persistence: nonEmpty,
        })).rejects.toThrow("review_comment_migration_inventory_not_empty");

        const empty = persistence([]);
        await expect(migrateReviewCommentAccountEncryptionInTx({
            accountId: "account-1",
            targetMode: "plain",
            directive: { action: "assert_empty" },
            persistence: empty,
        })).resolves.toEqual({ comments: [] });
    });
});
