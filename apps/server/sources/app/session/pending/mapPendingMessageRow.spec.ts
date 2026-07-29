import { describe, expect, it } from "vitest";

import { mapPendingMessageRow } from "./mapPendingMessageRow";

describe("mapPendingMessageRow", () => {
    it("projects queued rows as publicly queued", () => {
        const now = new Date("2026-07-12T00:00:00.000Z");
        expect(mapPendingMessageRow({
            localId: "local-1",
            messageRole: "user",
            content: { t: "plain", v: "hello" },
            status: "queued",
            deliveryState: null,
            deliveryBlockedReason: null,
            position: 1,
            createdAt: now,
            updatedAt: now,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: "account-1",
        })).toMatchObject({
            status: "queued",
            deliveryStatus: { status: "queued" },
        });
    });

    it("retains an explicit malformed action as a non-executable unsupported row", () => {
        const now = new Date("2026-07-12T00:00:00.000Z");
        const mapped = mapPendingMessageRow({
            localId: "malformed-action",
            messageRole: "user",
            content: { t: "plain", v: "hello" },
            requestedAction: { v: 1, kind: "future_action" },
            status: "queued",
            deliveryState: null,
            deliveryBlockedReason: null,
            position: 2,
            createdAt: now,
            updatedAt: now,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: "account-1",
        });

        expect(mapped).toMatchObject({
            localId: "malformed-action",
            requestedActionMalformed: true,
            deliveryStatus: { status: "blocked", reason: "unsupported_action" },
        });
        expect(mapped.requestedAction).toBeUndefined();
    });

    it("projects claimed rows as awaiting provider acceptance without adding persisted state", () => {
        const now = new Date("2026-07-12T00:00:00.000Z");
        expect(mapPendingMessageRow({
            localId: "delivering-local",
            messageRole: "user",
            content: { t: "plain", v: "hello" },
            requestedAction: { v: 1, kind: "enqueue" },
            status: "queued",
            deliveryState: "delivering",
            deliveryBlockedReason: null,
            position: 3,
            createdAt: now,
            updatedAt: now,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: "account-1",
        })).toMatchObject({
            deliveryState: "delivering",
            deliveryStatus: { status: "delivering", detail: "awaiting_acceptance" },
        });
    });
});
