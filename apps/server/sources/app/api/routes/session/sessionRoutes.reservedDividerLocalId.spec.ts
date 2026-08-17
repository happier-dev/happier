import { beforeEach, describe, expect, it } from "vitest";

import { SESSION_AGENT_TRANSITION_DIVIDER_LOCAL_ID_PREFIX } from "@happier-dev/protocol";

import {
    checkSessionAccess,
    createSessionMessage,
    createSessionRouteTestBuilder,
    resetSessionRouteMocks,
} from "./sessionRoutes.testkit";

/**
 * The transition divider's localId namespace is reserved for the owner-only
 * cutover command. If a client could write it, it could forge a transition
 * boundary — which the bounded context pass and the transcript separator both
 * trust — or overwrite a real one, since the message owner reconciles a
 * same-localId write by overwriting differing content in place.
 */
describe("v2 session message ingress rejects the reserved transition divider localId", () => {
    const reservedLocalId = `${SESSION_AGENT_TRANSITION_DIVIDER_LOCAL_ID_PREFIX}local-42`;

    beforeEach(() => {
        resetSessionRouteMocks();
        checkSessionAccess.mockReset();
        checkSessionAccess.mockResolvedValue({ level: "owner" });
        createSessionMessage.mockReset();
    });

    it("rejects a reserved localId in the body before reaching the message owner", async () => {
        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/messages");
        const { reply, response } = await route.invoke({
            params: { sessionId: "s1" },
            body: { ciphertext: "c1", localId: reservedLocalId },
        });

        expect(reply.statusCode).toBe(400);
        expect(response).toEqual({ error: "Invalid parameters", code: "reserved-local-id" });
        expect(createSessionMessage).not.toHaveBeenCalled();
    });

    it("rejects a reserved localId supplied through the idempotency-key header", async () => {
        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/messages");
        const { reply, response } = await route.invoke({
            params: { sessionId: "s1" },
            body: { ciphertext: "c1" },
            headers: { "idempotency-key": reservedLocalId },
        });

        expect(reply.statusCode).toBe(400);
        expect(response).toEqual({ error: "Invalid parameters", code: "reserved-local-id" });
        expect(createSessionMessage).not.toHaveBeenCalled();
    });

    it("still accepts an ordinary localId", async () => {
        createSessionMessage.mockResolvedValue({
            ok: true,
            didWrite: true,
            didUpdate: false,
            badgeAttentionChanged: false,
            attentionImpact: { affectsUnread: true, affectsMeaningfulActivity: true },
            message: {
                id: "m1",
                seq: 1,
                localId: "local-42",
                sidechainId: null,
                messageRole: "user",
                content: { t: "encrypted", c: "c1" },
                createdAt: new Date(1),
                updatedAt: new Date(1),
            },
            participantCursors: [],
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/messages");
        const { reply } = await route.invoke({
            params: { sessionId: "s1" },
            body: { ciphertext: "c1", localId: "local-42" },
        });

        expect(reply.statusCode).toBe(200);
        expect(createSessionMessage).toHaveBeenCalledTimes(1);
    });
});
