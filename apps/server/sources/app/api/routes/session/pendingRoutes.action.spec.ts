import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";
import type { Fastify } from "../../types";

const emitUpdate = vi.fn();
const buildPendingChangedUpdate = vi.fn(() => ({ type: "pending-changed" }));
const updatePendingRequestedAction = vi.fn();
const markPendingActivationFailed = vi.fn();
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
    return { ...actual, updatePendingRequestedAction, markPendingActivationFailed };
});

describe("sessionPendingRoutes requested action", () => {
    it.each([
        ["GET", "/v2/sessions/:sessionId/pending", "session.transcript.get"],
        ["POST", "/v2/sessions/:sessionId/pending", "session.message.send"],
        ["PATCH", "/v2/sessions/:sessionId/pending/:localId/action", "session.message.send"],
        ["PATCH", "/v2/sessions/:sessionId/pending/:localId", "session.message.send"],
        ["DELETE", "/v2/sessions/:sessionId/pending/:localId", "session.message.send"],
        ["POST", "/v2/sessions/:sessionId/pending/:localId/discard", "session.message.send"],
    ] as const)("declares token Action and exact Session binding for %s %s", async (method, path, actionId) => {
        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({ method, path, registerRoutes(app) { sessionPendingRoutes(app as unknown as Fastify); } });
        expect(route.app.routes.get(`${method} ${path}`)?.opts.config).toMatchObject({
            apiTokenSessionAction: actionId,
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
        });
    });
    beforeEach(() => {
        emitUpdate.mockReset();
        buildPendingChangedUpdate.mockClear();
        updatePendingRequestedAction.mockReset();
        markPendingActivationFailed.mockReset();
        sessionFindUnique.mockReset();
        sessionFindUnique.mockResolvedValue(HOSTED_RECIPIENT_PROJECTION);
    });

    it("marks only the exact waiting activation authorization failed", async () => {
        markPendingActivationFailed.mockResolvedValueOnce({
            ok: true,
            didFail: false,
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 8,
            recipientCursors: [],
        });
        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/activation/fail",
            defaultRequest: { authAuthority: "present_user" },
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });

        const { response } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1" },
            body: { requestId: "pending-1", requestedAt: 1_234, failureCode: "runtime_start_failed" },
        });

        expect(markPendingActivationFailed).toHaveBeenCalledWith({
            actorUserId: "actor",
            sessionId: "s1",
            requestId: "pending-1",
            requestedAt: 1_234,
            failureCode: "runtime_start_failed",
        });
        expect(response).toEqual({ ok: true, didFail: false });
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("registers only PATCH and does not publish an idempotent action retry", async () => {
        updatePendingRequestedAction.mockResolvedValueOnce({
            ok: true,
            didUpdate: false,
            requestedAction: { v: 1, kind: "steer_now" },
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 7,
            recipientCursors: [{ accountId: "u1", cursor: 10 }],
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "PATCH",
            path: "/v2/sessions/:sessionId/pending/:localId/action",
            defaultRequest: { authAuthority: "present_user" },
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

    it("forwards the main-conversation resume authorization command", async () => {
        updatePendingRequestedAction.mockResolvedValueOnce({
            ok: true,
            didUpdate: false,
            requestedAction: { v: 1, kind: "enqueue" },
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 7,
            recipientCursors: [],
        });
        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "PATCH",
            path: "/v2/sessions/:sessionId/pending/:localId/action",
            defaultRequest: { authAuthority: "present_user" },
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });

        await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l1" },
            body: {
                requestedAction: { v: 1, kind: "enqueue" },
                resumeWhenAvailable: true,
            },
        });

        expect(updatePendingRequestedAction).toHaveBeenCalledWith(expect.objectContaining({
            actorUserId: "actor",
            sessionId: "s1",
            localId: "l1",
            requestedAction: { v: 1, kind: "enqueue" },
            resumeWhenAvailable: true,
        }));
    });

    it("publishes a changed action exactly once per returned participant cursor", async () => {
        updatePendingRequestedAction.mockResolvedValueOnce({
            ok: true,
            didUpdate: true,
            requestedAction: { v: 1, kind: "send_now" },
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 8,
            recipientCursors: [{ accountId: "u1", cursor: 11 }],
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "PATCH",
            path: "/v2/sessions/:sessionId/pending/:localId/action",
            defaultRequest: { authAuthority: "present_user" },
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
            recipientCursors: [
                { accountId: "u1", cursor: 11 },
                { accountId: "u2", cursor: 12 },
            ],
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "PATCH",
            path: "/v2/sessions/:sessionId/pending/:localId/action",
            defaultRequest: { authAuthority: "present_user" },
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
