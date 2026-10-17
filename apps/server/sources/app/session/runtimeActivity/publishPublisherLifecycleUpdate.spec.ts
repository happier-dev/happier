import { beforeEach, describe, expect, it, vi } from "vitest";

const { emitUpdate } = vi.hoisted(() => ({ emitUpdate: vi.fn() }));

vi.mock("@/app/events/eventRouter", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/events/eventRouter")>();
    return {
        ...actual,
        eventRouter: { ...actual.eventRouter, emitUpdate },
    };
});

import { publishSessionPublisherLifecycleUpdate } from "./publishPublisherLifecycleUpdate";

describe("publishSessionPublisherLifecycleUpdate", () => {
    beforeEach(() => emitUpdate.mockClear());

    it("fans one combined reachability and Activity projection to every committed participant cursor", async () => {
        await publishSessionPublisherLifecycleUpdate({
            sessionId: "session-1",
            participantCursors: [
                { accountId: "owner", cursor: 11 },
                { accountId: "shared", cursor: 19 },
            ],
            active: true,
            activeAt: 123,
            projection: {
                state: "active",
                activeCount: 2,
                observedAt: 124,
                revision: 3,
            },
        });

        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(emitUpdate.mock.calls.map(([event]) => ({
            userId: event.userId,
            seq: event.payload.seq,
            body: event.payload.body,
        }))).toEqual([
            {
                userId: "owner",
                seq: 11,
                body: expect.objectContaining({
                    t: "update-session",
                    id: "session-1",
                    active: true,
                    activeAt: 123,
                    runtimeActivityState: "active",
                    runtimeActivityRevision: 3,
                    runtimeActivityActiveCount: 2,
                    runtimeActivityObservedAt: 124,
                }),
            },
            {
                userId: "shared",
                seq: 19,
                body: expect.objectContaining({ active: true, runtimeActivityRevision: 3 }),
            },
        ]);
    });

    it("preserves the explicit inactive transition", async () => {
        await publishSessionPublisherLifecycleUpdate({
            sessionId: "session-1",
            participantCursors: [{ accountId: "owner", cursor: 20 }],
            active: false,
            activeAt: 130,
        });

        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                seq: 20,
                body: expect.objectContaining({
                    active: false, activeAt: 130,
                }),
            }),
        }));
    });
});
