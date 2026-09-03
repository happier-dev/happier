import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";
import { getRouteEntry } from "../../testkit/routeHarness";

const updatePendingRequestedAction = vi.fn();
const markPendingActivationFailed = vi.fn();
const emitPendingChanged = vi.fn();
const refreshSessionParticipantBadgePushes = vi.fn();

vi.mock("@/app/session/pending/pendingMessageService", () => ({
    updatePendingRequestedAction,
    markPendingActivationFailed,
}));
vi.mock("@/app/session/pending/publishPendingMutation", () => ({
    emitPendingChanged,
    emitPendingResolvedMessage: vi.fn(),
}));
vi.mock("@/app/activity/refreshAccountActivityBadgePushes", () => ({
    refreshSessionParticipantBadgePushes,
}));

async function createActionRoute() {
    const { sessionPendingRoutes } = await import("./pendingRoutes");
    return createRouteTestBuilder({
        method: "PATCH",
        path: "/v2/sessions/:sessionId/pending/:localId/action",
        registerRoutes(app) {
            sessionPendingRoutes(app as any);
        },
    });
}

async function createActivationFailureRoute() {
    const { sessionPendingRoutes } = await import("./pendingRoutes");
    return createRouteTestBuilder({
        method: "POST",
        path: "/v2/sessions/:sessionId/pending/activation/fail",
        registerRoutes(app) {
            sessionPendingRoutes(app as any);
        },
    });
}

describe("sessionPendingRoutes (requested action)", () => {
    beforeEach(() => {
        vi.resetModules();
        updatePendingRequestedAction.mockReset();
        emitPendingChanged.mockReset();
        refreshSessionParticipantBadgePushes.mockReset();
        markPendingActivationFailed.mockReset();
    });

    it("rejects extra action-body keys at the route schema boundary", async () => {
        const route = await createActionRoute();
        const entry = getRouteEntry(route.app, "PATCH", "/v2/sessions/:sessionId/pending/:localId/action");
        const bodySchema = (entry.opts.schema as { body: { safeParse: (value: unknown) => { success: boolean } } }).body;

        expect(bodySchema.safeParse({
            requestedAction: { v: 1, kind: "send_now" },
            deliveryCommand: "resume_process_now",
        }).success).toBe(false);
    });

    it("maps an action conflict to 409 with the action-specific code", async () => {
        updatePendingRequestedAction.mockResolvedValueOnce({ ok: false, error: "action-conflict" });
        const route = await createActionRoute();

        const { reply, response } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l1" },
            body: { requestedAction: { v: 1, kind: "send_now" } },
        });

        expect(reply.statusCode).toBe(409);
        expect(response).toEqual({ error: "action-conflict" });
    });

    it("returns didUpdate and publishes Pending-changed only for an actual update", async () => {
        const base = {
            ok: true,
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 4,
            participantCursors: [],
            badgeAttentionChanged: false,
        } as const;
        updatePendingRequestedAction
            .mockResolvedValueOnce({ ...base, didUpdate: false })
            .mockResolvedValueOnce({ ...base, didUpdate: true });
        const route = await createActionRoute();
        const request = {
            userId: "actor",
            params: { sessionId: "s1", localId: "l1" },
            body: { requestedAction: { v: 1, kind: "send_now" } },
        };

        await expect(route.invoke(request).then(({ response }) => response)).resolves.toMatchObject({
            ok: true,
            didUpdate: false,
        });
        expect(emitPendingChanged).not.toHaveBeenCalled();

        await expect(route.invoke(request).then(({ response }) => response)).resolves.toMatchObject({
            ok: true,
            didUpdate: true,
        });
        expect(emitPendingChanged).toHaveBeenCalledTimes(1);
    });

    it("publishes the terminal authorization through the canonical pending-change event", async () => {
        markPendingActivationFailed.mockResolvedValueOnce({
            ok: true,
            didFail: true,
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 4,
            participantCursors: [{ accountId: "actor", cursor: 8 }],
        });
        const route = await createActivationFailureRoute();

        const { response } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1" },
            body: {
                requestId: "l1",
                requestedAt: 101,
                failureCode: "runtime_start_failed",
            },
        });

        expect(response).toEqual({ ok: true, didFail: true });
        expect(markPendingActivationFailed).toHaveBeenCalledWith({
            actorUserId: "actor",
            sessionId: "s1",
            requestId: "l1",
            requestedAt: 101,
            failureCode: "runtime_start_failed",
        });
        expect(emitPendingChanged).toHaveBeenCalledWith({
            sessionId: "s1",
            changedByAccountId: "actor",
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 4,
            participantCursors: [{ accountId: "actor", cursor: 8 }],
        });
    });
});
