import { randomUUID } from "node:crypto";

import {
    AutomationTriggerIdSchema,
} from "@happier-dev/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { cancelWorkflowRunTx } from "@/app/workflows/workflowRunService";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createAutomationWorkflowRecipeFixture } from "@/testkit/automationWorkflowRecipe";

import { claimAutomationRun } from "./automationClaimService";
import { createAutomation } from "./automationCrudService";
import { runAutomationScheduleWorkerPass, startAutomationScheduleWorker } from "./automationScheduleWorker";

const MACHINE_ID = "machine-schedule-firing";

function executionRecipe() {
    // The canonical current-definition fixture: the strict parsed recipe
    // object that createAutomation itself serializes when it seals the
    // stored definition (same pattern as the automationCrudService
    // integration fixtures).
    return createAutomationWorkflowRecipeFixture({ templateVersion: 1,
        directory: "/tmp/schedule-firing", prompt: "Two schedule firing recipe" });
}

function intervalTrigger(everyMs: number, enabled = true) {
    return {
        kind: "schedule" as const,
        enabled,
        schedule: { kind: "interval" as const, scheduleExpr: null, everyMs, timezone: null },
    };
}

describe("Automation schedule trigger firing (integration)", () => {
    let harness: LightSqliteHarness;
    let accountId: string;
    let automationId: string;
    let fastTriggerId: string;
    let slowTriggerId: string;
    let disabledTriggerId: string;

    const dueAt = new Date("2026-08-27T12:00:00.000Z");

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-automation-schedule-firing-",
        });
    }, 120_000);

    afterAll(async () => await harness.close());

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.automationRunEvent.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automationTrigger.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function seedTwoScheduleTriggers(): Promise<void> {
        const account = await db.account.create({
            data: { id: `account-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        accountId = account.id;
        await db.machine.create({
            data: {
                id: MACHINE_ID,
                accountId,
                metadata: "{}",
                installationId: `installation-${MACHINE_ID}`,
            },
        });
        const created = await createAutomation({
            accountId,
            input: {
                automationId: randomUUID(),
                name: "Two schedule firing",
                enabled: true,
                executionRecipe: executionRecipe(),
                assignments: [{ machineId: MACHINE_ID, enabled: true, priority: 1 }],
                triggers: [
                    { triggerId: AutomationTriggerIdSchema.parse(randomUUID()), trigger: intervalTrigger(60_000) },
                    { triggerId: AutomationTriggerIdSchema.parse(randomUUID()), trigger: intervalTrigger(120_000) },
                    // An independently disabled sibling must never fire.
                    { triggerId: AutomationTriggerIdSchema.parse(randomUUID()), trigger: intervalTrigger(60_000, false) },
                ],
            },
        });
        automationId = created.id;
        // Trigger rows are returned in their canonical stable-id order, not
        // the request array order. Select by semantic cadence/enablement so
        // this fixture does not couple to persistence ordering.
        const fast = created.triggers.find((trigger) =>
            trigger.kind === "schedule" && trigger.enabled && trigger.everyMs === 60_000,
        );
        const slow = created.triggers.find((trigger) =>
            trigger.kind === "schedule" && trigger.enabled && trigger.everyMs === 120_000,
        );
        const disabled = created.triggers.find((trigger) =>
            trigger.kind === "schedule" && !trigger.enabled && trigger.everyMs === 60_000,
        );
        expect(fast).toBeDefined();
        expect(slow).toBeDefined();
        expect(disabled).toBeDefined();
        expect(fast).toMatchObject({ kind: "schedule", enabled: true, everyMs: 60_000 });
        expect(slow).toMatchObject({ kind: "schedule", enabled: true, everyMs: 120_000 });
        expect(disabled).toMatchObject({ kind: "schedule", enabled: false, everyMs: 60_000 });
        fastTriggerId = fast!.id;
        slowTriggerId = slow!.id;
        disabledTriggerId = disabled!.id;
    }

    async function readRuns() {
        return await db.automationRun.findMany({
            where: { automationId },
            select: {
                id: true,
                triggerId: true,
                state: true,
                causeKind: true,
                causeTriggerKind: true,
                causeTriggerRevision: true,
                causeOccurredAt: true,
                occurrenceKey: true,
            },
            orderBy: [{ triggerId: "asc" }, { id: "asc" }],
        });
    }

    it("discovers a newly due trigger without a local wake while a future schedule is sleeping", async () => {
        await seedTwoScheduleTriggers();
        const futureAt = new Date(Date.now() + 60_000);
        await db.automationTrigger.updateMany({
            where: { automationId },
            data: { nextRunAt: futureAt },
        });
        const template = await db.automationTrigger.findUniqueOrThrow({ where: { id: fastTriggerId } });
        const idlePollMs = 100;
        const timers = vi.spyOn(globalThis, "setTimeout");
        const worker = startAutomationScheduleWorker({ idlePollMs });
        try {
            await vi.waitFor(() => expect(timers.mock.calls.some(([, delay]) => (
                delay === idlePollMs || (typeof delay === "number" && delay > 10_000)
            ))).toBe(true), { interval: 20 });
            // A database-only commit models another API replica: its process-
            // local wake cannot reach this worker.
            const triggerId = randomUUID();
            await db.automationTrigger.create({
                data: { ...template, id: triggerId, nextRunAt: new Date() },
            });
            await vi.waitFor(async () => {
                await expect(readRuns()).resolves.toMatchObject([
                    { triggerId, state: "queued", causeKind: "trigger", causeTriggerKind: "schedule" },
                ]);
            }, { timeout: 2_000, interval: 20 });
            await expect(db.automationTrigger.findUniqueOrThrow({
                where: { id: fastTriggerId },
                select: { nextRunAt: true, revision: true },
            })).resolves.toEqual({ nextRunAt: futureAt, revision: template.revision });
        } finally {
            await worker.stop();
            timers.mockRestore();
        }
    });

    it("admits one independent occurrence per enabled schedule trigger and never fires a disabled sibling", async () => {
        await seedTwoScheduleTriggers();

        for (const triggerId of [fastTriggerId, slowTriggerId, disabledTriggerId]) {
            await db.automationTrigger.update({
                where: { id: triggerId },
                data: { nextRunAt: dueAt },
            });
        }

        const firstPass = await runAutomationScheduleWorkerPass({ now: dueAt });
        expect(firstPass.progressed).toBe(true);

        const runs = await readRuns();
        expect(runs).toHaveLength(2);
        const runByTriggerId = new Map(runs.map((run) => [run.triggerId, run]));
        expect([...runByTriggerId.keys()].sort()).toEqual([fastTriggerId, slowTriggerId].sort());
        expect(runByTriggerId.has(disabledTriggerId)).toBe(false);

        for (const [triggerId, run] of runByTriggerId) {
            if (triggerId === null) throw new Error("Schedule Run must retain its trigger identity");
            const trigger = await db.automationTrigger.findUniqueOrThrow({
                where: { id: triggerId },
                select: { revision: true },
            });
            expect(run).toMatchObject({
                state: "queued",
                causeKind: "trigger",
                causeTriggerKind: "schedule",
                causeTriggerRevision: trigger.revision,
            });
            expect(run.occurrenceKey).toEqual(expect.any(String));
        }
        expect(new Set(runs.map((run) => run.occurrenceKey)).size).toBe(2);

        // An immediate replay pass of the same due moment admits nothing new:
        // each occurrence is owned by its own trigger.
        const replayPass = await runAutomationScheduleWorkerPass({ now: dueAt });
        expect(replayPass.progressed).toBe(false);
        await expect(readRuns()).resolves.toHaveLength(2);
    });

    it("keeps open-Run suppression scoped to one trigger so a terminal sibling fires again", async () => {
        await seedTwoScheduleTriggers();
        await db.automationTrigger.update({
            where: { id: fastTriggerId },
            data: { nextRunAt: dueAt },
        });
        await db.automationTrigger.update({
            where: { id: slowTriggerId },
            data: { nextRunAt: dueAt },
        });
        await runAutomationScheduleWorkerPass({ now: dueAt });
        const firstRuns = await readRuns();
        expect(firstRuns).toHaveLength(2);

        // Terminal-settle whichever trigger's Run the canonical claim owner
        // admits first (same-due admission order follows Run identity); the
        // sibling trigger's Run stays open.
        const claim = await claimAutomationRun({
            accountId,
            machineId: MACHINE_ID,
            leaseDurationMs: 30_000,
            claimRequest: {
                machineInstallationId: `installation-${MACHINE_ID}`,
                nonce: `schedule-firing-${randomUUID()}`,
                expiresAt: new Date(Date.now() + 300_000),
            },
        });
        expect(claim.run).not.toBeNull();
        expect(claim.accountCurrentness).not.toBeNull();
        const settledTriggerId = claim.run!.triggerId!;
        const otherTriggerId = settledTriggerId === fastTriggerId ? slowTriggerId : fastTriggerId;
        const otherRun = firstRuns.find((run) => run.triggerId === otherTriggerId)!;
        expect(otherRun.state).toBe("queued");

        // Before root admission the canonical Workflow cancellation owner
        // terminal-settles custody and applies the Automation terminal effects.
        const cancelled = await inTx((tx) => cancelWorkflowRunTx(tx, {
            accountId,
            runId: claim.run!.id,
            expectedRevision: claim.run!.revision,
        }));
        expect(cancelled.run).toMatchObject({ id: claim.run!.id, state: "cancelled" });

        // At the next joint due moment the terminal trigger admits its own
        // second occurrence while the open sibling stays suppressed.
        const secondDue = new Date(dueAt.getTime() + 120_000);
        await db.automationTrigger.update({
            where: { id: fastTriggerId },
            data: { nextRunAt: secondDue },
        });
        await db.automationTrigger.update({
            where: { id: slowTriggerId },
            data: { nextRunAt: secondDue },
        });
        const secondPass = await runAutomationScheduleWorkerPass({ now: secondDue });

        const allRuns = await readRuns();
        expect(secondPass.progressed).toBe(true);
        expect(allRuns).toHaveLength(3);
        const settledTriggerRuns = allRuns.filter((run) => run.triggerId === settledTriggerId);
        const otherTriggerRuns = allRuns.filter((run) => run.triggerId === otherTriggerId);
        expect(settledTriggerRuns).toHaveLength(2);
        expect(settledTriggerRuns.map((run) => run.state).sort()).toEqual(["cancelled", "queued"]);
        expect(otherTriggerRuns).toEqual([otherRun]);
        expect(otherRun.state).toBe("queued");
        expect(new Set(settledTriggerRuns.map((run) => run.occurrenceKey)).size).toBe(2);
        expect(new Set(allRuns.map((run) => run.occurrenceKey)).size).toBe(3);
    });
});
