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

function listedRow(params: Readonly<{
    id: string;
    name: string;
    templateVersion: number;
    targetType?: "new_session" | "existing_session" | "execution_run";
    enabled?: boolean;
}>) {
    return {
        id: params.id,
        name: params.name,
        templateVersion: params.templateVersion,
        targetType: params.targetType ?? "execution_run",
        enabled: params.enabled ?? true,
    };
}

const scheduleAutomation: AutomationListItem = {
    id: "automation-1",
    accountId: "account-1",
    name: "Daily digest",
    description: null,
    enabled: true,
    triggerKind: "schedule",
    scheduleKind: "interval",
    scheduleExpr: null,
    everyMs: 60_000,
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
    triggerDefinitionEnvelope: null,
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
        mocks.loadAutomation.mockResolvedValue(scheduleAutomation);
        mocks.listAutomations.mockResolvedValue([]);
    });

    it("reads the target through the Account-scoped Automation owner without pinning a trigger kind", async () => {
        // A conversation binding adds an invocation source; it never replaces
        // the Automation's schedule, so the read must not filter on one.
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

    it("returns templateVersionMismatch without the current version or content", async () => {
        await expect(verifyAutomationConversationTargetV1({
            accountId: "account-1",
            caller,
            input: { automationId: "automation-1", expectedTemplateVersion: 2 },
        })).resolves.toEqual({ kind: "notVerified", reason: "templateVersionMismatch" });
    });

    it("rejects final-result delivery for an execution-run target", async () => {
        await expect(verifyAutomationConversationTargetV1({
            accountId: "account-1",
            caller,
            input: {
                automationId: "automation-1",
                expectedTemplateVersion: 3,
                resultDelivery: "finalResult",
            },
        })).resolves.toEqual({ kind: "notVerified", reason: "resultDeliveryUnsupported" });
    });

    it("keeps a disabled Automation eligible to the final verifier", async () => {
        mocks.loadAutomation.mockResolvedValue({ ...scheduleAutomation, enabled: false });

        await expect(verifyAutomationConversationTargetV1({
            accountId: "account-1",
            caller,
            input: { automationId: "automation-1", expectedTemplateVersion: 3 },
        })).resolves.toEqual({ kind: "verified", templateVersion: 3 });
    });

    it("verifies for any current plugin caller and fails closed on stale materialization", async () => {
        // No plugin id is privileged: an out-of-tree caller reaches the same
        // Account targets a bundled one does.
        await expect(verifyAutomationConversationTargetV1({
            accountId: "account-1",
            caller: { ...caller, pluginId: "com.acme.other" },
            input: { automationId: "automation-1", expectedTemplateVersion: 3 },
        })).resolves.toEqual({ kind: "verified", templateVersion: 3 });
        mocks.loadAutomation.mockClear();

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

    it("lists a bounded ID keyset of every Account Automation without selecting target content", async () => {
        mocks.listAutomations.mockResolvedValue([
            listedRow({ id: "automation-1", name: "Current target", templateVersion: 0 }),
            listedRow({ id: "automation-2", name: "x".repeat(129), templateVersion: 2 }),
            listedRow({ id: "automation-3", name: "Lookahead only", templateVersion: 4 }),
        ]);

        await expect(listAutomationConversationTargetsV1({
            accountId: "account-1",
            caller,
            input: { limit: 2, cursor: "automation-0" },
        })).resolves.toEqual({
            items: [
                {
                    automationId: "automation-1",
                    templateVersion: 0,
                    label: "Current target",
                    execution: { targetType: "execution_run", enabled: true },
                },
                {
                    automationId: "automation-2",
                    templateVersion: 2,
                    label: "automation-2",
                    execution: { targetType: "execution_run", enabled: true },
                },
            ],
            nextCursor: "automation-2",
        });

        expect(mocks.listAutomations).toHaveBeenCalledWith({
            where: {
                accountId: "account-1",
                deletedAt: null,
                id: { gt: "automation-0" },
            },
            orderBy: { id: "asc" },
            take: 3,
            select: {
                id: true,
                name: true,
                templateVersion: true,
                targetType: true,
                enabled: true,
            },
        });
    });

    it("uses the server default and falls back to the ID for a noncanonical stored name", async () => {
        mocks.listAutomations.mockResolvedValue([
            listedRow({ id: "automation-1", name: "   ", templateVersion: 3 }),
        ]);

        await expect(listAutomationConversationTargetsV1({
            accountId: "account-1",
            caller,
            input: {},
        })).resolves.toEqual({
            items: [{
                automationId: "automation-1",
                templateVersion: 3,
                label: "automation-1",
                execution: { targetType: "execution_run", enabled: true },
            }],
            nextCursor: null,
        });
        expect(mocks.listAutomations).toHaveBeenCalledWith(expect.objectContaining({ take: 101 }));
    });

    it("returns an empty page without cursor state when the Account owns no Automation", async () => {
        await expect(listAutomationConversationTargetsV1({
            accountId: "account-1",
            caller,
            input: { cursor: null },
        })).resolves.toEqual({ items: [], nextCursor: null });
        expect(mocks.listAutomations).toHaveBeenCalledWith(expect.objectContaining({
            where: { accountId: "account-1", deletedAt: null },
            take: 101,
        }));
    });

    it("lists for any current plugin caller and refuses only stale caller materialization", async () => {
        await expect(listAutomationConversationTargetsV1({
            accountId: "account-1",
            caller: { ...caller, pluginId: "com.acme.other" },
            input: {},
        })).resolves.toEqual({ items: [], nextCursor: null });
        expect(mocks.listAutomations).toHaveBeenCalledTimes(1);
        mocks.listAutomations.mockClear();

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
