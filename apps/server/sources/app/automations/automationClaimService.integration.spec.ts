import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
    deriveSessionCreationTagV1,
    serializeAutomationRunExecutionRecipeV1,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { claimAutomationRun, heartbeatAutomationRun } from "./automationClaimService";
import { listDaemonAssignments } from "./automationAssignmentService";
import {
    automationAccountCurrentnessSelect,
    deriveAutomationAccountCurrentnessWitness,
} from "./automationAccountCurrentness";
import {
    deleteAutomation,
    setAutomationEnabled,
    updateAutomation,
} from "./automationCrudService";
import {
    failAutomationRun,
    startAutomationRun,
    startAutomationRunFromV2,
    succeedAutomationRun,
    succeedAutomationRunFromV2,
} from "./automationRunService";

const TEST_TEMPLATE_ENVELOPE = JSON.stringify({
    kind: "happier_automation_template_encrypted_v1",
    payloadCiphertext: "ciphertext-base64",
});

function strictE2eeRecipeForAssignments(assignmentMachineIds: readonly string[]): string {
    const serialized = serializeAutomationRunExecutionRecipeV1({
        v: 1,
        templateVersion: 1,
        assignmentMachineIds: [...assignmentMachineIds],
        template: { t: "encrypted", c: "test-frozen-template" },
        triggerEvidence: null,
        target: {
            kind: "newSession",
            spawn: {
                executionTarget: { serverId: "server", machineId: "machine" },
                directory: "/tmp/automation-claim-test",
                agentTarget: {
                    kind: "agent",
                    identity: { pluginId: "happier.agent.codex", localId: "codex" },
                },
            },
        },
    });
    if (serialized.kind !== "available") {
        throw new Error("Failed to construct strict Automation Run test recipe");
    }
    return serialized.serialized;
}

function strictPlainRecipeForAssignments(assignmentMachineIds: readonly string[]): string {
    const serialized = serializeAutomationRunExecutionRecipeV1({
        v: 1,
        templateVersion: 1,
        assignmentMachineIds: [...assignmentMachineIds],
        template: { t: "plain", v: { v: 1, prompt: "Run the frozen task." } },
        triggerEvidence: null,
        target: {
            kind: "newSession",
            spawn: {
                executionTarget: { serverId: "server", machineId: "machine" },
                directory: "/tmp/automation-claim-test",
                agentTarget: {
                    kind: "agent",
                    identity: { pluginId: "happier.agent.codex", localId: "codex" },
                },
            },
        },
    });
    if (serialized.kind !== "available") {
        throw new Error("Failed to construct strict plain Automation Run test recipe");
    }
    return serialized.serialized;
}

function strictPlainExecutionRecipeForAssignments(assignmentMachineIds: readonly string[]): string {
    const serialized = serializeAutomationRunExecutionRecipeV1({
        v: 1,
        templateVersion: 1,
        assignmentMachineIds: [...assignmentMachineIds],
        template: { t: "plain", v: { v: 1, prompt: "Run the detached task." } },
        triggerEvidence: null,
        target: {
            kind: "executionRun",
            request: {
                intent: "task",
                backendTarget: { kind: "builtInAgent", agentId: "codex" },
                permissionMode: "read_only",
                retentionPolicy: "ephemeral",
                runClass: "bounded",
                ioMode: "request_response",
            },
        },
    });
    if (serialized.kind !== "available") {
        throw new Error("Failed to construct strict detached Automation Run test recipe");
    }
    return serialized.serialized;
}

const TEST_STRICT_PLAIN_EXECUTION_RECIPE = strictPlainExecutionRecipeForAssignments([]);

async function createAccountWithMachine(
    machineId: string,
    encryptionMode: "plain" | "e2ee" = "e2ee",
): Promise<{ accountId: string }> {
    const account = await db.account.create({
        data: {
            ...createSignedAccountContentBinding(),
            encryptionMode,
        },
        select: { id: true },
    });
    await db.machine.create({
        data: {
            id: machineId,
            accountId: account.id,
            metadata: "{}",
        },
    });
    return { accountId: account.id };
}

async function createAutomationWithAssignments(params: {
    accountId: string;
    machineIds: string[];
    name: string;
}) {
    const automation = await db.automation.create({
        data: {
            accountId: params.accountId,
            name: params.name,
            enabled: true,
            targetType: "new_session",
            templateCiphertext: TEST_TEMPLATE_ENVELOPE,
            templateVersion: 1,
            triggers: {
                create: {
                    kind: "schedule",
                    scheduleKind: "interval",
                    everyMs: 60_000,
                },
            },
            assignments: {
                create: params.machineIds.map((machineId) => ({
                    machineId,
                    enabled: true,
                    priority: 0,
                })),
            },
        },
        select: { id: true, triggers: { select: { id: true } } },
    });
    return { id: automation.id, triggerId: automation.triggers[0]!.id };
}

function scheduleRunCause(triggerId: string) {
    const occurredAt = new Date();
    return {
        triggerId,
        causeKind: "trigger" as const,
        causeTriggerKind: "schedule" as const,
        causeTriggerRevision: 0,
        causeOccurredAt: occurredAt,
        causeScheduledFor: occurredAt,
        occurrenceKey: createHash("sha256")
            .update(`test-schedule:${randomUUID()}`, "utf8")
            .digest("base64url"),
    };
}

function frozenRunAssignments(machineIds: readonly string[]) {
    return {
        create: machineIds.map((machineId) => ({ machineId, priority: 0 })),
    };
}

describe("automationClaimService (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-automation-claim-service-" });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.automationWorkerClaimReceipt.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.session.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function createLeasedRetirementRun(params: Readonly<{
        machineId: string;
        name: string;
        state: "claimed" | "running";
        leaseExpiresAt: Date;
    }>) {
        const { accountId } = await createAccountWithMachine(params.machineId);
        const automation = await createAutomationWithAssignments({
            accountId,
            machineIds: [params.machineId],
            name: params.name,
        });
        const now = Date.now();
        const run = await db.automationRun.create({
            data: {
                automationId: automation.id,
                ...scheduleRunCause(automation.triggerId),
                accountId,
                state: params.state,
                scheduledAt: new Date(now - 60_000),
                dueAt: new Date(now - 50_000),
                claimedAt: new Date(now - 40_000),
                ...(params.state === "running" ? { startedAt: new Date(now - 30_000) } : {}),
                claimedByMachineId: params.machineId,
                leaseExpiresAt: params.leaseExpiresAt,
                attempt: 1,
                executionInputEnvelope: strictE2eeRecipeForAssignments([params.machineId]),
                assignments: {
                    create: [{ machineId: params.machineId, priority: 0 }],
                },
            },
            select: { id: true },
        });
        return { accountId, automationId: automation.id, runId: run.id };
    }

    it("fails closed before claiming or extending Runs for an inconsistent E2EE Account", async () => {
        const binding = createSignedAccountContentBinding();
        const account = await db.account.create({
            data: {
                publicKey: binding.publicKey,
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-inconsistent-account",
                accountId: account.id,
                metadata: "{}",
            },
        });
        const automation = await createAutomationWithAssignments({
            accountId: account.id,
            machineIds: ["machine-inconsistent-account"],
            name: "Inconsistent Account claim fence",
        });
        const queued = await db.automationRun.create({
            data: {
                automationId: automation.id,
                ...scheduleRunCause(automation.triggerId),
                accountId: account.id,
                state: "queued",
                scheduledAt: new Date(Date.now() - 30_000),
                dueAt: new Date(Date.now() - 20_000),
                executionInputEnvelope: JSON.stringify({
                    t: "encrypted",
                    c: "private-queued-run-sentinel",
                }),
                assignments: frozenRunAssignments(["machine-inconsistent-account"]),
            },
            select: { id: true },
        });
        const active = await db.automationRun.create({
            data: {
                automationId: automation.id,
                ...scheduleRunCause(automation.triggerId),
                accountId: account.id,
                state: "claimed",
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 50_000),
                claimedAt: new Date(Date.now() - 40_000),
                claimedByMachineId: "machine-inconsistent-account",
                leaseExpiresAt: new Date(Date.now() + 30_000),
                attempt: 1,
                executionInputEnvelope: JSON.stringify({
                    t: "encrypted",
                    c: "private-active-run-sentinel",
                }),
                assignments: frozenRunAssignments(["machine-inconsistent-account"]),
            },
            select: { id: true },
        });
        const before = await db.automationRun.findMany({
            where: { id: { in: [queued.id, active.id] } },
            orderBy: { id: "asc" },
            select: {
                id: true,
                state: true,
                claimedByMachineId: true,
                leaseExpiresAt: true,
                attempt: true,
                revision: true,
            },
        });

        const claim = await claimAutomationRun({
            accountId: account.id,
            machineId: "machine-inconsistent-account",
            leaseDurationMs: 30_000,
        });
        const heartbeat = await heartbeatAutomationRun({
            accountId: account.id,
            runId: active.id,
            machineId: "machine-inconsistent-account",
            attempt: 1,
            leaseDurationMs: 30_000,
        });
        const after = await db.automationRun.findMany({
            where: { id: { in: [queued.id, active.id] } },
            orderBy: { id: "asc" },
            select: {
                id: true,
                state: true,
                claimedByMachineId: true,
                leaseExpiresAt: true,
                attempt: true,
                revision: true,
            },
        });

        expect(claim).toEqual({ run: null, accountCurrentness: null });
        expect(heartbeat).toEqual({ ok: false, leaseExpiresAt: null });
        expect(after).toEqual(before);
    });

    it("terminalizes a stable malformed frozen recipe before granting a provider-effect lease", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-invalid-frozen-recipe",
                accountId: account.id,
                metadata: "{}",
            },
        });
        const automation = await createAutomationWithAssignments({
            accountId: account.id,
            machineIds: ["machine-invalid-frozen-recipe"],
            name: "Invalid frozen recipe",
        });
        const run = await db.automationRun.create({
            data: {
                automationId: automation.id,
                ...scheduleRunCause(automation.triggerId),
                accountId: account.id,
                state: "queued",
                scheduledAt: new Date(Date.now() - 30_000),
                dueAt: new Date(Date.now() - 20_000),
                // This is neither the strict current recipe nor the retained V2
                // recipe. It must not become a worker lease merely because it is due.
                executionInputEnvelope: JSON.stringify({ v: 1 }),
                assignments: frozenRunAssignments(["machine-invalid-frozen-recipe"]),
            },
            select: { id: true },
        });

        // Admission already froze this Run. Definition state is future-facing
        // and must not prevent the canonical lease-recovery owner from
        // recording the invalid frozen-input outcome.
        await db.automation.update({
            where: { id: automation.id },
            data: { enabled: false },
        });

        await expect(claimAutomationRun({
            accountId: account.id,
            machineId: "machine-invalid-frozen-recipe",
            leaseDurationMs: 30_000,
        })).resolves.toEqual({ run: null, accountCurrentness: null });

        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: run.id },
            select: {
                state: true,
                errorCode: true,
                claimedByMachineId: true,
                leaseExpiresAt: true,
                attempt: true,
            },
        })).resolves.toEqual({
            state: "failed",
            errorCode: "invalid_template",
            claimedByMachineId: null,
            leaseExpiresAt: null,
            attempt: 0,
        });
        await expect(db.automationRunEvent.findMany({
            where: { runId: run.id },
            select: { type: true },
        })).resolves.toEqual([{ type: "run_failed" }]);
        await expect(db.automationRun.count({
            where: { automationId: automation.id },
        })).resolves.toBe(1);
    });

    it("allows only one machine to claim a queued run", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        await db.machine.createMany({
            data: [
                { id: "machine-1", accountId: account.id, metadata: "{}" },
                { id: "machine-2", accountId: account.id, metadata: "{}" },
            ],
        });
        const automation = await createAutomationWithAssignments({
            accountId: account.id,
            machineIds: ["machine-1", "machine-2"],
            name: "Race automation",
        });
        const run = await db.automationRun.create({
            data: {
                automationId: automation.id,
                ...scheduleRunCause(automation.triggerId),
                accountId: account.id,
                state: "queued",
                scheduledAt: new Date(Date.now() - 30_000),
                dueAt: new Date(Date.now() - 20_000),
                executionInputEnvelope: strictE2eeRecipeForAssignments(["machine-1", "machine-2"]),
                assignments: frozenRunAssignments(["machine-1", "machine-2"]),
            },
            select: { id: true },
        });
        const [claimOne, claimTwo] = await Promise.all([
            claimAutomationRun({
                accountId: account.id,
                machineId: "machine-1",
                leaseDurationMs: 30_000,
            }),
            claimAutomationRun({
                accountId: account.id,
                machineId: "machine-2",
                leaseDurationMs: 30_000,
            }),
        ]);

        const nonNullClaims = [claimOne, claimTwo].filter((entry) => !!entry.run);
        expect(nonNullClaims).toHaveLength(1);
        const accountAfterClaim = await db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: automationAccountCurrentnessSelect,
        });
        expect(nonNullClaims[0]?.accountCurrentness).toEqual(
            deriveAutomationAccountCurrentnessWitness(accountAfterClaim),
        );

        const claimed = await db.automationRun.findUnique({
            where: { id: run.id },
            select: {
                state: true,
                claimedByMachineId: true,
                attempt: true,
            },
        });
        expect(claimed).toEqual(
            expect.objectContaining({
                state: "claimed",
                attempt: 1,
            }),
        );
        expect(["machine-1", "machine-2"]).toContain(claimed?.claimedByMachineId ?? "");
    });

    it("converges concurrent and response-loss retries of one signed V3 claim onto one Run", async () => {
        const machineId = "machine-idempotent-claim";
        const machineInstallationId = "installation-idempotent-claim";
        const { accountId } = await createAccountWithMachine(machineId);
        await db.machine.update({
            where: { id: machineId },
            data: { installationId: machineInstallationId },
        });
        const automation = await createAutomationWithAssignments({
            accountId,
            machineIds: [machineId],
            name: "Idempotent claim",
        });
        const createQueuedRun = async () => await db.automationRun.create({
            data: {
                automationId: automation.id,
                ...scheduleRunCause(automation.triggerId),
                accountId,
                state: "queued",
                scheduledAt: new Date(Date.now() - 30_000),
                dueAt: new Date(Date.now() - 20_000),
                executionInputEnvelope: strictE2eeRecipeForAssignments([machineId]),
                assignments: frozenRunAssignments([machineId]),
            },
            select: { id: true },
        });
        const [firstRun, secondRun] = await Promise.all([
            createQueuedRun(),
            createQueuedRun(),
        ]);
        const claimRequest = {
            machineInstallationId,
            nonce: "signed-claim-nonce-1",
            expiresAt: new Date(Date.now() + 300_000),
        };

        const [first, concurrentReplay] = await Promise.all([
            claimAutomationRun({
                accountId,
                machineId,
                leaseDurationMs: 30_000,
                claimRequest,
            }),
            claimAutomationRun({
                accountId,
                machineId,
                leaseDurationMs: 30_000,
                claimRequest,
            }),
        ]);
        const claimedBeforeReplay = await db.automationRun.findUnique({
            where: { id: first.run!.id },
            select: { attempt: true, revision: true, leaseExpiresAt: true },
        });
        const responseLossReplay = await claimAutomationRun({
            accountId,
            machineId,
            leaseDurationMs: 30_000,
            claimRequest,
        });

        expect(first.run?.id).toBeTruthy();
        expect(concurrentReplay).toEqual(first);
        // The replay rejoins the original claim decision without any new
        // effect: same Run, same attempt, untouched lease/revision.
        expect(responseLossReplay.run).toMatchObject({
            id: first.run!.id,
            attempt: claimedBeforeReplay!.attempt,
        });
        await db.automationRun.update({
            where: { id: first.run!.id },
            data: {
                state: "running",
                startedAt: new Date(),
                revision: { increment: 1 },
            },
        });
        // The signed nonce identifies the already-committed claim response,
        // not a later read of the mutable Run. Advancing the same attempt must
        // therefore leave replay byte-for-byte equivalent to the first result.
        await expect(claimAutomationRun({
            accountId,
            machineId,
            leaseDurationMs: 30_000,
            claimRequest,
        })).resolves.toEqual(first);
        await expect(db.automationRun.findUnique({
            where: { id: first.run!.id },
            select: { attempt: true, revision: true, leaseExpiresAt: true },
        })).resolves.toEqual({
            ...claimedBeforeReplay,
            revision: claimedBeforeReplay!.revision + 1,
        });
        expect([firstRun.id, secondRun.id]).toContain(first.run?.id);
        await expect(db.automationRun.count({
            where: { id: { in: [firstRun.id, secondRun.id] }, state: { in: ["claimed", "running"] } },
        })).resolves.toBe(1);
        await expect(db.automationWorkerClaimReceipt.count({
            where: { accountId, machineId },
        })).resolves.toBe(1);
    });

    it("replays an empty signed V3 claim without claiming work that appeared later", async () => {
        const machineId = "machine-empty-claim";
        const machineInstallationId = "installation-empty-claim";
        const { accountId } = await createAccountWithMachine(machineId);
        await db.machine.update({
            where: { id: machineId },
            data: { installationId: machineInstallationId },
        });
        const claimRequest = {
            machineInstallationId,
            nonce: "signed-empty-claim-nonce-1",
            expiresAt: new Date(Date.now() + 300_000),
        };
        await expect(claimAutomationRun({
            accountId,
            machineId,
            leaseDurationMs: 30_000,
            claimRequest,
        })).resolves.toEqual({ run: null, accountCurrentness: null });

        const automation = await createAutomationWithAssignments({
            accountId,
            machineIds: [machineId],
            name: "Work after empty claim",
        });
        const queued = await db.automationRun.create({
            data: {
                automationId: automation.id,
                ...scheduleRunCause(automation.triggerId),
                accountId,
                state: "queued",
                scheduledAt: new Date(Date.now() - 30_000),
                dueAt: new Date(Date.now() - 20_000),
                executionInputEnvelope: strictE2eeRecipeForAssignments([machineId]),
                assignments: frozenRunAssignments([machineId]),
            },
            select: { id: true },
        });

        // The empty outcome is the signed request's durable result. Reusing
        // that proof can never claim a different Run that appeared later.
        const rescanReplay = await claimAutomationRun({
            accountId,
            machineId,
            leaseDurationMs: 30_000,
            claimRequest,
        });
        expect(rescanReplay).toEqual({ run: null, accountCurrentness: null });
        await expect(db.automationRun.findUnique({
            where: { id: queued.id },
            select: { state: true, attempt: true },
        })).resolves.toEqual({
            state: "queued",
            attempt: 0,
        });
        const freshClaim = await claimAutomationRun({
            accountId,
            machineId,
            leaseDurationMs: 30_000,
            claimRequest: {
                ...claimRequest,
                nonce: "signed-empty-claim-nonce-2",
            },
        });
        expect(freshClaim.run).toMatchObject({ id: queued.id, attempt: 1 });
        await expect(db.automationRun.findUnique({
            where: { id: queued.id },
            select: { state: true, attempt: true },
        })).resolves.toMatchObject({
            state: "claimed",
            attempt: 1,
        });
        await expect(claimAutomationRun({
            accountId,
            machineId,
            leaseDurationMs: 30_000,
            claimRequest,
        })).resolves.toEqual({ run: null, accountCurrentness: null });
    });

    it.each(["plain", "e2ee"] as const)(
        "replays a claimed V3 receipt with its committed post-claim %s witness exactly",
        async (encryptionMode) => {
        const machineId = `machine-witness-replay-${encryptionMode}`;
        const machineInstallationId = `installation-witness-replay-${encryptionMode}`;
        const { accountId } = await createAccountWithMachine(machineId, encryptionMode);
        await db.machine.update({
            where: { id: machineId },
            data: { installationId: machineInstallationId },
        });
        const automation = await createAutomationWithAssignments({
            accountId,
            machineIds: [machineId],
            name: "Committed claim witness replay",
        });
        await db.automationRun.create({
            data: {
                automationId: automation.id,
                ...scheduleRunCause(automation.triggerId),
                accountId,
                state: "queued",
                scheduledAt: new Date(Date.now() - 30_000),
                dueAt: new Date(Date.now() - 20_000),
                executionInputEnvelope: encryptionMode === "e2ee"
                    ? strictE2eeRecipeForAssignments([machineId])
                    : strictPlainRecipeForAssignments([machineId]),
                assignments: frozenRunAssignments([machineId]),
            },
            select: { id: true },
        });
        const claimRequest = {
            machineInstallationId,
            nonce: "signed-witness-replay-nonce-1",
            expiresAt: new Date(Date.now() + 300_000),
        };
        const first = await claimAutomationRun({
            accountId,
            machineId,
            leaseDurationMs: 30_000,
            claimRequest,
        });
        expect(first.run).toBeTruthy();
        expect(first.accountCurrentness).toBeTruthy();

        // An unrelated Account write advances the global change sequence after
        // the claim committed. The retried request must still receive the exact
        // committed post-claim witness, never a freshly minted one.
        await db.account.update({ where: { id: accountId }, data: { seq: { increment: 1 } } });

        await expect(claimAutomationRun({
            accountId,
            machineId,
            leaseDurationMs: 30_000,
            claimRequest,
        })).resolves.toEqual(first);
    });

    it("claims a released-V2 run queued behind current strict-recipe runs", async () => {
        const machineId = "machine-v2-discriminator";
        const { accountId } = await createAccountWithMachine(machineId);
        const automation = await createAutomationWithAssignments({
            accountId,
            machineIds: [machineId],
            name: "V2 claim discriminator",
        });
        const createQueuedRun = async (params: Readonly<{
            dueAt: Date;
            executionInputEnvelope: string;
        }>) => await db.automationRun.create({
            data: {
                automationId: automation.id,
                ...scheduleRunCause(automation.triggerId),
                accountId,
                state: "queued",
                scheduledAt: new Date(params.dueAt.getTime() - 10_000),
                dueAt: params.dueAt,
                executionInputEnvelope: params.executionInputEnvelope,
                assignments: frozenRunAssignments([machineId]),
            },
            select: { id: true },
        });
        const dueBase = Date.now() - 120_000;
        const strictRunIds: string[] = [];
        for (let index = 0; index < 30; index += 1) {
            const run = await createQueuedRun({
                dueAt: new Date(dueBase + index * 1_000),
                executionInputEnvelope: strictE2eeRecipeForAssignments([machineId]),
            });
            strictRunIds.push(run.id);
        }
        const retainedV2Run = await createQueuedRun({
            dueAt: new Date(dueBase + 60_000),
            executionInputEnvelope: JSON.stringify({
                kind: "happier_automation_run_execution_input_v1",
                targetType: "new_session",
                templateVersion: 1,
                templateCiphertext: TEST_TEMPLATE_ENVELOPE,
                origin: { kind: "scheduled", scheduledFor: dueBase + 60_000 },
            }),
        });

        const claimed = await claimAutomationRun({
            accountId,
            machineId,
            leaseDurationMs: 30_000,
            requireV2RunRepresentability: true,
        });
        expect(claimed.run?.id).toBe(retainedV2Run.id);
        await expect(db.automationRun.findMany({
            where: { id: { in: strictRunIds }, state: "claimed" },
            select: { id: true },
        })).resolves.toEqual([]);
    });

    it("does not replay a newer lease attempt under an older signed V3 claim nonce", async () => {
        const machineId = "machine-claim-attempt-replay";
        const machineInstallationId = "installation-claim-attempt-replay";
        const { accountId } = await createAccountWithMachine(machineId);
        await db.machine.update({
            where: { id: machineId },
            data: { installationId: machineInstallationId },
        });
        const automation = await createAutomationWithAssignments({
            accountId,
            machineIds: [machineId],
            name: "Claim attempt replay fence",
        });
        const queued = await db.automationRun.create({
            data: {
                automationId: automation.id,
                ...scheduleRunCause(automation.triggerId),
                accountId,
                state: "queued",
                scheduledAt: new Date(Date.now() - 30_000),
                dueAt: new Date(Date.now() - 20_000),
                executionInputEnvelope: strictE2eeRecipeForAssignments([machineId]),
                assignments: frozenRunAssignments([machineId]),
            },
            select: { id: true },
        });
        const originalClaimRequest = {
            machineInstallationId,
            nonce: "signed-claim-attempt-nonce-1",
            expiresAt: new Date(Date.now() + 300_000),
        };
        const original = await claimAutomationRun({
            accountId,
            machineId,
            leaseDurationMs: 30_000,
            claimRequest: originalClaimRequest,
        });
        expect(original.run).toEqual(expect.objectContaining({ id: queued.id, attempt: 1 }));

        await db.automationRun.update({
            where: { id: queued.id },
            data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
        });
        const reclaimed = await claimAutomationRun({
            accountId,
            machineId,
            leaseDurationMs: 30_000,
            claimRequest: {
                ...originalClaimRequest,
                nonce: "signed-claim-attempt-nonce-2",
            },
        });
        expect(reclaimed.run).toEqual(expect.objectContaining({ id: queued.id, attempt: 2 }));

        await expect(claimAutomationRun({
            accountId,
            machineId,
            leaseDurationMs: 30_000,
            claimRequest: originalClaimRequest,
        })).resolves.toEqual({ run: null, accountCurrentness: null });
    });

    it.each([
        ["revoked", { revokedAt: new Date("2026-08-27T00:00:00.000Z") }],
        ["replaced", { replacedByMachineId: "machine-current-replacement" }],
    ] as const)("does not grant a claim to a %s machine", async (_state, machineUpdate) => {
        const machineId = `machine-${_state}-claim`;
        const { accountId } = await createAccountWithMachine(machineId);
        const automation = await createAutomationWithAssignments({
            accountId,
            machineIds: [machineId],
            name: `${_state} machine claim`,
        });
        const run = await db.automationRun.create({
            data: {
                automationId: automation.id,
                ...scheduleRunCause(automation.triggerId),
                accountId,
                state: "queued",
                scheduledAt: new Date(Date.now() - 30_000),
                dueAt: new Date(Date.now() - 20_000),
                executionInputEnvelope: strictE2eeRecipeForAssignments([machineId]),
                assignments: frozenRunAssignments([machineId]),
            },
            select: { id: true },
        });
        await db.machine.update({
            where: { id: machineId },
            data: machineUpdate,
        });

        await expect(claimAutomationRun({
            accountId,
            machineId,
            leaseDurationMs: 30_000,
        })).resolves.toEqual({ run: null, accountCurrentness: null });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: run.id },
            select: { state: true, claimedByMachineId: true, attempt: true },
        })).resolves.toEqual({
            state: "queued",
            claimedByMachineId: null,
            attempt: 0,
        });
    });

    it("does not let a second machine reclaim a lease kept healthy by heartbeat", async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
            const account = await db.account.create({
                data: { encryptionMode: "plain" },
                select: { id: true },
            });
            await db.machine.createMany({
                data: [
                    { id: "machine-heartbeat-1", accountId: account.id, metadata: "{}" },
                    { id: "machine-heartbeat-2", accountId: account.id, metadata: "{}" },
                ],
            });
            const automation = await createAutomationWithAssignments({
                accountId: account.id,
                machineIds: ["machine-heartbeat-1", "machine-heartbeat-2"],
                name: "Heartbeat lease automation",
            });
            const run = await db.automationRun.create({
                data: {
                    automationId: automation.id,
                    ...scheduleRunCause(automation.triggerId),
                    accountId: account.id,
                    state: "queued",
                    scheduledAt: new Date(Date.now() - 2_000),
                    dueAt: new Date(Date.now() - 1_000),
                    executionInputEnvelope: strictPlainExecutionRecipeForAssignments([
                        "machine-heartbeat-1",
                        "machine-heartbeat-2",
                    ]),
                    executionDispatchState: "notStarted",
                    assignments: frozenRunAssignments(["machine-heartbeat-1", "machine-heartbeat-2"]),
                },
                select: { id: true },
            });
            const claim = await claimAutomationRun({
                accountId: account.id,
                machineId: "machine-heartbeat-1",
                leaseDurationMs: 5_000,
            });
            expect(claim.run).toEqual(expect.objectContaining({ id: run.id, attempt: 1 }));

            vi.setSystemTime(new Date(Date.now() + 2_500));
            await expect(heartbeatAutomationRun({
                accountId: account.id,
                runId: run.id,
                machineId: "machine-heartbeat-1",
                attempt: 1,
                leaseDurationMs: 5_000,
            })).resolves.toEqual({
                ok: true,
                leaseExpiresAt: new Date(Date.now() + 5_000),
            });

            vi.setSystemTime(new Date(Date.now() + 2_501));
            await expect(claimAutomationRun({
                accountId: account.id,
                machineId: "machine-heartbeat-2",
                leaseDurationMs: 5_000,
            })).resolves.toEqual({ run: null, accountCurrentness: null });
        } finally {
            vi.useRealTimers();
        }
    });

    it("requires the exact claim witness at start and Account content identity at settlement", async () => {
        const { accountId } = await createAccountWithMachine("machine-currentness");
        const automation = await createAutomationWithAssignments({
            accountId,
            machineIds: ["machine-currentness"],
            name: "Currentness witness automation",
        });
        const staleRun = await db.automationRun.create({
            data: {
                automationId: automation.id,
                ...scheduleRunCause(automation.triggerId),
                accountId,
                state: "queued",
                scheduledAt: new Date(Date.now() - 30_000),
                dueAt: new Date(Date.now() - 20_000),
                executionInputEnvelope: strictE2eeRecipeForAssignments(["machine-currentness"]),
                assignments: frozenRunAssignments(["machine-currentness"]),
            },
            select: { id: true },
        });
        const staleClaim = await claimAutomationRun({
            accountId,
            machineId: "machine-currentness",
            leaseDurationMs: 30_000,
        });
        expect(staleClaim.accountCurrentness).not.toBeNull();
        expect(staleClaim.run?.id).toBe(staleRun.id);

        await db.account.update({
            where: { id: accountId },
            data: { seq: { increment: 1 } },
        });
        await expect(startAutomationRun({
            accountId,
            runId: staleRun.id,
            machineId: "machine-currentness",
            attempt: staleClaim.run!.attempt,
            accountCurrentness: staleClaim.accountCurrentness!,
        })).resolves.toBeNull();
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: staleRun.id },
            select: { state: true },
        })).resolves.toEqual({ state: "claimed" });

        const run = await db.automationRun.create({
            data: {
                automationId: automation.id,
                ...scheduleRunCause(automation.triggerId),
                accountId,
                state: "queued",
                scheduledAt: new Date(Date.now() - 10_000),
                dueAt: new Date(Date.now() - 5_000),
                executionInputEnvelope: strictE2eeRecipeForAssignments(["machine-currentness"]),
                assignments: frozenRunAssignments(["machine-currentness"]),
            },
            select: { id: true },
        });
        const claim = await claimAutomationRun({
            accountId,
            machineId: "machine-currentness",
            leaseDurationMs: 30_000,
        });
        expect(claim.run?.id).toBe(run.id);
        const started = await startAutomationRun({
            accountId,
            runId: run.id,
            machineId: "machine-currentness",
            attempt: claim.run!.attempt,
            accountCurrentness: claim.accountCurrentness!,
        });
        expect(started?.run.state).toBe("running");
        expect(started?.accountCurrentness).not.toEqual(claim.accountCurrentness);

        // Post-effect settlement compares Account content identity (mode and
        // content key) rather than the exact sequence: the start publication
        // and the target effect it authorizes legitimately advance Account.seq
        // past S, so the server can no longer distinguish a content-identical
        // pre-start echo from the post-start echo. An encryption transition is
        // still refused.
        await expect(failAutomationRun({
            accountId,
            runId: run.id,
            machineId: "machine-currentness",
            attempt: claim.run!.attempt,
            accountCurrentness: {
                ...started!.accountCurrentness,
                mode: "plain" as const,
                contentKeyFingerprint: null,
            },
            errorCode: "stale_currentness",
        })).resolves.toBeNull();
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: run.id },
            select: { state: true },
        })).resolves.toEqual({ state: "running" });

        await expect(failAutomationRun({
            accountId,
            runId: run.id,
            machineId: "machine-currentness",
            attempt: claim.run!.attempt,
            accountCurrentness: started!.accountCurrentness,
            errorCode: "worker_crashed",
        })).resolves.toEqual(expect.objectContaining({ id: run.id, state: "failed" }));
    });

    it("reclaims a run when the previous lease expired", async () => {
        const { accountId } = await createAccountWithMachine("machine-1");
        await db.machine.create({
            data: {
                id: "machine-2",
                accountId,
                metadata: "{}",
            },
        });

        const automation = await createAutomationWithAssignments({
            accountId,
            machineIds: ["machine-1", "machine-2"],
            name: "Expired lease automation",
        });
        const run = await db.automationRun.create({
            data: {
                automationId: automation.id,
                ...scheduleRunCause(automation.triggerId),
                accountId,
                state: "claimed",
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 50_000),
                claimedAt: new Date(Date.now() - 40_000),
                claimedByMachineId: "machine-1",
                leaseExpiresAt: new Date(Date.now() - 1_000),
                attempt: 1,
                executionInputEnvelope: strictE2eeRecipeForAssignments(["machine-1", "machine-2"]),
                assignments: frozenRunAssignments(["machine-1", "machine-2"]),
            },
            select: { id: true },
        });

        const claim = await claimAutomationRun({
            accountId,
            machineId: "machine-2",
            leaseDurationMs: 30_000,
        });

        expect(claim.run?.id).toBe(run.id);
        expect(claim.run?.claimedByMachineId).toBe("machine-2");

        const updated = await db.automationRun.findUnique({
            where: { id: run.id },
            select: {
                claimedByMachineId: true,
                attempt: true,
                state: true,
            },
        });
        expect(updated).toEqual(
            expect.objectContaining({
                state: "claimed",
                claimedByMachineId: "machine-2",
                attempt: 2,
            }),
        );
    });

    it("preserves released V2 expired-lease reclaim when the worker omits the attempt token", async () => {
        const { accountId } = await createAccountWithMachine("machine-1");
        const automation = await createAutomationWithAssignments({
            accountId,
            machineIds: ["machine-1"],
            name: "Released V2 attempt fence automation",
        });
        const run = await db.automationRun.create({
            data: {
                automationId: automation.id,
                ...scheduleRunCause(automation.triggerId),
                accountId,
                state: "claimed",
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 50_000),
                claimedAt: new Date(Date.now() - 40_000),
                claimedByMachineId: "machine-1",
                leaseExpiresAt: new Date(Date.now() - 1_000),
                attempt: 1,
                executionInputEnvelope: JSON.stringify({
                    kind: "happier_automation_run_execution_input_v1",
                    targetType: "new_session",
                    templateVersion: 1,
                    templateCiphertext: TEST_TEMPLATE_ENVELOPE,
                    origin: {
                        kind: "scheduled",
                        scheduledFor: Date.now() - 60_000,
                    },
                }),
                assignments: frozenRunAssignments(["machine-1"]),
            },
            select: { id: true },
        });

        const releasedV2Claim = await claimAutomationRun({
            accountId,
            machineId: "machine-1",
            leaseDurationMs: 30_000,
            requireV2RunRepresentability: true,
        });

        expect(releasedV2Claim.run).toEqual(expect.objectContaining({
            id: run.id,
            attempt: 2,
        }));
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: run.id },
            select: { state: true, claimedByMachineId: true, attempt: true },
        })).resolves.toEqual({
            state: "claimed",
            claimedByMachineId: "machine-1",
            attempt: 2,
        });

        await expect(heartbeatAutomationRun({
            accountId,
            runId: run.id,
            machineId: "machine-1",
            attempt: 1,
            leaseDurationMs: 30_000,
            requireV2RunRepresentability: true,
        })).resolves.toEqual({ ok: false, leaseExpiresAt: null });
        await expect(startAutomationRunFromV2({
            accountId,
            runId: run.id,
            machineId: "machine-1",
            attempt: 1,
        })).resolves.toBeNull();

        await expect(heartbeatAutomationRun({
            accountId,
            runId: run.id,
            machineId: "machine-1",
            leaseDurationMs: 30_000,
            requireV2RunRepresentability: true,
        })).resolves.toMatchObject({ ok: true });
        await expect(startAutomationRunFromV2({
            accountId,
            runId: run.id,
            machineId: "machine-1",
        })).resolves.toEqual(expect.objectContaining({ state: "running", attempt: 2 }));
        await expect(succeedAutomationRunFromV2({
            accountId,
            runId: run.id,
            machineId: "machine-1",
        })).resolves.toEqual(expect.objectContaining({ state: "succeeded", attempt: 2 }));
    });

    it("reclaims a stale running run when lease expiration has passed", async () => {
        const { accountId } = await createAccountWithMachine("machine-1");
        await db.machine.create({
            data: {
                id: "machine-2",
                accountId,
                metadata: "{}",
            },
        });

        const automation = await createAutomationWithAssignments({
            accountId,
            machineIds: ["machine-1", "machine-2"],
            name: "Expired running lease automation",
        });
        const run = await db.automationRun.create({
            data: {
                automationId: automation.id,
                ...scheduleRunCause(automation.triggerId),
                accountId,
                state: "running",
                scheduledAt: new Date(Date.now() - 120_000),
                dueAt: new Date(Date.now() - 110_000),
                claimedAt: new Date(Date.now() - 100_000),
                startedAt: new Date(Date.now() - 95_000),
                claimedByMachineId: "machine-1",
                leaseExpiresAt: new Date(Date.now() - 2_000),
                attempt: 1,
                executionInputEnvelope: strictE2eeRecipeForAssignments(["machine-1", "machine-2"]),
                assignments: frozenRunAssignments(["machine-1", "machine-2"]),
            },
            select: { id: true },
        });

        const claim = await claimAutomationRun({
            accountId,
            machineId: "machine-2",
            leaseDurationMs: 30_000,
        });

        expect(claim.run?.id).toBe(run.id);
        expect(claim.run?.claimedByMachineId).toBe("machine-2");
        expect(claim.run?.state).toBe("claimed");

        const updated = await db.automationRun.findUnique({
            where: { id: run.id },
            select: {
                state: true,
                claimedByMachineId: true,
                attempt: true,
            },
        });
        expect(updated).toEqual(
            expect.objectContaining({
                state: "claimed",
                claimedByMachineId: "machine-2",
                attempt: 2,
            }),
        );
    });

    it("fences stale same-machine lease attempts and admits only the reclaimed attempt", async () => {
        const { accountId } = await createAccountWithMachine("machine-1");
        const automation = await createAutomationWithAssignments({
            accountId,
            machineIds: ["machine-1"],
            name: "Attempt fence automation",
        });

        async function reclaim() {
            const run = await db.automationRun.create({
                data: {
                    automationId: automation.id,
                    ...scheduleRunCause(automation.triggerId),
                    accountId,
                    state: "claimed",
                    scheduledAt: new Date(Date.now() - 60_000),
                    dueAt: new Date(Date.now() - 50_000),
                    claimedAt: new Date(Date.now() - 40_000),
                    claimedByMachineId: "machine-1",
                    leaseExpiresAt: new Date(Date.now() - 1_000),
                    attempt: 1,
                    executionInputEnvelope: strictE2eeRecipeForAssignments(["machine-1"]),
                    assignments: frozenRunAssignments(["machine-1"]),
                },
                select: { id: true },
            });
            const producedSession = await db.session.create({
                data: {
                    accountId,
                    tag: deriveSessionCreationTagV1({
                        callerCreationNamespace: `automation:${automation.id}`,
                        creationKey: `automation-run:${run.id}`,
                    }),
                    metadata: "{}",
                },
                select: { id: true },
            });
            const claimed = await claimAutomationRun({
                accountId,
                machineId: "machine-1",
                leaseDurationMs: 30_000,
            });
            expect(claimed.run).toEqual(expect.objectContaining({ id: run.id, attempt: 2 }));
            expect(claimed.accountCurrentness).not.toBeNull();
            return {
                id: run.id,
                attempt: claimed.run!.attempt,
                accountCurrentness: claimed.accountCurrentness!,
                producedSessionId: producedSession.id,
            };
        }

        const heartbeatRun = await reclaim();
        expect(await heartbeatAutomationRun({
            accountId,
            runId: heartbeatRun.id,
            machineId: "machine-1",
            attempt: 1,
            leaseDurationMs: 30_000,
        })).toEqual({ ok: false, leaseExpiresAt: null });
        expect((await heartbeatAutomationRun({
            accountId,
            runId: heartbeatRun.id,
            machineId: "machine-1",
            attempt: heartbeatRun.attempt,
            leaseDurationMs: 30_000,
        })).ok).toBe(true);

        const startRun = await reclaim();
        expect(await startAutomationRun({
            accountId,
            runId: startRun.id,
            machineId: "machine-1",
            attempt: 1,
            accountCurrentness: startRun.accountCurrentness,
        })).toBeNull();
        const started = await startAutomationRun({
            accountId,
            runId: startRun.id,
            machineId: "machine-1",
            attempt: startRun.attempt,
            accountCurrentness: startRun.accountCurrentness,
        });
        expect(started).toEqual(expect.objectContaining({
            run: expect.objectContaining({ id: startRun.id, state: "running" }),
        }));

        const succeedRun = await reclaim();
        const startedForSuccess = await startAutomationRun({
            accountId,
            runId: succeedRun.id,
            machineId: "machine-1",
            attempt: succeedRun.attempt,
            accountCurrentness: succeedRun.accountCurrentness,
        });
        expect(startedForSuccess).not.toBeNull();
        expect(await succeedAutomationRun({
            accountId,
            runId: succeedRun.id,
            machineId: "machine-1",
            attempt: 1,
            accountCurrentness: startedForSuccess!.accountCurrentness,
            producedSessionId: succeedRun.producedSessionId,
        })).toBeNull();
        expect(await succeedAutomationRun({
            accountId,
            runId: succeedRun.id,
            machineId: "machine-1",
            attempt: succeedRun.attempt,
            accountCurrentness: startedForSuccess!.accountCurrentness,
            producedSessionId: succeedRun.producedSessionId,
        })).toEqual(expect.objectContaining({ id: succeedRun.id, state: "succeeded" }));

        const failRun = await reclaim();
        const startedForFailure = await startAutomationRun({
            accountId,
            runId: failRun.id,
            machineId: "machine-1",
            attempt: failRun.attempt,
            accountCurrentness: failRun.accountCurrentness,
        });
        expect(startedForFailure).not.toBeNull();
        expect(await failAutomationRun({
            accountId,
            runId: failRun.id,
            machineId: "machine-1",
            attempt: 1,
            accountCurrentness: startedForFailure!.accountCurrentness,
            errorCode: "stale",
        })).toBeNull();
        expect(await failAutomationRun({
            accountId,
            runId: failRun.id,
            machineId: "machine-1",
            attempt: failRun.attempt,
            accountCurrentness: startedForFailure!.accountCurrentness,
            errorCode: "current",
        })).toEqual(expect.objectContaining({ id: failRun.id, state: "failed", errorCode: "current" }));
    });

    it.each([
        ["released V2", true],
        ["current", false],
    ] as const)("does not grant a %s claimant a lease to origin-mismatched retained V2 input", async (_claimant, requireV2RunRepresentability) => {
        const machineId = `machine-${requireV2RunRepresentability ? "v2" : "current"}-frozen-input`;
        const { accountId } = await createAccountWithMachine(machineId);
        const automation = await createAutomationWithAssignments({
            accountId,
            machineIds: [machineId],
            name: "V2 frozen-input representability",
        });
        const now = Date.now();
        const frozenInput = (params: Readonly<{
            origin: { kind: "scheduled"; scheduledFor: number } | { kind: "manual"; invokedAt: number };
        }>) => JSON.stringify({
            kind: "happier_automation_run_execution_input_v1",
            targetType: "new_session",
            templateVersion: 1,
            templateCiphertext: TEST_TEMPLATE_ENVELOPE,
            origin: params.origin,
        });
        const [originMismatch, compatible] = await Promise.all([
            db.automationRun.create({
                data: {
                    automationId: automation.id,
                    ...scheduleRunCause(automation.triggerId),
                    accountId,
                    state: "queued",
                    scheduledAt: new Date(now - 90_000),
                    dueAt: new Date(now - 80_000),
                    executionInputEnvelope: frozenInput({
                        origin: { kind: "manual", invokedAt: now - 90_000 },
                    }),
                    assignments: frozenRunAssignments([machineId]),
                },
                select: { id: true },
            }),
            db.automationRun.create({
                data: {
                    automationId: automation.id,
                    ...scheduleRunCause(automation.triggerId),
                    accountId,
                    state: "queued",
                    scheduledAt: new Date(now - 50_000),
                    dueAt: new Date(now - 40_000),
                    executionInputEnvelope: frozenInput({
                        origin: { kind: "scheduled", scheduledFor: now - 50_000 },
                    }),
                    assignments: frozenRunAssignments([machineId]),
                },
                select: { id: true },
            }),
        ]);
        if (!requireV2RunRepresentability) {
            await db.automationRun.createMany({
                data: Array.from({ length: 25 }, (_, index) => ({
                    automationId: automation.id,
                    ...scheduleRunCause(automation.triggerId),
                    accountId,
                    state: "queued" as const,
                    scheduledAt: new Date(now - 79_000 + index),
                    dueAt: new Date(now - 79_000 + index),
                    executionInputEnvelope: frozenInput({
                        origin: { kind: "manual", invokedAt: now - 79_000 + index },
                    }),
                })),
            });
        }

        await expect(claimAutomationRun({
            accountId,
            machineId,
            leaseDurationMs: 30_000,
            expectedTriggerKind: "schedule",
            ...(requireV2RunRepresentability ? { requireV2RunRepresentability: true } : {}),
        })).resolves.toEqual(expect.objectContaining({
            run: expect.objectContaining({ id: compatible.id }),
        }));
        const originMismatches = await db.automationRun.findMany({
            where: {
                automationId: automation.id,
                id: { not: compatible.id },
            },
            orderBy: { dueAt: "asc" },
            select: {
                id: true,
                state: true,
                claimedByMachineId: true,
                leaseExpiresAt: true,
                attempt: true,
                revision: true,
            },
        });
        expect(originMismatches).toHaveLength(requireV2RunRepresentability ? 1 : 26);
        expect(originMismatches[0]).toEqual({
            id: originMismatch.id,
            state: "failed",
            claimedByMachineId: null,
            leaseExpiresAt: null,
            attempt: 0,
            revision: 1,
        });
        expect(originMismatches.slice(1).every((run) => (
            run.state === "queued"
            && run.claimedByMachineId === null
            && run.leaseExpiresAt === null
            && run.attempt === 0
            && run.revision === 0
        ))).toBe(true);
    });

    it.each([
        ["released V2", true],
        ["current", false],
    ] as const)("terminalizes a saturated invalid retained-V2 page before a later %s claim", async (_claimant, requireV2RunRepresentability) => {
        const machineId = `machine-${requireV2RunRepresentability ? "v2" : "current"}-saturated-invalid-v2`;
        const { accountId } = await createAccountWithMachine(machineId);
        const automation = await createAutomationWithAssignments({
            accountId,
            machineIds: [machineId],
            name: "Saturated invalid retained V2 inputs",
        });
        const now = Date.now();
        const frozenInput = (origin: Readonly<
            { kind: "scheduled"; scheduledFor: number } | { kind: "manual"; invokedAt: number }
        >) => JSON.stringify({
            kind: "happier_automation_run_execution_input_v1",
            targetType: "new_session",
            templateVersion: 1,
            templateCiphertext: TEST_TEMPLATE_ENVELOPE,
            origin,
        });
        const invalidIds: string[] = [];
        for (let index = 0; index < 25; index += 1) {
            const run = await db.automationRun.create({
                data: {
                    automationId: automation.id,
                    ...scheduleRunCause(automation.triggerId),
                    accountId,
                    state: "queued",
                    scheduledAt: new Date(now - 120_000 + index),
                    dueAt: new Date(now - 120_000 + index),
                    executionInputEnvelope: frozenInput({
                        kind: "manual",
                        invokedAt: now - 120_000 + index,
                    }),
                    assignments: frozenRunAssignments([machineId]),
                },
                select: { id: true },
            });
            invalidIds.push(run.id);
        }
        const compatible = await db.automationRun.create({
            data: {
                automationId: automation.id,
                ...scheduleRunCause(automation.triggerId),
                accountId,
                state: "queued",
                scheduledAt: new Date(now - 60_000),
                dueAt: new Date(now - 60_000),
                executionInputEnvelope: frozenInput({
                    kind: "scheduled",
                    scheduledFor: now - 60_000,
                }),
                assignments: frozenRunAssignments([machineId]),
            },
            select: { id: true },
        });

        await expect(claimAutomationRun({
            accountId,
            machineId,
            leaseDurationMs: 30_000,
            expectedTriggerKind: "schedule",
            ...(requireV2RunRepresentability ? { requireV2RunRepresentability: true } : {}),
        })).resolves.toEqual({ run: null, accountCurrentness: null });
        await expect(db.automationRun.count({
            where: { id: { in: invalidIds }, state: "failed" },
        })).resolves.toBe(25);

        await expect(claimAutomationRun({
            accountId,
            machineId,
            leaseDurationMs: 30_000,
            expectedTriggerKind: "schedule",
            ...(requireV2RunRepresentability ? { requireV2RunRepresentability: true } : {}),
        })).resolves.toEqual(expect.objectContaining({
            run: expect.objectContaining({ id: compatible.id }),
        }));
    });

    it("does not reclaim an expired execution Run whose durable dispatch marker has no committed start result", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-ambiguous-execution-dispatch",
                accountId: account.id,
                metadata: "{}",
            },
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Ambiguous detached dispatch",
                enabled: true,
                targetType: "execution_run",
                templateCiphertext: TEST_STRICT_PLAIN_EXECUTION_RECIPE,
                templateVersion: 1,
                triggers: {
                    create: {
                        kind: "schedule",
                        scheduleKind: "interval",
                        everyMs: 60_000,
                    },
                },
                assignments: {
                    create: {
                        machineId: "machine-ambiguous-execution-dispatch",
                        enabled: true,
                        priority: 0,
                    },
                },
            },
            select: { id: true, triggers: { select: { id: true } } },
        });
        const triggerId = automation.triggers[0]!.id;
        const run = await db.automationRun.create({
            data: {
                automationId: automation.id,
                ...scheduleRunCause(triggerId),
                accountId: account.id,
                state: "running",
                executionInputEnvelope: strictPlainExecutionRecipeForAssignments([
                    "machine-ambiguous-execution-dispatch",
                ]),
                executionDispatchState: "dispatchPermitted",
                executionAttempt: 1,
                executionDispatchCommittedAt: new Date(Date.now() - 20_000),
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 50_000),
                claimedAt: new Date(Date.now() - 40_000),
                startedAt: new Date(Date.now() - 30_000),
                claimedByMachineId: "machine-ambiguous-execution-dispatch",
                leaseExpiresAt: new Date(Date.now() - 1_000),
                attempt: 1,
                assignments: frozenRunAssignments(["machine-ambiguous-execution-dispatch"]),
            },
            select: { id: true },
        });

        await expect(claimAutomationRun({
            accountId: account.id,
            machineId: "machine-ambiguous-execution-dispatch",
            leaseDurationMs: 30_000,
        })).resolves.toEqual({ run: null, accountCurrentness: null });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: run.id },
            select: {
                state: true,
                executionDispatchState: true,
                executionAttempt: true,
                claimedByMachineId: true,
                leaseExpiresAt: true,
            },
        })).resolves.toEqual({
            state: "outcome_uncertain",
            executionDispatchState: "outcomeUnknown",
            executionAttempt: 1,
            claimedByMachineId: null,
            leaseExpiresAt: null,
        });
    });

    it("normalizes a retained never-started execution Run NULL marker while reclaiming it", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        await db.machine.createMany({
            data: [
                { id: "machine-null-claimed-1", accountId: account.id, metadata: "{}" },
                { id: "machine-null-claimed-2", accountId: account.id, metadata: "{}" },
            ],
        });
        const automation = await createAutomationWithAssignments({
            accountId: account.id,
            machineIds: ["machine-null-claimed-1", "machine-null-claimed-2"],
            name: "Retained NULL claimed execution Run",
        });
        const run = await db.automationRun.create({
            data: {
                automationId: automation.id,
                ...scheduleRunCause(automation.triggerId),
                accountId: account.id,
                state: "claimed",
                executionInputEnvelope: strictPlainExecutionRecipeForAssignments([
                    "machine-null-claimed-1",
                    "machine-null-claimed-2",
                ]),
                executionDispatchState: null,
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 50_000),
                claimedAt: new Date(Date.now() - 40_000),
                claimedByMachineId: "machine-null-claimed-1",
                leaseExpiresAt: new Date(Date.now() - 1_000),
                attempt: 1,
                assignments: frozenRunAssignments(["machine-null-claimed-1", "machine-null-claimed-2"]),
            },
            select: { id: true },
        });

        const reclaimed = await claimAutomationRun({
            accountId: account.id,
            machineId: "machine-null-claimed-2",
            leaseDurationMs: 30_000,
        });

        expect(reclaimed.run).toEqual(expect.objectContaining({
            id: run.id,
            state: "claimed",
            claimedByMachineId: "machine-null-claimed-2",
            attempt: 2,
            executionDispatchState: "notStarted",
        }));
    });

    it("terminalizes a retained previously-running execution Run NULL marker as uncertain", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        await db.machine.createMany({
            data: [
                { id: "machine-null-running-1", accountId: account.id, metadata: "{}" },
                { id: "machine-null-running-2", accountId: account.id, metadata: "{}" },
            ],
        });
        const automation = await createAutomationWithAssignments({
            accountId: account.id,
            machineIds: ["machine-null-running-1", "machine-null-running-2"],
            name: "Retained NULL running execution Run",
        });
        const run = await db.automationRun.create({
            data: {
                automationId: automation.id,
                ...scheduleRunCause(automation.triggerId),
                accountId: account.id,
                state: "running",
                executionInputEnvelope: strictPlainExecutionRecipeForAssignments([
                    "machine-null-running-1",
                    "machine-null-running-2",
                ]),
                executionDispatchState: null,
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 50_000),
                claimedAt: new Date(Date.now() - 40_000),
                startedAt: new Date(Date.now() - 30_000),
                claimedByMachineId: "machine-null-running-1",
                leaseExpiresAt: new Date(Date.now() - 1_000),
                attempt: 1,
                assignments: frozenRunAssignments(["machine-null-running-1", "machine-null-running-2"]),
            },
            select: { id: true },
        });

        // A post-admission pause cannot suppress settlement of an ambiguity
        // already implied by the frozen Run's committed dispatch state.
        await db.automation.update({
            where: { id: automation.id },
            data: { enabled: false },
        });

        await expect(claimAutomationRun({
            accountId: account.id,
            machineId: "machine-null-running-2",
            leaseDurationMs: 30_000,
        })).resolves.toEqual({ run: null, accountCurrentness: null });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: run.id },
            select: {
                state: true,
                executionDispatchState: true,
                claimedByMachineId: true,
                leaseExpiresAt: true,
            },
        })).resolves.toEqual({
            state: "outcome_uncertain",
            executionDispatchState: "outcomeUnknown",
            claimedByMachineId: null,
            leaseExpiresAt: null,
        });
    });

    it("keeps a disabled Definition from changing an admitted Run's frozen claim authority", async () => {
        const machineId = "machine-retired-disabled-lease";
        const leaseExpiresAt = new Date(Date.now() + 60_000);
        const { accountId, automationId, runId } = await createLeasedRetirementRun({
            machineId,
            name: "Disabled leased retirement",
            state: "claimed",
            leaseExpiresAt,
        });

        await expect(setAutomationEnabled({
            accountId,
            automationId,
            enabled: false,
        })).resolves.toEqual(expect.objectContaining({ id: automationId, enabled: false }));

        const liveWakes = await listDaemonAssignments({ accountId, machineId });
        expect(liveWakes).toEqual([
            expect.objectContaining({
                machineId,
                automation: expect.objectContaining({ id: automationId, enabled: false }),
                nextClaimAt: new Date(leaseExpiresAt.getTime() + 1),
            }),
        ]);
        await expect(claimAutomationRun({
            accountId,
            machineId,
            leaseDurationMs: 30_000,
        })).resolves.toEqual({ run: null, accountCurrentness: null });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: runId },
            select: { state: true, claimedByMachineId: true, leaseExpiresAt: true },
        })).resolves.toEqual({
            state: "claimed",
            claimedByMachineId: machineId,
            leaseExpiresAt,
        });

        await db.automationRun.update({
            where: { id: runId },
            data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
        });

        await expect(claimAutomationRun({
            accountId,
            machineId,
            leaseDurationMs: 30_000,
        })).resolves.toMatchObject({
            run: { id: runId, state: "claimed", claimedByMachineId: machineId, attempt: 2 },
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: runId },
            select: {
                state: true,
                claimedByMachineId: true,
                attempt: true,
                errorCode: true,
            },
        })).resolves.toEqual({
            state: "claimed",
            claimedByMachineId: machineId,
            attempt: 2,
            errorCode: null,
        });
    });

    it("keeps a deleted Definition from changing an admitted running Run's frozen claim authority", async () => {
        const machineId = "machine-retired-deleted-run";
        const { accountId, automationId, runId } = await createLeasedRetirementRun({
            machineId,
            name: "Deleted leased retirement",
            state: "running",
            leaseExpiresAt: new Date(Date.now() - 1_000),
        });

        await expect(deleteAutomation({ accountId, automationId })).resolves.toBe(true);
        await expect(listDaemonAssignments({ accountId, machineId })).resolves.toEqual([
            expect.objectContaining({
                machineId,
                automation: expect.objectContaining({ id: automationId, enabled: false }),
                nextClaimAt: expect.any(Date),
            }),
        ]);

        await expect(claimAutomationRun({
            accountId,
            machineId,
            leaseDurationMs: 30_000,
        })).resolves.toMatchObject({
            run: { id: runId, state: "claimed", claimedByMachineId: machineId, attempt: 2 },
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: runId },
            select: {
                state: true,
                claimedByMachineId: true,
                attempt: true,
                errorCode: true,
            },
        })).resolves.toEqual({
            state: "claimed",
            claimedByMachineId: machineId,
            attempt: 2,
            errorCode: null,
        });
    });

    it("keeps an admitted Run claimable from its frozen assignment after Definition reassignment", async () => {
        const machineId = "machine-retired-assignment-removal";
        const { accountId, automationId, runId } = await createLeasedRetirementRun({
            machineId,
            name: "Assignment-removed leased retirement",
            state: "running",
            leaseExpiresAt: new Date(Date.now() - 1_000),
        });
        // Assignment-liveness keeps an enabled definition runnable, so the
        // reachable definition mutation is a replacement machine set rather
        // than an empty one. The admitted Run must still claim from its frozen
        // assignment, not the current definition assignments.
        const reassignedMachineId = "machine-reassigned-active";
        await db.machine.create({
            data: { id: reassignedMachineId, accountId, metadata: "{}" },
        });

        await expect(updateAutomation({
            accountId,
            automationId,
            input: { assignments: [{ machineId: reassignedMachineId }] },
        })).resolves.toEqual(expect.objectContaining({ id: automationId }));
        await expect(listDaemonAssignments({ accountId, machineId })).resolves.toEqual([
            expect.objectContaining({
                machineId,
                automation: expect.objectContaining({ id: automationId, enabled: true }),
                nextClaimAt: expect.any(Date),
            }),
        ]);

        const reclaimed = await claimAutomationRun({
            accountId,
            machineId,
            leaseDurationMs: 30_000,
        });
        expect(reclaimed.run).toEqual(expect.objectContaining({
            id: runId,
            state: "claimed",
            claimedByMachineId: machineId,
            attempt: 2,
        }));
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: runId },
            select: {
                state: true,
                claimedByMachineId: true,
                leaseExpiresAt: true,
                errorCode: true,
            },
        })).resolves.toEqual({
            state: "claimed",
            claimedByMachineId: machineId,
            leaseExpiresAt: expect.any(Date),
            errorCode: null,
        });
    });

    async function addAccountMachine(params: Readonly<{ accountId: string; machineId: string }>) {
        await db.machine.create({
            data: {
                id: params.machineId,
                accountId: params.accountId,
                metadata: "{}",
            },
        });
        return params.machineId;
    }

    it("does not transfer a disabled Definition's admitted Run to an unassigned replacement machine", async () => {
        const claimantMachineId = "machine-dead-claimant-cancelled";
        const { accountId, automationId, runId } = await createLeasedRetirementRun({
            machineId: claimantMachineId,
            name: "Dead claimant disabled retirement",
            state: "claimed",
            leaseExpiresAt: new Date(Date.now() - 1_000),
        });
        const recoveringMachineId = await addAccountMachine({
            accountId,
            machineId: "machine-recovering-cancelled",
        });

        await expect(setAutomationEnabled({
            accountId,
            automationId,
            enabled: false,
        })).resolves.toEqual(expect.objectContaining({ id: automationId, enabled: false }));

        // The claimant never comes back: only the replacement machine scans.
        await expect(claimAutomationRun({
            accountId,
            machineId: recoveringMachineId,
            leaseDurationMs: 30_000,
        })).resolves.toEqual({ run: null, accountCurrentness: null });

        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: runId },
            select: {
                state: true,
                claimedByMachineId: true,
                leaseExpiresAt: true,
                errorCode: true,
                attempt: true,
                startedAt: true,
            },
        })).resolves.toEqual({
            state: "claimed",
            claimedByMachineId: claimantMachineId,
            leaseExpiresAt: expect.any(Date),
            errorCode: null,
            attempt: 1,
            startedAt: null,
        });
    });

    it("does not transfer a deleted Definition's admitted Run to an unassigned replacement machine", async () => {
        const claimantMachineId = "machine-dead-claimant-uncertain";
        const { accountId, automationId, runId } = await createLeasedRetirementRun({
            machineId: claimantMachineId,
            name: "Dead claimant deleted retirement",
            state: "running",
            leaseExpiresAt: new Date(Date.now() - 1_000),
        });
        const recoveringMachineId = await addAccountMachine({
            accountId,
            machineId: "machine-recovering-uncertain",
        });

        await expect(deleteAutomation({ accountId, automationId })).resolves.toBe(true);

        await expect(claimAutomationRun({
            accountId,
            machineId: recoveringMachineId,
            leaseDurationMs: 30_000,
        })).resolves.toEqual({ run: null, accountCurrentness: null });

        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: runId },
            select: {
                state: true,
                claimedByMachineId: true,
                leaseExpiresAt: true,
                errorCode: true,
                attempt: true,
            },
        })).resolves.toEqual({
            state: "running",
            claimedByMachineId: claimantMachineId,
            leaseExpiresAt: expect.any(Date),
            errorCode: null,
            attempt: 1,
        });
    });

    it("does not transfer a frozen Run assignment to an unassigned replacement machine", async () => {
        const claimantMachineId = "machine-dead-claimant-unassigned";
        const { accountId, automationId, runId } = await createLeasedRetirementRun({
            machineId: claimantMachineId,
            name: "Dead claimant unassigned retirement",
            state: "running",
            leaseExpiresAt: new Date(Date.now() - 1_000),
        });
        const recoveringMachineId = await addAccountMachine({
            accountId,
            machineId: "machine-recovering-unassigned",
        });

        // Assignment-liveness forbids emptying an enabled definition's
        // assignments, so the reachable not-transferred state is the paused
        // definition: its admitted Run keeps its frozen assignment while the
        // unassigned replacement machine sees and claims nothing.
        await expect(setAutomationEnabled({
            accountId,
            automationId,
            enabled: false,
        })).resolves.toEqual(expect.objectContaining({ id: automationId, enabled: false }));

        await expect(listDaemonAssignments({
            accountId,
            machineId: recoveringMachineId,
        })).resolves.toEqual([]);

        await expect(claimAutomationRun({
            accountId,
            machineId: recoveringMachineId,
            leaseDurationMs: 30_000,
        })).resolves.toEqual({ run: null, accountCurrentness: null });

        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: runId },
            select: { state: true, claimedByMachineId: true, errorCode: true, attempt: true },
        })).resolves.toEqual({
            state: "running",
            claimedByMachineId: claimantMachineId,
            errorCode: null,
            attempt: 1,
        });
    });

    it("does not project an admitted Run's recovery wake to an unassigned replacement machine", async () => {
        const claimantMachineId = "machine-dead-claimant-wake";
        const leaseExpiresAt = new Date(Date.now() - 1_000);
        const { accountId, automationId } = await createLeasedRetirementRun({
            machineId: claimantMachineId,
            name: "Dead claimant recovery wake",
            state: "running",
            leaseExpiresAt,
        });
        const recoveringMachineId = await addAccountMachine({
            accountId,
            machineId: "machine-recovering-wake",
        });

        await expect(setAutomationEnabled({
            accountId,
            automationId,
            enabled: false,
        })).resolves.toEqual(expect.objectContaining({ id: automationId, enabled: false }));

        await expect(listDaemonAssignments({
            accountId,
            machineId: recoveringMachineId,
        })).resolves.toEqual([]);
    });

    it("leaves a live Automation's expired lease to its own assigned machines", async () => {
        const claimantMachineId = "machine-live-claimant";
        const leaseExpiresAt = new Date(Date.now() - 1_000);
        const { accountId, runId } = await createLeasedRetirementRun({
            machineId: claimantMachineId,
            name: "Live assignment lease takeover",
            state: "claimed",
            leaseExpiresAt,
        });
        const unassignedMachineId = await addAccountMachine({
            accountId,
            machineId: "machine-unassigned-bystander",
        });

        // Mutable Definition state never changes the Run's frozen assignment,
        // so an unassigned machine must neither claim it nor receive a wake.
        await expect(listDaemonAssignments({
            accountId,
            machineId: unassignedMachineId,
        })).resolves.toEqual([]);
        await expect(claimAutomationRun({
            accountId,
            machineId: unassignedMachineId,
            leaseDurationMs: 30_000,
        })).resolves.toEqual({ run: null, accountCurrentness: null });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: runId },
            select: { state: true, claimedByMachineId: true, leaseExpiresAt: true, attempt: true },
        })).resolves.toEqual({
            state: "claimed",
            claimedByMachineId: claimantMachineId,
            leaseExpiresAt,
            attempt: 1,
        });

        // The assigned claimant still recovers its own expired lease.
        const reclaimed = await claimAutomationRun({
            accountId,
            machineId: claimantMachineId,
            leaseDurationMs: 30_000,
        });
        expect(reclaimed.run).toEqual(expect.objectContaining({
            id: runId,
            state: "claimed",
            claimedByMachineId: claimantMachineId,
            attempt: 2,
        }));
    });

    it("does not let an unassigned machine settle a live Automation's expired dispatch as uncertain", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        await db.machine.createMany({
            data: [
                { id: "machine-live-dispatch-claimant", accountId: account.id, metadata: "{}" },
                { id: "machine-live-dispatch-bystander", accountId: account.id, metadata: "{}" },
            ],
        });
        const automation = await createAutomationWithAssignments({
            accountId: account.id,
            machineIds: ["machine-live-dispatch-claimant"],
            name: "Live execution dispatch",
        });
        const run = await db.automationRun.create({
            data: {
                automationId: automation.id,
                ...scheduleRunCause(automation.triggerId),
                accountId: account.id,
                state: "running",
                executionInputEnvelope: strictPlainExecutionRecipeForAssignments([
                    "machine-live-dispatch-claimant",
                ]),
                executionDispatchState: "dispatchPermitted",
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 50_000),
                claimedAt: new Date(Date.now() - 40_000),
                startedAt: new Date(Date.now() - 30_000),
                claimedByMachineId: "machine-live-dispatch-claimant",
                leaseExpiresAt: new Date(Date.now() - 1_000),
                attempt: 1,
                assignments: frozenRunAssignments(["machine-live-dispatch-claimant"]),
            },
            select: { id: true },
        });

        // Frozen Run assignment is the only recovery authority. Definition
        // state is not a second decision engine for an admitted dispatch.
        await expect(claimAutomationRun({
            accountId: account.id,
            machineId: "machine-live-dispatch-bystander",
            leaseDurationMs: 30_000,
        })).resolves.toEqual({ run: null, accountCurrentness: null });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: run.id },
            select: {
                state: true,
                executionDispatchState: true,
                claimedByMachineId: true,
                attempt: true,
            },
        })).resolves.toEqual({
            state: "running",
            executionDispatchState: "dispatchPermitted",
            claimedByMachineId: "machine-live-dispatch-claimant",
            attempt: 1,
        });
    });
});
