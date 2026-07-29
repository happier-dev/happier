import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const emitUpdate = vi.fn();
const buildPendingChangedUpdate = vi.fn(() => ({ type: "pending-changed" }));
const updatePendingRequestedAction = vi.fn();

vi.mock("@/app/events/eventRouter", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/events/eventRouter")>();
    return {
        ...actual,
        eventRouter: { emitUpdate },
        buildPendingChangedUpdate,
    };
});
vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked: () => "k" }));
vi.mock("@/app/session/pending/pendingMessageService", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/session/pending/pendingMessageService")>();
    return { ...actual, updatePendingRequestedAction };
});

describe("sessionPendingRoutes requested action", () => {
    beforeEach(() => {
        vi.resetModules();
        emitUpdate.mockReset();
        buildPendingChangedUpdate.mockClear();
        updatePendingRequestedAction.mockReset();
    });

    it("registers only PATCH and does not publish an idempotent action retry", async () => {
        updatePendingRequestedAction.mockResolvedValueOnce({
            ok: true,
            didUpdate: false,
            requestedAction: { v: 1, kind: "steer_now" },
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 7,
            participantCursors: [{ accountId: "u1", cursor: 10 }],
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "PATCH",
            path: "/v2/sessions/:sessionId/pending/:localId/action",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        expect(route.app.routes.has("POST /v2/sessions/:sessionId/pending/:localId/action")).toBe(false);

        const { response } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l1" },
            body: { requestedAction: { v: 1, kind: "steer_now" } },
        });

        expect(response).toEqual({
            ok: true,
            didUpdate: false,
            requestedAction: { v: 1, kind: "steer_now" },
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 7,
        });
        expect(buildPendingChangedUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("publishes a changed action exactly once per returned participant cursor", async () => {
        updatePendingRequestedAction.mockResolvedValueOnce({
            ok: true,
            didUpdate: true,
            requestedAction: { v: 1, kind: "send_now" },
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 8,
            participantCursors: [{ accountId: "u1", cursor: 11 }],
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "PATCH",
            path: "/v2/sessions/:sessionId/pending/:localId/action",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { response } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l1" },
            body: { requestedAction: { v: 1, kind: "send_now" } },
        });

        expect(response).toMatchObject({ ok: true, didUpdate: true, pendingVersion: 8 });
        expect(buildPendingChangedUpdate).toHaveBeenCalledTimes(1);
        expect(emitUpdate).toHaveBeenCalledTimes(1);
    });
});
