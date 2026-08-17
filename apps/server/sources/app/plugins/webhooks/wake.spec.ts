import { describe, expect, it, vi } from "vitest";

const emitUpdate = vi.hoisted(() => vi.fn());

vi.mock("@/app/events/connectionEventRouter", () => ({
    eventRouter: { emitUpdate },
}));

import { emitPluginWebhookDeliveryCommittedWakeV1 } from "./wake";

describe("plugin webhook committed delivery wake", () => {
    it("sends only the canonical content-free AccountChange hint to the frozen target machine", () => {
        emitPluginWebhookDeliveryCommittedWakeV1({
            accountId: "account-1",
            targetMachineId: "machine-1",
            accountChangeCursor: 123,
        });

        expect(emitUpdate).toHaveBeenCalledWith({
            userId: "account-1",
            payload: expect.objectContaining({
                seq: 123,
                body: { t: "account-change" },
            }),
            recipientFilter: { type: "machine-only", machineId: "machine-1" },
        });
        expect(emitUpdate.mock.calls[0]?.[0]?.payload).not.toHaveProperty("deliveryId");
        expect(emitUpdate.mock.calls[0]?.[0]?.payload).not.toHaveProperty("endpointId");
    });
});
