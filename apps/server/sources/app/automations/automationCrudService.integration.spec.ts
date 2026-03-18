import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { eventRouter } from "@/app/events/eventRouter";

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
    let ioTo: ReturnType<typeof vi.fn>;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-automation-crud-service-" });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        ioTo = vi.fn();
        const emit = vi.fn();
        ioTo.mockReturnValue({ emit });
        eventRouter.setIo({ to: ioTo } as any);
    });

    afterEach(async () => {
        harness.restoreEnv();
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

        // User-scoped update (UI) + machine-only wakeup (daemon).
        const targets = ioTo.mock.calls.map(([arg]) => arg);
        expect(targets).toContain(`user-scoped:${account.id}`);
        expect(targets).toContain(`machine:machine-1:${account.id}`);

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

    it("allows existing_session automation when the target session is e2ee and stored metadata is opaque", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-automation-crud-existing-session-opaque" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
        });

        const opaqueSession = await db.session.create({
            data: {
                tag: "opaque-session",
                accountId: account.id,
                encryptionMode: "e2ee",
                metadata: "ciphertext-base64",
                active: true,
            },
            select: { id: true },
        });

        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Opaque existing session",
                description: null,
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                targetType: "existing_session",
                templateCiphertext: buildTemplateEnvelope(opaqueSession.id),
                assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
            },
        });

        expect(created.targetType).toBe("existing_session");
    });

    it("rejects existing_session automation when parseable metadata is not resumable", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-automation-crud-existing-session-resume-check" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
        });

        const nonResumableSession = await db.session.create({
            data: {
                tag: "plain-session",
                accountId: account.id,
                encryptionMode: "plain",
                metadata: JSON.stringify({ flavor: "claude" }),
                active: true,
            },
            select: { id: true },
        });

        await expect(() =>
            createAutomation({
                accountId: account.id,
                input: {
                    name: "Non-resumable existing session",
                    description: null,
                    enabled: true,
                    schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                    targetType: "existing_session",
                    templateCiphertext: buildTemplateEnvelope(nonResumableSession.id),
                    assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
                },
            }),
        ).rejects.toThrow(/resumable/i);
    });

    it("allows existing_session automation when the target session is plain and resumable", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-automation-crud-existing-session-plain-resume" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
        });

        const resumableSession = await db.session.create({
            data: {
                tag: "plain-resumable-session",
                accountId: account.id,
                encryptionMode: "plain",
                metadata: JSON.stringify({
                    flavor: "claude",
                    claudeSessionId: "claude-session-1",
                }),
                active: true,
            },
            select: { id: true },
        });

        const created = await createAutomation({
            accountId: account.id,
            input: {
                name: "Plain resumable existing session",
                description: null,
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                targetType: "existing_session",
                templateCiphertext: buildTemplateEnvelope(resumableSession.id),
                assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
            },
        });

        expect(created.targetType).toBe("existing_session");
    });

    it("rejects existing_session automation when the target session has an unknown encryption mode", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-automation-crud-existing-session-unknown-mode" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
        });

        const unknownModeSession = await db.session.create({
            data: {
                tag: "unknown-mode-session",
                accountId: account.id,
                encryptionMode: "legacy",
                metadata: "ciphertext-base64",
                active: true,
            },
            select: { id: true },
        });

        await expect(() =>
            createAutomation({
                accountId: account.id,
                input: {
                    name: "Unknown mode existing session",
                    description: null,
                    enabled: true,
                    schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                    targetType: "existing_session",
                    templateCiphertext: buildTemplateEnvelope(unknownModeSession.id),
                    assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
                },
            }),
        ).rejects.toThrow(/resumable/i);
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
