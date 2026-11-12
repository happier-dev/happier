import { randomUUID } from "node:crypto";
import type { Socket } from "socket.io";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from "@happier-dev/protocol/workflows";
import { UpdateBodySchema } from "@happier-dev/protocol/updates";
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES } from "@happier-dev/protocol";

import { eventRouter, type ClientConnection, type UpdatePayload } from "@/app/events/eventRouter";
import { automationAccountCurrentnessSelect, deriveAutomationAccountCurrentnessWitness } from "@/app/automations/automationAccountCurrentness";
import { claimAutomationRun } from "@/app/automations/automationClaimService";
import { db, initDbPostgres } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { materializeWorkflowAcceptedSnapshotFixture } from "@/testkit/workflowAcceptedSnapshot";

import { admitWorkflowRun, admitWorkflowRunTx, cancelWorkflowRun, deleteWorkflowRun, listWorkflowRunsForRecovery } from "./workflowRunService";

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== "postgres")("Direct Workflow queued-work publication (PostgreSQL)", () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    async function fixture() {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const machines = await Promise.all([0, 1].map(() => db.machine.create({
            data: { id: randomUUID(), accountId: account.id, metadata: "{}", installationId: randomUUID() },
        })));
        const accountCurrentness = deriveAutomationAccountCurrentnessWitness(await db.account.findUniqueOrThrow({
            where: { id: account.id }, select: automationAccountCurrentnessSelect,
        }));
        if (!accountCurrentness) throw new Error("Fixture currentness unavailable");
        const runId = randomUUID();
        const acceptedSnapshot = await materializeWorkflowAcceptedSnapshotFixture({
            definition: { version: 1, blocks: [{ kind: "wait", id: "answer",
                document: { text: "Answer", references: [], attachments: [] }, result: { kind: "text" } }] },
            context: { source: { kind: "inline" }, inputs: {}, machineId: machines[0].id,
                executionTarget: { kind: "session" }, origin: { kind: "direct" }, authorization: { principal: { kind: "host" } },
                workspaceTarget: { project: { machineId: machines[0].id, directory: "/repo", checkoutRootPath: "/repo" } } },
        });
        const request = { accountId: account.id, runId, machineId: machines[0].id, origin: { kind: "direct" as const },
            accountCurrentness, acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
                mode: "plain", binding: { v: 1, purpose: "accepted_snapshot", accountId: account.id, runId }, acceptedSnapshot,
            })) };
        return { account, machines, request };
    }

    function observe(accountId: string, machineId?: string) {
        const updates: UpdatePayload[] = [];
        // Only the Socket.IO transport is substituted; routing and publication stay real.
        const socket = { data: {}, emit(event: string, payload: UpdatePayload) {
            if (event === "update" && payload.body.t === "automation-run-updated") updates.push(payload);
        } } as unknown as Socket;
        const connection: ClientConnection = machineId
            ? { connectionType: "machine-scoped", userId: accountId, machineId, socket }
            : { connectionType: "user-scoped", userId: accountId, socket };
        eventRouter.addConnection(accountId, connection);
        return { updates, close: () => eventRouter.removeConnection(accountId, connection) };
    }

    it("wakes only the per-Run assigned Machine once after direct admission, without an Automation or managed target", async () => {
        const { account, machines, request } = await fixture();
        const target = observe(account.id, machines[0].id);
        const peer = observe(account.id, machines[1].id);
        const user = observe(account.id);
        try {
            expect(await db.automationAssignment.count({ where: { machineId: machines[0].id } })).toBe(0);
            expect(await db.managedMachine.count({ where: { enrolledMachineId: machines[0].id } })).toBe(0);
            await inTx(async tx => {
                expect(await admitWorkflowRunTx(tx, request)).toMatchObject({ kind: "created", run: { id: request.runId, state: "queued" } });
                expect(target.updates).toEqual([]);
            });
            const row = await db.automationRun.findUniqueOrThrow({ where: { id: request.runId } });
            expect(target.updates).toHaveLength(1);
            expect(target.updates[0]).toMatchObject({
                seq: (await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq,
                body: { t: "automation-run-updated", runId: request.runId, automationId: null, state: "queued",
                    scheduledAt: row.scheduledAt.getTime(), startedAt: null, finishedAt: null,
                    updatedAt: row.updatedAt.getTime(), machineId: null, attempt: 0, targetMachineId: machines[0].id },
            });
            expect(target.updates[0].body).not.toHaveProperty("managedWakeTargetV1");
            expect(UpdateBodySchema.parse(target.updates[0].body)).toMatchObject({
                t: "automation-run-updated", runId: request.runId, automationId: null, state: "queued",
            });
            expect(peer.updates).toEqual([]);
            expect(user.updates).toEqual([]);
            await expect(admitWorkflowRun(request)).resolves.toMatchObject({ kind: "existing" });
            expect(target.updates).toHaveLength(1);
            const claim = { accountId: account.id, leaseDurationMs: 30_000, scope: "workflow" as const,
                recipeFeaturePolicy: { workflowsEnabled: true } };
            await expect(claimAutomationRun({ ...claim, machineId: machines[1].id })).resolves.toMatchObject({ run: null });
            await expect(claimAutomationRun({ ...claim, machineId: machines[0].id })).resolves.toMatchObject({
                run: { id: request.runId, automationId: null, claimedByMachineId: machines[0].id, state: "claimed" },
            });
        } finally { target.close(); peer.close(); user.close(); }
    });

    it("never wakes rolled-back or rejected admissions and leaves delayed queued hints subject to cancellation", async () => {
        const { account, machines, request } = await fixture();
        const target = observe(account.id, machines[0].id);
        try {
            const rollback = new Error("Rollback direct admission");
            await expect(inTx(async tx => {
                await admitWorkflowRunTx(tx, request);
                throw rollback;
            })).rejects.toBe(rollback);
            expect(target.updates).toEqual([]);
            expect(await db.automationRun.findUnique({ where: { id: request.runId } })).toBeNull();
            await expect(admitWorkflowRun({ ...request, machineId: randomUUID() }))
                .rejects.toMatchObject({ code: "target_unavailable" });
            expect(target.updates).toEqual([]);
            const admitted = await admitWorkflowRun(request);
            await cancelWorkflowRun({ accountId: account.id, runId: request.runId, expectedRevision: admitted.run.revision });
            await expect(claimAutomationRun({ accountId: account.id, machineId: machines[0].id, leaseDurationMs: 30_000,
                scope: "workflow", recipeFeaturePolicy: { workflowsEnabled: true } })).resolves.toMatchObject({ run: null });
            expect((await db.automationRun.findUniqueOrThrow({ where: { id: request.runId } })).state).toBe("cancelled");
        } finally { target.close(); }
    });

    it("wakes pending terminal custody on Delete without changing the Run or Account cursor", async () => {
        const { account, machines, request } = await fixture();
        await admitWorkflowRun(request);
        await db.automationRun.update({ where: { id: request.runId }, data: {
            state: "outcome_uncertain", revision: 9, claimedByMachineId: machines[0].id, finishedAt: new Date(),
        } });
        const before = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
        const target = observe(account.id, machines[0].id);
        const peer = observe(account.id, machines[1].id);
        const user = observe(account.id);
        try {
            await expect(deleteWorkflowRun({ accountId: account.id, runId: request.runId, expectedRevision: 9 }))
                .rejects.toMatchObject({ code: "custody_pending" });
            expect(target.updates.map(update => update.body)).toEqual([expect.objectContaining({
                runId: request.runId, state: "outcome_uncertain", targetMachineId: machines[0].id,
            })]);
            expect(peer.updates).toEqual([]);
            expect(user.updates).toEqual([]);
            expect(await db.automationRun.findUniqueOrThrow({ where: { id: request.runId },
                select: { state: true, revision: true, workflowCustodyState: true } }))
                .toEqual({ state: "outcome_uncertain", revision: 9, workflowCustodyState: "pending" });
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual(before);
        } finally { target.close(); peer.close(); user.close(); }
    });

    it("retains direct claimed work until its real lease expires, outside invocation-custody recovery", async () => {
        const { account, machines, request } = await fixture();
        await admitWorkflowRun(request);
        const claim = { accountId: account.id, machineId: machines[0].id, leaseDurationMs: 30_000,
            scope: "workflow" as const, recipeFeaturePolicy: { workflowsEnabled: true } };
        // The authenticated claim transport supplies these already-verified
        // request identities; the service keeps real receipt and lease logic.
        const freshRequest = () => ({ machineInstallationId: machines[0].installationId!,
            nonce: randomUUID(), expiresAt: new Date(Date.now() + 30_000) });
        await expect(claimAutomationRun({ ...claim, claimRequest: freshRequest() })).resolves.toMatchObject({
            run: { id: request.runId, state: "claimed", attempt: 1 },
        });
        expect(await db.workflowRunInvocation.count({ where: { runId: request.runId } })).toBe(0);
        const reconnectRequest = freshRequest();
        await expect(claimAutomationRun({ ...claim, claimRequest: reconnectRequest })).resolves.toMatchObject({ run: null });
        await expect(listWorkflowRunsForRecovery({ accountId: account.id, machineId: machines[0].id,
            pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES }))
            .resolves.toMatchObject({ candidates: [] });
        await db.automationRun.update({ where: { id: request.runId }, data: { leaseExpiresAt: new Date(0) } });
        await expect(claimAutomationRun({ ...claim, claimRequest: reconnectRequest })).resolves.toMatchObject({ run: null });
        await expect(claimAutomationRun({ ...claim, claimRequest: freshRequest() })).resolves.toMatchObject({
            run: { id: request.runId, state: "claimed", attempt: 2 },
        });
        expect(await db.automationWorkerClaimReceipt.count({ where: { accountId: account.id } })).toBe(3);
    });
});
