import { afterEach, describe, expect, it, vi } from "vitest";

import { eventRouter } from "@/app/events/eventRouter";
import { emitPendingResolvedMessage } from "./publishPendingMutation";

vi.mock("@/storage/db", () => ({
    db: { session: { findUnique: vi.fn(async () => null) } },
}));

describe("emitPendingResolvedMessage", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("publishes pending plaintext maintenance-shaped records with explicit user attention", async () => {
        const emitUpdate = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});

        await emitPendingResolvedMessage({
            sessionId: "s1",
            message: {
                id: "m1",
                seq: 7,
                localId: "pending-user-message",
                messageRole: "user",
                content: {
                    t: "plain",
                    v: {
                        role: "agent",
                        content: {
                            type: "event",
                            id: "quota-wait-event",
                            data: {
                                type: "provider-quota-wait",
                                serviceId: "openai-codex",
                                groupId: "main",
                                resetAtMs: 1_900_000,
                                reason: "connected_service_group_quota_exhausted",
                            },
                        },
                    },
                },
                createdAt: new Date(1_000),
                updatedAt: new Date(2_000),
            },
            participantCursors: [{ accountId: "u1", cursor: 10 }],
            logContext: "pending publication failed",
        });

        expect(emitUpdate).toHaveBeenCalledOnce();
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            userId: "u1",
            payload: expect.objectContaining({
                body: expect.objectContaining({
                    t: "new-message",
                    message: expect.objectContaining({
                        attentionImpact: {
                            affectsUnread: true,
                            affectsMeaningfulActivity: true,
                        },
                    }),
                }),
            }),
        }));
    });
});
