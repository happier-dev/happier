import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createAutomation, runAutomationNow, setAutomationEnabled, updateAutomation } from "./automationCrudService";
import { AutomationValidationError } from "./automationValidation";

function buildTemplateEnvelope(existingSessionId?: string): string {
    return JSON.stringify({
        kind: "happier_automation_template_encrypted_v1",
        payloadCiphertext: "ciphertext-base64",
        ...(existingSessionId ? { existingSessionId } : {}),
    });
}

describe("automationCrudService (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-automation-crud-service-" });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.restoreEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("stores cron schedules with scheduleExpr and enqueues the first run", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-automation-crud-cron" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
        });

        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Cron session",
                description: null,
                enabled: true,
                schedule: { kind: "cron", scheduleExpr: "*/5 * * * *", timezone: "UTC" },
                targetType: "new_session",
                templateCiphertext: buildTemplateEnvelope(),
                assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
            },
        });

        expect(created.scheduleKind).toBe("cron");
        expect(created.scheduleExpr).toBe("*/5 * * * *");
        expect(created.everyMs).toBeNull();

        const queuedRuns = await db.automationRun.count({
            where: { automationId: created.id, state: "queued" },
        });
        expect(queuedRuns).toBe(1);
    });

    it("pause/resume toggles queued scheduled runs coherently", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-automation-crud-pause-resume" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
        });

        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Hourly session",
                description: null,
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                targetType: "new_session",
                templateCiphertext: buildTemplateEnvelope(),
                assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
            },
        });

        const initiallyQueued = await db.automationRun.count({
            where: {
                automationId: created.id,
                state: "queued",
            },
        });
        expect(initiallyQueued).toBe(1);

        const paused = await setAutomationEnabled({
            accountId: account.id,
            automationId: created.id,
            enabled: false,
        });
        expect(paused?.enabled).toBe(false);

        const queuedAfterPause = await db.automationRun.count({
            where: {
                automationId: created.id,
                state: "queued",
            },
        });
        expect(queuedAfterPause).toBe(0);

        const reenabled = await setAutomationEnabled({
            accountId: account.id,
            automationId: created.id,
            enabled: true,
        });
        expect(reenabled?.enabled).toBe(true);

        const queuedAfterResume = await db.automationRun.count({
            where: {
                automationId: created.id,
                state: "queued",
            },
        });
        expect(queuedAfterResume).toBe(1);
    });

    it("run-now adds an immediate queued run without deleting the scheduled queue", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-automation-crud-run-now" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
        });

        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Immediate run",
                description: null,
                enabled: true,
                schedule: { kind: "interval", everyMs: 300_000, timezone: null },
                targetType: "new_session",
                templateCiphertext: buildTemplateEnvelope(),
                assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
            },
        });

        const beforeRunNow = await db.automationRun.findMany({
            where: {
                automationId: created.id,
                state: "queued",
            },
            select: { id: true, dueAt: true },
            orderBy: [{ dueAt: "asc" }],
        });
        expect(beforeRunNow).toHaveLength(1);

        const immediate = await runAutomationNow({
            accountId: account.id,
            automationId: created.id,
        });
        expect(immediate).not.toBeNull();

        const afterRunNow = await db.automationRun.findMany({
            where: {
                automationId: created.id,
                state: "queued",
            },
            select: { id: true, dueAt: true },
            orderBy: [{ dueAt: "asc" }],
        });
        expect(afterRunNow).toHaveLength(2);
    });

    it("updates queued run dueAt (and nextRunAt) when schedule is changed", async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date("2026-02-12T10:00:00.000Z"));

            const account = await db.account.create({
                data: { publicKey: "pk-automation-crud-schedule-update" },
                select: { id: true },
            });
            await db.machine.create({
                data: {
                    id: "machine-1",
                    accountId: account.id,
                    metadata: "{}",
                },
            });

            const created = await createAutomation({
                accountId: account.id,
                input: {
                    name: "Schedule update",
                    description: null,
                    enabled: true,
                    schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                    targetType: "new_session",
                    templateCiphertext: buildTemplateEnvelope(),
                    assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
                },
            });

            const queuedBefore = await db.automationRun.findFirst({
                where: { automationId: created.id, state: "queued" },
                orderBy: [{ dueAt: "asc" }],
                select: { id: true, dueAt: true },
            });
            expect(queuedBefore?.dueAt.toISOString()).toBe("2026-02-12T10:01:00.000Z");

            const updated = await updateAutomation({
                accountId: account.id,
                automationId: created.id,
                input: {
                    schedule: { kind: "interval", everyMs: 120_000, timezone: null },
                },
            });
            expect(updated).not.toBeNull();

            const queuedAfter = await db.automationRun.findFirst({
                where: { automationId: created.id, state: "queued" },
                orderBy: [{ dueAt: "asc" }],
                select: { id: true, dueAt: true },
            });
            expect(queuedAfter?.id).toBe(queuedBefore?.id);
            expect(queuedAfter?.dueAt.toISOString()).toBe("2026-02-12T10:02:00.000Z");

            const automationRow = await db.automation.findUnique({
                where: { id: created.id },
                select: { nextRunAt: true },
            });
            expect(automationRow?.nextRunAt?.toISOString()).toBe("2026-02-12T10:02:00.000Z");
        } finally {
            vi.useRealTimers();
        }
    });

    it("rejects existing_session automation when target session does not exist or is inactive", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-automation-crud-existing-session-validation" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
        });

        await expect(() =>
            createAutomation({
                accountId: account.id,
                input: {
                    name: "Existing session missing",
                    description: null,
                    enabled: true,
                    schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                    targetType: "existing_session",
                    templateCiphertext: buildTemplateEnvelope("missing-session"),
                    assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
                },
            }),
        ).rejects.toThrow(/existing session/i);

        const inactiveSession = await db.session.create({
            data: {
                tag: "inactive-session",
                accountId: account.id,
                metadata: "{}",
                active: false,
            },
            select: { id: true },
        });

        await expect(() =>
            createAutomation({
                accountId: account.id,
                input: {
                    name: "Existing session inactive",
                    description: null,
                    enabled: true,
                    schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                    targetType: "existing_session",
                    templateCiphertext: buildTemplateEnvelope(inactiveSession.id),
                    assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
                },
            }),
        ).rejects.toThrow(/inactive/i);
    });

    it("allows existing_session automation for an active target and rejects invalid target updates", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-automation-crud-existing-session-update-validation" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
        });

        const activeSession = await db.session.create({
            data: {
                tag: "active-session",
                accountId: account.id,
                metadata: "{}",
            },
            select: { id: true },
        });

        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Existing session valid",
                description: null,
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                targetType: "existing_session",
                templateCiphertext: buildTemplateEnvelope(activeSession.id),
                assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
            },
        });

        expect(created.targetType).toBe("existing_session");

        await expect(() =>
            updateAutomation({
                accountId: account.id,
                automationId: created.id,
                input: {
                    templateCiphertext: buildTemplateEnvelope("missing-session-after-create"),
                },
            }),
        ).rejects.toThrow(/existing session/i);
    });

    it("rejects assignments that target machines outside of the account with AutomationValidationError", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-automation-crud-assignment-validation" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-owned",
                accountId: account.id,
                metadata: "{}",
            },
        });

        await expect(() =>
            createAutomation({
                accountId: account.id,
                input: {
                    name: "Invalid assignment automation",
                    description: null,
                    enabled: true,
                    schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                    targetType: "new_session",
                    templateCiphertext: buildTemplateEnvelope(),
                    assignments: [{ machineId: "machine-not-owned", enabled: true, priority: 0 }],
                },
            }),
        ).rejects.toBeInstanceOf(AutomationValidationError);
    });
});
