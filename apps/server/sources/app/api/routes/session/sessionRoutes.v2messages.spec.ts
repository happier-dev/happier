import { beforeEach, describe, expect, it } from "vitest";

import {
    buildNewMessageUpdate,
    createSessionMessage,
    createSessionRouteReply,
    emitUpdate,
    registerSessionRoutesAndGetHandler,
    resetSessionRouteMocks,
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
            content: { t: "encrypted", c: "cipher" },
            createdAt,
            updatedAt,
        });

        const { handler } = await registerSessionRoutesAndGetHandler("GET", "/v2/sessions/:sessionId/messages/by-local-id/:localId");
        const reply = createSessionRouteReply();

        const res = await handler(
            {
                userId: "u1",
                params: { sessionId: "s1", localId: "l1" },
                headers: {},
                query: {},
            },
            reply,
        );

        expect(sessionMessageFindUnique).toHaveBeenCalledWith({
            where: { sessionId_localId: { sessionId: "s1", localId: "l1" } },
            select: expect.any(Object),
        });

        expect(res).toEqual({
            message: {
                id: "m1",
                seq: 10,
                localId: "l1",
                content: { t: "encrypted", c: "cipher" },
                createdAt: createdAt.getTime(),
                updatedAt: updatedAt.getTime(),
            },
        });
    });

    it("returns 404 when message localId is not found", async () => {
        const { sessionMessageFindUnique } = await import("./sessionRoutes.testkit");
        sessionMessageFindUnique.mockResolvedValueOnce(null);

        const { handler } = await registerSessionRoutesAndGetHandler("GET", "/v2/sessions/:sessionId/messages/by-local-id/:localId");
        const reply = createSessionRouteReply();

        await handler(
            {
                userId: "u1",
                params: { sessionId: "s1", localId: "missing" },
                headers: {},
                query: {},
            },
            reply,
        );

        expect(reply.code).toHaveBeenCalledWith(404);
        expect(reply.send).toHaveBeenCalledWith({ error: "Message not found" });
    });

    it("creates a message via service and emits updates using returned cursors", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        createSessionMessage.mockResolvedValue({
            ok: true,
            didWrite: true,
            message: { id: "m1", seq: 10, localId: "l1", content: { t: "encrypted", c: "c" }, createdAt, updatedAt: createdAt },
            participantCursors: [
                { accountId: "u1", cursor: 111 },
                { accountId: "u2", cursor: 222 },
            ],
        });

        const { handler } = await registerSessionRoutesAndGetHandler("POST", "/v2/sessions/:sessionId/messages");
        const reply = createSessionRouteReply();

        const res = await handler(
            {
                userId: "u1",
                params: { sessionId: "s1" },
                headers: {},
                body: { ciphertext: "cipher", localId: "l1" },
            },
            reply,
        );

        expect(createSessionMessage).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            ciphertext: "cipher",
            localId: "l1",
        });

        expect(buildNewMessageUpdate).toHaveBeenCalledTimes(2);
        expect(buildNewMessageUpdate).toHaveBeenCalledWith(expect.anything(), "s1", 111, expect.any(String));
        expect(buildNewMessageUpdate).toHaveBeenCalledWith(expect.anything(), "s1", 222, expect.any(String));
        expect(emitUpdate).toHaveBeenCalledTimes(2);

        expect(res).toEqual({
            didWrite: true,
            message: { id: "m1", seq: 10, localId: "l1", createdAt: createdAt.getTime() },
        });
    });

    it("uses Idempotency-Key header as localId when body.localId is missing", async () => {
        const createdAt = new Date(1);
        createSessionMessage.mockResolvedValue({
            ok: true,
            didWrite: false,
            message: { id: "m1", seq: 10, localId: "idem-1", createdAt },
            participantCursors: [],
        });

        const { handler } = await registerSessionRoutesAndGetHandler("POST", "/v2/sessions/:sessionId/messages");
        const reply = createSessionRouteReply();

        await handler(
            {
                userId: "u1",
                params: { sessionId: "s1" },
                headers: { "idempotency-key": "idem-1" },
                body: { ciphertext: "cipher" },
            },
            reply,
        );

        expect(createSessionMessage).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            ciphertext: "cipher",
            localId: "idem-1",
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
            message: { id: "m1", seq: 10, localId: null, content: { t: "plain", v: { type: "user", text: "hi" } }, createdAt, updatedAt: createdAt },
            participantCursors: [{ accountId: "u1", cursor: 111 }],
        });

        const { handler } = await registerSessionRoutesAndGetHandler("POST", "/v2/sessions/:sessionId/messages");
        const reply = createSessionRouteReply();

        const res = await handler(
            {
                userId: "u1",
                params: { sessionId: "s1" },
                headers: {},
                body: { content: { t: "plain", v: { type: "user", text: "hi" } } },
            },
            reply,
        );

        expect(createSessionMessage).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            content: { t: "plain", v: { type: "user", text: "hi" } },
            localId: null,
        });

        expect(res).toEqual({
            didWrite: true,
            message: { id: "m1", seq: 10, localId: null, createdAt: createdAt.getTime() },
        });
    });

    it("maps service errors to status codes", async () => {
        const { handler } = await registerSessionRoutesAndGetHandler("POST", "/v2/sessions/:sessionId/messages");

        const mkReply = () => createSessionRouteReply();

        createSessionMessage.mockResolvedValueOnce({ ok: false, error: "invalid-params" });
        const r1 = mkReply();
        await handler({ userId: "u1", params: { sessionId: "s1" }, headers: {}, body: { ciphertext: "" } }, r1);
        expect(r1.code).toHaveBeenCalledWith(400);

        createSessionMessage.mockResolvedValueOnce({ ok: false, error: "forbidden" });
        const r2 = mkReply();
        await handler({ userId: "u1", params: { sessionId: "s1" }, headers: {}, body: { ciphertext: "x" } }, r2);
        expect(r2.code).toHaveBeenCalledWith(403);

        createSessionMessage.mockResolvedValueOnce({ ok: false, error: "session-not-found" });
        const r3 = mkReply();
        await handler({ userId: "u1", params: { sessionId: "s1" }, headers: {}, body: { ciphertext: "x" } }, r3);
        expect(r3.code).toHaveBeenCalledWith(404);
    });

    it("includes a stable error code when the service provides one for invalid-params", async () => {
        const { handler } = await registerSessionRoutesAndGetHandler("POST", "/v2/sessions/:sessionId/messages");
        createSessionMessage.mockResolvedValueOnce({
            ok: false,
            error: "invalid-params",
            code: "session_encryption_mode_mismatch",
        });

        const reply = createSessionRouteReply();
        await handler(
            { userId: "u1", params: { sessionId: "s1" }, headers: {}, body: { ciphertext: "x" } },
            reply,
        );

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(reply.send).toHaveBeenCalledWith({
            error: "Invalid parameters",
            code: "session_encryption_mode_mismatch",
        });
    });
});
