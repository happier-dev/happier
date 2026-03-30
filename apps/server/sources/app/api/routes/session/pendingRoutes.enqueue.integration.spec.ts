import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const enqueuePendingMessage = vi.fn();

vi.mock("@/app/session/pending/pendingMessageService", () => ({
    enqueuePendingMessage,
}));

describe("sessionPendingRoutes (enqueue)", () => {
    beforeEach(() => {
        vi.resetModules();
        enqueuePendingMessage.mockReset();
    });

    it("forwards plain content payloads to enqueuePendingMessage", async () => {
        const createdAt = new Date(1);
        enqueuePendingMessage.mockResolvedValueOnce({
            ok: true,
            didWrite: true,
            pending: {
                localId: "l1",
                content: { t: "plain", v: { type: "user", text: "hi" } },
                status: "queued",
                position: 1,
                createdAt,
                updatedAt: createdAt,
                discardedAt: null,
                discardedReason: null,
                authorAccountId: "actor",
            },
            pendingCount: 1,
            pendingVersion: 1,
            participantCursors: [],
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });

        const { reply } = await route.invoke(
            {
                userId: "actor",
                params: { sessionId: "s1" },
                body: { localId: "l1", content: { t: "plain", v: { type: "user", text: "hi" } } },
            },
        );

        expect(enqueuePendingMessage).toHaveBeenCalledWith({
            actorUserId: "actor",
            sessionId: "s1",
            localId: "l1",
            content: { t: "plain", v: { type: "user", text: "hi" } },
        });
        expect(reply.send).toHaveBeenCalledWith(
            expect.objectContaining({
                didWrite: true,
                pendingCount: 1,
                pendingVersion: 1,
            }),
        );
    });

    it("includes a stable error code when enqueuePendingMessage returns invalid-params with a code", async () => {
        enqueuePendingMessage.mockResolvedValueOnce({
            ok: false,
            error: "invalid-params",
            code: "session_encryption_mode_mismatch",
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });

        const { reply } = await route.invoke(
            {
                userId: "actor",
                params: { sessionId: "s1" },
                body: { localId: "l1", ciphertext: "cipher" },
            },
        );

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(reply.send).toHaveBeenCalledWith({
            error: "invalid-params",
            code: "session_encryption_mode_mismatch",
        });
    });
});
