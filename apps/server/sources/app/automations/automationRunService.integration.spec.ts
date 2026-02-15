import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { failAutomationRun, startAutomationRun, succeedAutomationRun } from "./automationRunService";

const TEST_TEMPLATE_ENVELOPE = JSON.stringify({
    kind: "happier_automation_template_encrypted_v1",
    payloadCiphertext: "ciphertext-base64",
});

async function createAccountMachineAutomation(params: {
    publicKey: string;
    machineId: string;
    automationName: string;
}) {
    const account = await db.account.create({
        data: { publicKey: params.publicKey },
        select: { id: true },
    });
    await db.machine.create({
        data: {
            id: params.machineId,
            accountId: account.id,
            metadata: "{}",
        },
    });
    const automation = await db.automation.create({
        data: {
            accountId: account.id,
            name: params.automationName,
            enabled: true,
            scheduleKind: "interval",
            everyMs: 120_000,
            targetType: "new_session",
            templateCiphertext: TEST_TEMPLATE_ENVELOPE,
            templateVersion: 1,
            assignments: {
                create: {
                    machineId: params.machineId,
                    enabled: true,
                    priority: 0,
                },
            },
        },
        select: { id: true },
    });
    return {
        accountId: account.id,
        machineId: params.machineId,
        automationId: automation.id,
    };
}

describe("automationRunService (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-automation-run-service-" });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.restoreEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.automationRunEvent.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("transitions claimed -> running -> succeeded and enqueues the next run", async () => {
        const seeded = await createAccountMachineAutomation({
            publicKey: "pk-automation-run-succeed",
            machineId: "machine-1",
            automationName: "Succeed automation",
        });
        const run = await db.automationRun.create({
            data: {
                automationId: seeded.automationId,
                accountId: seeded.accountId,
                state: "claimed",
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 30_000),
                claimedAt: new Date(Date.now() - 20_000),
                claimedByMachineId: seeded.machineId,
                leaseExpiresAt: new Date(Date.now() + 30_000),
                attempt: 1,
            },
            select: { id: true },
        });

        const started = await startAutomationRun({
            accountId: seeded.accountId,
            runId: run.id,
            machineId: seeded.machineId,
        });
        expect(started?.state).toBe("running");
        expect(started?.startedAt).not.toBeNull();

        const succeeded = await succeedAutomationRun({
            accountId: seeded.accountId,
            runId: run.id,
            machineId: seeded.machineId,
            summaryCiphertext: "  summary  ",
        });
        expect(succeeded).toEqual(
            expect.objectContaining({
                id: run.id,
                state: "succeeded",
                summaryCiphertext: "summary",
            }),
        );

        const runs = await db.automationRun.findMany({
            where: {
                automationId: seeded.automationId,
            },
            orderBy: [{ createdAt: "asc" }],
            select: {
                id: true,
                state: true,
                dueAt: true,
            },
        });
        expect(runs.map((entry) => entry.state)).toEqual(["succeeded", "queued"]);
        expect(runs[1]?.dueAt.getTime()).toBeGreaterThan(Date.now());
        const events = await db.automationRunEvent.findMany({
            where: { runId: run.id },
            orderBy: [{ ts: "asc" }],
            select: { type: true },
        });
        expect(events.map((entry) => entry.type)).toEqual(["run_started", "run_succeeded"]);

        const automation = await db.automation.findUnique({
            where: { id: seeded.automationId },
            select: { lastRunAt: true, nextRunAt: true },
        });
        expect(automation?.lastRunAt).not.toBeNull();
        expect(automation?.nextRunAt).not.toBeNull();
    });

    it("records failed runs and still schedules the next interval run", async () => {
        const seeded = await createAccountMachineAutomation({
            publicKey: "pk-automation-run-fail",
            machineId: "machine-2",
            automationName: "Fail automation",
        });
        const run = await db.automationRun.create({
            data: {
                automationId: seeded.automationId,
                accountId: seeded.accountId,
                state: "running",
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 30_000),
                startedAt: new Date(Date.now() - 20_000),
                claimedByMachineId: seeded.machineId,
                leaseExpiresAt: new Date(Date.now() + 30_000),
                attempt: 1,
            },
            select: { id: true },
        });

        const failed = await failAutomationRun({
            accountId: seeded.accountId,
            runId: run.id,
            machineId: seeded.machineId,
            errorCode: " worker_crashed ",
            errorMessage: " daemon restart happened ",
        });
        expect(failed).toEqual(
            expect.objectContaining({
                id: run.id,
                state: "failed",
                errorCode: "worker_crashed",
                errorMessage: "daemon restart happened",
            }),
        );

        const queuedFollowUp = await db.automationRun.findMany({
            where: {
                automationId: seeded.automationId,
                state: "queued",
            },
            select: { id: true },
        });
        expect(queuedFollowUp).toHaveLength(1);
        const events = await db.automationRunEvent.findMany({
            where: { runId: run.id },
            orderBy: [{ ts: "asc" }],
            select: { type: true },
        });
        expect(events.map((entry) => entry.type)).toEqual(["run_failed"]);
    });

    it("ignores unknown producedSessionId values instead of failing the run transition", async () => {
        const seeded = await createAccountMachineAutomation({
            publicKey: "pk-automation-run-unknown-produced-session",
            machineId: "machine-3",
            automationName: "Unknown produced session",
        });
        const run = await db.automationRun.create({
            data: {
                automationId: seeded.automationId,
                accountId: seeded.accountId,
                state: "running",
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 30_000),
                startedAt: new Date(Date.now() - 20_000),
                claimedByMachineId: seeded.machineId,
                leaseExpiresAt: new Date(Date.now() + 30_000),
                attempt: 1,
            },
            select: { id: true },
        });

        const succeeded = await succeedAutomationRun({
            accountId: seeded.accountId,
            runId: run.id,
            machineId: seeded.machineId,
            producedSessionId: "session-does-not-exist",
        });
        expect(succeeded).not.toBeNull();
        expect(succeeded?.state).toBe("succeeded");
        expect(succeeded?.producedSessionId).toBeNull();
    });
});
