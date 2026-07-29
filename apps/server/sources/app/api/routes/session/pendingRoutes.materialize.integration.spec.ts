import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const emitUpdate = vi.fn();
const buildNewMessageUpdate = vi.fn(() => ({ type: "new-message" }));
const buildMessageUpdatedUpdate = vi.fn(() => ({ type: "message-updated" }));
const buildPendingChangedUpdate = vi.fn(() => ({ type: "pending-changed" }));
const buildUpdateSessionUpdate = vi.fn(() => ({ type: "update-session" }));
const getSessionParticipantUserIds = vi.fn(async () => ["u1"]);
const markAccountChanged = vi.fn(async () => 10);
const refreshSessionParticipantBadgePushes = vi.fn(async () => {});

const materializeNextPendingMessage = vi.fn();
const blockPendingDelivery = vi.fn();
const dismissPendingDelivery = vi.fn();
const sendPendingDeliveryAsNew = vi.fn();
const markPendingDeliveryHandled = vi.fn();
const updatePendingMessage = vi.fn();
const listPendingMessages = vi.fn();
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildNewMessageUpdate,
    buildMessageUpdatedUpdate,
    buildPendingChangedUpdate,
    buildUpdateSessionUpdate,
}));

vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked: () => "k" }));
vi.mock("@/app/share/sessionParticipants", () => ({ getSessionParticipantUserIds }));
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));
vi.mock("@/app/activity/refreshAccountActivityBadgePushes", () => ({ refreshSessionParticipantBadgePushes }));
vi.mock("@/storage/inTx", () => ({
    inTx: vi.fn(async (fn: (tx: unknown) => unknown) => await fn({})),
}));

vi.mock("@/app/session/pending/pendingMessageService", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/session/pending/pendingMessageService")>();
    return {
        ...actual,
        materializeNextPendingMessage,
        blockPendingDelivery,
        dismissPendingDelivery,
        sendPendingDeliveryAsNew,
        markPendingDeliveryHandled,
        updatePendingMessage,
        listPendingMessages,
    };
});

describe("sessionPendingRoutes (materialize-next)", () => {
    beforeEach(() => {
        vi.resetModules();
        emitUpdate.mockReset();
        buildNewMessageUpdate.mockClear();
        buildMessageUpdatedUpdate.mockClear();
        buildPendingChangedUpdate.mockClear();
        buildUpdateSessionUpdate.mockClear();
        getSessionParticipantUserIds.mockReset();
        getSessionParticipantUserIds.mockResolvedValue(["u1"]);
        markAccountChanged.mockReset();
        markAccountChanged.mockResolvedValue(10);
        refreshSessionParticipantBadgePushes.mockReset();
        materializeNextPendingMessage.mockReset();
        blockPendingDelivery.mockReset();
        dismissPendingDelivery.mockReset();
        sendPendingDeliveryAsNew.mockReset();
        markPendingDeliveryHandled.mockReset();
        updatePendingMessage.mockReset();
        listPendingMessages.mockReset();
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

    it("projects typed delivery status while retaining legacy raw delivery fields", async () => {
        listPendingMessages.mockResolvedValueOnce({
            ok: true,
            pending: [
                {
                    localId: "blocked-local",
                    messageRole: "user",
                    content: { t: "plain", v: { role: "user", content: { type: "text", text: "blocked" } } },
                    status: "queued",
                    deliveryState: "blocked",
                    deliveryBlockedReason: "runtime_config_blocked",
                    deliveryStatus: { status: "blocked", reason: "runtime_config_blocked" },
                    position: 0,
                    createdAt: new Date(1_000),
                    updatedAt: new Date(2_000),
                    discardedAt: null,
                    discardedReason: null,
                    authorAccountId: "author",
                },
            ],
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/sessions/:sessionId/pending",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { response: res } = await route.invoke({ userId: "actor", params: { sessionId: "s1" } });

        expect(res).toMatchObject({
            pending: [
                {
                    localId: "blocked-local",
                    status: "queued",
                    deliveryState: "blocked",
                    deliveryBlockedReason: "runtime_config_blocked",
                    deliveryStatus: { status: "blocked", reason: "runtime_config_blocked" },
                },
            ],
        });
    });

    it("fails closed before the owner for HTTP materialization without publisher authority", async () => {
        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/materialize-next",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { reply, response } = await route.invoke({ userId: "actor", params: { sessionId: "s1" } });

        expect(reply.statusCode).toBe(403);
        expect(response).toEqual({ error: "forbidden" });
        expect(materializeNextPendingMessage).not.toHaveBeenCalled();
        expect(buildNewMessageUpdate).not.toHaveBeenCalled();
        expect(buildPendingChangedUpdate).not.toHaveBeenCalled();
        expect(buildUpdateSessionUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("maps stale pending update races to a client-safe not-found response", async () => {
        updatePendingMessage.mockResolvedValueOnce({ ok: false, error: "not-found" });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "PATCH",
            path: "/v2/sessions/:sessionId/pending/:localId",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { reply, response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "missing-local" },
            body: { ciphertext: "cipher-updated" },
        });

        expect(reply.statusCode).toBe(404);
        expect(res).toEqual({ error: "not-found" });
        expect(emitUpdate).not.toHaveBeenCalled();
    });


    it("rejects HTTP provider delivery-state opt-in", async () => {
        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/materialize-next",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { reply, response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1" },
            body: { deliveryState: "provider" },
        });

        expect(reply.statusCode).toBe(403);
        expect(res).toEqual({ error: "forbidden" });
        expect(materializeNextPendingMessage).not.toHaveBeenCalled();
        expect(buildNewMessageUpdate).not.toHaveBeenCalled();
    });

    it("does not expose ordinary user-authenticated HTTP provider settlement authority", async () => {
        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/:localId/delivery/accepted",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });

        expect(route.routeExists).toBe(false);
        expect(emitUpdate).not.toHaveBeenCalled();
    });


    it("blocks, sends as new, and marks provider delivery handled through durable pending routes", async () => {
        blockPendingDelivery.mockResolvedValueOnce({
            ok: true,
            pendingCount: 1,
            pendingBlockedCount: 1,
            pendingVersion: 4,
            participantCursors: [{ accountId: "u1", cursor: 40 }],
            badgeAttentionChanged: true,
            didUpdate: true,
        });
        sendPendingDeliveryAsNew.mockResolvedValueOnce({
            ok: true,
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 5,
            participantCursors: [{ accountId: "u1", cursor: 50 }],
            badgeAttentionChanged: true,
            didWrite: true,
            newLocalId: "l-provider-new",
        });
        markPendingDeliveryHandled.mockResolvedValueOnce({
            ok: true,
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 6,
            participantCursors: [{ accountId: "u1", cursor: 60 }],
            badgeAttentionChanged: true,
            didResolve: true,
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const blockRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/:localId/delivery/block",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const sendAsNewRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/:localId/delivery/send-as-new",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const handledRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/:localId/delivery/handled",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });

        await expect(blockRoute.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l-provider" },
            body: { reason: "terminal_composer_draft" },
        })).resolves.toMatchObject({ response: { ok: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 4 } });
        await expect(sendAsNewRoute.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l-provider" },
            body: {},
        })).resolves.toMatchObject({
            response: {
                ok: true,
                pendingCount: 1,
                pendingBlockedCount: 0,
                pendingVersion: 5,
                newLocalId: "l-provider-new",
            },
        });
        await expect(handledRoute.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l-provider" },
        })).resolves.toMatchObject({ response: { ok: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 6 } });

        expect(blockPendingDelivery).toHaveBeenCalledWith({
            actorUserId: "actor",
            sessionId: "s1",
            localId: "l-provider",
            reason: "terminal_composer_draft",
        });
        expect(sendPendingDeliveryAsNew).toHaveBeenCalledWith({
            actorUserId: "actor",
            sessionId: "s1",
            localId: "l-provider",
        });
        expect(markPendingDeliveryHandled).toHaveBeenCalledWith({ actorUserId: "actor", sessionId: "s1", localId: "l-provider" });
        expect(buildPendingChangedUpdate).toHaveBeenCalledTimes(3);
        expect(buildNewMessageUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).toHaveBeenCalledTimes(3);
    });

    it("routes explicit uncertain dismissal without creating a message", async () => {
        dismissPendingDelivery.mockResolvedValueOnce({
            ok: true,
            didDismiss: true,
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 5,
            participantCursors: [{ accountId: "u1", cursor: 50 }],
            badgeAttentionChanged: true,
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/:localId/delivery/dismiss",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        await expect(route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l-provider" },
        })).resolves.toMatchObject({
            response: { ok: true, didDismiss: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 5 },
        });

        expect(dismissPendingDelivery).toHaveBeenCalledWith({ actorUserId: "actor", sessionId: "s1", localId: "l-provider" });
        expect(buildPendingChangedUpdate).toHaveBeenCalledTimes(1);
        expect(buildNewMessageUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).toHaveBeenCalledTimes(1);
    });

    it("returns a stable conflict without publishing when send-as-new cannot archive the original", async () => {
        sendPendingDeliveryAsNew.mockResolvedValueOnce({
            ok: false,
            error: "delivery-settlement-conflict",
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/:localId/delivery/send-as-new",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { response, reply } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "effect-possible" },
            body: {},
        });

        expect(reply.statusCode).toBe(409);
        expect(response).toEqual({ error: "delivery-settlement-conflict" });
        expect(sendPendingDeliveryAsNew).toHaveBeenCalledWith({
            actorUserId: "actor",
            sessionId: "s1",
            localId: "effect-possible",
        });
        expect(buildPendingChangedUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
        expect(refreshSessionParticipantBadgePushes).not.toHaveBeenCalled();
    });

    it("emits pending-changed when handled provider delivery blocks on transcript conflict", async () => {
        markPendingDeliveryHandled.mockResolvedValueOnce({
            ok: false,
            error: "transcript-conflict",
            pendingStateChanged: true,
            pendingCount: 1,
            pendingBlockedCount: 1,
            pendingVersion: 9,
            participantCursors: [{ accountId: "u1", cursor: 63 }],
            badgeAttentionChanged: true,
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/:localId/delivery/handled",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { reply, response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l-provider-conflict" },
        });

        expect(reply.statusCode).toBe(409);
        expect(res).toEqual({ error: "transcript-conflict" });
        expect(buildPendingChangedUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: "s1",
                pendingCount: 1,
                pendingBlockedCount: 1,
                pendingVersion: 9,
            }),
            63,
            "k",
        );
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(refreshSessionParticipantBadgePushes).toHaveBeenCalledWith({
            badgeAttentionChanged: true,
            participantCursors: [{ accountId: "u1", cursor: 63 }],
        });
    });

});
