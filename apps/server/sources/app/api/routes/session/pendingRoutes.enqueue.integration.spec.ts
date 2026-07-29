import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const enqueuePendingMessage = vi.fn();
const emitUpdate = vi.fn();
const buildPendingChangedUpdate = vi.fn(() => ({ type: "pending-changed" }));

vi.mock("@/app/session/pending/pendingMessageService", () => ({
    enqueuePendingMessage,
}));
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildPendingChangedUpdate,
}));
vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked: () => "update-id" }));

describe("sessionPendingRoutes (enqueue)", () => {
    beforeEach(() => {
        vi.resetModules();
        enqueuePendingMessage.mockReset();
        emitUpdate.mockReset();
        buildPendingChangedUpdate.mockClear();
    });

    it("forwards the external handoff admission mode to enqueuePendingMessage", async () => {
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
                body: { localId: "l1", content: { t: "plain", v: { type: "user", text: "hi" } }, deliveryMode: "external_handoff" },
            },
        );

        expect(enqueuePendingMessage).toHaveBeenCalledWith({
            actorUserId: "actor",
            sessionId: "s1",
            localId: "l1",
            content: { t: "plain", v: { type: "user", text: "hi" } },
            messageRole: null,
            deliveryMode: "external_handoff",
            requestedAction: { v: 1, kind: "enqueue" },
        });
        expect(reply.send).toHaveBeenCalledWith(
            expect.objectContaining({
                didWrite: true,
                pendingCount: 1,
                pendingVersion: 1,
            }),
        );
    });

    it("forwards conditional continuation admission and returns suppression without a Pending row", async () => {
        enqueuePendingMessage.mockResolvedValueOnce({
            ok: true,
            didWrite: false,
            suppressed: true,
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 4,
            badgeAttentionChanged: false,
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

        const { reply } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1" },
            body: {
                localId: "connected-service-continuation:test",
                ciphertext: "cipher",
                messageRole: "user",
                deliveryMode: "continuation_if_no_queued_user_input",
                requestedAction: { v: 1, kind: "send_now" },
            },
        });

        expect(enqueuePendingMessage).toHaveBeenCalledWith({
            actorUserId: "actor",
            sessionId: "s1",
            localId: "connected-service-continuation:test",
            ciphertext: "cipher",
            messageRole: "user",
            admissionMode: "continuation_if_no_queued_user_input",
            requestedAction: { v: 1, kind: "send_now" },
        });
        expect(reply.send).toHaveBeenCalledWith({
            didWrite: false,
            suppressed: true,
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 4,
        });
    });

    it("acknowledges the persisted requested action on enqueue", async () => {
        const createdAt = new Date(1);
        const requestedAction = { v: 1 as const, kind: "send_now" as const };
        enqueuePendingMessage.mockResolvedValueOnce({
            ok: true,
            didWrite: true,
            pending: {
                localId: "l-exact",
                messageRole: "user",
                content: { t: "encrypted", c: "cipher" },
                requestedAction,
                status: "queued",
                deliveryStatus: { status: "queued" },
                position: 1,
                createdAt,
                updatedAt: createdAt,
                discardedAt: null,
                discardedReason: null,
                authorAccountId: "actor",
            },
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 1,
            badgeAttentionChanged: false,
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
        const { response } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1" },
            body: { localId: "l-exact", ciphertext: "cipher", messageRole: "user", requestedAction },
        });

        expect(response).toEqual(expect.objectContaining({ requestedAction }));
    });

    it("returns the exact committed-message proof for a terminal same-localId rejoin", async () => {
        const requestedAction = { v: 1 as const, kind: "send_now" as const };
        const createdAt = new Date(10);
        const updatedAt = new Date(11);
        enqueuePendingMessage.mockResolvedValueOnce({
            ok: true,
            terminal: true,
            didWrite: false,
            message: {
                id: "message-1",
                seq: 7,
                localId: "l-terminal",
                messageRole: "user",
                content: { t: "encrypted", c: "cipher" },
                requestedAction,
                createdAt,
                updatedAt,
            },
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 4,
            badgeAttentionChanged: false,
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
        const { response } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1" },
            body: { localId: "l-terminal", ciphertext: "cipher", messageRole: "user", requestedAction },
        });

        expect(response).toEqual(expect.objectContaining({
            didWrite: false,
            terminal: true,
            requestedAction,
            message: expect.objectContaining({
                id: "message-1",
                seq: 7,
                localId: "l-terminal",
            }),
        }));
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

    it("forwards unsupported messageRole metadata without rejecting enqueue", async () => {
        const createdAt = new Date(1);
        enqueuePendingMessage.mockResolvedValueOnce({
            ok: true,
            didWrite: true,
            pending: {
                localId: "l1",
                content: { t: "encrypted", c: "cipher" },
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

        const { reply } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1" },
            body: { localId: "l1", ciphertext: "cipher", messageRole: "future-role" },
        });

        expect(reply.code).not.toHaveBeenCalledWith(400);
        expect(enqueuePendingMessage).toHaveBeenCalledWith(expect.objectContaining({
            messageRole: "future-role",
        }));
    });

    it("publishes one exact machine activation after an inactive send-now row is durably committed", async () => {
        const createdAt = new Date("2026-07-23T12:00:00.000Z");
        enqueuePendingMessage.mockResolvedValueOnce({
            ok: true,
            didWrite: true,
            pending: {
                localId: "pending-after-ui-death",
                messageRole: "user",
                content: { t: "encrypted", c: "cipher" },
                requestedAction: { v: 1, kind: "send_now" },
                status: "queued",
                deliveryStatus: { status: "queued" },
                position: 1,
                createdAt,
                updatedAt: createdAt,
                discardedAt: null,
                discardedReason: null,
                authorAccountId: "actor",
            },
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 9,
            meaningfulActivityAt: createdAt,
            badgeAttentionChanged: false,
            participantCursors: [{ accountId: "owner", cursor: 41 }],
            activationTarget: {
                accountId: "owner",
                requestId: "pending-after-ui-death",
            },
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });

        await route.invoke({
            userId: "actor",
            params: { sessionId: "inactive-session" },
            body: {
                localId: "pending-after-ui-death",
                ciphertext: "cipher",
                messageRole: "user",
                requestedAction: { v: 1, kind: "send_now" },
            },
        });

        expect(buildPendingChangedUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: "inactive-session",
                pendingVersion: 9,
                pendingCount: 1,
                pendingActivationRequestId: "pending-after-ui-death",
            }),
            41,
            "update-id",
        );
        expect(emitUpdate).toHaveBeenCalledWith({
            userId: "owner",
            payload: { type: "pending-changed" },
            recipientFilter: { type: "user-machine-scoped-only" },
        });
    });
});
