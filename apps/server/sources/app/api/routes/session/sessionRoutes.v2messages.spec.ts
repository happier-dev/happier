import { beforeEach, describe, expect, it } from "vitest";

import {
    checkSessionAccess,
    buildNewMessageUpdate,
    buildMessageUpdatedUpdate,
    buildUpdateSessionUpdate,
    createSessionMessage,
    emitUpdate,
    createSessionRouteTestBuilder,
    getSessionParticipantUserIds,
    markAccountChanged,
    resetSessionRouteMocks,
    sessionMessageFindMany,
} from "./sessionRoutes.testkit";

describe("sessionRoutes v2 messages", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
    });

    it("fetches a message by localId", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        const updatedAt = new Date("2020-01-01T00:00:01.000Z");
        const { sessionMessageFindUnique } = await import("./sessionRoutes.testkit");
        sessionMessageFindUnique.mockResolvedValueOnce({
            id: "m1",
            seq: 10,
            localId: "l1",
            sidechainId: "sc-1",
            content: { t: "encrypted", c: "cipher" },
            createdAt,
            updatedAt,
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId/messages/by-local-id/:localId");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1", localId: "l1" },
            headers: {},
            query: {},
        });

        expect(sessionMessageFindUnique).toHaveBeenCalledWith({
            where: { sessionId_localId: { sessionId: "s1", localId: "l1" } },
            select: expect.any(Object),
        });

        expect(res).toEqual({
            message: {
                id: "m1",
                seq: 10,
                localId: "l1",
                sidechainId: "sc-1",
                content: { t: "encrypted", c: "cipher" },
                createdAt: createdAt.getTime(),
                updatedAt: updatedAt.getTime(),
            },
        });
    });

    it("returns 404 when message localId is not found", async () => {
        const { sessionMessageFindUnique } = await import("./sessionRoutes.testkit");
        sessionMessageFindUnique.mockResolvedValueOnce(null);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId/messages/by-local-id/:localId");
        const { reply } = await route.invoke({
            params: { sessionId: "s1", localId: "missing" },
            headers: {},
            query: {},
        });

        expect(reply.code).toHaveBeenCalledWith(404);
        expect(reply.send).toHaveBeenCalledWith({ error: "Message not found" });
    });

    it("returns only the exact local IDs absent from the requested session in one lookup", async () => {
        sessionMessageFindMany.mockResolvedValueOnce([{ localId: "present" }]);
        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/messages/by-local-id");
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            body: { localIds: ["present", "elsewhere", "absent", "absent"] },
        });

        expect(sessionMessageFindMany).toHaveBeenCalledExactlyOnceWith({
            where: { sessionId: "s1", localId: { in: ["present", "elsewhere", "absent"] } },
            select: { localId: true },
        });
        expect(response).toEqual({ absentLocalIds: ["elsewhere", "absent"] });
    });

    it("returns no exact local ID information to an account without session access", async () => {
        checkSessionAccess.mockResolvedValueOnce(null);
        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/messages/by-local-id", {
            defaultRequest: { userId: "unrelated-account" },
        });
        const { reply } = await route.invoke({
            params: { sessionId: "private-session" },
            body: { localIds: ["private-id"] },
        });

        expect(checkSessionAccess).toHaveBeenCalledWith("unrelated-account", "private-session");
        expect(reply.code).toHaveBeenCalledWith(404);
        expect(reply.send).toHaveBeenCalledWith({ error: "Session not found" });
        expect(sessionMessageFindMany).not.toHaveBeenCalled();
    });

    it("creates a message via service and emits updates using returned cursors", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        createSessionMessage.mockResolvedValue({
            ok: true,
            didWrite: true,
            didUpdate: false,
            message: { id: "m1", seq: 10, localId: "l1", content: { t: "encrypted", c: "c" }, createdAt, updatedAt: createdAt },
            participantCursors: [
                { accountId: "u1", cursor: 111 },
                { accountId: "u2", cursor: 222 },
            ],
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/messages");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            headers: {},
            body: { ciphertext: "cipher", localId: "l1" },
        });

        expect(createSessionMessage).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            ciphertext: "cipher",
            localId: "l1",
            sidechainId: null,
        });

        expect(buildNewMessageUpdate).toHaveBeenCalledTimes(2);
        expect(buildNewMessageUpdate).toHaveBeenCalledWith(expect.anything(), "s1", 111, expect.any(String));
        expect(buildNewMessageUpdate).toHaveBeenCalledWith(expect.anything(), "s1", 222, expect.any(String));
        expect(buildUpdateSessionUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).toHaveBeenCalledTimes(2);

        expect(res).toEqual({
            didWrite: true,
            message: { id: "m1", seq: 10, localId: "l1", createdAt: createdAt.getTime() },
        });
    });

    it("emits trusted write-service attention impact with new-message updates", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        const attentionImpact = {
            affectsUnread: false,
            affectsMeaningfulActivity: false,
        };
        createSessionMessage.mockResolvedValue({
            ok: true,
            didWrite: true,
            didUpdate: false,
            badgeAttentionChanged: false,
            attentionImpact,
            message: {
                id: "m1",
                seq: 10,
                localId: "provider-quota-wait:openai-codex:happier:reset_at_100",
                messageRole: "event",
                content: { t: "encrypted", c: "c" },
                createdAt,
                updatedAt: createdAt,
            },
            participantCursors: [
                { accountId: "u1", cursor: 111 },
            ],
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/messages");
        await route.invoke({
            params: { sessionId: "s1" },
            headers: {},
            body: {
                ciphertext: "cipher",
                localId: "provider-quota-wait:openai-codex:happier:reset_at_100",
                messageRole: "event",
            },
        });

        expect(buildNewMessageUpdate).toHaveBeenCalledWith(
            expect.anything(),
            "s1",
            111,
            expect.any(String),
            { attentionImpact },
        );
    });

    it("forwards ready event hints so the message write service can apply owner-only validation", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        createSessionMessage.mockResolvedValue({
            ok: true,
            didWrite: true,
            didUpdate: false,
            message: { id: "m-ready", seq: 10, localId: "ready-1", content: { t: "encrypted", c: "c" }, createdAt, updatedAt: createdAt },
            participantCursors: [
                { accountId: "u1", cursor: 111 },
                { accountId: "u2", cursor: 222 },
            ],
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/messages");
        await route.invoke({
            params: { sessionId: "s1" },
            headers: {},
            body: { ciphertext: "cipher", localId: "ready-1", sessionEventType: "ready" },
        });

        expect(createSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
            actorUserId: "u1",
            sessionId: "s1",
            ciphertext: "cipher",
            localId: "ready-1",
            sidechainId: null,
            trustedSessionEventType: "ready",
        }));
        expect(buildNewMessageUpdate).toHaveBeenCalledWith(expect.anything(), "s1", 111, expect.any(String));
        expect(buildNewMessageUpdate).toHaveBeenCalledWith(expect.anything(), "s1", 222, expect.any(String));
        expect(buildUpdateSessionUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).toHaveBeenCalledTimes(2);
    });

    it("does not forward connected-service attention overrides from the public route even for owner callers", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        createSessionMessage.mockResolvedValue({
            ok: true,
            didWrite: true,
            didUpdate: false,
            message: { id: "m1", seq: 10, localId: "connected-service-account-switch:openai-codex:main:1", content: { t: "encrypted", c: "c" }, createdAt, updatedAt: createdAt },
            participantCursors: [],
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/messages");
        await route.invoke({
            params: { sessionId: "s1" },
            headers: {},
            body: {
                ciphertext: "cipher",
                localId: "connected-service-account-switch:openai-codex:main:1",
                messageRole: "event",
                attentionImpact: {
                    affectsUnread: false,
                    affectsMeaningfulActivity: false,
                },
            },
        });

        expect(createSessionMessage).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            ciphertext: "cipher",
            localId: "connected-service-account-switch:openai-codex:main:1",
            sidechainId: null,
            messageRole: "event",
        });
    });

    it("does not forward connected-service non-unread attention for non-owner callers", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        createSessionMessage.mockResolvedValue({
            ok: true,
            didWrite: true,
            didUpdate: false,
            message: { id: "m1", seq: 10, localId: "connected-service-account-switch:openai-codex:main:1", content: { t: "encrypted", c: "c" }, createdAt, updatedAt: createdAt },
            participantCursors: [],
        });
        checkSessionAccess.mockResolvedValueOnce({ level: "edit" });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/messages");
        await route.invoke({
            params: { sessionId: "s1" },
            headers: {},
            body: {
                ciphertext: "cipher",
                localId: "connected-service-account-switch:openai-codex:main:1",
                messageRole: "event",
                attentionImpact: {
                    affectsUnread: false,
                    affectsMeaningfulActivity: false,
                },
            },
        });

        expect(createSessionMessage).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            ciphertext: "cipher",
            localId: "connected-service-account-switch:openai-codex:main:1",
            sidechainId: null,
            messageRole: "event",
        });
    });

    it("does not forward caller-supplied attention overrides from the public route", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        createSessionMessage.mockResolvedValue({
            ok: true,
            didWrite: true,
            didUpdate: false,
            message: { id: "m1", seq: 10, localId: "l1", content: { t: "encrypted", c: "c" }, createdAt, updatedAt: createdAt },
            participantCursors: [],
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/messages");
        await route.invoke({
            params: { sessionId: "s1" },
            headers: {},
            body: {
                ciphertext: "cipher",
                localId: "l1",
                attentionImpact: {
                    affectsUnread: false,
                    affectsMeaningfulActivity: false,
                },
                affectsUnread: false,
            },
        });

        expect(createSessionMessage).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            ciphertext: "cipher",
            localId: "l1",
            sidechainId: null,
        });
    });

    it("forwards sidechainId to the message write service when provided", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        createSessionMessage.mockResolvedValue({
            ok: true,
            didWrite: true,
            didUpdate: false,
            message: { id: "m1", seq: 10, localId: "l1", sidechainId: "sc-1", content: { t: "encrypted", c: "c" }, createdAt, updatedAt: createdAt },
            participantCursors: [],
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/messages");
        await route.invoke({
            params: { sessionId: "s1" },
            headers: {},
            body: { ciphertext: "cipher", localId: "l1", sidechainId: "sc-1" },
        });

        expect(createSessionMessage).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            ciphertext: "cipher",
            localId: "l1",
            sidechainId: "sc-1",
        });
    });

    it("forwards messageRole to the message write service when provided", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        createSessionMessage.mockResolvedValue({
            ok: true,
            didWrite: true,
            didUpdate: false,
            message: { id: "m1", seq: 10, localId: "l1", sidechainId: null, messageRole: "user", content: { t: "encrypted", c: "c" }, createdAt, updatedAt: createdAt },
            participantCursors: [],
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/messages");
        await route.invoke({
            params: { sessionId: "s1" },
            headers: {},
            body: { ciphertext: "cipher", localId: "l1", messageRole: "user" },
        });

        expect(createSessionMessage).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            ciphertext: "cipher",
            localId: "l1",
            sidechainId: null,
            messageRole: "user",
        });
    });

    it("allows unsupported messageRole metadata through request validation", async () => {
        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/messages");
        const entry = route.app.routes.get("POST /v2/sessions/:sessionId/messages");
        const schema = entry?.opts.schema;
        if (!schema || typeof schema !== "object" || !("body" in schema)) {
            throw new Error("Expected route body schema");
        }
        const bodySchema = schema.body as { safeParse(value: unknown): { success: boolean } };

        expect(bodySchema.safeParse({ ciphertext: "cipher", localId: "l1", messageRole: "tool" }).success).toBe(true);
    });

    it("emits message-updated when the service updates an existing message row", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        const updatedAt = new Date("2020-01-01T00:00:01.000Z");

        createSessionMessage.mockResolvedValue({
            ok: true,
            didWrite: false,
            didUpdate: true,
            message: {
                id: "m1",
                seq: 10,
                localId: "l1",
                sidechainId: null,
                content: { t: "encrypted", c: "c" },
                createdAt,
                updatedAt,
            },
            participantCursors: [{ accountId: "u1", cursor: 111 }],
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/messages");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            headers: {},
            body: { ciphertext: "cipher", localId: "l1" },
        });

        expect(buildNewMessageUpdate).not.toHaveBeenCalled();
        expect(buildMessageUpdatedUpdate).toHaveBeenCalledTimes(1);
        expect(buildMessageUpdatedUpdate).toHaveBeenCalledWith(expect.anything(), "s1", 111, expect.any(String));
        expect(emitUpdate).toHaveBeenCalledTimes(1);

        expect(res).toEqual({
            didWrite: false,
            didUpdate: true,
            message: { id: "m1", seq: 10, localId: "l1", createdAt: createdAt.getTime() },
        });
    });

    it("uses Idempotency-Key header as localId when body.localId is missing", async () => {
        const createdAt = new Date(1);
        createSessionMessage.mockResolvedValue({
            ok: true,
            didWrite: false,
            didUpdate: false,
            message: { id: "m1", seq: 10, localId: "idem-1", content: { t: "encrypted", c: "c" }, sidechainId: null, createdAt, updatedAt: createdAt },
            participantCursors: [],
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/messages");
        const { reply } = await route.invoke({
            params: { sessionId: "s1" },
            headers: { "idempotency-key": "idem-1" },
            body: { ciphertext: "cipher" },
        });

        expect(createSessionMessage).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            ciphertext: "cipher",
            localId: "idem-1",
            sidechainId: null,
        });
        expect(emitUpdate).not.toHaveBeenCalled();

        expect(reply.send).toHaveBeenCalledWith({
            didWrite: false,
            message: { id: "m1", seq: 10, localId: "idem-1", createdAt: createdAt.getTime() },
        });
    });

    it("accepts plain content writes and forwards them to the service", async () => {
        const createdAt = new Date(1);
        createSessionMessage.mockResolvedValue({
            ok: true,
            didWrite: true,
            didUpdate: false,
            message: { id: "m1", seq: 10, localId: null, sidechainId: null, content: { t: "plain", v: { type: "user", text: "hi" } }, createdAt, updatedAt: createdAt },
            participantCursors: [{ accountId: "u1", cursor: 111 }],
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/messages");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            headers: {},
            body: { content: { t: "plain", v: { type: "user", text: "hi" } } },
        });

        expect(createSessionMessage).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            content: { t: "plain", v: { type: "user", text: "hi" } },
            localId: null,
            sidechainId: null,
        });

        expect(res).toEqual({
            didWrite: true,
            message: { id: "m1", seq: 10, localId: null, createdAt: createdAt.getTime() },
        });
    });

    it("maps service errors to status codes", async () => {
        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/messages");

        createSessionMessage.mockResolvedValueOnce({ ok: false, error: "invalid-params" });
        const r1 = await route.invoke({ params: { sessionId: "s1" }, headers: {}, body: { ciphertext: "" } });
        expect(r1.reply.code).toHaveBeenCalledWith(400);

        createSessionMessage.mockResolvedValueOnce({ ok: false, error: "forbidden" });
        const r2 = await route.invoke({ params: { sessionId: "s1" }, headers: {}, body: { ciphertext: "x" } });
        expect(r2.reply.code).toHaveBeenCalledWith(403);

        createSessionMessage.mockResolvedValueOnce({ ok: false, error: "session-not-found" });
        const r3 = await route.invoke({ params: { sessionId: "s1" }, headers: {}, body: { ciphertext: "x" } });
        expect(r3.reply.code).toHaveBeenCalledWith(404);
    });

    it("includes a stable error code when the service provides one for invalid-params", async () => {
        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/messages");
        createSessionMessage.mockResolvedValueOnce({
            ok: false,
            error: "invalid-params",
            code: "session_encryption_mode_mismatch",
        });

        const { reply } = await route.invoke({ params: { sessionId: "s1" }, headers: {}, body: { ciphertext: "x" } });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(reply.send).toHaveBeenCalledWith({
            error: "Invalid parameters",
            code: "session_encryption_mode_mismatch",
        });
    });
});
