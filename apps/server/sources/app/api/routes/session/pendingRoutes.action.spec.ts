import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const emitUpdate = vi.fn();
const buildPendingChangedUpdate = vi.fn(() => ({ type: "pending-changed" }));
const updatePendingRequestedAction = vi.fn();
const sessionFindUnique = vi.fn();

const HOSTED_RECIPIENT_PROJECTION = {
    accountId: "u1",
    currentStorageState: "hosted",
    acceptedThroughServerSeq: null,
    materializationPublicationId: null,
    materializedThroughSourceAt: null,
    publishedThroughServerSeq: null,
    seq: 0,
    lastViewedSessionSeq: null,
    latestReadyEventSeq: null,
    latestReadyEventAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    meaningfulActivityAt: null,
    lastActiveAt: new Date(0),
} as const;

vi.mock("@/app/events/eventRouter", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/events/eventRouter")>();
    return {
        ...actual,
        eventRouter: { emitUpdate },
        buildPendingChangedUpdate,
    };
});
vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked: () => "k" }));
vi.mock("@/storage/db", () => ({
    db: { session: { findUnique: sessionFindUnique } },
}));
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
        sessionFindUnique.mockReset();
        sessionFindUnique.mockResolvedValue(HOSTED_RECIPIENT_PROJECTION);
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

    it("does not publish a finite pending change to a collaborator", async () => {
        sessionFindUnique.mockResolvedValueOnce({
            ...HOSTED_RECIPIENT_PROJECTION,
            currentStorageState: "snapshot_complete",
            acceptedThroughServerSeq: 4,
            materializationPublicationId: "pending-publication-v1",
            materializedThroughSourceAt: 42_000n,
            publishedThroughServerSeq: 4,
        });
        updatePendingRequestedAction.mockResolvedValueOnce({
            ok: true,
            didUpdate: true,
            requestedAction: { v: 1, kind: "send_now" },
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 8,
            participantCursors: [
                { accountId: "u1", cursor: 11 },
                { accountId: "u2", cursor: 12 },
            ],
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "PATCH",
            path: "/v2/sessions/:sessionId/pending/:localId/action",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l1" },
            body: { requestedAction: { v: 1, kind: "send_now" } },
        });

        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }));
        expect(emitUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ userId: "u2" }));
    });
});
