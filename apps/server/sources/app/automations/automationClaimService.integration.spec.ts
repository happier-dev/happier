import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
    AutomationRunExecutionInputV1Schema,
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
import { failAutomationRun, startAutomationRun, succeedAutomationRun } from "./automationRunService";

const TEST_TEMPLATE_ENVELOPE = JSON.stringify({
    kind: "happier_automation_template_encrypted_v1",
    payloadCiphertext: "ciphertext-base64",
});

const TEST_STRICT_E2EE_RECIPE = (() => {
    const serialized = serializeAutomationRunExecutionRecipeV1({
        v: 1,
        templateVersion: 1,
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
})();

const TEST_STRICT_PLAIN_EXECUTION_RECIPE = (() => {
    const serialized = serializeAutomationRunExecutionRecipeV1({
        v: 1,
        templateVersion: 1,
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
})();

async function createAccountWithMachine(machineId: string): Promise<{ accountId: string }> {
    const account = await db.account.create({
        data: {
            ...createSignedAccountContentBinding(),
            encryptionMode: "e2ee",
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
            scheduleKind: "interval",
            everyMs: 60_000,
            targetType: "new_session",
            templateCiphertext: TEST_TEMPLATE_ENVELOPE,
            templateVersion: 1,
            assignments: {
                create: params.machineIds.map((machineId) => ({
                    machineId,
                    enabled: true,
                    priority: 0,
                })),
            },
        },
        select: { id: true },
    });
    return automation;
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
                accountId,
                state: params.state,
                scheduledAt: new Date(now - 60_000),
                dueAt: new Date(now - 50_000),
                claimedAt: new Date(now - 40_000),
                ...(params.state === "running" ? { startedAt: new Date(now - 30_000) } : {}),
                claimedByMachineId: params.machineId,
                leaseExpiresAt: params.leaseExpiresAt,
                attempt: 1,
                executionInputEnvelope: TEST_STRICT_E2EE_RECIPE,
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
                accountId: account.id,
                state: "queued",
                scheduledAt: new Date(Date.now() - 30_000),
                dueAt: new Date(Date.now() - 20_000),
                executionInputEnvelope: JSON.stringify({
                    t: "encrypted",
                    c: "private-queued-run-sentinel",
                }),
            },
            select: { id: true },
        });
        const active = await db.automationRun.create({
            data: {
                automationId: automation.id,
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
                accountId: account.id,
                state: "queued",
                scheduledAt: new Date(Date.now() - 30_000),
                dueAt: new Date(Date.now() - 20_000),
                // This is neither the strict current recipe nor the retained V2
                // recipe. It must not become a worker lease merely because it is due.
                executionInputEnvelope: JSON.stringify({ v: 1 }),
            },
            select: { id: true },
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
                accountId: account.id,
                state: "queued",
                scheduledAt: new Date(Date.now() - 30_000),
                dueAt: new Date(Date.now() - 20_000),
                executionInputEnvelope: TEST_STRICT_E2EE_RECIPE,
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
                    accountId: account.id,
                    state: "queued",
                    scheduledAt: new Date(Date.now() - 2_000),
                    dueAt: new Date(Date.now() - 1_000),
                    executionInputEnvelope: TEST_STRICT_PLAIN_EXECUTION_RECIPE,
                    executionDispatchState: "notStarted",
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

    it("requires the claim witness at start and the post-start witness at settlement", async () => {
        const { accountId } = await createAccountWithMachine("machine-currentness");
        const automation = await createAutomationWithAssignments({
            accountId,
            machineIds: ["machine-currentness"],
            name: "Currentness witness automation",
        });
        const staleRun = await db.automationRun.create({
            data: {
                automationId: automation.id,
                accountId,
                state: "queued",
                scheduledAt: new Date(Date.now() - 30_000),
                dueAt: new Date(Date.now() - 20_000),
                executionInputEnvelope: TEST_STRICT_E2EE_RECIPE,
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
                accountId,
                state: "queued",
                scheduledAt: new Date(Date.now() - 10_000),
                dueAt: new Date(Date.now() - 5_000),
                executionInputEnvelope: TEST_STRICT_E2EE_RECIPE,
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

        await expect(failAutomationRun({
            accountId,
            runId: run.id,
            machineId: "machine-currentness",
            attempt: claim.run!.attempt,
            accountCurrentness: claim.accountCurrentness!,
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
                accountId,
                state: "claimed",
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 50_000),
                claimedAt: new Date(Date.now() - 40_000),
                claimedByMachineId: "machine-1",
                leaseExpiresAt: new Date(Date.now() - 1_000),
                attempt: 1,
                executionInputEnvelope: TEST_STRICT_E2EE_RECIPE,
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
                accountId,
                state: "running",
                scheduledAt: new Date(Date.now() - 120_000),
                dueAt: new Date(Date.now() - 110_000),
                claimedAt: new Date(Date.now() - 100_000),
                startedAt: new Date(Date.now() - 95_000),
                claimedByMachineId: "machine-1",
                leaseExpiresAt: new Date(Date.now() - 2_000),
                attempt: 1,
                executionInputEnvelope: TEST_STRICT_E2EE_RECIPE,
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
                    accountId,
                    state: "claimed",
                    scheduledAt: new Date(Date.now() - 60_000),
                    dueAt: new Date(Date.now() - 50_000),
                    claimedAt: new Date(Date.now() - 40_000),
                    claimedByMachineId: "machine-1",
                    leaseExpiresAt: new Date(Date.now() - 1_000),
                    attempt: 1,
                    executionInputEnvelope: TEST_STRICT_E2EE_RECIPE,
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
        }>) => JSON.stringify(AutomationRunExecutionInputV1Schema.parse({
            kind: "happier_automation_run_execution_input_v1",
            targetType: "new_session",
            templateVersion: 1,
            templateCiphertext: TEST_TEMPLATE_ENVELOPE,
            origin: params.origin,
        }));
        const [originMismatch, compatible] = await Promise.all([
            db.automationRun.create({
                data: {
                    automationId: automation.id,
                    accountId,
                    state: "queued",
                    originKind: "scheduled",
                    scheduledAt: new Date(now - 90_000),
                    dueAt: new Date(now - 80_000),
                    executionInputEnvelope: frozenInput({
                        origin: { kind: "manual", invokedAt: now - 90_000 },
                    }),
                },
                select: { id: true },
            }),
            db.automationRun.create({
                data: {
                    automationId: automation.id,
                    accountId,
                    state: "queued",
                    originKind: "scheduled",
                    scheduledAt: new Date(now - 50_000),
                    dueAt: new Date(now - 40_000),
                    executionInputEnvelope: frozenInput({
                        origin: { kind: "scheduled", scheduledFor: now - 50_000 },
                    }),
                },
                select: { id: true },
            }),
        ]);
        if (!requireV2RunRepresentability) {
            await db.automationRun.createMany({
                data: Array.from({ length: 25 }, (_, index) => ({
                    automationId: automation.id,
                    accountId,
                    state: "queued" as const,
                    originKind: "scheduled" as const,
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
            state: "queued",
            claimedByMachineId: null,
            leaseExpiresAt: null,
            attempt: 0,
            revision: 0,
        });
        expect(originMismatches.every((run) => (
            run.state === "queued"
            && run.claimedByMachineId === null
            && run.leaseExpiresAt === null
            && run.attempt === 0
            && run.revision === 0
        ))).toBe(true);
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
                scheduleKind: "interval",
                everyMs: 60_000,
                targetType: "execution_run",
                templateCiphertext: TEST_STRICT_PLAIN_EXECUTION_RECIPE,
                templateVersion: 1,
                assignments: {
                    create: {
                        machineId: "machine-ambiguous-execution-dispatch",
                        enabled: true,
                        priority: 0,
                    },
                },
            },
            select: { id: true },
        });
        const run = await db.automationRun.create({
            data: {
                automationId: automation.id,
                accountId: account.id,
                state: "running",
                executionInputEnvelope: TEST_STRICT_PLAIN_EXECUTION_RECIPE,
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
                accountId: account.id,
                state: "claimed",
                executionInputEnvelope: TEST_STRICT_PLAIN_EXECUTION_RECIPE,
                executionDispatchState: null,
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 50_000),
                claimedAt: new Date(Date.now() - 40_000),
                claimedByMachineId: "machine-null-claimed-1",
                leaseExpiresAt: new Date(Date.now() - 1_000),
                attempt: 1,
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
                accountId: account.id,
                state: "running",
                executionInputEnvelope: TEST_STRICT_PLAIN_EXECUTION_RECIPE,
                executionDispatchState: null,
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 50_000),
                claimedAt: new Date(Date.now() - 40_000),
                startedAt: new Date(Date.now() - 30_000),
                claimedByMachineId: "machine-null-running-1",
                leaseExpiresAt: new Date(Date.now() - 1_000),
                attempt: 1,
            },
            select: { id: true },
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

    it("keeps a disabled live lease nonterminal, then cancels it after expiry through its retained claimant wake", async () => {
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
        })).resolves.toEqual({ run: null, accountCurrentness: null });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: runId },
            select: {
                state: true,
                claimedByMachineId: true,
                leaseExpiresAt: true,
                errorCode: true,
            },
        })).resolves.toEqual({
            state: "cancelled",
            claimedByMachineId: null,
            leaseExpiresAt: null,
            errorCode: "automation_retired_after_lease_expiry",
        });
        await expect(db.automationRunEvent.findMany({
            where: { runId },
            select: { type: true, payload: true },
        })).resolves.toContainEqual({
            type: "run_cancelled",
            payload: { reason: "automation_retired_after_lease_expiry" },
        });
    });

    it("terminalizes an expired running Run as outcome-uncertain after Automation deletion", async () => {
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
        })).resolves.toEqual({ run: null, accountCurrentness: null });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: runId },
            select: {
                state: true,
                claimedByMachineId: true,
                leaseExpiresAt: true,
                errorCode: true,
            },
        })).resolves.toEqual({
            state: "outcome_uncertain",
            claimedByMachineId: null,
            leaseExpiresAt: null,
            errorCode: "automation_retired_after_lease_expiry",
        });
        await expect(db.automationRunEvent.findMany({
            where: { runId },
            select: { type: true, payload: true },
        })).resolves.toContainEqual({
            type: "run_outcome_uncertain",
            payload: { reason: "automation_retired_after_lease_expiry" },
        });
    });

    it("terminalizes an expired running Run as outcome-uncertain after claimant assignment removal", async () => {
        const machineId = "machine-retired-assignment-removal";
        const { accountId, automationId, runId } = await createLeasedRetirementRun({
            machineId,
            name: "Assignment-removed leased retirement",
            state: "running",
            leaseExpiresAt: new Date(Date.now() - 1_000),
        });

        await expect(updateAutomation({
            accountId,
            automationId,
            input: { assignments: [] },
        })).resolves.toEqual(expect.objectContaining({ id: automationId }));
        await expect(listDaemonAssignments({ accountId, machineId })).resolves.toEqual([
            expect.objectContaining({
                machineId,
                automation: expect.objectContaining({ id: automationId, enabled: true }),
                nextClaimAt: expect.any(Date),
            }),
        ]);

        await expect(claimAutomationRun({
            accountId,
            machineId,
            leaseDurationMs: 30_000,
        })).resolves.toEqual({ run: null, accountCurrentness: null });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: runId },
            select: {
                state: true,
                claimedByMachineId: true,
                leaseExpiresAt: true,
                errorCode: true,
            },
        })).resolves.toEqual({
            state: "outcome_uncertain",
            claimedByMachineId: null,
            leaseExpiresAt: null,
            errorCode: "automation_retired_after_lease_expiry",
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

    it("cancels an expired claimed Run of a disabled Automation through a replacement machine that never executes it", async () => {
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
            state: "cancelled",
            claimedByMachineId: null,
            leaseExpiresAt: null,
            errorCode: "automation_retired_after_lease_expiry",
            // Recovery terminalizes; it never becomes a new execution attempt.
            attempt: 1,
            startedAt: null,
        });
        await expect(db.automationRunEvent.findMany({
            where: { runId },
            select: { type: true, payload: true },
        })).resolves.toContainEqual({
            type: "run_cancelled",
            payload: { reason: "automation_retired_after_lease_expiry" },
        });
    });

    it("terminalizes an expired running Run of a deleted Automation as outcome-uncertain through a replacement machine", async () => {
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
            state: "outcome_uncertain",
            claimedByMachineId: null,
            leaseExpiresAt: null,
            errorCode: "automation_retired_after_lease_expiry",
            attempt: 1,
        });
        await expect(db.automationRunEvent.findMany({
            where: { runId },
            select: { type: true, payload: true },
        })).resolves.toContainEqual({
            type: "run_outcome_uncertain",
            payload: { reason: "automation_retired_after_lease_expiry" },
        });
    });

    it("terminalizes an expired running Run whose only assignment was removed through a replacement machine", async () => {
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

        await expect(updateAutomation({
            accountId,
            automationId,
            input: { assignments: [] },
        })).resolves.toEqual(expect.objectContaining({ id: automationId }));

        await expect(claimAutomationRun({
            accountId,
            machineId: recoveringMachineId,
            leaseDurationMs: 30_000,
        })).resolves.toEqual({ run: null, accountCurrentness: null });

        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: runId },
            select: { state: true, claimedByMachineId: true, errorCode: true, attempt: true },
        })).resolves.toEqual({
            state: "outcome_uncertain",
            claimedByMachineId: null,
            errorCode: "automation_retired_after_lease_expiry",
            attempt: 1,
        });
    });

    it("projects a retired Run's recovery wake to a replacement machine so the claim scan is reachable", async () => {
        const claimantMachineId = "machine-dead-claimant-wake";
        const leaseExpiresAt = new Date(Date.now() - 1_000);
        const { accountId, automationId, runId } = await createLeasedRetirementRun({
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
        })).resolves.toEqual([
            expect.objectContaining({
                id: runId,
                machineId: recoveringMachineId,
                automation: expect.objectContaining({ id: automationId, enabled: false }),
                nextClaimAt: new Date(leaseExpiresAt.getTime() + 1),
            }),
        ]);
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

        // The Definition is not retired, so an unassigned machine must neither
        // terminalize the Run nor receive a wake for it.
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
                accountId: account.id,
                state: "running",
                executionInputEnvelope: TEST_STRICT_PLAIN_EXECUTION_RECIPE,
                executionDispatchState: "dispatchPermitted",
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 50_000),
                claimedAt: new Date(Date.now() - 40_000),
                startedAt: new Date(Date.now() - 30_000),
                claimedByMachineId: "machine-live-dispatch-claimant",
                leaseExpiresAt: new Date(Date.now() - 1_000),
                attempt: 1,
            },
            select: { id: true },
        });

        // The abandoned-dispatch owner scopes its write to an enabled,
        // undeleted Definition and to nothing else, so recovery discovery is
        // the only thing keeping an unassigned machine away from a live Run.
        // Widening it past retirement would settle this Run as uncertain.
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
