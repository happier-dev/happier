import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const deletePendingMessage = vi.fn();

vi.mock("@/app/session/pending/pendingMessageService", () => ({
    deletePendingMessage,
}));

describe("sessionPendingRoutes (delete) (status mapping)", () => {
    beforeEach(() => {
        vi.resetModules();
        deletePendingMessage.mockReset();
    });

    it("returns success when pending localId is already absent", async () => {
        deletePendingMessage.mockResolvedValueOnce({
            ok: true,
            pendingCount: 3,
            pendingVersion: 7,
            participantCursors: [],
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "DELETE",
            path: "/v2/sessions/:sessionId/pending/:localId",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { reply } = await route.invoke({ userId: "actor", params: { sessionId: "s1", localId: "l1" } });

        expect(reply.code).not.toHaveBeenCalled();
        expect(reply.send).toHaveBeenCalledWith({ ok: true, pendingCount: 3, pendingVersion: 7 });
    });
});
