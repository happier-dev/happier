import { randomUUID } from "node:crypto";

import {
    AutomationTriggerIdSchema,
    serializeAutomationStoredDefinitionExecutionRecipeV1,
} from "@happier-dev/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { removeAutomationMachineAssignmentsTx, AutomationMachineAssignmentRemovalFenceUnavailableError } from "./automationMachineAssignmentRemoval";
import { admitCompletedParentTurnAutomationRunsTx } from "./automationSessionLifecycleAdmission";
import { runAutomationNow } from "./automationCrudService";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";

/**
 * Permanent machine revocation removes definition assignments only through
 * this canonical Automation-owned composition. Reversible replacement never
 * calls it. These tests prove the
 * assignment-liveness invariant survives machine loss at the composition
 * boundary: an enabled Automation that loses its last enabled assignment is
 * disabled atomically with its schedule cursors cleared and its Event
 * catalog/source projection advanced, while frozen admitted-Run assignment
 * snapshots are preserved untouched. They also prove the approved stranded-Run
 * settlement: on durable revocation (the machine row is marked first), a
 * nonterminal Run whose complete frozen snapshot is permanently revoked
 * settles through the one canonical cancellation transition. A reversibly
 * replaced sibling assignment keeps the Run intact for natural undo. The whole
 * mutation fails closed and typed when the Account encryption fence is
 * unavailable.
 */

function storedRecipe(templateVersion: number): string {
    const serialized = serializeAutomationStoredDefinitionExecutionRecipeV1({
        v: 1,
        templateVersion,
        template: { t: "plain", v: { v: 1, prompt: "Machine assignment removal recipe" } },
        triggerEvidence: null,
        target: {
            kind: "newSession",
            spawn: {
                executionTarget: { serverId: "server", machineId: "machine" },
                directory: "/tmp/automation-machine-assignment-removal",
                agentTarget: {
                    kind: "agent",
                    identity: { pluginId: "happier.agent.codex", localId: "codex" },
                },
            },
        },
    });
    if (serialized.kind !== "available") throw new Error("Test recipe did not serialize");
    return serialized.serialized;
}

describe("automation machine-assignment removal (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-automation-machine-assignment-removal-",
        });
    }, 120_000);

    afterAll(async () => await harness.close());

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.automationEventCatalogState.deleteMany(),
            () => db.automationRunEvent.deleteMany(),
            () => db.automationRunAssignment.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationTrigger.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.sessionTurnMutationReceipt.deleteMany(),
            () => db.sessionTurn.deleteMany(),
            () => db.session.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function createAccount(): Promise<string> {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        return account.id;
    }

    async function createMachine(accountId: string): Promise<string> {
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({
            data: { id: machineId, accountId, metadata: "{}" },
            select: { id: true },
        });
        return machineId;
    }

    async function seedAutomation(params: Readonly<{
        accountId: string;
        enabled?: boolean;
        trigger?: Readonly<{
            kind: "schedule" | "pluginEvent" | "sessionLifecycle";
            nextRunAt?: Date;
            sourceSessionId?: string;
            sourceTurnId?: string;
        }>;
    }>): Promise<{ automationId: string; triggerId: string | null }> {
        const automationId = `automation-${randomUUID()}`;
        const triggerId = params.trigger
            ? AutomationTriggerIdSchema.parse(randomUUID())
            : null;
        await db.automation.create({
            data: {
                id: automationId,
                accountId: params.accountId,
                name: "Machine assignment removal definition",
                enabled: params.enabled ?? true,
                targetType: "new_session",
                templateCiphertext: storedRecipe(1),
                templateVersion: 1,
                triggers: params.trigger && triggerId
                    ? {
                        create: {
                            id: triggerId,
                            kind: params.trigger.kind,
                            enabled: true,
                            revision: 0,
                            ...(params.trigger.kind === "schedule"
                                ? {
                                    scheduleKind: "interval" as const,
                                    everyMs: 60_000,
                                    nextRunAt: params.trigger.nextRunAt ?? null,
                                }
                                : {}),
                            ...(params.trigger.kind === "pluginEvent"
                                ? {
                                    eventPluginId: "happier.test",
                                    eventLocalId: "removal-event",
                                    sourceSelectorId: randomUUID(),
                                    sourceContractVersion: 1,
                                    observationTransport: "checkpointedPull" as const,
                                    watcherMachineId: "watcher-machine",
                                    watcherMachineInstallationId: "watcher-installation",
                                    watcherPluginId: "happier.test",
                                    watcherMaterializationId: "watcher-materialization",
                                    definitionEnvelope: "{}",
                                }
                                : {}),
                            ...(params.trigger.kind === "sessionLifecycle"
                                ? {
                                    sessionLifecycleEvent: "parentTurnCompleted" as const,
                                    sourceSessionId: params.trigger.sourceSessionId ?? null,
                                    sourceTurnId: params.trigger.sourceTurnId ?? null,
                                }
                                : {}),
                        },
                    }
                    : undefined,
            },
            select: { id: true },
        });
        return { automationId, triggerId };
    }

    async function createAssignment(automationId: string, machineId: string): Promise<void> {
        await db.automationAssignment.create({
            data: { automationId, machineId, enabled: true, priority: 0 },
        });
    }

    it("disables an enabled schedule Automation that loses its last enabled assignment, clears its cursor, and marks the Automation change", async () => {
        const accountId = await createAccount();
        const machineId = await createMachine(accountId);
        const cursorDueAt = new Date("2026-08-29T12:00:00.000Z");
        const { automationId, triggerId } = await seedAutomation({
            accountId,
            trigger: { kind: "schedule", nextRunAt: cursorDueAt },
        });
        await createAssignment(automationId, machineId);

        const result = await inTx(async (tx) => await removeAutomationMachineAssignmentsTx({
            tx,
            accountId,
            machineId,
            markMachineUnavailableTx: async () => {},
        }));

        expect(result).toEqual({
            affectedAutomationIds: [automationId],
            disabledAutomationIds: [automationId],
        });
        await expect(db.automationAssignment.findMany({
            where: { automationId },
        })).resolves.toEqual([]);
        await expect(db.automation.findUnique({
            where: { id: automationId },
            select: { enabled: true },
        })).resolves.toEqual({ enabled: false });
        await expect(db.automationTrigger.findUnique({
            where: { id: triggerId! },
            select: { nextRunAt: true },
        })).resolves.toEqual({ nextRunAt: null });
        await expect(db.accountChange.findUnique({
            where: {
                accountId_kind_entityId: { accountId, kind: "automation", entityId: automationId },
            },
            select: { entityId: true },
        })).resolves.toMatchObject({ entityId: automationId });
    });

    it("preserves Automation enablement, cursor, and remaining assignments when another enabled assignment remains", async () => {
        const accountId = await createAccount();
        const revokedMachineId = await createMachine(accountId);
        const survivingMachineId = await createMachine(accountId);
        const cursorDueAt = new Date("2026-08-29T12:00:00.000Z");
        const { automationId, triggerId } = await seedAutomation({
            accountId,
            trigger: { kind: "schedule", nextRunAt: cursorDueAt },
        });
        await createAssignment(automationId, revokedMachineId);
        await createAssignment(automationId, survivingMachineId);

        const result = await inTx(async (tx) => await removeAutomationMachineAssignmentsTx({
            tx,
            accountId,
            machineId: revokedMachineId,
            markMachineUnavailableTx: async () => {},
        }));

        expect(result).toEqual({
            affectedAutomationIds: [automationId],
            disabledAutomationIds: [],
        });
        await expect(db.automation.findUnique({
            where: { id: automationId },
            select: { enabled: true },
        })).resolves.toEqual({ enabled: true });
        await expect(db.automationTrigger.findUnique({
            where: { id: triggerId! },
            select: { nextRunAt: true },
        })).resolves.toEqual({ nextRunAt: cursorDueAt });
        await expect(db.automationAssignment.findMany({
            where: { automationId },
            select: { machineId: true },
        })).resolves.toEqual([{ machineId: survivingMachineId }]);
    });

    it("advances the Event source catalog revision only when an enabled Event definition loses its last assignment", async () => {
        const accountId = await createAccount();
        const firstMachineId = await createMachine(accountId);
        const secondMachineId = await createMachine(accountId);
        const { automationId } = await seedAutomation({
            accountId,
            trigger: { kind: "pluginEvent" },
        });
        await createAssignment(automationId, firstMachineId);
        await createAssignment(automationId, secondMachineId);

        // One of several: the visible enabled source projection is unchanged,
        // so the canonical catalog revision must not move.
        await inTx(async (tx) => await removeAutomationMachineAssignmentsTx({
            tx,
            accountId,
            machineId: firstMachineId,
            markMachineUnavailableTx: async () => {},
        }));
        await expect(db.automationEventCatalogState.findUnique({
            where: { accountId },
            select: { eventSourceDefinitionsRevision: true },
        })).resolves.toBeNull();

        // Last enabled assignment: the enabled Event definition left the
        // visible projection, so watchers must re-adopt through the revision.
        await inTx(async (tx) => await removeAutomationMachineAssignmentsTx({
            tx,
            accountId,
            machineId: secondMachineId,
            markMachineUnavailableTx: async () => {},
        }));
        await expect(db.automationEventCatalogState.findUnique({
            where: { accountId },
            select: { eventSourceDefinitionsRevision: true },
        })).resolves.toMatchObject({ eventSourceDefinitionsRevision: 1n });
        await expect(db.automation.findUnique({
            where: { id: automationId },
            select: { enabled: true },
        })).resolves.toEqual({ enabled: false });
    });

    it("does not advance the Event catalog when assignment loss disables an Automation with no visible Event trigger", async () => {
        const accountId = await createAccount();
        const machineId = await createMachine(accountId);
        const { automationId, triggerId } = await seedAutomation({
            accountId,
            trigger: { kind: "pluginEvent" },
        });
        await db.automationTrigger.update({
            where: { id: triggerId! },
            data: { enabled: false },
        });
        await createAssignment(automationId, machineId);

        await inTx(async (tx) => await removeAutomationMachineAssignmentsTx({
            tx,
            accountId,
            machineId,
            markMachineUnavailableTx: async () => {},
        }));

        await expect(db.automation.findUnique({
            where: { id: automationId },
            select: { enabled: true },
        })).resolves.toEqual({ enabled: false });
        await expect(db.automationEventCatalogState.findUnique({
            where: { accountId },
        })).resolves.toBeNull();
    });

    it("keeps an already-admitted Run's immutable frozen assignment snapshot without transfer while its machine remains eligible", async () => {
        const accountId = await createAccount();
        const machineId = await createMachine(accountId);
        const { automationId } = await seedAutomation({ accountId });
        await createAssignment(automationId, machineId);

        const admitted = await runAutomationNow({
            accountId,
            automationId,
            idempotencyKey: "machine-removal-frozen-run",
        });
        expect(admitted).toMatchObject({ state: "queued", causeKind: "manual" });

        await inTx(async (tx) => await removeAutomationMachineAssignmentsTx({
            tx,
            accountId,
            machineId,
            markMachineUnavailableTx: async () => {},
        }));

        // Frozen admitted-Run semantics: the snapshot survives definition
        // assignment removal verbatim and is never transferred to another
        // machine. The terminal disposition is approved at the durable
        // permanent-revoke boundary, so while the frozen machine itself is
        // still non-revoked, its assignment keeps the Run untouched.
        await expect(db.automationRunAssignment.findMany({
            where: { runId: admitted!.id },
            select: { machineId: true },
        })).resolves.toEqual([{ machineId }]);
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: admitted!.id },
            select: { state: true, finishedAt: true },
        })).resolves.toMatchObject({ state: "queued", finishedAt: null });
    });

    it("settles a queued Run stranded by revocation of its last frozen machine as cancelled while its snapshot remains", async () => {
        const accountId = await createAccount();
        const machineId = await createMachine(accountId);
        const { automationId } = await seedAutomation({ accountId });
        await createAssignment(automationId, machineId);
        const admitted = await runAutomationNow({
            accountId,
            automationId,
            idempotencyKey: "machine-removal-stranded-queued",
        });
        expect(admitted).toMatchObject({ state: "queued" });

        // The composition acquires the Account fence before invoking the
        // canonical revoke mutation, exactly like the HTTP revoke route.
        await inTx(async (tx) => await removeAutomationMachineAssignmentsTx({
            tx,
            accountId,
            machineId,
            markMachineUnavailableTx: async (fencedTx) => {
                await fencedTx.machine.update({
                    where: { id: machineId },
                    data: { revokedAt: new Date() },
                });
            },
        }));

        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: admitted!.id },
            select: { state: true, finishedAt: true, errorCode: true },
        })).resolves.toMatchObject({
            state: "cancelled",
            finishedAt: expect.any(Date),
            errorCode: null,
        });
        await expect(db.automationRunEvent.findFirstOrThrow({
            where: { runId: admitted!.id, type: "run_cancelled" },
            select: { type: true },
        })).resolves.toMatchObject({ type: "run_cancelled" });
        // The frozen snapshot is never rewritten, transferred, or deleted by
        // the settlement — only the Run's own lifecycle settles.
        await expect(db.automationRunAssignment.findMany({
            where: { runId: admitted!.id },
            select: { machineId: true },
        })).resolves.toEqual([{ machineId }]);
    });

    it("settles a running Run stranded by permanent revocation as outcome-uncertain without inventing dispatch state", async () => {
        const accountId = await createAccount();
        const machineId = await createMachine(accountId);
        await createMachine(accountId);
        const { automationId } = await seedAutomation({ accountId });
        await createAssignment(automationId, machineId);
        const admitted = await runAutomationNow({
            accountId,
            automationId,
            idempotencyKey: "machine-removal-stranded-running",
        });
        await db.automationRun.update({
            where: { id: admitted!.id },
            data: {
                state: "running",
                startedAt: new Date(),
                claimedByMachineId: machineId,
                leaseExpiresAt: new Date(Date.now() + 30_000),
                attempt: 1,
            },
        });

        // The durable revocation writer runs after the Account fence. The
        // strict new-Session recipe keeps no execution dispatch state, and the
        // settlement must stay outcome-uncertain for that target kind too.
        await inTx(async (tx) => await removeAutomationMachineAssignmentsTx({
            tx,
            accountId,
            machineId,
            markMachineUnavailableTx: async (fencedTx) => {
                await fencedTx.machine.update({
                    where: { id: machineId },
                    data: { revokedAt: new Date() },
                });
            },
        }));

        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: admitted!.id },
            select: {
                state: true,
                errorCode: true,
                executionDispatchState: true,
                finishedAt: true,
            },
        })).resolves.toEqual({
            state: "outcome_uncertain",
            errorCode: "execution_run_outcome_unknown",
            executionDispatchState: null,
            finishedAt: expect.any(Date),
        });
        await expect(db.automationRunEvent.findFirstOrThrow({
            where: { runId: admitted!.id, type: "run_outcome_uncertain" },
            orderBy: { ts: "desc" },
            select: { type: true, payload: true },
        })).resolves.toEqual({
            type: "run_outcome_uncertain",
            payload: { reason: "cancelled_while_running" },
        });
    });

    it("leaves a Run whose frozen snapshot keeps one eligible machine when one of several frozen machines is revoked", async () => {
        const accountId = await createAccount();
        const removedMachineId = await createMachine(accountId);
        const survivingMachineId = await createMachine(accountId);
        const { automationId } = await seedAutomation({ accountId });
        await createAssignment(automationId, removedMachineId);
        await createAssignment(automationId, survivingMachineId);
        const admitted = await runAutomationNow({
            accountId,
            automationId,
            idempotencyKey: "machine-removal-one-of-several",
        });
        // Admission froze the complete snapshot of both enabled assignments.
        await expect(db.automationRunAssignment.findMany({
            where: { runId: admitted!.id },
            select: { machineId: true },
        })).resolves.toEqual(expect.arrayContaining([
            { machineId: removedMachineId },
            { machineId: survivingMachineId },
        ]));

        await inTx(async (tx) => await removeAutomationMachineAssignmentsTx({
            tx,
            accountId,
            machineId: removedMachineId,
            markMachineUnavailableTx: async (fencedTx) => {
                await fencedTx.machine.update({
                    where: { id: removedMachineId },
                    data: { revokedAt: new Date() },
                });
            },
        }));

        // One frozen eligible assignment remains permanently valid, so the
        // Run is left alone.
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: admitted!.id },
            select: { state: true, finishedAt: true },
        })).resolves.toMatchObject({ state: "queued", finishedAt: null });
    });

    it("leaves a Run whose other frozen assignment is reversibly replaced when one machine is revoked", async () => {
        const accountId = await createAccount();
        const revokedMachineId = await createMachine(accountId);
        const replacedMachineId = await createMachine(accountId);
        const replacementMachineId = await createMachine(accountId);
        const { automationId } = await seedAutomation({ accountId });
        await createAssignment(automationId, revokedMachineId);
        await createAssignment(automationId, replacedMachineId);
        const admitted = await runAutomationNow({
            accountId,
            automationId,
            idempotencyKey: "machine-removal-reversible-sibling",
        });
        await db.machine.update({
            where: { id: replacedMachineId },
            data: {
                replacedByMachineId: replacementMachineId,
                replacedAt: new Date(),
            },
        });

        await inTx(async (tx) => await removeAutomationMachineAssignmentsTx({
            tx,
            accountId,
            machineId: revokedMachineId,
            markMachineUnavailableTx: async (fencedTx) => {
                await fencedTx.machine.update({
                    where: { id: revokedMachineId },
                    data: { revokedAt: new Date() },
                });
            },
        }));

        // Replacement is reversible. The definition loses only the revoked
        // machine assignment, while the admitted Run retains both frozen rows
        // and stays pending so undo can make the surviving authority usable.
        await expect(db.automationAssignment.findMany({
            where: { automationId },
            select: { machineId: true },
        })).resolves.toEqual([{ machineId: replacedMachineId }]);
        await expect(db.automationRunAssignment.findMany({
            where: { runId: admitted!.id },
            select: { machineId: true },
        })).resolves.toEqual(expect.arrayContaining([
            { machineId: revokedMachineId },
            { machineId: replacedMachineId },
        ]));
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: admitted!.id },
            select: { state: true, finishedAt: true },
        })).resolves.toMatchObject({ state: "queued", finishedAt: null });
    });

    it("does not treat a foreign-Account frozen machine as proof of permanent local machine loss", async () => {
        const accountId = await createAccount();
        const revokedMachineId = await createMachine(accountId);
        const foreignAccountId = await createAccount();
        const foreignMachineId = await createMachine(foreignAccountId);
        const { automationId } = await seedAutomation({ accountId });
        await createAssignment(automationId, revokedMachineId);
        const admitted = await runAutomationNow({
            accountId,
            automationId,
            idempotencyKey: "machine-removal-foreign-snapshot-machine",
        });
        await db.automationRunAssignment.create({
            data: { runId: admitted!.id, machineId: foreignMachineId, priority: 1 },
        });

        await inTx(async (tx) => await removeAutomationMachineAssignmentsTx({
            tx,
            accountId,
            machineId: revokedMachineId,
            markMachineUnavailableTx: async (fencedTx) => {
                await fencedTx.machine.update({
                    where: { id: revokedMachineId },
                    data: { revokedAt: new Date() },
                });
            },
        }));

        // The foreign row is corrupt execution authority for this Account,
        // but it is not evidence that every frozen machine was permanently
        // revoked here. Settlement therefore fails closed.
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: admitted!.id },
            select: { state: true, finishedAt: true },
        })).resolves.toMatchObject({ state: "queued", finishedAt: null });
    });

    it("settles a stranded frozen Run even when no current definition assignment remains", async () => {
        const accountId = await createAccount();
        const machineId = await createMachine(accountId);
        const { automationId } = await seedAutomation({ accountId });
        await createAssignment(automationId, machineId);
        const admitted = await runAutomationNow({
            accountId,
            automationId,
            idempotencyKey: "machine-removal-stranded-without-assignments",
        });
        expect(admitted).toMatchObject({ state: "queued" });

        // A first removal takes the definition assignments while the machine
        // is still eligible, so the frozen Run is untouched.
        await inTx(async (tx) => await removeAutomationMachineAssignmentsTx({
            tx,
            accountId,
            machineId,
            markMachineUnavailableTx: async () => {},
        }));
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: admitted!.id },
            select: { state: true },
        })).resolves.toMatchObject({ state: "queued" });

        // The durable revoke writer then marks the machine under the fence. No current
        // AutomationAssignment row remains, but the frozen snapshot still
        // names it: settlement is independent of definition-assignment
        // presence.
        await inTx(async (tx) => await removeAutomationMachineAssignmentsTx({
            tx,
            accountId,
            machineId,
            markMachineUnavailableTx: async (fencedTx) => {
                await fencedTx.machine.update({
                    where: { id: machineId },
                    data: { revokedAt: new Date() },
                });
            },
        }));

        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: admitted!.id },
            select: { state: true, finishedAt: true, errorCode: true },
        })).resolves.toMatchObject({
            state: "cancelled",
            finishedAt: expect.any(Date),
            errorCode: null,
        });
    });

    it("leaves an already-terminal frozen Run unchanged when its last frozen machine is revoked", async () => {
        const accountId = await createAccount();
        const machineId = await createMachine(accountId);
        const { automationId } = await seedAutomation({ accountId });
        await createAssignment(automationId, machineId);
        const admitted = await runAutomationNow({
            accountId,
            automationId,
            idempotencyKey: "machine-removal-terminal-run",
        });
        await db.automationRun.update({
            where: { id: admitted!.id },
            data: { state: "succeeded", finishedAt: new Date(Date.now() - 1_000) },
        });
        const before = await db.automationRun.findUniqueOrThrow({
            where: { id: admitted!.id },
        });

        await inTx(async (tx) => await removeAutomationMachineAssignmentsTx({
            tx,
            accountId,
            machineId,
            markMachineUnavailableTx: async (fencedTx) => {
                await fencedTx.machine.update({
                    where: { id: machineId },
                    data: { revokedAt: new Date() },
                });
            },
        }));

        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: admitted!.id },
        })).resolves.toEqual(before);
    });

    it("disables an exact-turn definition that lost its last assignment so parent-turn completion admits no Run", async () => {
        const accountId = await createAccount();
        const machineId = await createMachine(accountId);
        const suffix = randomUUID();
        const sourceSessionId = `session-${suffix}`;
        const sourceTurnId = `turn-${suffix}`;
        await db.session.create({
            data: {
                id: sourceSessionId,
                tag: `removal-${suffix}`,
                accountId,
                encryptionMode: "e2ee",
                metadata: "{}",
                latestTurnId: sourceTurnId,
                latestTurnStatus: "completed",
            },
        });
        await db.sessionTurn.create({
            data: {
                sessionId: sourceSessionId,
                turnId: sourceTurnId,
                status: "completed",
                startedAt: 1n,
                updatedAt: 1n,
            },
        });
        const { automationId } = await seedAutomation({
            accountId,
            trigger: {
                kind: "sessionLifecycle",
                sourceSessionId,
                sourceTurnId,
            },
        });
        await createAssignment(automationId, machineId);

        await inTx(async (tx) => await removeAutomationMachineAssignmentsTx({
            tx,
            accountId,
            machineId,
            markMachineUnavailableTx: async () => {},
        }));
        await expect(db.automation.findUnique({
            where: { id: automationId },
            select: { enabled: true },
        })).resolves.toEqual({ enabled: false });

        // Exact-turn settlement rules are preserved: the disabled definition
        // is outside the enabled membership set, so canonical parent-turn
        // settlement admits nothing, creates no Run, and does not roll back
        // or mutate the source terminal truth.
        const results = await inTx(async (tx) => await admitCompletedParentTurnAutomationRunsTx({
            tx,
            accountId,
            sourceSessionId,
            sourceTurnId,
            occurredAt: Date.now(),
        }));
        expect(results).toEqual([]);
        await expect(db.automationRun.count({ where: { automationId } })).resolves.toBe(0);
    });

    it("fails the whole removal closed and typed when the Account encryption fence is unavailable", async () => {
        // e2ee mode without a complete content-key binding is the canonical
        // inconsistent-Account shape the transition fence refuses.
        const binding = createSignedAccountContentBinding();
        const account = await db.account.create({
            data: { publicKey: binding.publicKey, encryptionMode: "e2ee" },
            select: { id: true },
        });
        const accountId = account.id;
        const machineId = await createMachine(accountId);
        const { automationId } = await seedAutomation({ accountId });
        await createAssignment(automationId, machineId);
        // Admission itself is fence-gated, so this regression seeds the frozen
        // snapshot directly; the composition reads only persisted bytes.
        const strandedRun = await db.automationRun.create({
            data: {
                automationId,
                accountId,
                state: "queued",
                causeKind: "manual",
                causeOccurredAt: new Date(),
                scheduledAt: new Date(),
                dueAt: new Date(),
                executionInputEnvelope: storedRecipe(1),
            },
            select: { id: true },
        });
        await db.automationRunAssignment.create({
            data: { runId: strandedRun.id, machineId, priority: 0 },
        });

        // The canonical callers give the machine mutation to the composition.
        // The typed fence failure must prevent that mutation and every later
        // write instead of committing a half-transition that would permanently
        // strand the settlement.
        await expect(inTx(async (tx) => {
            await removeAutomationMachineAssignmentsTx({
                tx,
                accountId,
                machineId,
                markMachineUnavailableTx: async (fencedTx) => {
                    await fencedTx.machine.update({
                        where: { id: machineId },
                        data: { revokedAt: new Date() },
                    });
                },
            });
        })).rejects.toBeInstanceOf(AutomationMachineAssignmentRemovalFenceUnavailableError);

        // Nothing committed: the machine marking rolled back, the definition
        // assignment remains, and the stranded Run stays queued for the
        // retried, consistent revoke to settle.
        await expect(db.machine.findUniqueOrThrow({
            where: { id: machineId },
            select: { revokedAt: true },
        })).resolves.toEqual({ revokedAt: null });
        await expect(db.automationAssignment.count({
            where: { automationId, machineId },
        })).resolves.toBe(1);
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: strandedRun.id },
            select: { state: true, finishedAt: true },
        })).resolves.toMatchObject({ state: "queued", finishedAt: null });
    });

    it("is a no-op for a machine without definition assignments", async () => {
        const accountId = await createAccount();
        const machineId = await createMachine(accountId);
        await seedAutomation({ accountId });

        const result = await inTx(async (tx) => await removeAutomationMachineAssignmentsTx({
            tx,
            accountId,
            machineId,
            markMachineUnavailableTx: async () => {},
        }));

        expect(result).toEqual({ affectedAutomationIds: [], disabledAutomationIds: [] });
        await expect(db.accountChange.findMany({
            where: { accountId, kind: "automation" },
        })).resolves.toEqual([]);
    });
});
