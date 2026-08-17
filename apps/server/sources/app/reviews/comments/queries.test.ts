import { describe, expect, it } from "vitest";

import {
    REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
    type ReviewCommentActorRefV1,
    type ReviewCommentSnapshotV1,
} from "@happier-dev/protocol";

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
    let id = 0;
    const store = createInMemoryReviewCommentStore();
    const operations = createReviewCommentOperations(store, {
        now: () => 1000,
        createId: (prefix) => `${prefix}-${String(++id).padStart(4, "0")}`,
    });
    return { operations };
}

const userActor: ReviewCommentActorRefV1 = { kind: "user", userId: "user-1" };
const pluginActor: ReviewCommentActorRefV1 = { kind: "plugin", pluginId: "review-coderabbit" };

function listInput<T extends Record<string, unknown>>(
    input: T,
): T & { states: []; taxonomyIds: []; includeHistory: false } {
    return {
        states: [],
        taxonomyIds: [],
        includeHistory: false,
        ...input,
    };
}

describe("review comment list queries", () => {
    it("paginates comments with a stable cursor across identical updatedAt values", async () => {
        const { operations } = createHarness();
        const created = [];
        for (const filePath of ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]) {
            const result = await operations.create({
                accountId: "account-1",
                actor: userActor,
                input: {
                    projectId: "project-1",
                    anchor: { kind: "file", filePath },
                    snapshot: textSnapshot([filePath]),
                    body: `Review ${filePath}.`,
                    authorIntent: "open",
                    clientMutationId: `mutation-${filePath}`,
                },
            });
            created.push(result.comment.id);
        }

        const firstPage = await operations.list({
            accountId: "account-1",
            input: listInput({ projectId: "project-1", limit: 2 }),
        });
        expect(firstPage.items.map((comment) => comment.id)).toEqual([created[3], created[2]]);
        expect(firstPage.cursor).toEqual(expect.any(String));

        const secondPage = await operations.list({
            accountId: "account-1",
            input: listInput({ projectId: "project-1", limit: 2, cursor: firstPage.cursor ?? undefined }),
        });
        expect(secondPage.items.map((comment) => comment.id)).toEqual([created[1], created[0]]);
        expect(secondPage.cursor).toBeNull();
    });

    it("rejects cursors replayed with different list filters", async () => {
        const { operations } = createHarness();
        for (const filePath of ["src/a.ts", "src/b.ts", "src/c.ts"]) {
            await operations.create({
                accountId: "account-1",
                actor: userActor,
                input: {
                    projectId: "project-1",
                    anchor: { kind: "file", filePath },
                    snapshot: textSnapshot([filePath]),
                    body: `Review ${filePath}.`,
                    authorIntent: "open",
                    clientMutationId: `mutation-${filePath}`,
                },
            });
        }

        const firstPage = await operations.list({
            accountId: "account-1",
            input: listInput({ projectId: "project-1", limit: 1 }),
        });

        await expect(operations.list({
            accountId: "account-1",
            input: listInput({
                projectId: "project-1",
                engineId: "review-coderabbit",
                limit: 1,
                cursor: firstPage.cursor ?? undefined,
            }),
        })).rejects.toMatchObject({ code: "review_comment_invalid_filter" });
    });

    it("uses project workspace session run engine author file folder severity taxonomy and history filters", async () => {
        const { operations } = createHarness();
        const matching = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            grants: [REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1],
            input: {
                projectId: "project-1",
                workspaceId: "workspace-1",
                sessionId: "session-1",
                runId: "run-1",
                engineId: "review-coderabbit",
                anchor: { kind: "folder", folderPath: "src/security" },
                snapshot: textSnapshot(["security"]),
                body: "Review this folder.",
                authorIntent: "propose",
                clientMutationId: "mutation-matching",
                metadata: { severity: "critical", taxonomyIds: ["security.open_redirect"] },
            },
        });
        await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            grants: [REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1],
            input: {
                projectId: "project-1",
                workspaceId: "workspace-1",
                sessionId: "session-1",
                runId: "run-1",
                engineId: "review-coderabbit",
                anchor: { kind: "folder", folderPath: "src/security" },
                snapshot: textSnapshot(["security"]),
                body: "Wrong taxonomy.",
                authorIntent: "propose",
                clientMutationId: "mutation-wrong-taxonomy",
                metadata: { severity: "critical", taxonomyIds: ["security.sql_injection"] },
            },
        });
        await operations.create({
            accountId: "account-1",
            actor: userActor,
            input: {
                projectId: "project-2",
                workspaceId: "workspace-1",
                sessionId: "session-1",
                runId: "run-1",
                engineId: "review-coderabbit",
                anchor: { kind: "folder", folderPath: "src/security" },
                snapshot: textSnapshot(["other"]),
                body: "Wrong project.",
                authorIntent: "open",
                clientMutationId: "mutation-wrong-project",
                metadata: { severity: "critical" },
            },
        });
        const history = await operations.create({
            accountId: "account-1",
            actor: userActor,
            input: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/closed.ts" },
                snapshot: textSnapshot(["closed"]),
                body: "Closed comment.",
                authorIntent: "open",
                clientMutationId: "mutation-history",
            },
        });
        await operations.transition({
            accountId: "account-1",
            actor: userActor,
            input: {
                projectId: "project-1",
                commentId: history.comment.id,
                expectedState: "open",
                expectedServerRevision: 1,
                toState: "resolved",
                evidence: [{ kind: "reasoning", message: "Fixed." }],
                clientMutationId: "mutation-resolve",
            },
        });

        const active = await operations.list({
            accountId: "account-1",
            input: listInput({
                projectId: "project-1",
                workspaceId: "workspace-1",
                sessionId: "session-1",
                runId: "run-1",
                engineId: "review-coderabbit",
                authorKind: "plugin",
                authorId: "review-coderabbit",
                folderPath: "src/security",
                severity: "critical",
                taxonomyIds: ["security.open_redirect"],
                limit: 10,
            }),
        });
        expect(active.items.map((comment) => comment.id)).toEqual([matching.comment.id]);

        const defaultHistory = await operations.list({
            accountId: "account-1",
            input: listInput({ projectId: "project-1", limit: 10 }),
        });
        expect(defaultHistory.items.some((comment) => comment.id === history.comment.id)).toBe(false);

        const explicitHistory = await operations.list({
            accountId: "account-1",
            input: { projectId: "project-1", includeHistory: true, states: ["resolved"], taxonomyIds: [], limit: 10 },
        });
        expect(explicitHistory.items.map((comment) => comment.id)).toEqual([history.comment.id]);
    });
});
