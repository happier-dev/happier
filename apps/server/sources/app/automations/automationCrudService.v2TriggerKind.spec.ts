import { beforeEach, describe, expect, it, vi } from "vitest";
import { serializeAutomationRunExecutionRecipeV1 } from "@happier-dev/protocol";

import type { Tx } from "@/storage/inTx";

const mocks = vi.hoisted(() => ({
    inTx: vi.fn(),
    afterTx: vi.fn(),
    automationFindFirst: vi.fn(),
    automationUpdateMany: vi.fn(),
    acquireAccountEncryptionTransitionFenceInTx: vi.fn(),
}));

vi.mock("@/storage/inTx", () => ({
    inTx: mocks.inTx,
    afterTx: mocks.afterTx,
}));
vi.mock("@/storage/db", () => ({ db: {} }));
vi.mock("@/app/encryption/accountEncryptionTransition", () => ({
    acquireAccountEncryptionTransitionFenceInTx:
        mocks.acquireAccountEncryptionTransitionFenceInTx,
}));

import { getAutomation, updateAutomation } from "./automationCrudService";

const strictRecipe = serializeAutomationRunExecutionRecipeV1({
    v: 1,
    templateVersion: 3,
    template: { t: "plain", v: { v: 1, prompt: "current V3 definition" } },
    triggerEvidence: null,
    target: {
        kind: "newSession",
        spawn: {
            executionTarget: { serverId: "server", machineId: "machine" },
            directory: "/tmp/v3-definition",
            agentTarget: {
                kind: "agent",
                identity: { pluginId: "happier.agent.codex", localId: "codex" },
            },
        },
    },
});
if (strictRecipe.kind !== "available") {
    throw new Error("Expected strict V3 fixture to serialize");
}
const strictRecipeSerialized = strictRecipe.serialized;

function strictScheduleDefinition() {
    return {
        id: "strict-schedule",
        accountId: "account-1",
        name: "Current V3 schedule",
        description: null,
        enabled: true,
        triggerKind: "schedule" as const,
        scheduleKind: "interval" as const,
        scheduleExpr: null,
        everyMs: 60_000,
        timezone: null,
        targetType: "new_session" as const,
        templateCiphertext: strictRecipeSerialized,
        templateVersion: 3,
        triggerEventPluginId: null,
        triggerEventLocalId: null,
        triggerSourceSelectorId: null,
        triggerSourceContractVersion: null,
        triggerObservationTransport: null,
        triggerWebhookEndpointId: null,
        triggerObservationStartsAt: null,
        watcherMachineId: null,
        watcherMachineInstallationId: null,
        watcherPluginId: null,
        watcherMaterializationId: null,
        triggerDefinitionEnvelope: null,
        nextRunAt: null,
        lastRunAt: null,
        createdAt: new Date("2026-08-10T12:00:00.000Z"),
        updatedAt: new Date("2026-08-10T12:00:00.000Z"),
        assignments: [],
    };
}

function createTransaction(): Tx {
    return {
        automation: {
            findFirst: mocks.automationFindFirst,
            updateMany: mocks.automationUpdateMany,
        },
    } as unknown as Tx;
}

describe("V2 Automation trigger-kind ownership", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.automationFindFirst.mockResolvedValue(null);
        mocks.automationUpdateMany.mockResolvedValue({ count: 0 });
        mocks.acquireAccountEncryptionTransitionFenceInTx.mockResolvedValue({
            status: "ready",
        });
        mocks.inTx.mockImplementation(async (operation: (tx: Tx) => Promise<unknown>) => (
            await operation(createTransaction())
        ));
    });

    it.each([
        ["Event", "event-automation"],
        ["Conversation", "conversation-automation"],
    ] as const)("leaves a %s definition untouched when V2 attempts a mutation", async (_kind, automationId) => {
        await expect(updateAutomation({
            accountId: "account-1",
            automationId,
            input: { name: "must not mutate" },
            expectedTriggerKind: "schedule",
        })).resolves.toBeNull();

        expect(mocks.automationFindFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                id: automationId,
                accountId: "account-1",
                deletedAt: null,
                triggerKind: "schedule",
            },
        }));
        expect(mocks.automationUpdateMany).not.toHaveBeenCalled();
    });

    it("does not expose or mutate a strict V3 schedule definition through the V2 service boundary", async () => {
        mocks.automationFindFirst.mockResolvedValue(strictScheduleDefinition());

        await expect(getAutomation({
            accountId: "account-1",
            automationId: "strict-schedule",
            expectedTriggerKind: "schedule",
            requireV2DefinitionRepresentability: true,
        })).resolves.toBeNull();

        await expect(updateAutomation({
            accountId: "account-1",
            automationId: "strict-schedule",
            input: { name: "must not mutate current V3" },
            expectedTriggerKind: "schedule",
            requireV2DefinitionRepresentability: true,
        })).resolves.toBeNull();

        expect(mocks.automationUpdateMany).not.toHaveBeenCalled();
    });
});
