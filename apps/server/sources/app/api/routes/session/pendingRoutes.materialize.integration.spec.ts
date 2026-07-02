import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const emitUpdate = vi.fn();
const buildNewMessageUpdate = vi.fn(() => ({ type: "new-message" }));
const buildPendingChangedUpdate = vi.fn(() => ({ type: "pending-changed" }));
const buildUpdateSessionUpdate = vi.fn(() => ({ type: "update-session" }));
const getSessionParticipantUserIds = vi.fn(async () => ["u1"]);
const markAccountChanged = vi.fn(async () => 10);

const materializeNextPendingMessage = vi.fn();
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildNewMessageUpdate,
    buildPendingChangedUpdate,
    buildUpdateSessionUpdate,
}));

vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked: () => "k" }));
vi.mock("@/app/share/sessionParticipants", () => ({ getSessionParticipantUserIds }));
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));
vi.mock("@/storage/inTx", () => ({
    inTx: vi.fn(async (fn: (tx: unknown) => unknown) => await fn({})),
}));

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
        buildUpdateSessionUpdate.mockClear();
        getSessionParticipantUserIds.mockReset();
        getSessionParticipantUserIds.mockResolvedValue(["u1"]);
        markAccountChanged.mockReset();
        markAccountChanged.mockResolvedValue(10);
        materializeNextPendingMessage.mockReset();
    });

    it("does not register the temporary pending-state reconciliation route", async () => {
        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/sessions/:sessionId/pending/state",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });

        expect(route.routeExists).toBe(false);
    });

    it("emits new-message and pending-changed updates on successful materialization", async () => {
        materializeNextPendingMessage.mockResolvedValueOnce({
            ok: true,
            didMaterialize: true,
            didWriteMessage: true,
            message: { id: "m1", seq: 1, localId: "l1", messageRole: "user", content: { t: "plain", v: { role: "user", content: { type: "text", text: "hello" } } }, createdAt: new Date(1_000), updatedAt: new Date(1_000) },
            pendingCount: 0,
            pendingVersion: 2,
            meaningfulActivityAt: new Date(1_000),
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
            message: { id: "m1", seq: 1, localId: "l1", messageRole: "user", content: { t: "plain", v: { role: "user", content: { type: "text", text: "hello" } } }, createdAt: 1_000, updatedAt: 1_000 },
            pendingCount: 0,
            pendingVersion: 2,
        });

        expect(buildNewMessageUpdate).toHaveBeenCalledTimes(2);
        expect(buildPendingChangedUpdate).toHaveBeenCalledTimes(2);
        expect(buildPendingChangedUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: "s1",
                pendingCount: 0,
                pendingVersion: 2,
                meaningfulActivityAt: new Date(1_000),
            }),
            20,
            "k",
        );
        expect(buildUpdateSessionUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).toHaveBeenCalledTimes(4);
    });

    it("returns pending state when no queued message is materialized", async () => {
        materializeNextPendingMessage.mockResolvedValueOnce({
            ok: true,
            didMaterialize: false,
            pendingCount: 0,
            pendingVersion: 5,
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

        expect(res).toEqual({ ok: true, didMaterialize: false, pendingCount: 0, pendingVersion: 5 });
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("emits ready projection updates when materialization returns a ready projection", async () => {
        materializeNextPendingMessage.mockResolvedValueOnce({
            ok: true,
            didMaterialize: true,
            didWriteMessage: true,
            message: {
                id: "m-ready",
                seq: 7,
                localId: "ready-local",
                messageRole: "event",
                content: { t: "plain", v: { type: "event" } },
                createdAt: new Date(1_000),
                updatedAt: new Date(1_000),
            },
            pendingCount: 0,
            pendingVersion: 2,
            participantCursorsMessage: [{ accountId: "u1", cursor: 10 }],
            participantCursorsPending: [{ accountId: "u1", cursor: 20 }],
            readyProjection: {
                latestReadyEventSeq: 7,
                latestReadyEventAt: 1_000,
            },
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/materialize-next",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        await route.invoke({ userId: "actor", params: { sessionId: "s1" } });

        expect(buildUpdateSessionUpdate).toHaveBeenCalledWith("s1", 10, expect.any(String), undefined, undefined, {
            latestReadyEventSeq: 7,
            latestReadyEventAt: 1_000,
        });
        expect(emitUpdate).toHaveBeenCalledTimes(3);
    });

    it("keeps the route successful when one emitUpdate throws", async () => {
        materializeNextPendingMessage.mockResolvedValueOnce({
            ok: true,
            didMaterialize: true,
            didWriteMessage: true,
            message: { id: "m1", seq: 1, localId: "l1", messageRole: "user", content: { t: "plain", v: { role: "user", content: { type: "text", text: "hello" } } }, createdAt: new Date(1_000), updatedAt: new Date(1_000) },
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
            message: { id: "m1", seq: 1, localId: "l1", messageRole: "user", content: { t: "plain", v: { role: "user", content: { type: "text", text: "hello" } } }, createdAt: 1_000, updatedAt: 1_000 },
            pendingCount: 0,
            pendingVersion: 2,
        });
        expect(buildPendingChangedUpdate).toHaveBeenCalledTimes(2);
    });
});
