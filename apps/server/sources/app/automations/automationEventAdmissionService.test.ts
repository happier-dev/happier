import { describe, expect, it, vi } from "vitest";

import { createRequestLocalDurablePushCurrentnessReads } from "./automationEventAdmissionService";

describe("request-local durable-push currentness reads", () => {
    it("validates one invocation once and reads each distinct endpoint once", async () => {
        const validateInvocation = vi.fn().mockResolvedValue({ kind: "ready" });
        const readEndpoint = vi.fn(async (webhookEndpointId: string) => ({ webhookEndpointId }));
        const reads = createRequestLocalDurablePushCurrentnessReads({
            validateInvocation,
            readEndpoint,
        });

        await expect(Promise.all([
            reads.validateInvocation(),
            reads.validateInvocation(),
        ])).resolves.toEqual([{ kind: "ready" }, { kind: "ready" }]);
        await expect(Promise.all([
            reads.readEndpoint("endpoint-1"),
            reads.readEndpoint("endpoint-1"),
            reads.readEndpoint("endpoint-2"),
        ])).resolves.toEqual([
            { webhookEndpointId: "endpoint-1" },
            { webhookEndpointId: "endpoint-1" },
            { webhookEndpointId: "endpoint-2" },
        ]);

        expect(validateInvocation).toHaveBeenCalledTimes(1);
        expect(readEndpoint.mock.calls).toEqual([
            ["endpoint-1"],
            ["endpoint-2"],
        ]);
    });
});
