import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createAutomation } from "./automationCrudService";
import { getAutomationSettings, updateAutomationSettings } from "./automationSettingsService";

describe("automationSettingsService (integration)", () => {
    let harness: LightSqliteHarness;
    let ioTo: ReturnType<typeof vi.fn>;
    let emit: ReturnType<typeof vi.fn>;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-automation-settings-service-",
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        ioTo = vi.fn();
        emit = vi.fn();
        ioTo.mockReturnValue({ emit });
        eventRouter.setIo({ to: ioTo } as never);
    });

    afterEach(async () => {
        eventRouter.clearIo();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("persists the Account policy and wakes every assigned machine through the incumbent signal", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        await db.machine.createMany({
            data: [
                { id: "machine-settings-one", accountId: account.id, metadata: "{}" },
                { id: "machine-settings-two", accountId: account.id, metadata: "{}" },
            ],
        });
        await createAutomation({
            accountId: account.id,
            input: {
                name: "Settings wake target",
                enabled: false,
                schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                targetType: "new_session",
                templateCiphertext: JSON.stringify({
                    kind: "happier_automation_template_plain_v1",
                    payload: { prompt: "wake on policy update" },
                }),
                assignments: [
                    { machineId: "machine-settings-one" },
                    { machineId: "machine-settings-two" },
                ],
            },
        });

        ioTo.mockClear();
        emit.mockClear();

        await expect(getAutomationSettings({ accountId: account.id })).resolves.toEqual({
            maxActiveRunsPerMachine: 4,
            runRetention: "thirtyDays",
        });
        await expect(updateAutomationSettings({
            accountId: account.id,
            settings: { maxActiveRunsPerMachine: 2, runRetention: "keepForever" },
        })).resolves.toEqual({
            maxActiveRunsPerMachine: 2,
            runRetention: "keepForever",
        });
        await expect(getAutomationSettings({ accountId: account.id })).resolves.toEqual({
            maxActiveRunsPerMachine: 2,
            runRetention: "keepForever",
        });
        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                automationMaxActiveRunsPerMachine: true,
                automationRunRetention: true,
            },
        })).resolves.toEqual({
            automationMaxActiveRunsPerMachine: 2,
            automationRunRetention: "keepForever",
        });
        await expect(db.accountChange.findUniqueOrThrow({
            where: {
                accountId_kind_entityId: {
                    accountId: account.id,
                    kind: "automation",
                    entityId: "automation-settings",
                },
            },
            select: { cursor: true },
        })).resolves.toEqual({ cursor: expect.any(Number) });

        const assignmentUpdates = emit.mock.calls
            .filter((call) => call[0] === "update")
            .map((call) => call[1])
            .filter((payload): payload is { body: { t: string; machineId?: string } } =>
                typeof payload === "object"
                && payload !== null
                && "body" in payload
                && typeof payload.body === "object"
                && payload.body !== null
                && "t" in payload.body
                && payload.body.t === "automation-assignment-updated",
            )
            .map((payload) => payload.body.machineId)
            .sort();
        expect(assignmentUpdates).toEqual(["machine-settings-one", "machine-settings-two"]);
    });
});
