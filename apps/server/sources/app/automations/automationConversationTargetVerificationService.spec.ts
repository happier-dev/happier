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
    immutableGenerationId: "generation-1",
} as const;

function listedRow(params: Readonly<{
    id: string;
    name: string;
    targetType?: "new_session" | "existing_session" | "execution_run";
    enabled?: boolean;
}>) {
    return {
        id: params.id,
        name: params.name,
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
    targetType: "execution_run",
    templateCiphertext: "strict-definition",
    templateVersion: 3,
    lastRunAt: null,
    createdAt: new Date("2026-08-12T00:00:00.000Z"),
    updatedAt: new Date("2026-08-12T00:00:00.000Z"),
    assignments: [],
    triggers: [{
        id: "trigger-schedule-1",
        automationId: "automation-1",
        kind: "schedule",
        enabled: true,
        revision: 1,
        deletedAt: null,
        scheduleKind: "interval",
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
        createdAt: new Date("2026-08-12T00:00:00.000Z"),
        updatedAt: new Date("2026-08-12T00:00:00.000Z"),
        eventSourceStatus: null,
    }],
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
            input: { automationId: "automation-1" },
        })).resolves.toEqual({ kind: "verified" });

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
                input: { automationId: "automation-hidden" },
            })).resolves.toEqual({ kind: "notVerified", reason: "notFound" });
        },
    );

    it("verifies the current Automation without exposing or pinning its recipe version", async () => {
        mocks.loadAutomation.mockResolvedValue({ ...scheduleAutomation, templateVersion: 4 });

        await expect(verifyAutomationConversationTargetV1({
            accountId: "account-1",
            caller,
            input: { automationId: "automation-1" },
        })).resolves.toEqual({ kind: "verified" });
    });

    it("rejects final-result delivery for an execution-run target", async () => {
        await expect(verifyAutomationConversationTargetV1({
            accountId: "account-1",
            caller,
            input: {
                automationId: "automation-1",
                resultDelivery: "finalResult",
            },
        })).resolves.toEqual({ kind: "notVerified", reason: "resultDeliveryUnsupported" });
    });

    it("keeps a disabled Automation eligible to the final verifier", async () => {
        mocks.loadAutomation.mockResolvedValue({ ...scheduleAutomation, enabled: false });

        await expect(verifyAutomationConversationTargetV1({
            accountId: "account-1",
            caller,
            input: { automationId: "automation-1" },
        })).resolves.toEqual({ kind: "verified" });
    });

    it("verifies for any current plugin caller and fails closed on stale materialization", async () => {
        // No plugin id is privileged: an out-of-tree caller reaches the same
        // Account targets a bundled one does.
        await expect(verifyAutomationConversationTargetV1({
            accountId: "account-1",
            caller: { ...caller, pluginId: "com.acme.other" },
            input: { automationId: "automation-1" },
        })).resolves.toEqual({ kind: "verified" });
        mocks.loadAutomation.mockClear();

        mocks.assertCurrentCaller.mockRejectedValueOnce(
            new AutomationEventCurrentnessError("caller_materialization_not_current"),
        );
        await expect(verifyAutomationConversationTargetV1({
            accountId: "account-1",
            caller,
            input: { automationId: "automation-1" },
        })).rejects.toBeInstanceOf(AutomationConversationTargetVerificationCallerError);
        expect(mocks.loadAutomation).not.toHaveBeenCalled();
    });

    it("lists a bounded ID keyset of every Account Automation without selecting target content", async () => {
        mocks.listAutomations.mockResolvedValue([
            listedRow({ id: "automation-1", name: "Current target" }),
            listedRow({ id: "automation-2", name: "x".repeat(129) }),
            listedRow({ id: "automation-3", name: "Lookahead only" }),
        ]);

        await expect(listAutomationConversationTargetsV1({
            accountId: "account-1",
            caller,
            input: { limit: 2, cursor: "automation-0" },
        })).resolves.toEqual({
            items: [
                {
                    automationId: "automation-1",
                    label: "Current target",
                    execution: { targetType: "execution_run", enabled: true },
                },
                {
                    automationId: "automation-2",
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
                targetType: true,
                enabled: true,
            },
        });
    });

    it("uses the server default and falls back to the ID for a noncanonical stored name", async () => {
        mocks.listAutomations.mockResolvedValue([
            listedRow({ id: "automation-1", name: "   " }),
        ]);

        await expect(listAutomationConversationTargetsV1({
            accountId: "account-1",
            caller,
            input: {},
        })).resolves.toEqual({
            items: [{
                automationId: "automation-1",
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
