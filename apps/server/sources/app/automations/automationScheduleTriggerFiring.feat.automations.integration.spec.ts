import { randomUUID } from "node:crypto";
import { deriveAutomationOccurrenceKeyV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';

import {
    AutomationTriggerIdSchema,
} from "@happier-dev/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { retainMachinePresenceTransitionInTx } from "@/app/presence/machinePresenceTransitions";
import { cancelWorkflowRunTx } from "@/app/workflows/workflowRunService";
import { createDatabaseIntegrationHarness } from "@/testkit/databaseIntegrationHarness";
import { createAutomationWorkflowRecipeFixture } from "@/testkit/automationWorkflowRecipe";
import { observePrismaRequests } from "@/testkit/observeSqliteRequests";

import { claimAutomationRun } from "./automationClaimService";
import { createAutomation, updateAutomationTrigger } from "./automationCrudService";
import { runAutomationScheduleWorkerPass, startAutomationScheduleWorker } from "./automationScheduleWorker";
import { emitAutomationScheduleWake } from "./automationScheduleWake";
import { ensureAutomationScheduleCursorsTx } from "./automationRunQueueService";
import { toAutomationDefinitionListItemApiDto } from "./automationApiProjection";

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

/**
 * Delays of the timers the schedule worker arms. Prisma 7 runs its transaction timers in
 * JavaScript, so a bare setTimeout spy under fake timers also sees database timeouts.
 */
function spyScheduleWorkerTimers(): Readonly<{ delays: number[]; restore: () => void }> {
    const delays: number[] = [];
    const armed = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) => {
        if (new Error().stack?.includes("automationScheduleWorker")) delays.push(Number(delay));
        return armed(handler, delay, ...args);
    }) as typeof setTimeout);
    return { delays, restore: () => spy.mockRestore() };
}

describe("Automation schedule trigger firing (integration)", () => {
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
    let accountId: string;
    let automationId: string;
    let fastTriggerId: string;
    let slowTriggerId: string;
    let disabledTriggerId: string;

    const dueAt = new Date("2026-08-27T12:00:00.000Z");

    beforeAll(async () => {
        harness = await createDatabaseIntegrationHarness({ tempDirPrefix: "happier-automation-schedule-firing-" });
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
            () => db.session.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function seedTwoScheduleTriggers(scoped = false, machineId = MACHINE_ID): Promise<void> {
        const account = await db.account.create({
            data: { id: `account-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        accountId = account.id;
        await db.machine.create({
            data: {
                id: machineId,
                accountId,
                metadata: "{}",
                installationId: `installation-${machineId}`,
            },
        });
        const source = scoped ? await db.session.create({ data: { accountId, tag: randomUUID(),
            encryptionMode: "plain", metadata: JSON.stringify({ machineId, path: "/tmp/schedule-firing" }) } }) : null;
        const created = await createAutomation({
            accountId,
            input: {
                automationId: randomUUID(),
                name: "Two schedule firing",
                enabled: true,
                ...(source ? { scopeSessionId: source.id } : {}),
                executionRecipe: executionRecipe(),
                assignments: [{ machineId, enabled: true, priority: 1 }],
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
                errorCode: true,
                causeScheduledFor: true,
                causeKind: true,
                causeTriggerKind: true,
                causeTriggerRevision: true,
                causeOccurredAt: true,
                occurrenceKey: true,
            },
            orderBy: [{ triggerId: "asc" }, { id: "asc" }],
        });
    }

    async function seedOnce(active = true, paused = false) {
        accountId = `account-${randomUUID()}`;
        await db.account.create({ data: { id: accountId, encryptionMode: "plain" } });
        await db.machine.create({ data: { id: MACHINE_ID, accountId, metadata: "{}",
            installationId: `installation-${MACHINE_ID}`, active } });
        const source = paused ? await db.session.create({ data: {
            accountId, tag: randomUUID(), encryptionMode: "plain",
            metadata: JSON.stringify({ machineId: MACHINE_ID, path: "/tmp/schedule-firing" }),
        } }) : null;
        if (source) {
            await db.session.updateMany({ where: { id: source.id }, data: { botPausedAt: BigInt(dueAt.getTime() - 1) } });
        }
        const created = await createAutomation({ accountId, input: {
            automationId: randomUUID(), name: "Run once", enabled: true,
            ...(source ? { scopeSessionId: source.id } : {}),
            executionRecipe: executionRecipe(), assignments: [{ machineId: MACHINE_ID }],
            triggers: [{ triggerId: AutomationTriggerIdSchema.parse(randomUUID()), trigger: {
                kind: "schedule", enabled: true, schedule: { kind: "once", scheduledAt: dueAt.getTime() },
            } }],
        } });
        automationId = created.id;
        expect(toAutomationDefinitionListItemApiDto(created, null).triggers[0]).toMatchObject({
            schedule: { kind: "once", scheduledAt: dueAt.getTime() }, remainingOccurrences: 1, nextRunAt: dueAt.getTime(),
        });
        return created.triggers[0]!;
    }

    it("admits one absolute occurrence once and never rearms a spent schedule", async () => {
        const trigger = await seedOnce();
        await runAutomationScheduleWorkerPass({ now: new Date(dueAt.getTime() - 1) });
        await expect(readRuns()).resolves.toHaveLength(0);
        await runAutomationScheduleWorkerPass({ now: dueAt });
        await runAutomationScheduleWorkerPass({ now: new Date(dueAt.getTime() + 60_000) });
        await expect(readRuns()).resolves.toMatchObject([{ state: "queued", causeScheduledFor: dueAt }]);
        await expect(db.automationTrigger.findUniqueOrThrow({ where: { id: trigger.id } }))
            .resolves.toMatchObject({ nextRunAt: null, remainingOccurrences: 0, enabled: true });
        await updateAutomationTrigger({ accountId, automationId, triggerId: trigger.id,
            expectedRevision: trigger.revision, enabled: false });
        await updateAutomationTrigger({ accountId, automationId, triggerId: trigger.id,
            expectedRevision: trigger.revision + 1, enabled: true });
        await inTx(tx => ensureAutomationScheduleCursorsTx({ tx, automationId, now: new Date(dueAt.getTime() + 120_000) }));
        await runAutomationScheduleWorkerPass({ now: new Date(dueAt.getTime() + 120_000) });
        await expect(readRuns()).resolves.toHaveLength(1);
    });

    it("records a paused Bot's absolute occurrence as skipped and never replays it after resume", async () => {
        const trigger = await seedOnce(true, true);
        await runAutomationScheduleWorkerPass({ now: dueAt });
        await expect(readRuns()).resolves.toMatchObject([{
            state: "skipped", errorCode: "bot_paused", causeScheduledFor: dueAt,
        }]);
        await expect(db.automationTrigger.findUniqueOrThrow({ where: { id: trigger.id } }))
            .resolves.toMatchObject({ nextRunAt: null, remainingOccurrences: 0 });
        await db.session.updateMany({ where: { accountId }, data: { botPausedAt: null } });
        await runAutomationScheduleWorkerPass({ now: new Date(dueAt.getTime() + 60_000) });
        await expect(readRuns()).resolves.toHaveLength(1);
        await expect(claimAutomationRun({ accountId, machineId: MACHINE_ID, leaseDurationMs: 30_000 }))
            .resolves.toMatchObject({ run: null });
    });

    it("records offline at the instant as missed and never runs it on reconnect", async () => {
        await seedOnce(false);
        await runAutomationScheduleWorkerPass({ now: dueAt });
        await expect(readRuns()).resolves.toMatchObject([{ state: "missed", errorCode: "machine_offline", causeScheduledFor: dueAt }]);
        await db.machine.update({ where: { id: MACHINE_ID }, data: { active: true } });
        await runAutomationScheduleWorkerPass({ now: new Date(dueAt.getTime() + 60_000) });
        await expect(readRuns()).resolves.toMatchObject([{ state: "missed", errorCode: "machine_offline" }]);
        await expect(claimAutomationRun({ accountId, machineId: MACHINE_ID, leaseDurationMs: 30_000 }))
            .resolves.toMatchObject({ run: null });
    });

    it("does not admit late after a Machine reconnects beyond the scheduled instant", async () => {
        await seedOnce(false);
        // The canonical presence owner retained an offline-to-online transition
        // while the schedule worker was unavailable; current online is too late.
        await db.machine.update({ where: { id: MACHINE_ID }, data: { active: true,
            presenceTransitions: JSON.stringify({ v: 1, revision: 2,
                offline: { revision: 1, occurredAt: dueAt.getTime() - 1_000 },
                online: { revision: 2, occurredAt: dueAt.getTime() + 1_000 } }) } });
        await runAutomationScheduleWorkerPass({ now: new Date(dueAt.getTime() + 2_000) });
        await expect(readRuns()).resolves.toMatchObject([{ state: "missed", errorCode: "machine_offline" }]);
    });

    it("marks erased on-time presence missed after a later disconnect and reconnect", async () => {
        await seedOnce();
        // The retained pair is indistinguishable from an offline-at-due target
        // that reconnected twice. Prefer visible missed over firing uncertain work.
        await db.machine.update({ where: { id: MACHINE_ID }, data: {
            presenceTransitions: JSON.stringify({ v: 1, revision: 2,
                offline: { revision: 1, occurredAt: dueAt.getTime() + 1_000 },
                online: { revision: 2, occurredAt: dueAt.getTime() + 2_000 } }) } });
        await runAutomationScheduleWorkerPass({ now: new Date(dueAt.getTime() + 3_000) });
        await expect(readRuns()).resolves.toMatchObject([{ state: "missed", errorCode: "machine_presence_at_due_unavailable" }]);
    });

    it("never fires late when multiple reconnects erase offline-at-due evidence", async () => {
        await seedOnce(false);
        for (const [active, offset] of [[false, -1_000], [true, 1_000], [false, 2_000], [true, 3_000]] as const) {
            await inTx(async tx => {
                await tx.machine.update({ where: { id: MACHINE_ID }, data: { active } });
                await retainMachinePresenceTransitionInTx(tx, {
                    machineId: MACHINE_ID, active, occurredAt: dueAt.getTime() + offset,
                    recipientAccountIds: [accountId],
                });
            });
        }
        await runAutomationScheduleWorkerPass({ now: new Date(dueAt.getTime() + 4_000) });
        await expect(readRuns()).resolves.toMatchObject([{ state: "missed", errorCode: "machine_presence_at_due_unavailable" }]);
        await expect(claimAutomationRun({ accountId, machineId: MACHINE_ID, leaseDurationMs: 30_000 }))
            .resolves.toMatchObject({ run: null });
    });

    it("retains proven on-time presence across a later disconnect without reconnect", async () => {
        await seedOnce();
        await db.machine.update({ where: { id: MACHINE_ID }, data: { active: false,
            presenceTransitions: JSON.stringify({ v: 1, revision: 2,
                online: { revision: 1, occurredAt: dueAt.getTime() - 1_000 },
                offline: { revision: 2, occurredAt: dueAt.getTime() + 1_000 } }) } });
        await runAutomationScheduleWorkerPass({ now: new Date(dueAt.getTime() + 2_000) });
        await expect(readRuns()).resolves.toMatchObject([{ state: "queued" }]);
    });

    it("freezes only on-time targets when the highest-priority assignment is offline", async () => {
        await seedOnce(false);
        const onlineId = `${MACHINE_ID}-online`;
        await db.machine.create({ data: { id: onlineId, accountId, metadata: "{}", active: true, installationId: onlineId } });
        await db.automationAssignment.updateMany({ where: { automationId }, data: { priority: 2 } });
        await db.automationAssignment.create({ data: { automationId, machineId: onlineId, priority: 1, enabled: true } });
        await runAutomationScheduleWorkerPass({ now: dueAt });
        const runs = await readRuns();
        expect(runs).toMatchObject([{ state: "queued" }]);
        await expect(db.automationRunAssignment.findMany({ where: { runId: runs[0]!.id }, select: { machineId: true } }))
            .resolves.toEqual([{ machineId: onlineId }]);
    });

    it("edits and cancels a pending absolute occurrence before it is due", async () => {
        const trigger = await seedOnce();
        const later = new Date(dueAt.getTime() + 60_000);
        await updateAutomationTrigger({ accountId, automationId, triggerId: trigger.id,
            expectedRevision: trigger.revision, trigger: { kind: "schedule", schedule: { kind: "once", scheduledAt: later.getTime() } } });
        await runAutomationScheduleWorkerPass({ now: dueAt });
        await expect(readRuns()).resolves.toHaveLength(0);
        await updateAutomationTrigger({ accountId, automationId, triggerId: trigger.id,
            expectedRevision: trigger.revision + 1, enabled: false });
        await runAutomationScheduleWorkerPass({ now: later });
        await expect(readRuns()).resolves.toHaveLength(0);
        await expect(db.automationTrigger.findUniqueOrThrow({ where: { id: trigger.id } }))
            .resolves.toMatchObject({ nextRunAt: null, remainingOccurrences: 1, enabled: false });
    });

    it("skips an inconsistent Account without preventing a ready sibling Account from firing", async () => {
        await seedTwoScheduleTriggers();
        const inconsistentAccountId = accountId;
        const inconsistentAutomationId = automationId;
        await db.automationTrigger.updateMany({ where: { automationId }, data: { nextRunAt: dueAt } });
        // This persisted inconsistency is refused by the real content fence,
        // not a mocked transition result.
        await db.account.update({ where: { id: accountId }, data: { encryptionMode: "e2ee" } });
        await seedTwoScheduleTriggers(false, `${MACHINE_ID}-ready`);
        await db.automationTrigger.updateMany({ where: { automationId }, data: { nextRunAt: dueAt } });

        await runAutomationScheduleWorkerPass({ now: dueAt });

        await expect(db.automationRun.count({ where: { accountId: inconsistentAccountId,
            automationId: inconsistentAutomationId } })).resolves.toBe(0);
        await expect(readRuns()).resolves.toHaveLength(2);
    });

    it("rolls back one failed due transaction and continues admitting the next eligible trigger", async () => {
        await seedTwoScheduleTriggers();
        await db.automationTrigger.update({ where: { id: fastTriggerId }, data: { nextRunAt: dueAt } });
        await db.automationTrigger.update({ where: { id: slowTriggerId }, data: { nextRunAt: new Date(dueAt.getTime() + 1) } });
        let failedReads = 0;
        const release = observePrismaRequests(db, { before: request => {
            const where = (request.args as { where?: { id?: string } }).where;
            if (request.model === "AutomationTrigger" && request.action === "findFirst" && where?.id === fastTriggerId) {
                failedReads += 1;
                throw new Error("Persistence boundary unavailable for this trigger");
            }
        } });
        try {
            await runAutomationScheduleWorkerPass({ now: new Date(dueAt.getTime() + 1) });
        } finally { release(); }

        expect(failedReads).toBeGreaterThan(0);
        await expect(readRuns()).resolves.toMatchObject([{ triggerId: slowTriggerId, state: "queued" }]);
        await expect(db.automationTrigger.findUniqueOrThrow({ where: { id: fastTriggerId }, select: { nextRunAt: true } }))
            .resolves.toEqual({ nextRunAt: dueAt });
    });

    it("stops before another admission and resumes the remaining valid work on the next pass", async () => {
        await seedTwoScheduleTriggers();
        await db.automationTrigger.updateMany({ where: { automationId }, data: { nextRunAt: dueAt } });
        let admitted = 0;
        const release = observePrismaRequests(db, { after: (request, result) => {
            if (request.model === "AutomationRun" && result && typeof result === "object"
                && "id" in result && "state" in result && result.state === "queued") admitted += 1;
        } });
        try {
            await runAutomationScheduleWorkerPass({ now: dueAt, shouldStop: () => admitted > 0 });
        } finally { release(); }
        await expect(readRuns()).resolves.toHaveLength(1);
        await runAutomationScheduleWorkerPass({ now: dueAt });
        await expect(readRuns()).resolves.toHaveLength(2);
    });

    it.each([128, 384])("scans each retained page only once before finding the final deadline (%i open Runs)", async (heldCount) => {
        await seedTwoScheduleTriggers();
        const template = await db.automationTrigger.findUniqueOrThrow({ where: { id: fastTriggerId } });
        const heldIds = [fastTriggerId, ...Array.from({ length: heldCount - 1 }, () => randomUUID())];
        await db.automationTrigger.createMany({ data: heldIds.slice(1).map(id => ({ ...template, id, nextRunAt: dueAt })) });
        await db.automationTrigger.update({ where: { id: fastTriggerId }, data: { nextRunAt: dueAt } });
        const future = new Date(dueAt.getTime() + 60_000);
        await db.automationTrigger.update({ where: { id: slowTriggerId }, data: { nextRunAt: future } });
        await db.automationRun.createMany({ data: heldIds.map(triggerId => ({
            id: randomUUID(), accountId, automationId, originKind: "automation", state: "queued",
            triggerId, causeKind: "trigger", causeTriggerKind: "schedule", causeTriggerRevision: template.revision,
            causeOccurredAt: dueAt, causeScheduledFor: dueAt, dueAt, scheduledAt: dueAt,
            occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId: AutomationTriggerIdSchema.parse(triggerId),
                evidence: { v: 1, kind: "schedule", scheduledFor: dueAt.getTime() } }),
        })) });
        let scans = 0;
        const release = observePrismaRequests(db, { before: request => {
            if (request.model === "AutomationTrigger" && request.action === "findMany") scans += 1;
        } });
        let cursor: import("./automationScheduleWorker").AutomationScheduleScanCursor | null = null;
        let result: Awaited<ReturnType<typeof runAutomationScheduleWorkerPass>>;
        try {
            do {
                result = await runAutomationScheduleWorkerPass({ now: dueAt, scanCursor: cursor });
                cursor = result.continuationCursor;
            } while (cursor !== null);
        } finally { release(); }
        expect(result!.nextDueAt).toEqual(future);
        // One due scan and one final deadline scan, each proportional to real pages.
        expect(scans).toBe(2 * (heldCount / 128 + 1));
        await expect(readRuns()).resolves.toHaveLength(heldCount);
    });

    it("continues past a full retained open-Run cohort without omitting later valid work", async () => {
        await seedTwoScheduleTriggers();
        const template = await db.automationTrigger.findUniqueOrThrow({ where: { id: fastTriggerId } });
        const heldTriggerIds = [fastTriggerId, ...Array.from({ length: 127 }, () => randomUUID())];
        await db.automationTrigger.createMany({ data: heldTriggerIds.slice(1).map(id => ({ ...template, id, nextRunAt: dueAt })) });
        await db.automationTrigger.update({ where: { id: fastTriggerId }, data: { nextRunAt: dueAt } });
        await db.automationTrigger.update({ where: { id: slowTriggerId }, data: { nextRunAt: new Date(dueAt.getTime() + 1) } });
        // Retained admitted Runs exercise the real indexed open-work filter;
        // none is a new claim or needs to materialize its private recipe.
        await db.automationRun.createMany({ data: heldTriggerIds.map(triggerId => ({
            id: randomUUID(), accountId, automationId, originKind: "automation", state: "queued",
            triggerId, causeKind: "trigger", causeTriggerKind: "schedule", causeTriggerRevision: template.revision,
            causeOccurredAt: dueAt, causeScheduledFor: dueAt, dueAt, scheduledAt: dueAt,
            occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId: AutomationTriggerIdSchema.parse(triggerId),
                evidence: { v: 1, kind: "schedule", scheduledFor: dueAt.getTime() } }),
        })) });
        await runAutomationScheduleWorkerPass({ now: new Date(dueAt.getTime() + 1), shouldStop: () => true });
        await expect(db.automationRun.count({ where: { triggerId: slowTriggerId } })).resolves.toBe(0);

        const worker = startAutomationScheduleWorker();
        try {
            await vi.waitFor(async () => {
                await expect(db.automationRun.count({ where: { triggerId: slowTriggerId } })).resolves.toBe(1);
            }, { timeout: 2_000, interval: 20 });
        } finally { await worker.stop(); }
        await expect(readRuns()).resolves.toHaveLength(heldTriggerIds.length + 1);
        let readsAfterStop = 0;
        const release = observePrismaRequests(db, { before: request => {
            if (request.model === "AutomationTrigger" && request.action.startsWith("find")) readsAfterStop += 1;
        } });
        try {
            emitAutomationScheduleWake();
            await Promise.resolve();
            expect(readsAfterStop).toBe(0);
        } finally { release(); }
    });

    it("retains admission failure recovery after later scan pages make no progress", async () => {
        await seedTwoScheduleTriggers();
        const failedDueAt = new Date(Date.now() - 1_000);
        const template = await db.automationTrigger.findUniqueOrThrow({ where: { id: fastTriggerId } });
        const heldIds = Array.from({ length: 127 }, () => randomUUID());
        await db.automationTrigger.createMany({ data: heldIds.map(id => ({ ...template, id, nextRunAt: failedDueAt })) });
        await db.automationTrigger.update({ where: { id: fastTriggerId }, data: { nextRunAt: failedDueAt } });
        await db.automationTrigger.update({ where: { id: slowTriggerId }, data: { nextRunAt: new Date(failedDueAt.getTime() + 1) } });
        await db.automationRun.createMany({ data: [...heldIds, slowTriggerId].map(triggerId => ({
            id: randomUUID(), accountId, automationId, originKind: "automation", state: "queued",
            triggerId, causeKind: "trigger", causeTriggerKind: "schedule", causeTriggerRevision: template.revision,
            causeOccurredAt: failedDueAt, causeScheduledFor: failedDueAt, dueAt: failedDueAt, scheduledAt: failedDueAt,
            occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId: AutomationTriggerIdSchema.parse(triggerId),
                evidence: { v: 1, kind: "schedule", scheduledFor: failedDueAt.getTime() } }),
        })) });
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        const timers = spyScheduleWorkerTimers();
        let failed = false;
        const release = observePrismaRequests(db, { before: request => {
            const where = (request.args as { where?: { id?: string } }).where;
            if (!failed && request.model === "AutomationTrigger" && request.action === "findFirst" && where?.id === fastTriggerId) {
                failed = true; throw new Error("Temporary admission database failure");
            }
        } });
        const worker = startAutomationScheduleWorker();
        try {
            await vi.waitFor(() => expect(timers.delays.some((delay) => delay === 10_000)).toBe(true));
            expect(failed).toBe(true);
            await vi.advanceTimersByTimeAsync(10_000);
            await vi.waitFor(async () => expect(await db.automationRun.count({ where: { triggerId: fastTriggerId } })).toBe(1));
        } finally { await worker.stop(); release(); timers.restore(); vi.useRealTimers(); }
    });

    it("retries a failed database scan once, then leaves a healthy future schedule idle", async () => {
        await seedTwoScheduleTriggers();
        await db.automationTrigger.updateMany({ where: { automationId },
            data: { nextRunAt: new Date(Date.now() + 600_000) } });
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        const timers = spyScheduleWorkerTimers();
        let reads = 0;
        let failNextScan = true;
        const release = observePrismaRequests(db, { before: request => {
            if (request.model !== "AutomationTrigger" || !request.action.startsWith("find")) return;
            reads += 1;
            if (failNextScan) { failNextScan = false; throw new Error("Database temporarily unavailable"); }
        } });
        const worker = startAutomationScheduleWorker();
        try {
            await vi.waitFor(() => expect(timers.delays.filter((delay) => typeof delay === "number" && (delay === 10_000 || delay > 500_000))).toHaveLength(1));
            expect(reads).toBe(1);
            await vi.advanceTimersByTimeAsync(10_000);
            await vi.waitFor(() => expect(timers.delays.filter((delay) => typeof delay === "number" && (delay === 10_000 || delay > 500_000))).toHaveLength(2));
            const recoveredReads = reads;
            expect(recoveredReads).toBeGreaterThan(1);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(reads).toBe(recoveredReads);
        } finally { await worker.stop(); release(); timers.restore(); vi.useRealTimers(); }
    });

    it("does no idle scans and wakes for a committed schedule change before its old deadline", async () => {
        await seedTwoScheduleTriggers();
        const futureAt = new Date(Date.now() + 600_000);
        await db.automationTrigger.updateMany({ where: { automationId }, data: { nextRunAt: futureAt } });
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        const timers = spyScheduleWorkerTimers();
        let reads = 0;
        const release = observePrismaRequests(db, { before: request => {
            if (request.model === "AutomationTrigger" && request.action.startsWith("find")) reads += 1;
        } });
        const worker = startAutomationScheduleWorker();
        try {
            await vi.waitFor(() => expect(timers.delays.some((delay) => typeof delay === "number" && (delay === 10_000 || delay > 500_000))).toBe(true));
            const startupReads = reads;
            await vi.advanceTimersByTimeAsync(60_000);
            expect(reads - startupReads).toBe(0);
            const trigger = await db.automationTrigger.findUniqueOrThrow({ where: { id: fastTriggerId } });
            const scheduledAt = Date.now() + 60_000;
            await updateAutomationTrigger({ accountId, automationId, triggerId: fastTriggerId,
                expectedRevision: trigger.revision,
                trigger: { kind: "schedule", schedule: { kind: "once", scheduledAt } } });
            await vi.waitFor(() => expect(timers.delays.some((delay) => typeof delay === "number" && delay > 1_000 && delay <= 60_000)).toBe(true));
            await vi.advanceTimersByTimeAsync(Math.max(0, scheduledAt - Date.now()));
            await vi.waitFor(async () => expect(await readRuns()).toMatchObject([{ triggerId: fastTriggerId, causeScheduledFor: new Date(scheduledAt) }]));
            await worker.stop();
            const stoppedReads = reads;
            emitAutomationScheduleWake();
            await vi.advanceTimersByTimeAsync(600_000);
            expect(reads).toBe(stoppedReads);
        } finally {
            await worker.stop(); release(); timers.restore(); vi.useRealTimers();
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

    it("coalesces scoped schedule firings behind an active Run and releases only the latest pending occurrence", async () => {
        await seedTwoScheduleTriggers(true);
        await db.automationTrigger.update({ where: { id: fastTriggerId }, data: { nextRunAt: dueAt } });
        await db.automationTrigger.update({ where: { id: slowTriggerId }, data: { nextRunAt: new Date(dueAt.getTime() + 240_000) } });
        await runAutomationScheduleWorkerPass({ now: dueAt });
        const active = await claimAutomationRun({ accountId, machineId: MACHINE_ID, leaseDurationMs: 30_000,
            claimRequest: { machineInstallationId: `installation-${MACHINE_ID}`, nonce: randomUUID(),
                expiresAt: new Date(Date.now() + 300_000) } });
        expect(active.run).not.toBeNull();
        const secondDue = new Date(dueAt.getTime() + 60_000);
        const newestDue = new Date(dueAt.getTime() + 120_000);
        await runAutomationScheduleWorkerPass({ now: secondDue });
        await runAutomationScheduleWorkerPass({ now: newestDue });
        const runs = await readRuns();
        expect(runs).toHaveLength(3);
        expect(runs.find(run => run.id === active.run!.id)).toMatchObject({ state: "claimed", causeScheduledFor: dueAt });
        expect(runs.find(run => run.causeScheduledFor?.getTime() === secondDue.getTime()))
            .toMatchObject({ state: "skipped", errorCode: "superseded_by_newer_occurrence" });
        const newest = runs.find(run => run.causeScheduledFor?.getTime() === newestDue.getTime());
        expect(newest).toMatchObject({ state: "queued" });
        await expect(db.automationTrigger.findUniqueOrThrow({ where: { id: fastTriggerId }, select: { nextRunAt: true } }))
            .resolves.toEqual({ nextRunAt: new Date(newestDue.getTime() + 60_000) });
        const claim = () => claimAutomationRun({ accountId, machineId: MACHINE_ID, leaseDurationMs: 30_000,
            claimRequest: { machineInstallationId: `installation-${MACHINE_ID}`, nonce: randomUUID(),
                expiresAt: new Date(Date.now() + 300_000) } });
        expect((await claim()).run).toBeNull();
        await inTx(tx => cancelWorkflowRunTx(tx, { accountId, runId: active.run!.id,
            expectedRevision: active.run!.revision, accountEncryptionMode: "plain" }));
        expect((await claim()).run?.id).toBe(newest!.id);
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
            accountEncryptionMode: "plain",
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
