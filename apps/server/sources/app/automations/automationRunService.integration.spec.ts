import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
    deriveSessionCreationTagV1,
    serializeAutomationRunExecutionRecipeV1,
    type SessionServerStartDispatchResultV1,
} from "@happier-dev/protocol";
import type { Socket } from "socket.io";

import { eventRouter, type ClientConnection, type UpdatePayload } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { inTx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";

import {
    cancelAutomationRun,
    failAutomationRun,
    startAutomationRun,
    succeedAutomationRun,
    terminalizeRetiredAutomationRunAfterLeaseExpiryTx,
} from "./automationRunService";
import * as automationRunServiceModule from "./automationRunService";
import {
    claimNextAutomationReplyHandoff,
    findNextAutomationReplyHandoffDueAt,
} from "./automationReplyHandoffService";
import {
    automationAccountCurrentnessSelect,
    deriveAutomationAccountCurrentnessWitness,
} from "./automationAccountCurrentness";

const TEST_TEMPLATE_ENVELOPE = JSON.stringify({
    kind: "happier_automation_template_encrypted_v1",
    payloadCiphertext: "ciphertext-base64",
});

const TEST_STRICT_PLAIN_RECIPE = (() => {
    const serialized = serializeAutomationRunExecutionRecipeV1({
        v: 1,
        templateVersion: 1,
        template: {
            t: "plain",
            v: { v: 1, prompt: "Run the scheduled automation." },
        },
        triggerEvidence: null,
        target: {
            kind: "newSession",
            spawn: {
                executionTarget: { serverId: "server", machineId: "machine" },
                directory: "/tmp/automation-run-service",
                agentTarget: {
                    kind: "agent",
                    identity: {
                        pluginId: "happier.agent.codex",
                        localId: "codex",
                    },
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

const INCONSISTENT_E2EE_CURRENTNESS = {
    mode: "e2ee" as const,
    version: 0,
    contentKeyFingerprint: "unavailable-for-inconsistent-account",
};

function createMachineConnection(params: {
    accountId: string;
    machineId: string;
    updates: UpdatePayload[];
}): ClientConnection {
    const socket = {
        emit(event: string, payload: UpdatePayload) {
            if (event === "update") params.updates.push(payload);
        },
    } as unknown as Socket;
    return {
        connectionType: "machine-scoped",
        userId: params.accountId,
        machineId: params.machineId,
        socket,
    };
}

function createUserConnection(params: {
    accountId: string;
    updates: UpdatePayload[];
}): ClientConnection {
    const socket = {
        emit(event: string, payload: UpdatePayload) {
            if (event === "update") params.updates.push(payload);
        },
    } as unknown as Socket;
    return {
        connectionType: "user-scoped",
        userId: params.accountId,
        socket,
    };
}

async function readAutomationAccountCurrentness(accountId: string) {
    const account = await db.account.findUniqueOrThrow({
        where: { id: accountId },
        select: automationAccountCurrentnessSelect,
    });
    const currentness = deriveAutomationAccountCurrentnessWitness(account);
    if (!currentness) {
        throw new Error("Automation Account currentness is unavailable in this fixture");
    }
    return currentness;
}

async function createAccountMachineAutomation(params: {
    publicKey: string;
    machineId: string;
    automationName: string;
}) {
    const account = await db.account.create({
        data: { publicKey: params.publicKey, encryptionMode: "plain" },
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
            templateCiphertext: TEST_STRICT_PLAIN_RECIPE,
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

type SessionStartRetentionInput = {
    accountId: string;
    machineId: string;
    runId: string;
    attempt: number;
    result: SessionServerStartDispatchResultV1;
};

async function retainAutomationRunProducedSession(params: SessionStartRetentionInput): Promise<unknown> {
    // Resolve dynamically so this owner-level RED can execute before the new
    // retention operation is exported by the production owner.
    const operation = Reflect.get(automationRunServiceModule, "retainAutomationRunProducedSession");
    if (typeof operation !== "function") {
        throw new Error("expected AutomationRun produced-Session retention operation");
    }
    return await (operation as (input: SessionStartRetentionInput) => Promise<unknown>)(params);
}

function sessionStartSuccess(sessionId: string): SessionStartRetentionInput["result"] {
    return {
        type: "success",
        disposition: "created",
        sessionId,
        executionTarget: { serverId: "server", machineId: "machine" },
        organizationPlacement: { folderId: null, tagIds: [] },
        initialInput: { status: "notRequested" },
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
        harness.resetEnv();
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

    async function seedExecutionDispatchRun(params: Readonly<{
        id: string;
        state?: "claimed" | "running";
        executionDispatchState?: "notStarted" | "retryWaiting" | "dispatchPermitted";
        executionAttempt?: number;
    }>) {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const machine = await db.machine.create({
            data: {
                id: `machine-${params.id}`,
                accountId: account.id,
                metadata: "{}",
            },
            select: { id: true },
        });
        const automation = await db.automation.create({
            data: {
                id: `automation-${params.id}`,
                accountId: account.id,
                name: `Detached execution ${params.id}`,
                enabled: true,
                scheduleKind: "interval",
                everyMs: 120_000,
                targetType: "execution_run",
                templateCiphertext: TEST_STRICT_PLAIN_EXECUTION_RECIPE,
                templateVersion: 1,
                assignments: {
                    create: {
                        machineId: machine.id,
                        enabled: true,
                        priority: 0,
                    },
                },
            },
            select: { id: true },
        });
        const state = params.state ?? "claimed";
        const run = await db.automationRun.create({
            data: {
                id: params.id,
                automationId: automation.id,
                accountId: account.id,
                state,
                executionInputEnvelope: TEST_STRICT_PLAIN_EXECUTION_RECIPE,
                executionDispatchState: params.executionDispatchState ?? "notStarted",
                executionAttempt: params.executionAttempt ?? 0,
                ...(params.executionDispatchState === "dispatchPermitted"
                    ? { executionDispatchCommittedAt: new Date(Date.now() - 5_000) }
                    : {}),
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 30_000),
                claimedAt: new Date(Date.now() - 20_000),
                ...(state === "running" ? { startedAt: new Date(Date.now() - 10_000) } : {}),
                claimedByMachineId: machine.id,
                leaseExpiresAt: new Date(Date.now() + 30_000),
                attempt: 1,
            },
            select: { id: true },
        });
        return { account, machine, automation, run };
    }

    function readExecutionDispatchSettlementOwner() {
        const settle = Reflect.get(automationRunServiceModule, "settleAutomationExecutionDispatch");
        expect(settle).toBeTypeOf("function");
        return settle;
    }

    it("fails closed before lifecycle Run writers mutate an inconsistent E2EE Account", async () => {
        const binding = createSignedAccountContentBinding();
        const account = await db.account.create({
            data: {
                publicKey: binding.publicKey,
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const machine = await db.machine.create({
            data: {
                id: "machine-inconsistent-run-settlement",
                accountId: account.id,
                metadata: "{}",
            },
            select: { id: true },
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Inconsistent Account settlement",
                enabled: true,
                scheduleKind: "interval",
                everyMs: 120_000,
                targetType: "new_session",
                templateCiphertext: TEST_TEMPLATE_ENVELOPE,
                templateVersion: 1,
            },
            select: { id: true },
        });
        const run = await db.automationRun.create({
            data: {
                automationId: automation.id,
                accountId: account.id,
                state: "running",
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 30_000),
                claimedAt: new Date(Date.now() - 20_000),
                startedAt: new Date(Date.now() - 10_000),
                claimedByMachineId: machine.id,
                leaseExpiresAt: new Date(Date.now() + 30_000),
                attempt: 1,
                executionInputEnvelope: JSON.stringify({
                    t: "encrypted",
                    c: "private-settlement-run-sentinel",
                }),
            },
            select: { id: true },
        });
        const startRun = await db.automationRun.create({
            data: {
                automationId: automation.id,
                accountId: account.id,
                state: "claimed",
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 30_000),
                claimedAt: new Date(Date.now() - 20_000),
                claimedByMachineId: machine.id,
                leaseExpiresAt: new Date(Date.now() + 30_000),
                attempt: 1,
            },
            select: { id: true },
        });
        const failRun = await db.automationRun.create({
            data: {
                automationId: automation.id,
                accountId: account.id,
                state: "claimed",
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 30_000),
                claimedAt: new Date(Date.now() - 20_000),
                claimedByMachineId: machine.id,
                leaseExpiresAt: new Date(Date.now() + 30_000),
                attempt: 1,
            },
            select: { id: true },
        });
        const cancelRun = await db.automationRun.create({
            data: {
                automationId: automation.id,
                accountId: account.id,
                state: "queued",
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 30_000),
                attempt: 0,
            },
            select: { id: true },
        });
        const runIds = [run.id, startRun.id, failRun.id, cancelRun.id];
        const before = await db.automationRun.findMany({
            where: { id: { in: runIds } },
            orderBy: { id: "asc" },
            select: { id: true, state: true, startedAt: true, finishedAt: true, revision: true },
        });

        const started = await startAutomationRun({
            accountId: account.id,
            runId: startRun.id,
            machineId: machine.id,
            attempt: 1,
            accountCurrentness: INCONSISTENT_E2EE_CURRENTNESS,
        });
        const failed = await failAutomationRun({
            accountId: account.id,
            runId: failRun.id,
            machineId: machine.id,
            attempt: 1,
            accountCurrentness: INCONSISTENT_E2EE_CURRENTNESS,
        });
        const cancelled = await cancelAutomationRun({
            accountId: account.id,
            runId: cancelRun.id,
        });
        const settled = await succeedAutomationRun({
            accountId: account.id,
            runId: run.id,
            machineId: machine.id,
            attempt: 1,
            accountCurrentness: INCONSISTENT_E2EE_CURRENTNESS,
        });

        expect(started).toBeNull();
        expect(failed).toBeNull();
        expect(cancelled).toBeNull();
        expect(settled).toBeNull();
        await expect(db.automationRun.findMany({
            where: { id: { in: runIds } },
            orderBy: { id: "asc" },
            select: { id: true, state: true, startedAt: true, finishedAt: true, revision: true },
        })).resolves.toEqual(before);
    });

    async function seedConversationRunForResultValidation() {
        const account = await db.account.create({
            data: { id: "account-conversation-result-validation", publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const machine = await db.machine.create({
            data: {
                id: "machine-conversation-result-validation",
                accountId: account.id,
                metadata: "{}",
            },
            select: { id: true },
        });
        const automation = await db.automation.create({
            data: {
                id: "automation-conversation-result-validation",
                accountId: account.id,
                name: "Conversation result validation",
                enabled: true,
                targetType: "new_session",
                templateCiphertext: JSON.stringify({
                    kind: "happier_automation_template_plain_v1",
                    payload: { prompt: "reply" },
                }),
                templateVersion: 1,
                triggerKind: "conversation",
                triggerDefinitionEnvelope: JSON.stringify({ t: "plain", v: {} }),
            },
            select: { id: true },
        });
        const run = await db.automationRun.create({
            data: {
                id: "run-conversation-result-validation",
                automationId: automation.id,
                accountId: account.id,
                state: "running",
                originKind: "conversation",
                originOccurredAt: new Date(Date.now() - 60_000),
                occurrenceKey: "conversation-occurrence-result-validation",
                triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: {} }),
                replyContextEnvelope: JSON.stringify({
                    t: "plain",
                    v: {
                        v: 1,
                        correspondence: {
                            automationId: automation.id,
                            occurrenceKey: "conversation-occurrence-result-validation",
                        },
                        templateVersion: 1,
                        opaqueContext: { conversationId: "conversation-1" },
                    },
                }),
                replyHandoffActionPluginId: "happier.channels",
                replyHandoffActionLocalId: "automation/result-deliver-v1",
                replyHandoffTargetMachineId: machine.id,
                replyHandoffTargetMachineInstallationId: "installation-1",
                replyHandoffTargetMaterializationId: "materialization-1",
                replyHandoffId: "handoff-conversation-result-validation",
                replyHandoffState: "awaitingResult",
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 30_000),
                startedAt: new Date(Date.now() - 20_000),
                claimedByMachineId: machine.id,
                leaseExpiresAt: new Date(Date.now() + 30_000),
                attempt: 1,
            },
            select: { id: true },
        });
        return { account, machine, automation, run };
    }

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
            attempt: 1,
            accountCurrentness: await readAutomationAccountCurrentness(seeded.accountId),
        });
        expect(started?.run.state).toBe("running");
        expect(started?.run.startedAt).not.toBeNull();
        if (!started) {
            throw new Error("Expected the claimed Automation Run to start");
        }

        const resultEnvelope = JSON.stringify({
            t: "plain",
            v: {
                v: 1,
                correspondence: {
                    accountId: seeded.accountId,
                    automationId: seeded.automationId,
                    runId: run.id,
                    handoffId: "handoff-run-succeed",
                },
                result: { v: 1, kind: "text", text: "summary" },
            },
        });
        const succeeded = await succeedAutomationRun({
            accountId: seeded.accountId,
            runId: run.id,
            machineId: seeded.machineId,
            attempt: 1,
            accountCurrentness: started.accountCurrentness,
            resultEnvelope,
        });
        expect(succeeded).toEqual(
            expect.objectContaining({
                id: run.id,
                state: "succeeded",
                resultEnvelope,
                summaryCiphertext: null,
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

    it("atomically persists execution dispatch permission and terminalizes an exhausted retry through the incumbent failed-run lifecycle", async () => {
        const first = await seedExecutionDispatchRun({ id: "run-execution-dispatch-first" });
        const started = await startAutomationRun({
            accountId: first.account.id,
            runId: first.run.id,
            machineId: first.machine.id,
            attempt: 1,
            accountCurrentness: await readAutomationAccountCurrentness(first.account.id),
        });

        expect(started?.run).toEqual(expect.objectContaining({
            state: "running",
            executionDispatchState: "dispatchPermitted",
            executionAttempt: 1,
        }));
        expect(started?.run.executionDispatchCommittedAt).not.toBeNull();

        const exhausted = await seedExecutionDispatchRun({
            id: "run-execution-dispatch-exhausted",
            executionDispatchState: "retryWaiting",
            executionAttempt: 3,
        });
        const updates: UpdatePayload[] = [];
        const observer = createMachineConnection({
            accountId: exhausted.account.id,
            machineId: exhausted.machine.id,
            updates,
        });
        eventRouter.addConnection(exhausted.account.id, observer);
        try {
            await expect(startAutomationRun({
                accountId: exhausted.account.id,
                runId: exhausted.run.id,
                machineId: exhausted.machine.id,
                attempt: 1,
                accountCurrentness: await readAutomationAccountCurrentness(exhausted.account.id),
            })).resolves.toBeNull();
            expect(updates).toEqual([
                expect.objectContaining({
                    body: expect.objectContaining({
                        t: "automation-run-state-changed",
                        runId: exhausted.run.id,
                        automationId: exhausted.automation.id,
                        originKind: "scheduled",
                        previousState: "claimed",
                        currentState: "failed",
                        claimedByMachineId: null,
                    }),
                }),
                expect.objectContaining({
                    body: expect.objectContaining({
                        t: "automation-run-state-changed",
                        automationId: exhausted.automation.id,
                        previousState: null,
                        currentState: "queued",
                        claimedByMachineId: null,
                    }),
                }),
            ]);
        } finally {
            eventRouter.removeConnection(exhausted.account.id, observer);
        }
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: exhausted.run.id },
            select: {
                state: true,
                executionDispatchState: true,
                executionAttempt: true,
                executionDispatchCommittedAt: true,
                executionDispatchDueAt: true,
                executionNativeRunId: true,
                executionNativeCallId: true,
                executionNativeSidechainId: true,
                finishedAt: true,
                claimedByMachineId: true,
                leaseExpiresAt: true,
                errorCode: true,
                errorMessage: true,
                revision: true,
            },
        })).resolves.toEqual({
            state: "failed",
            executionDispatchState: "settled",
            executionAttempt: 3,
            executionDispatchCommittedAt: null,
            executionDispatchDueAt: null,
            executionNativeRunId: null,
            executionNativeCallId: null,
            executionNativeSidechainId: null,
            finishedAt: expect.any(Date),
            claimedByMachineId: null,
            leaseExpiresAt: null,
            errorCode: "execution_run_retry_exhausted",
            errorMessage: null,
            revision: 1,
        });
        await expect(db.automationRunEvent.findMany({
            where: { runId: exhausted.run.id },
            select: { type: true },
        })).resolves.toEqual([{ type: "run_failed" }]);
        await expect(db.automationRun.findMany({
            where: { automationId: exhausted.automation.id },
            orderBy: [{ createdAt: "asc" }],
            select: { state: true, dueAt: true },
        })).resolves.toEqual([
            expect.objectContaining({ state: "failed" }),
            expect.objectContaining({ state: "queued", dueAt: expect.any(Date) }),
        ]);
        await expect(db.automation.findUniqueOrThrow({
            where: { id: exhausted.automation.id },
            select: { lastRunAt: true, nextRunAt: true },
        })).resolves.toEqual({
            lastRunAt: null,
            nextRunAt: expect.any(Date),
        });
    });

    it("does not terminalize an exhausted execution retry from stale currentness or claim authority", async () => {
        const seeded = await seedExecutionDispatchRun({
            id: "run-execution-dispatch-exhausted-stale-authority",
            executionDispatchState: "retryWaiting",
            executionAttempt: 3,
        });
        const currentness = await readAutomationAccountCurrentness(seeded.account.id);
        const before = await db.automationRun.findUniqueOrThrow({
            where: { id: seeded.run.id },
            select: {
                state: true,
                executionDispatchState: true,
                executionAttempt: true,
                finishedAt: true,
                claimedByMachineId: true,
                leaseExpiresAt: true,
                errorCode: true,
                revision: true,
            },
        });

        await expect(startAutomationRun({
            accountId: seeded.account.id,
            runId: seeded.run.id,
            machineId: "machine-not-the-claim-owner",
            attempt: 1,
            accountCurrentness: currentness,
        })).resolves.toBeNull();
        await expect(startAutomationRun({
            accountId: seeded.account.id,
            runId: seeded.run.id,
            machineId: seeded.machine.id,
            attempt: 2,
            accountCurrentness: currentness,
        })).resolves.toBeNull();
        await expect(startAutomationRun({
            accountId: seeded.account.id,
            runId: seeded.run.id,
            machineId: seeded.machine.id,
            attempt: 1,
            accountCurrentness: { ...currentness, version: currentness.version + 1 },
        })).resolves.toBeNull();
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: seeded.run.id },
            select: {
                state: true,
                executionDispatchState: true,
                executionAttempt: true,
                finishedAt: true,
                claimedByMachineId: true,
                leaseExpiresAt: true,
                errorCode: true,
                revision: true,
            },
        })).resolves.toEqual(before);
        await expect(db.automationRunEvent.count({
            where: { runId: seeded.run.id },
        })).resolves.toBe(0);
    });

    it("allows only one concurrent worker to terminalize an exhausted execution retry", async () => {
        const seeded = await seedExecutionDispatchRun({
            id: "run-execution-dispatch-exhausted-concurrent",
            executionDispatchState: "retryWaiting",
            executionAttempt: 3,
        });
        const currentness = await readAutomationAccountCurrentness(seeded.account.id);

        await expect(Promise.all([
            startAutomationRun({
                accountId: seeded.account.id,
                runId: seeded.run.id,
                machineId: seeded.machine.id,
                attempt: 1,
                accountCurrentness: currentness,
            }),
            startAutomationRun({
                accountId: seeded.account.id,
                runId: seeded.run.id,
                machineId: seeded.machine.id,
                attempt: 1,
                accountCurrentness: currentness,
            }),
        ])).resolves.toEqual([null, null]);
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: seeded.run.id },
            select: {
                state: true,
                executionDispatchState: true,
                finishedAt: true,
                claimedByMachineId: true,
                leaseExpiresAt: true,
                revision: true,
            },
        })).resolves.toEqual({
            state: "failed",
            executionDispatchState: "settled",
            finishedAt: expect.any(Date),
            claimedByMachineId: null,
            leaseExpiresAt: null,
            revision: 1,
        });
        await expect(db.automationRunEvent.findMany({
            where: { runId: seeded.run.id },
            select: { type: true },
        })).resolves.toEqual([{ type: "run_failed" }]);
    });

    it("durably requeues only a strict noRunCreated dispatch result under the same Automation Run", async () => {
        const seeded = await seedExecutionDispatchRun({
            id: "run-execution-dispatch-retry",
            state: "running",
            executionDispatchState: "dispatchPermitted",
            executionAttempt: 1,
        });
        const settle = readExecutionDispatchSettlementOwner();

        await settle({
            accountId: seeded.account.id,
            runId: seeded.run.id,
            machineId: seeded.machine.id,
            attempt: 1,
            accountCurrentness: await readAutomationAccountCurrentness(seeded.account.id),
            outcome: {
                kind: "noRunCreated",
                errorCode: "execution_run_target_unavailable",
            },
        });

        const updated = await db.automationRun.findUniqueOrThrow({
            where: { id: seeded.run.id },
            select: {
                state: true,
                executionDispatchState: true,
                executionAttempt: true,
                executionDispatchDueAt: true,
                dueAt: true,
                claimedByMachineId: true,
                leaseExpiresAt: true,
                executionNativeRunId: true,
            },
        });
        expect(updated).toEqual(expect.objectContaining({
            state: "queued",
            executionDispatchState: "retryWaiting",
            executionAttempt: 1,
            claimedByMachineId: null,
            leaseExpiresAt: null,
            executionNativeRunId: null,
        }));
        expect(updated.executionDispatchDueAt).not.toBeNull();
        expect(updated.dueAt).toEqual(updated.executionDispatchDueAt);

        const exhausted = await seedExecutionDispatchRun({
            id: "run-execution-dispatch-third-no-run-created",
            state: "running",
            executionDispatchState: "dispatchPermitted",
            executionAttempt: 3,
        });
        await settle({
            accountId: exhausted.account.id,
            runId: exhausted.run.id,
            machineId: exhausted.machine.id,
            attempt: 1,
            accountCurrentness: await readAutomationAccountCurrentness(exhausted.account.id),
            outcome: {
                kind: "noRunCreated",
                errorCode: "execution_run_target_unavailable",
            },
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: exhausted.run.id },
            select: {
                state: true,
                executionDispatchState: true,
                executionAttempt: true,
                executionDispatchDueAt: true,
                finishedAt: true,
                claimedByMachineId: true,
                leaseExpiresAt: true,
            },
        })).resolves.toEqual({
            state: "failed",
            executionDispatchState: "settled",
            executionAttempt: 3,
            executionDispatchDueAt: null,
            finishedAt: expect.any(Date),
            claimedByMachineId: null,
            leaseExpiresAt: null,
        });
    });

    it("persists returned native identity and nested wait timeout as started-but-uncertain with no redispatch", async () => {
        const seeded = await seedExecutionDispatchRun({
            id: "run-execution-dispatch-wait-timeout",
            state: "running",
            executionDispatchState: "dispatchPermitted",
            executionAttempt: 1,
        });
        const settle = readExecutionDispatchSettlementOwner();

        await settle({
            accountId: seeded.account.id,
            runId: seeded.run.id,
            machineId: seeded.machine.id,
            attempt: 1,
            accountCurrentness: await readAutomationAccountCurrentness(seeded.account.id),
            outcome: {
                kind: "started",
                runId: "native-run-timeout",
                callId: "native-call-timeout",
                sidechainId: "native-sidechain-timeout",
                wait: { ok: false, code: "timeout" },
            },
        });

        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: seeded.run.id },
            select: {
                state: true,
                executionDispatchState: true,
                executionAttempt: true,
                executionNativeRunId: true,
                executionNativeCallId: true,
                executionNativeSidechainId: true,
                claimedByMachineId: true,
                leaseExpiresAt: true,
            },
        })).resolves.toEqual({
            state: "outcome_uncertain",
            executionDispatchState: "started",
            executionAttempt: 1,
            executionNativeRunId: "native-run-timeout",
            executionNativeCallId: "native-call-timeout",
            executionNativeSidechainId: "native-sidechain-timeout",
            claimedByMachineId: null,
            leaseExpiresAt: null,
        });
    });

    it("commits an unclassified or lost start response as outcomeUnknown with no fresh-attempt permission", async () => {
        const seeded = await seedExecutionDispatchRun({
            id: "run-execution-dispatch-unknown",
            state: "running",
            executionDispatchState: "dispatchPermitted",
            executionAttempt: 1,
        });
        const settle = readExecutionDispatchSettlementOwner();

        await settle({
            accountId: seeded.account.id,
            runId: seeded.run.id,
            machineId: seeded.machine.id,
            attempt: 1,
            accountCurrentness: await readAutomationAccountCurrentness(seeded.account.id),
            outcome: {
                kind: "outcomeUnknown",
                errorCode: "execution_run_target_unavailable",
            },
        });

        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: seeded.run.id },
            select: {
                state: true,
                executionDispatchState: true,
                executionAttempt: true,
                executionDispatchDueAt: true,
                executionNativeRunId: true,
            },
        })).resolves.toEqual({
            state: "outcome_uncertain",
            executionDispatchState: "outcomeUnknown",
            executionAttempt: 1,
            executionDispatchDueAt: null,
            executionNativeRunId: null,
        });
    });

    it("keeps a permitted dispatch uncertain when generic cancellation races the worker and still retains the learned native identity", async () => {
        const seeded = await seedExecutionDispatchRun({
            id: "run-execution-dispatch-cancel-race",
            state: "running",
            executionDispatchState: "dispatchPermitted",
            executionAttempt: 1,
        });
        // S: the exact witness the worker holds from its start response.
        const startWitness = await readAutomationAccountCurrentness(seeded.account.id);

        // The user cancels while `execution.run.start` is already in flight.
        // Nothing durably establishes that the external execution stopped, so
        // the Run may not be reported as cleanly cancelled.
        const cancelled = await cancelAutomationRun({
            accountId: seeded.account.id,
            runId: seeded.run.id,
        });
        expect(cancelled).toEqual(expect.objectContaining({
            state: "outcome_uncertain",
            executionDispatchState: "outcomeUnknown",
        }));
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: seeded.run.id },
            select: {
                state: true,
                executionDispatchState: true,
                executionDispatchDueAt: true,
                executionNativeRunId: true,
                finishedAt: true,
                claimedByMachineId: true,
                leaseExpiresAt: true,
                errorCode: true,
            },
        })).resolves.toEqual({
            state: "outcome_uncertain",
            executionDispatchState: "outcomeUnknown",
            executionDispatchDueAt: null,
            executionNativeRunId: null,
            finishedAt: expect.any(Date),
            // Cancellation keeps the claiming machine's authority on the row
            // exactly as it already does for a plain cancelled Run, so the
            // worker that owns the dispatch can still report what it learned.
            claimedByMachineId: seeded.machine.id,
            leaseExpiresAt: expect.any(Date),
            errorCode: "execution_run_cancelled_outcome_unknown",
        });

        // The worker's start had already returned a native identity. The
        // dispatch settlement owner remains the only writer of dispatch truth:
        // it retains that identity so the uncertainty stays resolvable, and it
        // does not rewrite the terminality cancellation already published.
        //
        // The worker echoes the exact post-start witness S it captured before
        // the effect. Cancellation itself published an Account change, so S is
        // necessarily behind the current Account version by the time the
        // dispatch result arrives; settlement must still retain the identity.
        const settle = readExecutionDispatchSettlementOwner();
        const settled = await settle({
            accountId: seeded.account.id,
            runId: seeded.run.id,
            machineId: seeded.machine.id,
            attempt: 1,
            accountCurrentness: startWitness,
            outcome: {
                kind: "started",
                runId: "native-run-cancel-race",
                callId: "native-call-cancel-race",
                sidechainId: "native-sidechain-cancel-race",
                wait: { ok: false, code: "timeout" },
            },
        });
        expect(settled).not.toBeNull();
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: seeded.run.id },
            select: {
                state: true,
                executionDispatchState: true,
                executionAttempt: true,
                executionNativeRunId: true,
                executionNativeCallId: true,
                executionNativeSidechainId: true,
                errorCode: true,
            },
        })).resolves.toEqual({
            state: "outcome_uncertain",
            executionDispatchState: "outcomeUnknown",
            executionAttempt: 1,
            executionNativeRunId: "native-run-cancel-race",
            executionNativeCallId: "native-call-cancel-race",
            executionNativeSidechainId: "native-sidechain-cancel-race",
            errorCode: "execution_run_cancelled_outcome_unknown",
        });
    });

    it("persists the returned native execution identity when an unrelated Account write moves the global sequence", async () => {
        const seeded = await seedExecutionDispatchRun({
            id: "run-execution-dispatch-unrelated-seq",
            state: "running",
            executionDispatchState: "dispatchPermitted",
            executionAttempt: 1,
        });
        // S: the exact witness the worker holds from its start response.
        const startWitness = await readAutomationAccountCurrentness(seeded.account.id);

        // Any unrelated Account-scoped write advances Account.seq. It changes
        // no Automation fact and no encryption identity, so it must not cost
        // the Run the only pointer back to a real running external execution.
        await inTx(async (tx) => {
            await markAccountChanged(tx, {
                accountId: seeded.account.id,
                kind: "kv",
                entityId: "unrelated-key",
            });
        });
        const movedWitness = await readAutomationAccountCurrentness(seeded.account.id);
        expect(movedWitness.version).toBeGreaterThan(startWitness.version);
        expect(movedWitness.mode).toBe(startWitness.mode);
        expect(movedWitness.contentKeyFingerprint).toBe(startWitness.contentKeyFingerprint);

        const settle = readExecutionDispatchSettlementOwner();
        const settled = await settle({
            accountId: seeded.account.id,
            runId: seeded.run.id,
            machineId: seeded.machine.id,
            attempt: 1,
            accountCurrentness: startWitness,
            outcome: {
                kind: "started",
                runId: "native-run-unrelated-seq",
                callId: "native-call-unrelated-seq",
                sidechainId: "native-sidechain-unrelated-seq",
                wait: { ok: false, code: "timeout" },
            },
        });
        expect(settled).not.toBeNull();
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: seeded.run.id },
            select: {
                state: true,
                executionDispatchState: true,
                executionAttempt: true,
                executionNativeRunId: true,
                executionNativeCallId: true,
                executionNativeSidechainId: true,
            },
        })).resolves.toEqual({
            state: "outcome_uncertain",
            executionDispatchState: "started",
            executionAttempt: 1,
            executionNativeRunId: "native-run-unrelated-seq",
            executionNativeCallId: "native-call-unrelated-seq",
            executionNativeSidechainId: "native-sidechain-unrelated-seq",
        });
    });

    it("still refuses a noRunCreated redispatch permission after an unrelated Account write", async () => {
        const seeded = await seedExecutionDispatchRun({
            id: "run-execution-dispatch-unrelated-seq-retry",
            state: "running",
            executionDispatchState: "dispatchPermitted",
            executionAttempt: 1,
        });
        const startWitness = await readAutomationAccountCurrentness(seeded.account.id);
        await inTx(async (tx) => {
            await markAccountChanged(tx, {
                accountId: seeded.account.id,
                kind: "kv",
                entityId: "unrelated-key",
            });
        });

        // Redispatch permission is a pre-effect decision. It keeps the exact
        // witness: nothing external has run, so a stale claimant may not
        // re-authorize a new attempt.
        const settle = readExecutionDispatchSettlementOwner();
        await expect(settle({
            accountId: seeded.account.id,
            runId: seeded.run.id,
            machineId: seeded.machine.id,
            attempt: 1,
            accountCurrentness: startWitness,
            outcome: { kind: "noRunCreated", errorCode: "execution_run_not_created" },
        })).resolves.toBeNull();
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: seeded.run.id },
            select: { state: true, executionDispatchState: true, executionAttempt: true },
        })).resolves.toEqual({
            state: "running",
            executionDispatchState: "dispatchPermitted",
            executionAttempt: 1,
        });
    });

    it("refuses a started dispatch settlement whose witness names a different Account encryption identity", async () => {
        const seeded = await seedExecutionDispatchRun({
            id: "run-execution-dispatch-mode-transition",
            state: "running",
            executionDispatchState: "dispatchPermitted",
            executionAttempt: 1,
        });
        const startWitness = await readAutomationAccountCurrentness(seeded.account.id);

        // Relaxing the post-effect decision to content identity is not the
        // same as dropping it. A witness naming a different Account
        // encryption mode and content key may not terminalize the Run or
        // persist its native identity, so the encryption transition still
        // fences the one write the effect permit authorized.
        const settle = readExecutionDispatchSettlementOwner();
        await expect(settle({
            accountId: seeded.account.id,
            runId: seeded.run.id,
            machineId: seeded.machine.id,
            attempt: 1,
            accountCurrentness: {
                ...startWitness,
                mode: "e2ee",
                contentKeyFingerprint: "different-current-key",
            },
            outcome: {
                kind: "started",
                runId: "native-run-mode-transition",
                callId: "native-call-mode-transition",
                sidechainId: "native-sidechain-mode-transition",
                wait: { ok: false, code: "timeout" },
            },
        })).resolves.toBeNull();
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: seeded.run.id },
            select: {
                state: true,
                executionDispatchState: true,
                executionNativeRunId: true,
            },
        })).resolves.toEqual({
            state: "running",
            executionDispatchState: "dispatchPermitted",
            executionNativeRunId: null,
        });
    });

    it("refuses a generic success or failure claim over a permitted dispatch", async () => {
        const succeedSeed = await seedExecutionDispatchRun({
            id: "run-execution-dispatch-generic-succeed",
            state: "running",
            executionDispatchState: "dispatchPermitted",
            executionAttempt: 1,
        });
        await expect(succeedAutomationRun({
            accountId: succeedSeed.account.id,
            runId: succeedSeed.run.id,
            machineId: succeedSeed.machine.id,
            attempt: 1,
            accountCurrentness: await readAutomationAccountCurrentness(succeedSeed.account.id),
        })).resolves.toBeNull();

        const failSeed = await seedExecutionDispatchRun({
            id: "run-execution-dispatch-generic-fail",
            state: "running",
            executionDispatchState: "dispatchPermitted",
            executionAttempt: 1,
        });
        await expect(failAutomationRun({
            accountId: failSeed.account.id,
            runId: failSeed.run.id,
            machineId: failSeed.machine.id,
            attempt: 1,
            accountCurrentness: await readAutomationAccountCurrentness(failSeed.account.id),
            errorCode: "worker_said_so",
        })).resolves.toBeNull();

        await expect(db.automationRun.findMany({
            where: { id: { in: [succeedSeed.run.id, failSeed.run.id] } },
            orderBy: { id: "asc" },
            select: { state: true, executionDispatchState: true },
        })).resolves.toEqual([
            { state: "running", executionDispatchState: "dispatchPermitted" },
            { state: "running", executionDispatchState: "dispatchPermitted" },
        ]);
    });

    it("projects a committed Run state transition only to Account machine observers", async () => {
        const seeded = await createAccountMachineAutomation({
            publicKey: "pk-automation-run-state-observer",
            machineId: "machine-run-state-observer",
            automationName: "Observed automation",
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
        const updates: UpdatePayload[] = [];
        const observer = createMachineConnection({
            accountId: seeded.accountId,
            machineId: seeded.machineId,
            updates,
        });
        eventRouter.addConnection(seeded.accountId, observer);
        try {
            const started = await startAutomationRun({
                accountId: seeded.accountId,
                runId: run.id,
                machineId: seeded.machineId,
                attempt: 1,
                accountCurrentness: await readAutomationAccountCurrentness(seeded.accountId),
            });

            expect(started?.run.state).toBe("running");
            expect(updates).toEqual([
                expect.objectContaining({
                    body: {
                        t: "automation-run-state-changed",
                        runId: run.id,
                        automationId: seeded.automationId,
                        originKind: "scheduled",
                        previousState: "claimed",
                        currentState: "running",
                        transitionedAt: expect.any(Number),
                        claimedByMachineId: seeded.machineId,
                    },
                }),
            ]);
        } finally {
            eventRouter.removeConnection(seeded.accountId, observer);
        }
    });

    it("names the authoritative cancellation cause on the machine lifecycle carrier when a permitted dispatch is cancelled", async () => {
        const seeded = await seedExecutionDispatchRun({
            id: "run-execution-dispatch-cancel-cause",
            state: "running",
            executionDispatchState: "dispatchPermitted",
            executionAttempt: 1,
        });
        const updates: UpdatePayload[] = [];
        const observer = createMachineConnection({
            accountId: seeded.account.id,
            machineId: seeded.machine.id,
            updates,
        });
        eventRouter.addConnection(seeded.account.id, observer);
        try {
            const cancelled = await cancelAutomationRun({
                accountId: seeded.account.id,
                runId: seeded.run.id,
            });
            expect(cancelled?.state).toBe("outcome_uncertain");
            // The published state is uncertain, so the observing machine can
            // only distinguish "the user cancelled this" from "your attempt
            // went stale" through the explicit cause.
            expect(updates.map((update) => update.body)).toContainEqual(
                expect.objectContaining({
                    t: "automation-run-state-changed",
                    runId: seeded.run.id,
                    currentState: "outcome_uncertain",
                    cause: "cancelledAfterDispatchPermitted",
                }),
            );
        } finally {
            eventRouter.removeConnection(seeded.account.id, observer);
        }
    });

    it("publishes no cancellation cause when the Run had not been permitted to dispatch", async () => {
        const seeded = await seedExecutionDispatchRun({
            id: "run-execution-dispatch-cancel-no-cause",
            state: "running",
            executionDispatchState: "notStarted",
            executionAttempt: 0,
        });
        const updates: UpdatePayload[] = [];
        const observer = createMachineConnection({
            accountId: seeded.account.id,
            machineId: seeded.machine.id,
            updates,
        });
        eventRouter.addConnection(seeded.account.id, observer);
        try {
            const cancelled = await cancelAutomationRun({
                accountId: seeded.account.id,
                runId: seeded.run.id,
            });
            expect(cancelled?.state).toBe("cancelled");
            const cancelledTransition = updates
                .map((update) => update.body as Record<string, unknown>)
                .find((body) => body.t === "automation-run-state-changed"
                    && body.runId === seeded.run.id);
            expect(cancelledTransition).toEqual(expect.objectContaining({
                currentState: "cancelled",
            }));
            expect(cancelledTransition).not.toHaveProperty("cause");
        } finally {
            eventRouter.removeConnection(seeded.account.id, observer);
        }
    });

    it("settles a Conversation result and makes its pre-frozen reply handoff ready in the same Run transition", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const machine = await db.machine.create({
            data: { id: "machine-conversation-reply", accountId: account.id, metadata: "{}" },
            select: { id: true },
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Conversation reply",
                enabled: true,
                targetType: "new_session",
                templateCiphertext: JSON.stringify({
                    kind: "happier_automation_template_plain_v1",
                    payload: { prompt: "reply" },
                }),
                templateVersion: 1,
                triggerKind: "conversation",
                triggerDefinitionEnvelope: JSON.stringify({ t: "plain", v: {} }),
            },
            select: { id: true },
        });
        const run = await db.automationRun.create({
            data: {
                id: "run-conversation-reply-ready",
                automationId: automation.id,
                accountId: account.id,
                state: "running",
                originKind: "conversation",
                originOccurredAt: new Date(Date.now() - 60_000),
                occurrenceKey: "conversation-occurrence-ready",
                triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: {} }),
                replyContextEnvelope: JSON.stringify({
                    t: "plain",
                    v: {
                        v: 1,
                        correspondence: {
                            automationId: automation.id,
                            occurrenceKey: "conversation-occurrence-ready",
                        },
                        templateVersion: 1,
                        opaqueContext: { conversationId: "conversation-1" },
                    },
                }),
                replyHandoffActionPluginId: "happier.channels",
                replyHandoffActionLocalId: "automation/result-deliver-v1",
                replyHandoffTargetMachineId: machine.id,
                replyHandoffTargetMachineInstallationId: "installation-1",
                replyHandoffTargetMaterializationId: "materialization-1",
                replyHandoffId: "handoff-conversation-reply-ready",
                replyHandoffState: "awaitingResult",
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 30_000),
                startedAt: new Date(Date.now() - 20_000),
                claimedByMachineId: machine.id,
                leaseExpiresAt: new Date(Date.now() + 30_000),
                attempt: 1,
            },
            select: { id: true },
        });
        const resultEnvelope = JSON.stringify({
            t: "plain",
            v: {
                v: 1,
                correspondence: {
                    accountId: account.id,
                    automationId: automation.id,
                    runId: run.id,
                    handoffId: "handoff-conversation-reply-ready",
                },
                result: { v: 1, kind: "text", text: "Finished" },
            },
        });

        const succeeded = await succeedAutomationRun({
            accountId: account.id,
            runId: run.id,
            machineId: machine.id,
            attempt: 1,
            accountCurrentness: await readAutomationAccountCurrentness(account.id),
            resultEnvelope,
        });

        expect(succeeded).toEqual(expect.objectContaining({
            id: run.id,
            state: "succeeded",
            resultEnvelope,
            replyHandoffState: "ready",
            replyHandoffAttempt: 0,
            replyHandoffReceiptEnvelope: null,
        }));
        expect(succeeded?.replyHandoffDueAt).not.toBeNull();
    });

    it("settles strict no-result-delivery Conversations with a null result envelope and no reply handoff or wake", async () => {
        const account = await db.account.create({
            data: {
                id: "account-conversation-no-result-delivery",
                publicKey: null,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const machine = await db.machine.create({
            data: {
                id: "machine-conversation-no-result-delivery",
                accountId: account.id,
                metadata: "{}",
            },
            select: { id: true },
        });
        const automation = await db.automation.create({
            data: {
                id: "automation-conversation-no-result-delivery",
                accountId: account.id,
                name: "Conversation without result delivery",
                enabled: true,
                targetType: "new_session",
                templateCiphertext: JSON.stringify({
                    kind: "happier_automation_template_plain_v1",
                    payload: { prompt: "reply without delivery" },
                }),
                templateVersion: 1,
                triggerKind: "conversation",
                triggerDefinitionEnvelope: JSON.stringify({ t: "plain", v: {} }),
            },
            select: { id: true },
        });
        const createNoHandoffRun = async (id: string, occurrenceKey: string) => await db.automationRun.create({
            data: {
                id,
                automationId: automation.id,
                accountId: account.id,
                state: "running",
                originKind: "conversation",
                originOccurredAt: new Date(Date.now() - 60_000),
                occurrenceKey,
                triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: {} }),
                replyContextEnvelope: null,
                replyHandoffActionPluginId: null,
                replyHandoffActionLocalId: null,
                replyHandoffTargetMachineId: null,
                replyHandoffTargetMachineInstallationId: null,
                replyHandoffTargetMaterializationId: null,
                replyHandoffId: null,
                replyHandoffState: "none",
                replyHandoffAttempt: 0,
                replyHandoffDueAt: null,
                replyHandoffReceiptEnvelope: null,
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 30_000),
                startedAt: new Date(Date.now() - 20_000),
                claimedByMachineId: machine.id,
                leaseExpiresAt: new Date(Date.now() + 30_000),
                attempt: 1,
            },
            select: { id: true },
        });
        const rejectedRun = await createNoHandoffRun(
            "run-conversation-no-result-delivery-rejected",
            "conversation-occurrence-no-result-delivery-rejected",
        );
        const run = await createNoHandoffRun(
            "run-conversation-no-result-delivery",
            "conversation-occurrence-no-result-delivery",
        );
        const currentness = await readAutomationAccountCurrentness(account.id);
        const mismatchedCorrespondences = [
            { accountId: "other-account", automationId: automation.id, runId: rejectedRun.id },
            { accountId: account.id, automationId: "other-automation", runId: rejectedRun.id },
            { accountId: account.id, automationId: automation.id, runId: run.id },
        ] as const;
        for (const correspondence of mismatchedCorrespondences) {
            await expect(succeedAutomationRun({
                accountId: account.id,
                runId: rejectedRun.id,
                machineId: machine.id,
                attempt: 1,
                accountCurrentness: currentness,
                resultEnvelope: JSON.stringify({
                    t: "plain",
                    v: {
                        v: 1,
                        correspondence,
                        result: { v: 1, kind: "text", text: "Wrong no-handoff correspondence" },
                    },
                }),
            })).resolves.toBeNull();
        }
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: rejectedRun.id },
            select: {
                state: true,
                resultEnvelope: true,
                replyHandoffState: true,
                replyHandoffDueAt: true,
            },
        })).resolves.toEqual({
            state: "running",
            resultEnvelope: null,
            replyHandoffState: "none",
            replyHandoffDueAt: null,
        });
        const succeeded = await succeedAutomationRun({
            accountId: account.id,
            runId: run.id,
            machineId: machine.id,
            attempt: 1,
            accountCurrentness: currentness,
            resultEnvelope: null,
        });

        expect(succeeded).toEqual(expect.objectContaining({
            id: run.id,
            state: "succeeded",
            resultEnvelope: null,
            replyContextEnvelope: null,
            replyHandoffActionPluginId: null,
            replyHandoffActionLocalId: null,
            replyHandoffTargetMachineId: null,
            replyHandoffTargetMachineInstallationId: null,
            replyHandoffTargetMaterializationId: null,
            replyHandoffId: null,
            replyHandoffState: "none",
            replyHandoffAttempt: 0,
            replyHandoffDueAt: null,
            replyHandoffReceiptEnvelope: null,
        }));
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: run.id },
            select: {
                state: true,
                resultEnvelope: true,
                replyContextEnvelope: true,
                replyHandoffActionPluginId: true,
                replyHandoffActionLocalId: true,
                replyHandoffTargetMachineId: true,
                replyHandoffTargetMachineInstallationId: true,
                replyHandoffTargetMaterializationId: true,
                replyHandoffId: true,
                replyHandoffState: true,
                replyHandoffAttempt: true,
                replyHandoffDueAt: true,
                replyHandoffReceiptEnvelope: true,
            },
        })).resolves.toEqual({
            state: "succeeded",
            resultEnvelope: null,
            replyContextEnvelope: null,
            replyHandoffActionPluginId: null,
            replyHandoffActionLocalId: null,
            replyHandoffTargetMachineId: null,
            replyHandoffTargetMachineInstallationId: null,
            replyHandoffTargetMaterializationId: null,
            replyHandoffId: null,
            replyHandoffState: "none",
            replyHandoffAttempt: 0,
            replyHandoffDueAt: null,
            replyHandoffReceiptEnvelope: null,
        });
        const now = new Date();
        await expect(findNextAutomationReplyHandoffDueAt({ now })).resolves.toBeNull();
        await expect(claimNextAutomationReplyHandoff({ now })).resolves.toBeNull();
    });

    it.each(["missing result envelope", "wrong Account mode", "wrong plain correspondence"])(
        "rejects a Conversation result with %s before any Run settlement effects",
        async (caseName) => {
            const seeded = await seedConversationRunForResultValidation();
            const resultEnvelope = caseName === "missing result envelope"
                ? undefined
                : caseName === "wrong Account mode"
                    ? JSON.stringify({ t: "encrypted", c: "opaque-ciphertext" })
                    : JSON.stringify({
                        t: "plain",
                        v: {
                            v: 1,
                            correspondence: {
                                accountId: seeded.account.id,
                                automationId: seeded.automation.id,
                                runId: "other-run",
                                handoffId: "handoff-conversation-result-validation",
                            },
                            result: { v: 1, kind: "text", text: "Wrong correspondence" },
                        },
                    });

            await expect(succeedAutomationRun({
                accountId: seeded.account.id,
                runId: seeded.run.id,
                machineId: seeded.machine.id,
                attempt: 1,
                accountCurrentness: await readAutomationAccountCurrentness(seeded.account.id),
                ...(resultEnvelope === undefined ? {} : { resultEnvelope }),
            })).resolves.toBeNull();
            await expect(db.automationRun.findUniqueOrThrow({
                where: { id: seeded.run.id },
                select: {
                    state: true,
                    resultEnvelope: true,
                    replyHandoffState: true,
                    replyHandoffDueAt: true,
                },
            })).resolves.toEqual({
                state: "running",
                resultEnvelope: null,
                replyHandoffState: "awaitingResult",
                replyHandoffDueAt: null,
            });
            await expect(db.automationRunEvent.count({
                where: { runId: seeded.run.id },
            })).resolves.toBe(0);
        },
    );

    it.each(["failed", "cancelled"] as const)(
        "moves an awaiting Conversation handoff to blocked when the Run is terminally %s",
        async (terminalState) => {
            const seeded = await seedConversationRunForResultValidation();

            const settled = terminalState === "failed"
                ? await failAutomationRun({
                    accountId: seeded.account.id,
                    runId: seeded.run.id,
                    machineId: seeded.machine.id,
                    attempt: 1,
                    accountCurrentness: await readAutomationAccountCurrentness(seeded.account.id),
                    errorCode: "session_turn_failed",
                })
                : await cancelAutomationRun({
                    accountId: seeded.account.id,
                    runId: seeded.run.id,
                });

            expect(settled).toEqual(expect.objectContaining({
                state: terminalState,
                replyHandoffState: "blocked",
                replyHandoffDueAt: null,
                replyHandoffReceiptEnvelope: null,
            }));
            await expect(findNextAutomationReplyHandoffDueAt({ now: new Date() })).resolves.toBeNull();
            await expect(claimNextAutomationReplyHandoff({ now: new Date() })).resolves.toBeNull();
        },
    );

    it("blocks an awaiting Conversation handoff when a retired Automation terminalizes its expired lease", async () => {
        const seeded = await seedConversationRunForResultValidation();
        // The retirement terminalizer only fires for an already-expired lease
        // whose Definition or claimant assignment is gone.
        await db.automationRun.update({
            where: { id: seeded.run.id },
            data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
        });
        await db.automation.update({
            where: { id: seeded.automation.id },
            data: { enabled: false },
        });
        const current = await db.automationRun.findUniqueOrThrow({
            where: { id: seeded.run.id },
            select: { revision: true, executionInputEnvelope: true, executionDispatchState: true },
        });

        const terminalized = await inTx(async (tx) => await terminalizeRetiredAutomationRunAfterLeaseExpiryTx({
            tx,
            accountId: seeded.account.id,
            automationId: seeded.automation.id,
            runId: seeded.run.id,
            state: "running",
            runRevision: current.revision,
            claimedByMachineId: seeded.machine.id,
            executionInputEnvelope: current.executionInputEnvelope,
            originKind: "conversation",
            executionDispatchState: current.executionDispatchState,
            accountCurrentness: await readAutomationAccountCurrentness(seeded.account.id),
            now: new Date(),
        }));

        expect(terminalized).toEqual(expect.objectContaining({
            state: "outcome_uncertain",
            replyHandoffState: "blocked",
            replyHandoffDueAt: null,
            replyHandoffReceiptEnvelope: null,
        }));
        await expect(findNextAutomationReplyHandoffDueAt({ now: new Date() })).resolves.toBeNull();
        await expect(claimNextAutomationReplyHandoff({ now: new Date() })).resolves.toBeNull();
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
        const errorDetailEnvelope = JSON.stringify({
            t: "plain",
            v: {
                v: 1,
                correspondence: {
                    automationId: seeded.automationId,
                    runId: run.id,
                },
                detail: "daemon restart happened",
            },
        });

        const failed = await failAutomationRun({
            accountId: seeded.accountId,
            runId: run.id,
            machineId: seeded.machineId,
            attempt: 1,
            accountCurrentness: await readAutomationAccountCurrentness(seeded.accountId),
            errorCode: " worker_crashed ",
            errorDetailEnvelope,
        });
        expect(failed).toEqual(
            expect.objectContaining({
                id: run.id,
                state: "failed",
                errorCode: "worker_crashed",
                errorMessage: errorDetailEnvelope,
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
            attempt: 1,
            accountCurrentness: await readAutomationAccountCurrentness(seeded.accountId),
            producedSessionId: "session-does-not-exist",
        });
        expect(succeeded).not.toBeNull();
        expect(succeeded?.state).toBe("succeeded");
        expect(succeeded?.producedSessionId).toBeNull();
    });

    it("requires and preserves the canonical Session identity for strict new-Session success", async () => {
        const seeded = await createAccountMachineAutomation({
            publicKey: "pk-automation-run-retained-success-session",
            machineId: "machine-retained-success-session",
            automationName: "Retained success session",
        });
        const run = await db.automationRun.create({
            data: {
                id: "run-retained-success-session",
                automationId: seeded.automationId,
                accountId: seeded.accountId,
                state: "running",
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 30_000),
                startedAt: new Date(Date.now() - 20_000),
                claimedByMachineId: seeded.machineId,
                leaseExpiresAt: new Date(Date.now() + 30_000),
                attempt: 1,
                executionInputEnvelope: TEST_STRICT_PLAIN_RECIPE,
            },
            select: { id: true },
        });
        const accountCurrentness = await readAutomationAccountCurrentness(seeded.accountId);
        await expect(succeedAutomationRun({
            accountId: seeded.accountId,
            runId: run.id,
            machineId: seeded.machineId,
            attempt: 1,
            accountCurrentness,
        })).resolves.toBeNull();
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: run.id },
            select: { state: true, producedSessionId: true },
        })).resolves.toEqual({ state: "running", producedSessionId: null });

        const canonicalSession = await db.session.create({
            data: {
                id: "session-retained-success-session",
                accountId: seeded.accountId,
                tag: deriveSessionCreationTagV1({
                    callerCreationNamespace: `automation:${seeded.automationId}`,
                    creationKey: `automation-run:${run.id}`,
                }),
                metadata: "{}",
            },
            select: { id: true },
        });
        await expect(retainAutomationRunProducedSession({
            accountId: seeded.accountId,
            machineId: seeded.machineId,
            runId: run.id,
            attempt: 1,
            result: sessionStartSuccess(canonicalSession.id),
        })).resolves.toEqual(expect.objectContaining({
            state: "running",
            producedSessionId: canonicalSession.id,
        }));

        await expect(succeedAutomationRun({
            accountId: seeded.accountId,
            runId: run.id,
            machineId: seeded.machineId,
            attempt: 1,
            accountCurrentness,
        })).resolves.toEqual(expect.objectContaining({
            state: "succeeded",
            producedSessionId: canonicalSession.id,
        }));
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: run.id },
            select: { state: true, producedSessionId: true },
        })).resolves.toEqual({
            state: "succeeded",
            producedSessionId: canonicalSession.id,
        });
    });

    it("retains only the canonical strict new-Session identity through failed input and cancellation settlement without a duplicate lifecycle transition", async () => {
        const seeded = await createAccountMachineAutomation({
            publicKey: "pk-automation-run-known-produced-session",
            machineId: "machine-known-produced-session",
            automationName: "Known produced session",
        });
        const run = await db.automationRun.create({
            data: {
                id: "run-known-produced-session",
                automationId: seeded.automationId,
                accountId: seeded.accountId,
                state: "running",
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 30_000),
                startedAt: new Date(Date.now() - 20_000),
                claimedByMachineId: seeded.machineId,
                leaseExpiresAt: new Date(Date.now() + 30_000),
                attempt: 1,
                executionInputEnvelope: TEST_STRICT_PLAIN_RECIPE,
            },
            select: { id: true },
        });
        const canonicalSession = await db.session.create({
            data: {
                id: "session-known-produced-session",
                accountId: seeded.accountId,
                tag: deriveSessionCreationTagV1({
                    callerCreationNamespace: `automation:${seeded.automationId}`,
                    creationKey: `automation-run:${run.id}`,
                }),
                metadata: "{}",
            },
            select: { id: true },
        });
        const otherSession = await db.session.create({
            data: {
                id: "session-other-produced-session",
                accountId: seeded.accountId,
                tag: "other-session-tag",
                metadata: "{}",
            },
            select: { id: true },
        });
        const currentness = await readAutomationAccountCurrentness(seeded.accountId);

        await expect(retainAutomationRunProducedSession({
            accountId: seeded.accountId,
            machineId: seeded.machineId,
            runId: run.id,
            attempt: 1,
            result: sessionStartSuccess(canonicalSession.id),
        })).resolves.toEqual(expect.objectContaining({
            state: "running",
            producedSessionId: canonicalSession.id,
        }));
        await expect(failAutomationRun({
            accountId: seeded.accountId,
            runId: run.id,
            machineId: seeded.machineId,
            attempt: 1,
            accountCurrentness: currentness,
            errorCode: "prompt_delivery_failed",
        })).resolves.toEqual(expect.objectContaining({
            state: "failed",
            producedSessionId: canonicalSession.id,
        }));

        const cancelledRun = await db.automationRun.create({
            data: {
                id: "run-cancelled-known-produced-session",
                automationId: seeded.automationId,
                accountId: seeded.accountId,
                state: "running",
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 30_000),
                startedAt: new Date(Date.now() - 20_000),
                claimedByMachineId: seeded.machineId,
                leaseExpiresAt: new Date(Date.now() + 30_000),
                attempt: 1,
                executionInputEnvelope: TEST_STRICT_PLAIN_RECIPE,
            },
            select: { id: true },
        });
        const cancelledSession = await db.session.create({
            data: {
                id: "session-cancelled-known-produced-session",
                accountId: seeded.accountId,
                tag: deriveSessionCreationTagV1({
                    callerCreationNamespace: `automation:${seeded.automationId}`,
                    creationKey: `automation-run:${cancelledRun.id}`,
                }),
                metadata: "{}",
            },
            select: { id: true },
        });
        await expect(cancelAutomationRun({
            accountId: seeded.accountId,
            runId: cancelledRun.id,
        })).resolves.toEqual(expect.objectContaining({ state: "cancelled" }));
        await expect(failAutomationRun({
            accountId: seeded.accountId,
            runId: cancelledRun.id,
            machineId: seeded.machineId,
            attempt: 1,
            accountCurrentness: currentness,
            producedSessionId: otherSession.id,
            errorCode: "session_start_cancelled_after_create",
        })).resolves.toBeNull();
        await expect(failAutomationRun({
            accountId: seeded.accountId,
            runId: cancelledRun.id,
            machineId: seeded.machineId,
            attempt: 1,
            accountCurrentness: {
                ...currentness,
                mode: "e2ee",
                contentKeyFingerprint: "different-current-key",
            },
            producedSessionId: cancelledSession.id,
            errorCode: "session_start_cancelled_after_create",
        })).resolves.toBeNull();
        const lifecycleUpdates: UpdatePayload[] = [];
        const legacyUpdates: UpdatePayload[] = [];
        const machineObserver = createMachineConnection({
            accountId: seeded.accountId,
            machineId: seeded.machineId,
            updates: lifecycleUpdates,
        });
        const userObserver = createUserConnection({
            accountId: seeded.accountId,
            updates: legacyUpdates,
        });
        eventRouter.addConnection(seeded.accountId, machineObserver);
        eventRouter.addConnection(seeded.accountId, userObserver);
        try {
            const retained = await failAutomationRun({
                accountId: seeded.accountId,
                runId: cancelledRun.id,
                machineId: seeded.machineId,
                attempt: 1,
                accountCurrentness: currentness,
                producedSessionId: cancelledSession.id,
                errorCode: "session_start_cancelled_after_create",
            });
            expect(retained).toEqual(expect.objectContaining({
                state: "cancelled",
                producedSessionId: cancelledSession.id,
                errorCode: null,
            }));
            expect(lifecycleUpdates).toEqual([]);
            expect(legacyUpdates).toEqual([
                expect.objectContaining({
                    body: expect.objectContaining({
                        t: "automation-run-updated",
                        runId: cancelledRun.id,
                        state: "cancelled",
                    }),
                }),
            ]);
        } finally {
            eventRouter.removeConnection(seeded.accountId, machineObserver);
            eventRouter.removeConnection(seeded.accountId, userObserver);
        }
        await expect(db.automationRunEvent.findMany({
            where: { runId: cancelledRun.id },
            orderBy: [{ ts: "asc" }],
            select: { type: true },
        })).resolves.toEqual([{ type: "run_cancelled" }]);
    });

    it("retains a canonical created Session before cancellation without changing the Run lifecycle", async () => {
        const seeded = await createAccountMachineAutomation({
            publicKey: "pk-automation-run-retain-before-cancel",
            machineId: "machine-retain-before-cancel",
            automationName: "Retain before cancellation",
        });
        const run = await db.automationRun.create({
            data: {
                id: "run-retain-before-cancel",
                automationId: seeded.automationId,
                accountId: seeded.accountId,
                state: "running",
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 30_000),
                startedAt: new Date(Date.now() - 20_000),
                claimedByMachineId: seeded.machineId,
                leaseExpiresAt: new Date(Date.now() + 30_000),
                attempt: 1,
                executionInputEnvelope: TEST_STRICT_PLAIN_RECIPE,
                resultEnvelope: "preserved-result",
                errorCode: "preserved-code",
                errorMessage: "preserved message",
            },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                id: "session-retain-before-cancel",
                accountId: seeded.accountId,
                tag: deriveSessionCreationTagV1({
                    callerCreationNamespace: `automation:${seeded.automationId}`,
                    creationKey: `automation-run:${run.id}`,
                }),
                metadata: "{}",
            },
            select: { id: true },
        });
        const before = await db.automationRun.findUniqueOrThrow({
            where: { id: run.id },
            select: {
                state: true,
                finishedAt: true,
                resultEnvelope: true,
                errorCode: true,
                errorMessage: true,
                revision: true,
                producedSessionId: true,
            },
        });

        await expect(retainAutomationRunProducedSession({
            accountId: seeded.accountId,
            machineId: seeded.machineId,
            runId: run.id,
            attempt: 1,
            result: sessionStartSuccess(session.id),
        })).resolves.toEqual(expect.objectContaining({
            id: run.id,
            state: "running",
            producedSessionId: session.id,
        }));

        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: run.id },
            select: {
                state: true,
                finishedAt: true,
                resultEnvelope: true,
                errorCode: true,
                errorMessage: true,
                revision: true,
                producedSessionId: true,
            },
        })).resolves.toEqual({
            ...before,
            revision: before.revision + 1,
            producedSessionId: session.id,
        });
        await expect(retainAutomationRunProducedSession({
            accountId: seeded.accountId,
            machineId: seeded.machineId,
            runId: run.id,
            attempt: 1,
            result: sessionStartSuccess(session.id),
        })).resolves.toEqual(expect.objectContaining({
            id: run.id,
            state: "running",
            revision: before.revision + 1,
            producedSessionId: session.id,
        }));
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: run.id },
            select: {
                state: true,
                finishedAt: true,
                resultEnvelope: true,
                errorCode: true,
                errorMessage: true,
                revision: true,
                producedSessionId: true,
            },
        })).resolves.toEqual({
            ...before,
            revision: before.revision + 1,
            producedSessionId: session.id,
        });
        await expect(db.automationRunEvent.findMany({
            where: { runId: run.id },
            select: { type: true },
        })).resolves.toEqual([]);

        await expect(cancelAutomationRun({
            accountId: seeded.accountId,
            runId: run.id,
        })).resolves.toEqual(expect.objectContaining({
            state: "cancelled",
            producedSessionId: session.id,
        }));
    });

    it("does not retain a same-tag Session with missing canonical correspondence from an unknown outcome", async () => {
        const seeded = await createAccountMachineAutomation({
            publicKey: "pk-automation-run-cancel-before-retain",
            machineId: "machine-cancel-before-retain",
            automationName: "Cancel before retention",
        });
        const run = await db.automationRun.create({
            data: {
                id: "run-cancel-before-retain",
                automationId: seeded.automationId,
                accountId: seeded.accountId,
                state: "running",
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 30_000),
                startedAt: new Date(Date.now() - 20_000),
                claimedByMachineId: seeded.machineId,
                leaseExpiresAt: new Date(Date.now() + 30_000),
                attempt: 1,
                executionInputEnvelope: TEST_STRICT_PLAIN_RECIPE,
                resultEnvelope: "preserved-cancelled-result",
                errorCode: "preserved-cancelled-code",
                errorMessage: "preserved cancelled message",
            },
            select: { id: true },
        });
        await db.session.create({
            data: {
                id: "session-cancel-before-retain",
                accountId: seeded.accountId,
                tag: deriveSessionCreationTagV1({
                    callerCreationNamespace: `automation:${seeded.automationId}`,
                    creationKey: `automation-run:${run.id}`,
                }),
                metadata: "{}",
            },
            select: { id: true },
        });
        await expect(cancelAutomationRun({
            accountId: seeded.accountId,
            runId: run.id,
        })).resolves.toEqual(expect.objectContaining({ state: "cancelled" }));
        const before = await db.automationRun.findUniqueOrThrow({
            where: { id: run.id },
            select: {
                state: true,
                finishedAt: true,
                resultEnvelope: true,
                errorCode: true,
                errorMessage: true,
                revision: true,
                producedSessionId: true,
            },
        });

        await expect(retainAutomationRunProducedSession({
            accountId: seeded.accountId,
            machineId: seeded.machineId,
            runId: run.id,
            attempt: 1,
            result: { type: "pending", retryWithSameCreationKey: true, outcome: "unknown" },
        })).resolves.toBeNull();

        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: run.id },
            select: {
                state: true,
                finishedAt: true,
                resultEnvelope: true,
                errorCode: true,
                errorMessage: true,
                revision: true,
                producedSessionId: true,
            },
        })).resolves.toEqual(before);
        await expect(db.automationRunEvent.findMany({
            where: { runId: run.id },
            select: { type: true },
        })).resolves.toEqual([{ type: "run_cancelled" }]);
    });

    it("refuses noncanonical, stale, and non-Session retention candidates", async () => {
        const seeded = await createAccountMachineAutomation({
            publicKey: "pk-automation-run-retention-refusals",
            machineId: "machine-retention-refusals",
            automationName: "Retention refusals",
        });
        const otherAccount = await db.account.create({
            data: { publicKey: "pk-automation-run-retention-other-account", encryptionMode: "plain" },
            select: { id: true },
        });
        const run = await db.automationRun.create({
            data: {
                id: "run-retention-refusals",
                automationId: seeded.automationId,
                accountId: seeded.accountId,
                state: "running",
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 30_000),
                startedAt: new Date(Date.now() - 20_000),
                claimedByMachineId: seeded.machineId,
                leaseExpiresAt: new Date(Date.now() + 30_000),
                attempt: 2,
                executionInputEnvelope: TEST_STRICT_PLAIN_RECIPE,
            },
            select: { id: true },
        });
        const canonicalSession = await db.session.create({
            data: {
                id: "session-retention-canonical",
                accountId: seeded.accountId,
                tag: deriveSessionCreationTagV1({
                    callerCreationNamespace: `automation:${seeded.automationId}`,
                    creationKey: `automation-run:${run.id}`,
                }),
                metadata: "{}",
            },
            select: { id: true },
        });
        const otherSession = await db.session.create({
            data: {
                id: "session-retention-other",
                accountId: seeded.accountId,
                tag: "other-session-tag",
                metadata: "{}",
            },
            select: { id: true },
        });

        await expect(retainAutomationRunProducedSession({
            accountId: otherAccount.id,
            machineId: seeded.machineId,
            runId: run.id,
            attempt: 2,
            result: sessionStartSuccess(canonicalSession.id),
        })).resolves.toBeNull();
        await expect(retainAutomationRunProducedSession({
            accountId: seeded.accountId,
            machineId: "machine-retention-substitute",
            runId: run.id,
            attempt: 2,
            result: sessionStartSuccess(canonicalSession.id),
        })).resolves.toBeNull();
        await expect(retainAutomationRunProducedSession({
            accountId: seeded.accountId,
            machineId: seeded.machineId,
            runId: run.id,
            attempt: 3,
            result: sessionStartSuccess(canonicalSession.id),
        })).resolves.toBeNull();
        await expect(retainAutomationRunProducedSession({
            accountId: seeded.accountId,
            machineId: seeded.machineId,
            runId: run.id,
            attempt: 2,
            result: sessionStartSuccess(otherSession.id),
        })).resolves.toBeNull();

        const nonSessionRun = await db.automationRun.create({
            data: {
                id: "run-retention-execution-target",
                automationId: seeded.automationId,
                accountId: seeded.accountId,
                state: "running",
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 30_000),
                startedAt: new Date(Date.now() - 20_000),
                claimedByMachineId: seeded.machineId,
                leaseExpiresAt: new Date(Date.now() + 30_000),
                attempt: 1,
                executionInputEnvelope: TEST_STRICT_PLAIN_EXECUTION_RECIPE,
            },
            select: { id: true },
        });
        const nonSessionCandidate = await db.session.create({
            data: {
                id: "session-retention-execution-target",
                accountId: seeded.accountId,
                tag: deriveSessionCreationTagV1({
                    callerCreationNamespace: `automation:${seeded.automationId}`,
                    creationKey: `automation-run:${nonSessionRun.id}`,
                }),
                metadata: "{}",
            },
            select: { id: true },
        });
        await expect(retainAutomationRunProducedSession({
            accountId: seeded.accountId,
            machineId: seeded.machineId,
            runId: nonSessionRun.id,
            attempt: 1,
            result: sessionStartSuccess(nonSessionCandidate.id),
        })).resolves.toBeNull();

        await db.automationRun.update({
            where: { id: run.id },
            data: { producedSessionId: otherSession.id },
        });
        await expect(retainAutomationRunProducedSession({
            accountId: seeded.accountId,
            machineId: seeded.machineId,
            runId: run.id,
            attempt: 2,
            result: sessionStartSuccess(canonicalSession.id),
        })).resolves.toBeNull();
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: run.id },
            select: { producedSessionId: true },
        })).resolves.toEqual({ producedSessionId: otherSession.id });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: nonSessionRun.id },
            select: { producedSessionId: true },
        })).resolves.toEqual({ producedSessionId: null });
    });
});
