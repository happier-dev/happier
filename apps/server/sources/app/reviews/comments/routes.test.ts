import { describe, expect, it } from "vitest";

import type { ReviewCommentActorRefV1 } from "@happier-dev/protocol";
import {
    REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
    ReviewCommentCreateResponseV1Schema,
} from "@happier-dev/protocol";

import { createFakeRouteApp, createReplyStub, getRouteHandler } from "@/app/api/testkit/routeHarness";
import { buildReviewCommentTextSnapshotHashes } from "./snapshots";
import { createInMemoryReviewCommentStore } from "./store";
import { createReviewCommentOperations } from "./operations";
import { registerReviewCommentRoutes } from "./routes";

function createHarness() {
    let now = 1000;
    let id = 0;
    const store = createInMemoryReviewCommentStore();
    const operations = createReviewCommentOperations(store, {
        now: () => now++,
        createId: (prefix) => `${prefix}-${++id}`,
    });
    const actor: ReviewCommentActorRefV1 = { kind: "user", userId: "user-1" };
    const app = createFakeRouteApp();
    registerReviewCommentRoutes(app as any, {
        operations,
        resolvePrincipal: async () => ({
            accountId: "account-1",
            actor,
            grants: [REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1],
        }),
    });
    return { app };
}

function textSnapshot() {
    const lines = {
        selectedLines: ["return value.name;"],
        beforeContext: [],
        afterContext: [],
    };
    const hashes = buildReviewCommentTextSnapshotHashes(lines);
    return {
        kind: "text" as const,
        ...lines,
        ...hashes,
        capturedAt: 1,
        fileLength: 1,
        source: "workingTree" as const,
        isUncommitted: true,
        isUntracked: false,
        truncated: false,
        hasBidiControls: false,
        likelyMinified: false,
    };
}

describe("review comment routes", () => {
    it("registers list/get/create/edit/transition/bulkTransition/redact routes with authenticated prehandlers", () => {
        const { app } = createHarness();

        for (const route of [
            "GET /v1/reviews/comments",
            "GET /v1/reviews/comments/:commentId",
            "POST /v1/reviews/comments",
            "PATCH /v1/reviews/comments/:commentId",
            "POST /v1/reviews/comments/:commentId/transition",
            "POST /v1/reviews/comments/bulkTransition",
            "POST /v1/reviews/comments/:commentId/redact",
        ]) {
            expect(app.routes.get(route)?.opts.preHandler).toBe(app.authenticate);
        }
    });

    it("creates and lists durable comments with canonical protocol response shapes", async () => {
        const { app } = createHarness();
        const create = getRouteHandler(app, "POST", "/v1/reviews/comments");
        const createReply = createReplyStub();

        const created = ReviewCommentCreateResponseV1Schema.parse(await create({
            userId: "user-1",
            body: {
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
                snapshot: textSnapshot(),
                body: "Null-check this value.",
                authorIntent: "open",
                clientMutationId: "mutation-1",
            },
        }, createReply));

        expect(createReply.statusCode).toBe(200);
        expect(created).toMatchObject({ comment: { state: "open", projectId: "project-1" } });

        const list = getRouteHandler(app, "GET", "/v1/reviews/comments");
        const listed = await list({
            userId: "user-1",
            query: { projectId: "project-1" },
        }, createReplyStub());
        expect(listed).toMatchObject({ items: [{ id: created.comment.id }], cursor: null });
    });

    it("returns stable review-comment errors for malformed route inputs", async () => {
        const { app } = createHarness();
        const list = getRouteHandler(app, "GET", "/v1/reviews/comments");
        const create = getRouteHandler(app, "POST", "/v1/reviews/comments");

        const listReply = createReplyStub();
        const listed = await list({
            userId: "user-1",
            query: { limit: 1000 },
        }, listReply);
        expect(listReply.statusCode).toBe(400);
        expect(listed).toMatchObject({ error: "review_comment_invalid_filter" });

        const createReply = createReplyStub();
        const created = await create({
            userId: "user-1",
            body: {},
        }, createReply);
        expect(createReply.statusCode).toBe(400);
        expect(created).toMatchObject({ error: "review_comment_invalid_request" });
    });
});
