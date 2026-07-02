import { describe, expect, it } from "vitest";

import type {
    ReviewCommentActorRefV1,
    ReviewCommentSnapshotV1,
} from "@happier-dev/protocol";

import { REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1 } from "@happier-dev/protocol";
import { buildReviewCommentTextSnapshotHashes } from "./snapshots";
import { createInMemoryReviewCommentStore } from "./store";
import { createReviewCommentOperations } from "./operations";

function textSnapshot(lines: readonly string[]): ReviewCommentSnapshotV1 {
    const hashes = buildReviewCommentTextSnapshotHashes({
        selectedLines: lines,
        beforeContext: [],
        afterContext: [],
    });
    return {
        kind: "text",
        selectedLines: [...lines],
        beforeContext: [],
        afterContext: [],
        selectedLinesHash: hashes.selectedLinesHash,
        contextWindowHash: hashes.contextWindowHash,
        capturedAt: 1,
        fileLength: lines.length,
        source: "workingTree",
        isUncommitted: true,
        isUntracked: false,
        truncated: false,
        hasBidiControls: false,
        likelyMinified: false,
    };
}

function createHarness() {
    let now = 1000;
    let id = 0;
    const store = createInMemoryReviewCommentStore();
    const operations = createReviewCommentOperations(store, {
        now: () => now++,
        createId: (prefix) => `${prefix}-${++id}`,
    });
    return { store, operations };
}

const pluginActor: ReviewCommentActorRefV1 = {
    kind: "plugin",
    pluginId: "review-coderabbit",
    engineRunId: "run-1",
};

describe("review comment operations", () => {
    it("stores current-state rows and append-only events for proposed plugin comments", async () => {
        const { store, operations } = createHarness();

        const result = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            grants: [],
            input: {
                projectId: "project-1",
                runId: "run-1",
                engineId: "review-coderabbit",
                anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
                snapshot: textSnapshot(["return value.name;"]),
                body: "Null-check this value.",
                clientMutationId: "mutation-1",
            },
        });

        expect(result.comment.state).toBe("proposed");
        expect(result.comment.author).toEqual(pluginActor);
        expect(await store.get({ accountId: "account-1", commentId: result.comment.id }))
            .toEqual(result.comment);
        expect(await store.listEvents({ accountId: "account-1", commentId: result.comment.id }))
            .toMatchObject([
                {
                    eventKind: "created",
                    commentId: result.comment.id,
                    accountId: "account-1",
                    projectId: "project-1",
                },
            ]);
    });

    it("requires the direct write grant before creating open comments", async () => {
        const { operations } = createHarness();

        await expect(operations.create({
            accountId: "account-1",
            actor: pluginActor,
            grants: [],
            input: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/config.ts" },
                snapshot: textSnapshot(["secret = readEnv();"]),
                body: "Investigate secret handling.",
                authorIntent: "open",
                clientMutationId: "mutation-1",
            },
        })).rejects.toMatchObject({ code: "review_comment_direct_write_permission_required" });

        const result = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            grants: [REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1],
            input: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/config.ts" },
                snapshot: textSnapshot(["secret = readEnv();"]),
                body: "Investigate secret handling.",
                authorIntent: "open",
                clientMutationId: "mutation-2",
            },
        });
        expect(result.comment.state).toBe("open");
    });

    it("allows user principals to create open comments without plugin direct-write grants", async () => {
        const { operations } = createHarness();

        const result = await operations.create({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            grants: [],
            input: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/config.ts" },
                snapshot: textSnapshot(["secret = readEnv();"]),
                body: "Track this issue.",
                authorIntent: "open",
                clientMutationId: "mutation-user-open",
            },
        });

        expect(result.comment).toMatchObject({
            state: "open",
            author: { kind: "user", userId: "user-1" },
        });
    });

    it("returns a stable error code for invalid snapshot metadata", async () => {
        const { operations } = createHarness();
        const lines = {
            selectedLines: ["x".repeat(5000)],
            beforeContext: [],
            afterContext: [],
        };
        const hashes = buildReviewCommentTextSnapshotHashes(lines);

        await expect(operations.create({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            grants: [],
            input: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/config.ts" },
                snapshot: {
                    kind: "text",
                    ...lines,
                    ...hashes,
                    capturedAt: 1,
                    fileLength: 1,
                    source: "workingTree",
                    isUncommitted: true,
                    isUntracked: false,
                    truncated: false,
                    hasBidiControls: false,
                    likelyMinified: true,
                },
                body: "Track invalid snapshot metadata.",
                authorIntent: "open",
                clientMutationId: "mutation-invalid-snapshot",
            },
        })).rejects.toMatchObject({ code: "review_comment_snapshot_invalid" });
    });

    it("enforces transition evidence and appends transition events without rewriting prior events", async () => {
        const { store, operations } = createHarness();
        const created = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            grants: [REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1],
            input: {
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
                snapshot: textSnapshot(["return value.name;"]),
                body: "Null-check this value.",
                authorIntent: "open",
                clientMutationId: "mutation-1",
            },
        });

        await expect(operations.transition({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                commentId: created.comment.id,
                toState: "resolved",
                clientMutationId: "mutation-2",
            },
        })).rejects.toMatchObject({ code: "review_comment_invalid_transition" });

        const transitioned = await operations.transition({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                commentId: created.comment.id,
                toState: "resolved",
                evidence: [{ kind: "test", testResultRef: "test-1", status: "passed" }],
                clientMutationId: "mutation-3",
            },
        });

        expect(transitioned.comment.state).toBe("resolved");
        expect(transitioned.comment.serverRevision).toBe(2);
        expect(await store.listEvents({ accountId: "account-1", commentId: created.comment.id }))
            .toHaveLength(2);
    });

    it("rejects plugin moderation transitions while allowing original author delegated resolution with evidence", async () => {
        const { operations } = createHarness();
        const proposed = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
                snapshot: textSnapshot(["return value.name;"]),
                body: "Null-check this value.",
                clientMutationId: "mutation-1",
            },
        });

        await expect(operations.transition({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                commentId: proposed.comment.id,
                toState: "open",
                clientMutationId: "mutation-2",
            },
        })).rejects.toMatchObject({ code: "review_comment_permission_denied" });

        const opened = await operations.transition({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                commentId: proposed.comment.id,
                toState: "open",
                clientMutationId: "mutation-3",
            },
        });
        const delegated = await operations.transition({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                commentId: opened.comment.id,
                toState: "delegated",
                reason: "Please verify the fix.",
                clientMutationId: "mutation-4",
            },
        });
        const resolved = await operations.transition({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                commentId: delegated.comment.id,
                toState: "resolved",
                evidence: [{ kind: "test", testResultRef: "test-1", status: "passed" }],
                clientMutationId: "mutation-5",
            },
        });

        expect(resolved.comment.state).toBe("resolved");
    });

    it("requires typed evidence for non-user delegated completion", async () => {
        const { operations } = createHarness();
        const opened = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            grants: [REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1],
            input: {
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
                snapshot: textSnapshot(["return value.name;"]),
                body: "Null-check this value.",
                authorIntent: "open",
                clientMutationId: "mutation-1",
            },
        });
        const delegated = await operations.transition({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                commentId: opened.comment.id,
                toState: "delegated",
                reason: "Please verify the fix.",
                clientMutationId: "mutation-2",
            },
        });

        await expect(operations.transition({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                commentId: delegated.comment.id,
                toState: "resolved",
                reason: "Looks fixed.",
                clientMutationId: "mutation-3",
            },
        })).rejects.toMatchObject({ code: "review_comment_invalid_transition" });
    });

    it("rejects non-user delegated completion by actors that did not author the comment", async () => {
        const { operations } = createHarness();
        const opened = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            grants: [REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1],
            input: {
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
                snapshot: textSnapshot(["return value.name;"]),
                body: "Null-check this value.",
                authorIntent: "open",
                clientMutationId: "mutation-1",
            },
        });
        const delegated = await operations.transition({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                commentId: opened.comment.id,
                toState: "delegated",
                reason: "Please verify the fix.",
                clientMutationId: "mutation-2",
            },
        });

        await expect(operations.transition({
            accountId: "account-1",
            actor: { kind: "plugin", pluginId: "review-deepsec" },
            input: {
                commentId: delegated.comment.id,
                toState: "resolved",
                evidence: [{ kind: "test", testResultRef: "test-1", status: "passed" }],
                clientMutationId: "mutation-3",
            },
        })).rejects.toMatchObject({ code: "review_comment_permission_denied" });
    });

    it("allows only users and original authors to attach evidence", async () => {
        const { operations } = createHarness();
        const created = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/config.ts" },
                snapshot: textSnapshot(["secret = readEnv();"]),
                body: "Investigate secret handling.",
                clientMutationId: "mutation-1",
            },
        });

        await expect(operations.attachEvidence({
            accountId: "account-1",
            actor: { kind: "plugin", pluginId: "review-deepsec" },
            input: {
                commentId: created.comment.id,
                evidence: [{ kind: "reasoning", message: "Forged evidence." }],
                clientMutationId: "mutation-2",
            },
        })).rejects.toMatchObject({ code: "review_comment_permission_denied" });

        await expect(operations.attachEvidence({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                commentId: created.comment.id,
                evidence: [{ kind: "reasoning", message: "Author evidence." }],
                clientMutationId: "mutation-3",
            },
        })).resolves.toMatchObject({
            comment: {
                evidence: [{ kind: "reasoning", message: "Author evidence." }],
            },
        });
    });

    it("allows only users and original authors to edit non-redacted comments", async () => {
        const { operations } = createHarness();
        const created = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/config.ts" },
                snapshot: textSnapshot(["secret = readEnv();"]),
                body: "Investigate secret handling.",
                clientMutationId: "mutation-1",
            },
        });

        await expect(operations.edit({
            accountId: "account-1",
            actor: { kind: "plugin", pluginId: "review-deepsec" },
            input: {
                commentId: created.comment.id,
                nextBody: "Rewrite another plugin's comment.",
                clientMutationId: "mutation-2",
            },
        })).rejects.toMatchObject({ code: "review_comment_permission_denied" });

        await expect(operations.edit({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                commentId: created.comment.id,
                nextBody: "Updated by the original plugin.",
                clientMutationId: "mutation-3",
            },
        })).resolves.toMatchObject({
            comment: {
                body: "Updated by the original plugin.",
                bodyVersion: 2,
            },
        });
    });

    it("allows redaction only for user principals", async () => {
        const { operations } = createHarness();
        const created = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/config.ts" },
                snapshot: textSnapshot(["secret = readEnv();"]),
                body: "Investigate secret handling.",
                clientMutationId: "mutation-1",
            },
        });

        await expect(operations.redact({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                commentId: created.comment.id,
                redactBody: true,
                clientMutationId: "mutation-2",
            },
        })).rejects.toMatchObject({ code: "review_comment_permission_denied" });
    });

    it("creates replies directly in the parent thread without a transient root event", async () => {
        const { store, operations } = createHarness();
        const parent = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
                snapshot: textSnapshot(["return value.name;"]),
                body: "Null-check this value.",
                clientMutationId: "mutation-1",
            },
        });

        const reply = await operations.reply({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                parentCommentId: parent.comment.id,
                body: "Fixed in the next patch.",
                clientMutationId: "mutation-2",
            },
        });

        expect(reply.comment.parentCommentId).toBe(parent.comment.id);
        expect(reply.comment.threadId).toBe(parent.comment.threadId);
        expect(await store.listEvents({ accountId: "account-1", commentId: reply.comment.id }))
            .toMatchObject([{ eventKind: "replied", event: { parentCommentId: parent.comment.id } }]);
    });

    it("redacts the durable body while preserving a valid current-state row", async () => {
        const { operations } = createHarness();
        const created = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/config.ts" },
                snapshot: textSnapshot(["secret = readEnv();"]),
                body: "Investigate secret handling.",
                clientMutationId: "mutation-1",
            },
        });

        const redacted = await operations.redact({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                commentId: created.comment.id,
                redactBody: true,
                clientMutationId: "mutation-2",
            },
        });

        expect(redacted.comment.body).toBe("");
        expect(redacted.comment.flags.redacted).toBe(true);
    });

    it("redacts materialized edit history with the body", async () => {
        const { operations } = createHarness();
        const created = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/config.ts" },
                snapshot: textSnapshot(["secret = readEnv();"]),
                body: "Investigate secret handling.",
                clientMutationId: "mutation-1",
            },
        });
        const edited = await operations.edit({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                commentId: created.comment.id,
                nextBody: "Updated secret handling details.",
                clientMutationId: "mutation-2",
            },
        });

        expect(edited.comment.edits).toHaveLength(1);

        const redacted = await operations.redact({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                commentId: created.comment.id,
                redactBody: true,
                clientMutationId: "mutation-3",
            },
        });

        expect(redacted.comment.edits).toEqual([]);
    });

    it("rejects already redacted comments", async () => {
        const { operations } = createHarness();
        const created = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/config.ts" },
                snapshot: textSnapshot(["secret = readEnv();"]),
                body: "Investigate secret handling.",
                clientMutationId: "mutation-1",
            },
        });

        await operations.redact({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                commentId: created.comment.id,
                redactBody: true,
                clientMutationId: "mutation-2",
            },
        });

        await expect(operations.redact({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                commentId: created.comment.id,
                redactBody: true,
                clientMutationId: "mutation-3",
            },
        })).rejects.toMatchObject({ code: "review_comment_already_redacted" });
    });

    it("rejects replies to closed or redacted parent comments", async () => {
        const { operations } = createHarness();
        const open = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            grants: [REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1],
            input: {
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
                snapshot: textSnapshot(["return value.name;"]),
                body: "Null-check this value.",
                authorIntent: "open",
                clientMutationId: "mutation-1",
            },
        });
        const resolved = await operations.transition({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                commentId: open.comment.id,
                toState: "resolved",
                evidence: [{ kind: "test", testResultRef: "test-1", status: "passed" }],
                clientMutationId: "mutation-2",
            },
        });

        await expect(operations.reply({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                parentCommentId: resolved.comment.id,
                body: "This thread is closed.",
                clientMutationId: "mutation-3",
            },
        })).rejects.toMatchObject({ code: "review_comment_thread_closed" });

        const redacted = await operations.redact({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                commentId: resolved.comment.id,
                redactBody: true,
                clientMutationId: "mutation-4",
            },
        });

        await expect(operations.reply({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                parentCommentId: redacted.comment.id,
                body: "This thread is redacted.",
                clientMutationId: "mutation-5",
            },
        })).rejects.toMatchObject({ code: "review_comment_thread_closed" });
    });

    it("bulk-transitions with one bulk action id and reports per-comment failures", async () => {
        const { store, operations } = createHarness();
        const open = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            grants: [REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1],
            input: {
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
                snapshot: textSnapshot(["return value.name;"]),
                body: "Null-check this value.",
                authorIntent: "open",
                clientMutationId: "mutation-1",
            },
        });
        const proposed = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/other.ts", line: 4 },
                snapshot: textSnapshot(["return value.age;"]),
                body: "Check this branch.",
                clientMutationId: "mutation-2",
            },
        });

        const result = await operations.bulkTransition({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                commentIds: [open.comment.id, proposed.comment.id],
                toState: "resolved",
                expectedState: "open",
                evidence: [{ kind: "test", testResultRef: "test-1", status: "passed" }],
                bulkActionId: "bulk-1",
                clientMutationId: "mutation-3",
            },
        });

        expect(result.bulkActionId).toBe("bulk-1");
        expect(result.updated.map((comment) => comment.id)).toEqual([open.comment.id]);
        expect(result.updated[0]?.transitions.at(-1)?.bulkActionId).toBe("bulk-1");
        expect(result.failed).toEqual([{
            commentId: proposed.comment.id,
            errorCode: "review_comment_conflict",
            error: "Review comment state did not match expectedState",
        }]);
        expect(await store.listEvents({ accountId: "account-1", commentId: open.comment.id }))
            .toMatchObject([
                {},
                { eventKind: "transitioned", event: { bulkActionId: "bulk-1" } },
            ]);
    });

    it("keys agent dispositions by agent and session identity", async () => {
        const { operations } = createHarness();
        const created = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/config.ts" },
                snapshot: textSnapshot(["secret = readEnv();"]),
                body: "Investigate secret handling.",
                clientMutationId: "mutation-1",
            },
        });

        const disposition = await operations.setDisposition({
            accountId: "account-1",
            actor: { kind: "agent", agentId: "agent-1", sessionId: "session-1" },
            input: {
                commentId: created.comment.id,
                disposition: "working",
                clientMutationId: "mutation-2",
            },
        });

        expect(disposition.comment.dispositions).toEqual({
            "agent:agent-1:session-1": "working",
        });
    });
});
