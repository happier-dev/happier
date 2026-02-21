import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

const createSessionMessage = vi.fn(async () => ({ ok: false, error: "invalid-params" }));
vi.mock("@/app/session/sessionWriteService", () => ({
    createSessionMessage,
    updateSessionMetadata: vi.fn(async () => ({ ok: false, error: "internal" })),
    updateSessionAgentState: vi.fn(async () => ({ ok: false, error: "internal" })),
}));
vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

describe("sessionUpdateHandler", () => {
    beforeEach(() => {
        createSessionMessage.mockClear();
    });

    it("does not crash on invalid message payloads and acks with invalid-params when callback is provided", async () => {
        const socket = createFakeSocket();

        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");
        sessionUpdateHandler(
            "user-1",
            socket as any,
            // minimal connection object for logging
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "message");

        const callback = vi.fn();
        await handler({ sid: "s-1" }, callback); // missing message

        expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({
                ok: false,
                error: "invalid-params",
            }),
        );
    });

    it("does not crash on invalid message payloads when callback is missing (old clients)", async () => {
        const socket = createFakeSocket();

        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");
        sessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "message");

        await expect(handler({ sid: "s-1" })).resolves.toBeUndefined();
    });

    it("accepts plain message envelopes and forwards them to createSessionMessage", async () => {
        const socket = createFakeSocket();

        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");
        sessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "message");
        const callback = vi.fn();
        await handler({ sid: "s-1", message: { t: "plain", v: { type: "user", text: "hi" } } }, callback);

        expect(createSessionMessage).toHaveBeenCalledWith({
            actorUserId: "user-1",
            sessionId: "s-1",
            content: { t: "plain", v: { type: "user", text: "hi" } },
            localId: null,
        });
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: "invalid-params" }));
    });

    it("does not crash when plain message envelopes contain unserializable payloads", async () => {
        const socket = createFakeSocket();

        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");
        sessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const circular: any = { kind: "circular" };
        circular.self = circular;

        const handler = getSocketHandler(socket, "message");
        const callback = vi.fn();
        await handler({ sid: "s-1", message: { t: "plain", v: circular } }, callback);

        expect(createSessionMessage).toHaveBeenCalledWith({
            actorUserId: "user-1",
            sessionId: "s-1",
            content: { t: "plain", v: circular },
            localId: null,
        });
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: "invalid-params" }));
    });
});
