import { beforeEach, describe, expect, it } from "vitest";

import {
    buildUpdateSessionUpdate,
    createSessionRouteReply,
    emitUpdate,
    patchSession,
    registerSessionRoutesAndGetHandler,
    resetSessionRouteMocks,
} from "./sessionRoutes.testkit";

describe("sessionRoutes v2 patch", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
    });

    it("emits update-session using returned per-recipient cursors", async () => {
        patchSession.mockResolvedValue({
            ok: true,
            participantCursors: [
                { accountId: "u1", cursor: 10 },
                { accountId: "u2", cursor: 11 },
            ],
            metadata: { version: 2, value: "mNew" },
            agentState: { version: 3, value: null },
        });

        const { handler } = await registerSessionRoutesAndGetHandler("PATCH", "/v2/sessions/:sessionId");
        const reply = createSessionRouteReply();

        const res = await handler(
            {
                userId: "u1",
                params: { sessionId: "s1" },
                body: {
                    metadata: { ciphertext: "mNew", expectedVersion: 1 },
                    agentState: { ciphertext: null, expectedVersion: 2 },
                },
            },
            reply,
        );

        expect(patchSession).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            metadata: { ciphertext: "mNew", expectedVersion: 1 },
            agentState: { ciphertext: null, expectedVersion: 2 },
        });

        expect(buildUpdateSessionUpdate).toHaveBeenCalledWith(
            "s1",
            10,
            expect.any(String),
            { value: "mNew", version: 2 },
            { value: null, version: 3 },
        );
        expect(buildUpdateSessionUpdate).toHaveBeenCalledWith(
            "s1",
            11,
            expect.any(String),
            { value: "mNew", version: 2 },
            { value: null, version: 3 },
        );
        expect(emitUpdate).toHaveBeenCalledTimes(2);

        expect(res).toEqual({
            success: true,
            metadata: { version: 2 },
            agentState: { version: 3 },
        });
    });

    it("passes through version-mismatch current values", async () => {
        patchSession.mockResolvedValue({
            ok: false,
            error: "version-mismatch",
            current: { metadata: { version: 9, value: "m9" } },
        });

        const { handler } = await registerSessionRoutesAndGetHandler("PATCH", "/v2/sessions/:sessionId");
        const reply = createSessionRouteReply();

        const res = await handler(
            {
                userId: "u1",
                params: { sessionId: "s1" },
                body: {
                    metadata: { ciphertext: "mNew", expectedVersion: 1 },
                },
            },
            reply,
        );

        expect(res).toEqual({
            success: false,
            error: "version-mismatch",
            metadata: { version: 9, value: "m9" },
        });
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("returns 500 on version-mismatch when current state is missing", async () => {
        patchSession.mockResolvedValue({
            ok: false,
            error: "version-mismatch",
            current: null,
        });

        const { handler } = await registerSessionRoutesAndGetHandler("PATCH", "/v2/sessions/:sessionId");
        const reply = createSessionRouteReply();

        const res = await handler(
            {
                userId: "u1",
                params: { sessionId: "s1" },
                body: {
                    metadata: { ciphertext: "mNew", expectedVersion: 1 },
                },
            },
            reply,
        );

        expect(reply.code).toHaveBeenCalledWith(500);
        expect(res).toEqual({ error: "Failed to update session" });
        expect(emitUpdate).not.toHaveBeenCalled();
    });
});
