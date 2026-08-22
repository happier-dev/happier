import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    assertCurrentCaller: vi.fn(),
    inTx: vi.fn(),
    getOrCreateServerIdentityId: vi.fn(async () => "server-1"),
}));

vi.mock("./automationEventCurrentness", async (importOriginal) => {
    const original = await importOriginal<typeof import("./automationEventCurrentness")>();
    return {
        ...original,
        assertCurrentAutomationEventCallerMaterializationTx: mocks.assertCurrentCaller,
    };
});
vi.mock("@/app/serverIdentity/serverIdentity", () => ({
    getOrCreateServerIdentityId: mocks.getOrCreateServerIdentityId,
}));
vi.mock("@/storage/inTx", () => ({
    inTx: mocks.inTx,
    afterTx: vi.fn(),
}));

import {
    admitAutomationConversationV1,
    AutomationConversationAdmissionCallerError,
} from "./automationConversationAdmissionService";

/** A synthetic out-of-tree bridge: participation is not a Channels privilege. */
const bridgeCaller = {
    pluginId: "acme.slack-bridge",
    contributionLocalId: "slack/observation-ingest-v1",
    machineId: "machine-1",
    machineInstallationId: "installation-1",
    materializationId: "materialization-slack-1",
} as const;

const input = {
    automationId: "automation-1",
    bindingId: "binding-1",
    templateVersion: 3,
    occurrenceId: "slack:event:1",
    occurredAt: 1_700_000_000_000,
    sender: { id: "U-123" },
    text: "Please summarize the latest change.",
    resultDelivery: {
        kind: "finalResult",
        actionRef: {
            pluginId: "acme.slack-bridge",
            localId: "automation/reply-deliver-v1",
        },
        opaqueContext: { channelId: "C-123" },
    },
} as const;

describe("Automation conversation admission delivery-target ownership", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.inTx.mockImplementation(async () => {
            throw new Error("the admission transaction must not open for a rejected target");
        });
    });

    it("refuses to freeze a delivery target outside the admitting plugin", async () => {
        await expect(admitAutomationConversationV1({
            accountId: "account-1",
            caller: bridgeCaller,
            input: {
                ...input,
                resultDelivery: {
                    ...input.resultDelivery,
                    // The bundled Channels contribution is not this caller's own.
                    actionRef: {
                        pluginId: "happier.channels",
                        localId: "automation/result-deliver-v1",
                    },
                },
            },
        })).rejects.toBeInstanceOf(AutomationConversationAdmissionCallerError);
        expect(mocks.inTx).not.toHaveBeenCalled();
        expect(mocks.getOrCreateServerIdentityId).not.toHaveBeenCalled();
    });

    it("accepts a third-party plugin's own delivery contribution", async () => {
        mocks.inTx.mockImplementation(async () => ({
            kind: "admitted",
            runId: "run-1",
            checkpointSafe: true,
        }));

        await expect(admitAutomationConversationV1({
            accountId: "account-1",
            caller: bridgeCaller,
            input,
        })).resolves.toEqual({ kind: "admitted", runId: "run-1", checkpointSafe: true });
        expect(mocks.inTx).toHaveBeenCalledTimes(1);
    });
});
