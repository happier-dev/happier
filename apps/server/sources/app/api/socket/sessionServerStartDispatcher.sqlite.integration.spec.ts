import { randomUUID } from "node:crypto";

import {
    deriveSessionCreationTagV1,
    serializeAutomationRunExecutionRecipeV1,
    type SessionServerStartDispatchRequestV1,
} from "@happier-dev/protocol";
import type { Server } from "socket.io";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fetchAutomationAccountCurrentnessWitnessTx } from "@/app/automations/automationAccountCurrentness";
import { cancelAutomationRun } from "@/app/automations/automationRunService";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    createSessionServerStartAutomationIngress,
    createSessionServerStartDaemonDispatcher,
} from "./sessionServerStartDispatcher";

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
            scheduleKind: "interval",
            everyMs: 120_000,
            targetType: "new_session",
            templateCiphertext: recipe,
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
        await expect(cancelAutomationRun({
            accountId: seeded.account.id,
            runId: seeded.run.id,
        })).resolves.toEqual(expect.objectContaining({ state: "cancelled" }));
        targetResult.resolve(sessionStartSuccess(committedSession.id, seeded.targetMachineId));

        // The caller never observes this promise until after the durable
        // assertion below: it models the source Socket ACK being dropped.
        await vi.waitFor(async () => {
            await expect(db.automationRun.findUniqueOrThrow({
                where: { id: seeded.run.id },
                select: { state: true, producedSessionId: true },
            })).resolves.toEqual({ state: "cancelled", producedSessionId: committedSession.id });
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
        })).resolves.toEqual(expect.objectContaining({ state: "cancelled" }));
        const committedSession = await createCanonicalSession(seeded);
        targetResult.resolve(sessionStartSuccess(committedSession.id, seeded.targetMachineId));

        await vi.waitFor(async () => {
            await expect(db.automationRun.findUniqueOrThrow({
                where: { id: seeded.run.id },
                select: { state: true, producedSessionId: true },
            })).resolves.toEqual({ state: "cancelled", producedSessionId: committedSession.id });
        });
        await expect(sourceAck).resolves.toEqual(expect.objectContaining({
            v: 1,
            kind: "result",
            result: expect.objectContaining({ type: "success", sessionId: committedSession.id }),
        }));
    });

    it("does not forward when the exact target withdraws sessionSpawn after ingress derivation", async () => {
        const seeded = await seedCrossMachineRun();
        const accountCurrentness = await inTx(async (tx) =>
            await fetchAutomationAccountCurrentnessWitnessTx(tx, seeded.account.id),
        );
        if (accountCurrentness === null) {
            throw new Error("Expected plain Account currentness");
        }
        const request: SessionServerStartDispatchRequestV1 = {
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
                origin: "event",
                accountCurrentness,
                requestEnvelope: { t: "plain", v: { opaqueToServer: true } },
            },
        };
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
