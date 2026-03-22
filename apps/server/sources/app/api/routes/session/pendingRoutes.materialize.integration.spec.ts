import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const emitUpdate = vi.fn();
const buildNewMessageUpdate = vi.fn(() => ({ type: "new-message" }));
const buildPendingChangedUpdate = vi.fn(() => ({ type: "pending-changed" }));

const materializeNextPendingMessage = vi.fn();

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildNewMessageUpdate,
    buildPendingChangedUpdate,
}));

vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked: () => "k" }));

vi.mock("@/app/session/pending/pendingMessageService", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/session/pending/pendingMessageService")>();
    return {
        ...actual,
        materializeNextPendingMessage,
    };
});

describe("sessionPendingRoutes (materialize-next)", () => {
    beforeEach(() => {
        vi.resetModules();
        emitUpdate.mockReset();
        buildNewMessageUpdate.mockClear();
        buildPendingChangedUpdate.mockClear();
        materializeNextPendingMessage.mockReset();
    });

    it("emits new-message and pending-changed updates on successful materialization", async () => {
        materializeNextPendingMessage.mockResolvedValueOnce({
            ok: true,
            didMaterialize: true,
            didWriteMessage: true,
            message: { id: "m1", seq: 1, localId: "l1" },
            pendingCount: 0,
            pendingVersion: 2,
            participantCursorsMessage: [
                { accountId: "u1", cursor: 10 },
                { accountId: "u2", cursor: 11 },
            ],
            participantCursorsPending: [
                { accountId: "u1", cursor: 20 },
                { accountId: "u2", cursor: 21 },
            ],
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/materialize-next",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { response: res } = await route.invoke({ userId: "actor", params: { sessionId: "s1" } });

        expect(res).toEqual({
            ok: true,
            didMaterialize: true,
            didWriteMessage: true,
            message: { id: "m1", seq: 1, localId: "l1" },
        });

        expect(buildNewMessageUpdate).toHaveBeenCalledTimes(2);
        expect(buildPendingChangedUpdate).toHaveBeenCalledTimes(2);
        expect(emitUpdate).toHaveBeenCalledTimes(4);
    });

    it("keeps the route successful when one emitUpdate throws", async () => {
        materializeNextPendingMessage.mockResolvedValueOnce({
            ok: true,
            didMaterialize: true,
            didWriteMessage: true,
            message: { id: "m1", seq: 1, localId: "l1" },
            pendingCount: 0,
            pendingVersion: 2,
            participantCursorsMessage: [
                { accountId: "u1", cursor: 10 },
                { accountId: "u2", cursor: 11 },
            ],
            participantCursorsPending: [
                { accountId: "u1", cursor: 20 },
                { accountId: "u2", cursor: 21 },
            ],
        });
        emitUpdate
            .mockImplementationOnce(() => {
                throw new Error("emit failed");
            })
            .mockImplementation(() => undefined);

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/materialize-next",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { response: res } = await route.invoke({ userId: "actor", params: { sessionId: "s1" } });

        expect(res).toEqual({
            ok: true,
            didMaterialize: true,
            didWriteMessage: true,
            message: { id: "m1", seq: 1, localId: "l1" },
        });
        expect(buildPendingChangedUpdate).toHaveBeenCalledTimes(2);
    });
});
