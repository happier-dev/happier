import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AutomationListItem } from "./automationTypes";

const mocks = vi.hoisted(() => ({
    assertCurrentCaller: vi.fn(),
    loadAutomation: vi.fn(),
    listAutomations: vi.fn(),
}));

vi.mock("./automationCrudService", () => ({
    loadAutomationTx: mocks.loadAutomation,
}));
vi.mock("./automationEventCurrentness", async (importOriginal) => {
    const original = await importOriginal<typeof import("./automationEventCurrentness")>();
    return {
        ...original,
        assertCurrentAutomationEventCallerMaterializationTx: mocks.assertCurrentCaller,
    };
});
vi.mock("@/app/serverIdentity/serverIdentity", () => ({
    getOrCreateServerIdentityId: vi.fn(async () => "server-1"),
}));
vi.mock("@/storage/inTx", () => ({
    inTx: vi.fn(async (operation: (tx: object) => Promise<unknown>) => await operation({
        automation: { findMany: mocks.listAutomations },
    })),
}));

import {
    AutomationConversationTargetVerificationCallerError,
    listAutomationConversationTargetsV1,
    verifyAutomationConversationTargetV1,
} from "./automationConversationTargetVerificationService";
import { AutomationEventCurrentnessError } from "./automationEventCurrentness";

const caller = {
    pluginId: "happier.channels",
    machineId: "machine-1",
    machineInstallationId: "installation-1",
    materializationId: "materialization-1",
} as const;

const conversationAutomation: AutomationListItem = {
    id: "automation-1",
    accountId: "account-1",
    name: "Conversation target",
    description: null,
    enabled: true,
    triggerKind: "conversation",
    scheduleKind: null,
    scheduleExpr: null,
    everyMs: null,
    timezone: null,
    targetType: "execution_run",
    templateCiphertext: "strict-definition",
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
    triggerDefinitionEnvelope: "conversation-definition",
    nextRunAt: null,
    lastRunAt: null,
    createdAt: new Date("2026-08-12T00:00:00.000Z"),
    updatedAt: new Date("2026-08-12T00:00:00.000Z"),
    assignments: [],
};

describe("Automation conversation target verification", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.assertCurrentCaller.mockResolvedValue({ version: "1.0.0" });
        mocks.loadAutomation.mockResolvedValue(conversationAutomation);
        mocks.listAutomations.mockResolvedValue([]);
    });

    it("returns only the exact verified version from the Account-scoped Automation read owner", async () => {
        await expect(verifyAutomationConversationTargetV1({
            accountId: "account-1",
            caller,
            input: { automationId: "automation-1", expectedTemplateVersion: 3 },
        })).resolves.toEqual({ kind: "verified", templateVersion: 3 });

        expect(mocks.loadAutomation).toHaveBeenCalledWith(expect.anything(), {
            accountId: "account-1",
            automationId: "automation-1",
        });
    });

    it.each(["missing", "deleted", "foreign Account"])(
        "folds %s into notFound without replacement facts",
        async () => {
            mocks.loadAutomation.mockResolvedValue(null);
            await expect(verifyAutomationConversationTargetV1({
                accountId: "account-1",
                caller,
                input: { automationId: "automation-hidden", expectedTemplateVersion: 3 },
            })).resolves.toEqual({ kind: "notVerified", reason: "notFound" });
        },
    );

    it("returns notConversation without definition content", async () => {
        mocks.loadAutomation.mockResolvedValue({
            ...conversationAutomation,
            triggerKind: "schedule",
            triggerDefinitionEnvelope: null,
        });
        await expect(verifyAutomationConversationTargetV1({
            accountId: "account-1",
            caller,
            input: { automationId: "automation-1", expectedTemplateVersion: 3 },
        })).resolves.toEqual({ kind: "notVerified", reason: "notConversation" });
    });

    it("returns templateVersionMismatch without the current version or content", async () => {
        await expect(verifyAutomationConversationTargetV1({
            accountId: "account-1",
            caller,
            input: { automationId: "automation-1", expectedTemplateVersion: 2 },
        })).resolves.toEqual({
            kind: "notVerified",
            reason: "templateVersionMismatch",
        });
    });

    it("rejects final-result delivery for an exact execution-run Conversation target", async () => {
        await expect(verifyAutomationConversationTargetV1({
            accountId: "account-1",
            caller,
            input: {
                automationId: "automation-1",
                expectedTemplateVersion: 3,
                resultDelivery: "finalResult",
            },
        })).resolves.toEqual({
            kind: "notVerified",
            reason: "resultDeliveryUnsupported",
        });
    });

    it("keeps a disabled Conversation Automation eligible to the final verifier", async () => {
        mocks.loadAutomation.mockResolvedValue({ ...conversationAutomation, enabled: false });

        await expect(verifyAutomationConversationTargetV1({
            accountId: "account-1",
            caller,
            input: { automationId: "automation-1", expectedTemplateVersion: 3 },
        })).resolves.toEqual({ kind: "verified", templateVersion: 3 });
    });

    it("fails closed for a wrong plugin or stale exact materialization before reading Automation state", async () => {
        await expect(verifyAutomationConversationTargetV1({
            accountId: "account-1",
            caller: { ...caller, pluginId: "com.acme.other" },
            input: { automationId: "automation-1", expectedTemplateVersion: 3 },
        })).rejects.toBeInstanceOf(AutomationConversationTargetVerificationCallerError);
        expect(mocks.loadAutomation).not.toHaveBeenCalled();

        mocks.assertCurrentCaller.mockRejectedValueOnce(
            new AutomationEventCurrentnessError("caller_materialization_not_current"),
        );
        await expect(verifyAutomationConversationTargetV1({
            accountId: "account-1",
            caller,
            input: { automationId: "automation-1", expectedTemplateVersion: 3 },
        })).rejects.toBeInstanceOf(AutomationConversationTargetVerificationCallerError);
        expect(mocks.loadAutomation).not.toHaveBeenCalled();
    });

    it("lists only a bounded ID-keyset projection through the current caller and never selects target content", async () => {
        mocks.listAutomations.mockResolvedValue([
            { id: "automation-1", name: "Current target", templateVersion: 0 },
            { id: "automation-2", name: "x".repeat(129), templateVersion: 2 },
            { id: "automation-3", name: "Later target", templateVersion: 3 },
        ]);

        await expect(listAutomationConversationTargetsV1({
            accountId: "account-1",
            caller,
            input: { limit: 2, cursor: "automation-0" },
        })).resolves.toEqual({
            items: [
                { automationId: "automation-1", templateVersion: 0, label: "Current target" },
                { automationId: "automation-2", templateVersion: 2, label: "automation-2" },
            ],
            nextCursor: "automation-2",
        });

        expect(mocks.listAutomations).toHaveBeenCalledWith({
            where: {
                accountId: "account-1",
                deletedAt: null,
                triggerKind: "conversation",
                id: { gt: "automation-0" },
            },
            orderBy: { id: "asc" },
            take: 3,
            select: { id: true, name: true, templateVersion: true },
        });
    });

    it("uses the server default and falls back to the ID for a noncanonical stored name", async () => {
        mocks.listAutomations.mockResolvedValue([
            { id: "automation-1", name: "   ", templateVersion: 3 },
        ]);

        await expect(listAutomationConversationTargetsV1({
            accountId: "account-1",
            caller,
            input: {},
        })).resolves.toEqual({
            items: [{ automationId: "automation-1", templateVersion: 3, label: "automation-1" }],
            nextCursor: null,
        });
        expect(mocks.listAutomations).toHaveBeenCalledWith(expect.objectContaining({
            take: 101,
        }));
    });

    it("returns an empty page without cursor state when no current target is available", async () => {
        await expect(listAutomationConversationTargetsV1({
            accountId: "account-1",
            caller,
            input: { cursor: null },
        })).resolves.toEqual({ items: [], nextCursor: null });
        expect(mocks.listAutomations).toHaveBeenCalledWith({
            where: {
                accountId: "account-1",
                deletedAt: null,
                triggerKind: "conversation",
            },
            orderBy: { id: "asc" },
            take: 101,
            select: { id: true, name: true, templateVersion: true },
        });
    });

    it("refuses wrong or stale caller materialization before querying target rows", async () => {
        await expect(listAutomationConversationTargetsV1({
            accountId: "account-1",
            caller: { ...caller, pluginId: "com.acme.other" },
            input: {},
        })).rejects.toBeInstanceOf(AutomationConversationTargetVerificationCallerError);
        expect(mocks.listAutomations).not.toHaveBeenCalled();

        mocks.assertCurrentCaller.mockRejectedValueOnce(
            new AutomationEventCurrentnessError("caller_materialization_not_current"),
        );
        await expect(listAutomationConversationTargetsV1({
            accountId: "account-1",
            caller,
            input: {},
        })).rejects.toBeInstanceOf(AutomationConversationTargetVerificationCallerError);
        expect(mocks.listAutomations).not.toHaveBeenCalled();
    });
});
