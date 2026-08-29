import { randomUUID } from "node:crypto";

import {
    AutomationRunCauseSchema,
    deriveAutomationOccurrenceKeyV1,
    deriveSessionCreationTagV1,
    serializeAutomationRunExecutionRecipeV1,
    type SessionServerStartDispatchRequestV1,
} from "@happier-dev/protocol";
import type { Server } from "socket.io";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fetchAutomationAccountCurrentnessWitnessTx } from "@/app/automations/automationAccountCurrentness";
import { encodeAutomationRunCause } from "@/app/automations/automationRunCauseCodec";
import { cancelAutomationRun } from "@/app/automations/automationRunService";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    createSessionServerStartAutomationIngress,
    createSessionServerStartDaemonDispatcher,
} from "./sessionServerStartDispatcher";
import type { RpcAckResponseEmitter, RpcForwardTargetGuard } from "./rpc/_types";

function sessionStartRecipe(targetMachineId: string): string {
    const serialized = serializeAutomationRunExecutionRecipeV1({
        v: 1,
        templateVersion: 1,
        template: { t: "plain", v: { v: 1, prompt: "Start the Automation Session." } },
        triggerEvidence: null,
        target: {
            kind: "newSession",
            spawn: {
                executionTarget: { serverId: "server-1", machineId: targetMachineId },
                directory: "/workspace",
                agentTarget: {
                    kind: "agent",
                    identity: { pluginId: "happier.agent.codex", localId: "codex" },
                },
            },
        },
        assignmentMachineIds: [targetMachineId],
    });
    if (serialized.kind !== "available") {
        throw new Error("Expected strict Session-start recipe fixture");
    }
    return serialized.serialized;
}

function sessionStartSuccess(sessionId: string, targetMachineId: string) {
    return {
        type: "success" as const,
        disposition: "created" as const,
        sessionId,
        executionTarget: { serverId: "server-1", machineId: targetMachineId },
        organizationPlacement: { folderId: null, tagIds: [] },
        initialInput: { status: "notRequested" as const },
    };
}

async function seedCrossMachineRun() {
    const suffix = randomUUID();
    const sourceMachineId = `source-${suffix}`;
    const targetMachineId = `target-${suffix}`;
    const targetMachineInstallationId = `installation-${suffix}`;
    const account = await db.account.create({
        data: { encryptionMode: "plain" },
        select: { id: true },
    });
    await db.machine.create({
        data: { id: sourceMachineId, accountId: account.id, metadata: "{}" },
    });
    await db.machine.create({
        data: {
            id: targetMachineId,
            accountId: account.id,
            metadata: "{}",
            installationId: targetMachineInstallationId,
            operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        },
    });
    const recipe = sessionStartRecipe(targetMachineId);
    const automation = await db.automation.create({
        data: {
            accountId: account.id,
            name: `Session ingress retention ${suffix}`,
            enabled: true,
            targetType: "new_session",
            templateCiphertext: recipe,
            templateVersion: 1,
            triggers: {
                create: {
                    kind: "schedule",
                    scheduleKind: "interval",
                    everyMs: 120_000,
                },
            },
        },
        select: { id: true, triggers: { select: { id: true, revision: true } } },
    });
    const trigger = automation.triggers[0]!;
    const scheduledFor = new Date(Date.now() - 60_000);
    const cause = AutomationRunCauseSchema.parse({
        kind: "trigger",
        triggerId: trigger.id,
        triggerRevision: trigger.revision,
        triggerKind: "schedule",
        occurrenceKey: deriveAutomationOccurrenceKeyV1({
            triggerId: trigger.id,
            evidence: {
                v: 1,
                kind: "schedule",
                scheduledFor: scheduledFor.getTime(),
            },
        }),
        occurredAt: scheduledFor.getTime(),
        evidence: { scheduledFor: scheduledFor.getTime() },
    });
    const run = await db.automationRun.create({
        data: {
            automationId: automation.id,
            accountId: account.id,
            state: "running",
            ...encodeAutomationRunCause(cause),
            scheduledAt: scheduledFor,
            dueAt: new Date(Date.now() - 30_000),
            startedAt: new Date(Date.now() - 20_000),
            claimedByMachineId: sourceMachineId,
            leaseExpiresAt: new Date(Date.now() + 30_000),
            attempt: 1,
            executionInputEnvelope: recipe,
        },
        select: { id: true },
    });

    return {
        account,
        automation,
        cause,
        run,
        sourceMachineId,
        targetMachineId,
        targetMachineInstallationId,
    };
}

async function createCanonicalSession(params: Awaited<ReturnType<typeof seedCrossMachineRun>>) {
    return await db.session.create({
        data: {
            accountId: params.account.id,
            tag: deriveSessionCreationTagV1({
                callerCreationNamespace: `automation:${params.automation.id}`,
                creationKey: `automation-run:${params.run.id}`,
            }),
            metadata: "{}",
        },
        select: { id: true },
    });
}

function ingressRequest(runId: string) {
    return {
        v: 1 as const,
        kind: "session.serverStart.ingress" as const,
        runId,
        attempt: 1,
        requestEnvelope: { t: "plain" as const, v: { opaqueToServer: true } },
    };
}

async function dispatchRequestFor(
    seeded: Awaited<ReturnType<typeof seedCrossMachineRun>>,
): Promise<SessionServerStartDispatchRequestV1> {
    const accountCurrentness = await inTx(async (tx) =>
        await fetchAutomationAccountCurrentnessWitnessTx(tx, seeded.account.id),
    );
    if (accountCurrentness === null) {
        throw new Error("Expected plain Account currentness");
    }
    return {
        v: 1,
        kind: "session.serverStart.dispatch",
        target: {
            accountId: seeded.account.id,
            machineId: seeded.targetMachineId,
            machineInstallationId: seeded.targetMachineInstallationId,
        },
        start: {
            automationId: seeded.automation.id,
            runId: seeded.run.id,
            attempt: 1,
            claimedByMachineId: seeded.sourceMachineId,
            cause: seeded.cause,
            accountCurrentness,
            requestEnvelope: { t: "plain", v: { opaqueToServer: true } },
        },
    };
}

function exactTargetSocket(
    seeded: Awaited<ReturnType<typeof seedCrossMachineRun>>,
): RpcAckResponseEmitter {
    return {
        id: `socket-${seeded.targetMachineId}`,
        data: {
            clientType: "machine-scoped",
            machineId: seeded.targetMachineId,
            verifiedMachineInstallationId: seeded.targetMachineInstallationId,
        },
        timeout: () => ({ emitWithAck: async () => ({}) }),
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

describe("Session server-start Automation ingress on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-server-start-ingress-",
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.automationRunEvent.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.session.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("retains a target-committed Session when cancellation beats the discarded outer ACK", async () => {
        const seeded = await seedCrossMachineRun();
        const committedSession = await createCanonicalSession(seeded);
        const forwardStarted = deferred<void>();
        const targetResult = deferred<ReturnType<typeof sessionStartSuccess>>();
        const ingress = createSessionServerStartAutomationIngress({
            forward: async () => {
                forwardStarted.resolve();
                return await targetResult.promise;
            },
        });
        const sourceAck = ingress({
            accountId: seeded.account.id,
            sourceMachineId: seeded.sourceMachineId,
            request: ingressRequest(seeded.run.id),
        });

        await forwardStarted.promise;
        // The seeded Run is running, so the refined canonical cancellation
        // settles it outcome-uncertain; the committed Session still retains
        // its exact canonical identity.
        await expect(cancelAutomationRun({
            accountId: seeded.account.id,
            runId: seeded.run.id,
        })).resolves.toEqual(expect.objectContaining({ state: "outcome_uncertain" }));
        targetResult.resolve(sessionStartSuccess(committedSession.id, seeded.targetMachineId));

        // The caller never observes this promise until after the durable
        // assertion below: it models the source Socket ACK being dropped.
        await vi.waitFor(async () => {
            await expect(db.automationRun.findUniqueOrThrow({
                where: { id: seeded.run.id },
                select: { state: true, producedSessionId: true },
            })).resolves.toEqual({ state: "outcome_uncertain", producedSessionId: committedSession.id });
        });
        await expect(sourceAck).resolves.toEqual(expect.objectContaining({
            v: 1,
            kind: "result",
            result: expect.objectContaining({ type: "success", sessionId: committedSession.id }),
        }));
    });

    it("retains a Session committed after cancellation before the outer ACK can be observed", async () => {
        const seeded = await seedCrossMachineRun();
        const forwardStarted = deferred<void>();
        const targetResult = deferred<ReturnType<typeof sessionStartSuccess>>();
        const ingress = createSessionServerStartAutomationIngress({
            forward: async () => {
                forwardStarted.resolve();
                return await targetResult.promise;
            },
        });
        const sourceAck = ingress({
            accountId: seeded.account.id,
            sourceMachineId: seeded.sourceMachineId,
            request: ingressRequest(seeded.run.id),
        });

        await forwardStarted.promise;
        await expect(cancelAutomationRun({
            accountId: seeded.account.id,
            runId: seeded.run.id,
        })).resolves.toEqual(expect.objectContaining({ state: "outcome_uncertain" }));
        const committedSession = await createCanonicalSession(seeded);
        targetResult.resolve(sessionStartSuccess(committedSession.id, seeded.targetMachineId));

        await vi.waitFor(async () => {
            await expect(db.automationRun.findUniqueOrThrow({
                where: { id: seeded.run.id },
                select: { state: true, producedSessionId: true },
            })).resolves.toEqual({ state: "outcome_uncertain", producedSessionId: committedSession.id });
        });
        await expect(sourceAck).resolves.toEqual(expect.objectContaining({
            v: 1,
            kind: "result",
            result: expect.objectContaining({ type: "success", sessionId: committedSession.id }),
        }));
    });

    it.each([
        {
            // Cancellation publishes an Automation change, so it also advances
            // `Account.seq` and trips the incumbent Account-currentness arm.
            // The three facts below move no Account state and are what
            // discriminate the Run-claim arm of the pre-submit guard.
            name: "the user cancels the Run",
            moveRun: async (seeded: Awaited<ReturnType<typeof seedCrossMachineRun>>) => {
                // A running Run settles outcome-uncertain under canonical
                // cancellation; the pre-submit guard must still refuse it.
                await expect(cancelAutomationRun({
                    accountId: seeded.account.id,
                    runId: seeded.run.id,
                })).resolves.toEqual(expect.objectContaining({ state: "outcome_uncertain" }));
            },
        },
        {
            name: "the claim moves to another machine",
            moveRun: async (seeded: Awaited<ReturnType<typeof seedCrossMachineRun>>) => {
                await db.automationRun.update({
                    where: { id: seeded.run.id },
                    data: { claimedByMachineId: seeded.targetMachineId },
                });
            },
        },
        {
            name: "the Run advances to a later attempt",
            moveRun: async (seeded: Awaited<ReturnType<typeof seedCrossMachineRun>>) => {
                await db.automationRun.update({
                    where: { id: seeded.run.id },
                    data: { attempt: 2 },
                });
            },
        },
        {
            name: "the claim lease expires",
            moveRun: async (seeded: Awaited<ReturnType<typeof seedCrossMachineRun>>) => {
                await db.automationRun.update({
                    where: { id: seeded.run.id },
                    data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
                });
            },
        },
    ])("never submits the Session start when $name after ingress derivation", async ({ moveRun }) => {
        const seeded = await seedCrossMachineRun();
        const request = await dispatchRequestFor(seeded);
        const target = exactTargetSocket(seeded);
        const operation = vi.fn(async () => ({ emitted: true }));
        const forwardRpc = vi.fn(async (params: Readonly<{
            targetGuard?: RpcForwardTargetGuard;
        }>) => {
            const targetGuard = params.targetGuard;
            if (!targetGuard) throw new Error("Expected the exact-machine target guard");
            // The dispatch is derived and the exact target is selected. The Run
            // stops being current here, before the target operation is submitted.
            await moveRun(seeded);
            await expect(targetGuard.filterTargets([target])).resolves.toEqual([]);
            await expect(targetGuard.runOperation({
                target,
                operation,
                readLatestTarget: async () => target,
            })).resolves.toEqual({ status: "unavailable" });
            return { ok: false as const, error: "target unavailable" };
        });
        const dispatcher = createSessionServerStartDaemonDispatcher({
            io: {} as Server,
            forwardRpc: forwardRpc as never,
        });

        await expect(dispatcher(request)).resolves.toEqual({
            type: "error",
            code: "target_unavailable",
            retryable: true,
        });
        expect(operation).not.toHaveBeenCalled();
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: seeded.run.id },
            select: { producedSessionId: true },
        })).resolves.toEqual({ producedSessionId: null });
    });

    it("submits the Session start while the derived Run claim stays current", async () => {
        const seeded = await seedCrossMachineRun();
        const request = await dispatchRequestFor(seeded);
        const target = exactTargetSocket(seeded);
        const operation = vi.fn(async () => sessionStartSuccess("session-current", seeded.targetMachineId));
        const forwardRpc = vi.fn(async (params: Readonly<{
            targetGuard?: RpcForwardTargetGuard;
        }>) => {
            const targetGuard = params.targetGuard;
            if (!targetGuard) throw new Error("Expected the exact-machine target guard");
            await expect(targetGuard.filterTargets([target])).resolves.toEqual([target]);
            const guarded = await targetGuard.runOperation({
                target,
                operation,
                readLatestTarget: async () => target,
            });
            if (guarded.status !== "current") throw new Error("Expected a current guarded operation");
            return { ok: true as const, result: guarded.value };
        });
        const dispatcher = createSessionServerStartDaemonDispatcher({
            io: {} as Server,
            forwardRpc: forwardRpc as never,
        });

        await expect(dispatcher(request)).resolves.toEqual(
            sessionStartSuccess("session-current", seeded.targetMachineId),
        );
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it("does not forward when the exact target withdraws sessionSpawn after ingress derivation", async () => {
        const seeded = await seedCrossMachineRun();
        const request = await dispatchRequestFor(seeded);
        const forwardRpc = vi.fn(async () => ({
            ok: true as const,
            result: sessionStartSuccess("must-not-forward", seeded.targetMachineId),
        }));
        const dispatcher = createSessionServerStartDaemonDispatcher({
            io: {} as Server,
            forwardRpc: forwardRpc as never,
        });

        await db.machine.update({
            where: { id: seeded.targetMachineId },
            data: {
                operationProtocolCapabilities: {},
                operationProtocolCapabilitiesRevision: 2,
            },
        });

        await expect(dispatcher(request)).resolves.toEqual({
            type: "error",
            code: "target_unavailable",
            retryable: true,
        });
        expect(forwardRpc).not.toHaveBeenCalled();
    });
});
