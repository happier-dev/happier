import { beforeEach, describe, expect, it, vi } from "vitest";
import { serializeAutomationStoredDefinitionExecutionRecipeV1 } from "@happier-dev/protocol";

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

const strictRecipe = serializeAutomationStoredDefinitionExecutionRecipeV1({
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
        targetType: "new_session" as const,
        templateCiphertext: strictRecipeSerialized,
        templateVersion: 3,
        lastRunAt: null,
        createdAt: new Date("2026-08-10T12:00:00.000Z"),
        updatedAt: new Date("2026-08-10T12:00:00.000Z"),
        assignments: [],
        triggers: [scheduleTrigger("strict-schedule", "strict-schedule-trigger")],
    };
}

function scheduleTrigger(automationId: string, id: string) {
    const at = new Date("2026-08-10T12:00:00.000Z");
    return {
        id,
        automationId,
        kind: "schedule" as const,
        enabled: true,
        revision: 1,
        deletedAt: null,
        scheduleKind: "interval" as const,
        scheduleExpr: null,
        everyMs: 60_000,
        timezone: null,
        nextRunAt: null,
        eventPluginId: null,
        eventLocalId: null,
        sourceSelectorId: null,
        sourceContractVersion: null,
        observationTransport: null,
        webhookEndpointId: null,
        observationStartsAt: null,
        watcherMachineId: null,
        watcherMachineInstallationId: null,
        watcherPluginId: null,
        watcherMaterializationId: null,
        definitionEnvelope: null,
        sessionLifecycleEvent: null,
        sourceSessionId: null,
        sourceTurnId: null,
        createdAt: at,
        updatedAt: at,
        eventSourceStatus: null,
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

describe("V2 Automation exact-one-schedule compatibility", () => {
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
        ["zero triggers", []],
        ["multiple schedules", [scheduleTrigger("automation-1", "schedule-1"), scheduleTrigger("automation-1", "schedule-2")]],
        ["a non-schedule trigger", [{ ...scheduleTrigger("automation-1", "event-1"), kind: "pluginEvent" as const }]],
    ] as const)("does not expose or mutate a definition with %s", async (_label, triggers) => {
        mocks.automationFindFirst.mockResolvedValue({
            ...strictScheduleDefinition(),
            id: "automation-1",
            templateCiphertext: JSON.stringify({
                kind: "happier_automation_template_plain_v1",
                payload: { prompt: "released V2" },
            }),
            triggers,
        });

        await expect(getAutomation({
            accountId: "account-1",
            automationId: "automation-1",
            requireV2DefinitionRepresentability: true,
        })).resolves.toBeNull();
        await expect(updateAutomation({
            accountId: "account-1",
            automationId: "automation-1",
            input: { name: "must not mutate" },
            requireV2DefinitionRepresentability: true,
        })).resolves.toBeNull();

        expect(mocks.automationUpdateMany).not.toHaveBeenCalled();
    });

    it("does not expose or mutate a strict V3 schedule definition through the V2 service boundary", async () => {
        mocks.automationFindFirst.mockResolvedValue(strictScheduleDefinition());

        await expect(getAutomation({
            accountId: "account-1",
            automationId: "strict-schedule",
            requireV2DefinitionRepresentability: true,
        })).resolves.toBeNull();

        await expect(updateAutomation({
            accountId: "account-1",
            automationId: "strict-schedule",
            input: { name: "must not mutate current V3" },
            requireV2DefinitionRepresentability: true,
        })).resolves.toBeNull();

        expect(mocks.automationUpdateMany).not.toHaveBeenCalled();
    });
});
