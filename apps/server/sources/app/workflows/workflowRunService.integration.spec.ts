import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import {
    EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
    measureExternalActionResultResponseEnvelopeUtf8BytesV1,
    prepareExternalActionResponseEnvelopeV1,
    PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
    signAccountContentKeyBindingV1,
    sealEncryptedDataKeyEnvelopeV1,
    type ValidatedAutomationAccountEncryptionV1,
    type WorkerUpdateV1,
} from "@happier-dev/protocol";
import {
    sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
    sealWorkflowCheckpointStoredEnvelopeV1,
    sealWorkflowFinalResultStoredEnvelopeV1,
    sealWorkflowProgressStoredEnvelopeV1,
    serializeWorkflowStoredContentEnvelopeV1,
    type WorkflowReviewV1,
} from "@happier-dev/protocol/workflows";
import {
    EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
    computeExternalActionRequestEnvelopeDigestV1,
    encodeExternalActionResolvedTargetV1,
    signExternalActionMachineRequestV1,
} from "@happier-dev/protocol/actions";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { materializeWorkflowAcceptedSnapshotFixture } from "@/testkit/workflowAcceptedSnapshot";
import { automationAccountCurrentnessSelect, deriveAutomationAccountCurrentnessWitness } from "@/app/automations/automationAccountCurrentness";
import { deriveAccountRecipientEnvelopeReadinessFromRow } from "@/app/encryption/accountRecipientEnvelopeReadiness";
import { cancelAutomationRun } from "@/app/automations/automationRunService";
import { claimAutomationRun, heartbeatAutomationRun, toAutomationV3WorkerClaimResponse } from "@/app/automations/automationClaimService";
import { automationRunWithAutomationSelect } from "@/app/automations/automationPersistenceSelect";
import { projectAutomationOriginRun } from "@/app/automations/automationRunCauseCodec";
import { AUTOMATION_RUN_TERMINAL_STATES } from "@/app/automations/automationTypes";
import { createMaterializedEphemeralRunnerFixture } from "@/app/ephemeralRunner/materializedRunner.testkit";
import { createSignedPluginInstallationPublisherHeader, createTrustedMachineInstallation } from "@/testkit/pluginInstallationPublisherTestkit";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import * as workflowRunService from "./workflowRunService";

import {
    admitWorkflowInvocations as admitWorkflowInvocationsOwner,
    admitWorkflowRun as admitWorkflowRunOwner,
    appendBoundedPage,
    cancelWorkflowRun,
    commitWorkflowInvocationFact as commitWorkflowInvocationFactOwner,
    deleteWorkflowRun,
    deriveWorkflowRunAvailability,
    getWorkflowRun,
    getCurrentWorkflowRunInvocation,
    getWorkflowRunInvocation,
    initializeWorkflowRunExecution as initializeWorkflowRunExecutionOwner,
    listWorkflowRunInvocations,
    listWorkflowRunsForRecovery,
    listWorkflowRuns,
    pauseWorkflowRun,
    resumeWorkflowRunBoundary,
    recoverWorkflowInvocations as recoverWorkflowInvocationsOwner,
    resolveAutomationWorkflowAcceptedSnapshot as resolveAutomationWorkflowAcceptedSnapshotOwner,
    transitionWorkflowRun as transitionWorkflowRunOwner,
    waitWorkflowRun,
} from "./workflowRunService";

const definition = {
    version: 1 as const,
    inputs: [],
    defaults: { agentTarget: { kind: "agent" as const, identity: { pluginId: "happier.agent.test", localId: "test" } } },
    blocks: [{ kind: "step" as const, id: "step", document: { text: "Work", references: [], attachments: [] }, input: [], result: { kind: "text" as const } }],
};
const e2eeWorkflowContent = {
    mode: "e2ee" as const,
    runDataKey: new Uint8Array(32).fill(7),
    randomBytes: (length: number) => new Uint8Array(length).fill(3),
};
async function acceptedEnvelope(params: { accountId: string; runId: string; machineId: string; originSessionId?: string; automationId?: string; deliver?: boolean; permission?: "default" | "read-only" }) {
    const origin = { kind: "direct" as const, ...(params.originSessionId ? { originSessionId: params.originSessionId } : {}) };
    const acceptedSnapshot = await materializeWorkflowAcceptedSnapshotFixture({
        definition: params.permission ? { ...definition, defaults: { ...definition.defaults, permissionMode: params.permission } } : definition,
        context: {
            source: params.automationId ? { kind: "automation", automationId: params.automationId } : { kind: "inline" },
            inputs: {}, machineId: params.machineId, executionTarget: { kind: "session" },
            workspaceTarget: { project: { machineId: params.machineId, directory: "/repo", checkoutRootPath: "/repo" } },
            ...(!params.automationId || params.originSessionId ? { origin } : {}),
            ...(params.deliver && params.originSessionId ? {
                resultDelivery: { kind: "originating_session", originSessionId: params.originSessionId },
            } : {}),
            authorization: { principal: { kind: "host" } },
        },
    });
    return serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: "plain",
        binding: { v: 1, purpose: "accepted_snapshot", accountId: params.accountId, runId: params.runId },
        acceptedSnapshot,
    }));
}
async function encryptedAcceptedEnvelope(params: { accountId: string; runId: string; machineId: string }) {
    return serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        ...e2eeWorkflowContent,
        binding: { v: 1, purpose: "accepted_snapshot", accountId: params.accountId, runId: params.runId },
        acceptedSnapshot: await materializeWorkflowAcceptedSnapshotFixture({
            definition,
            context: { source: { kind: "inline" },
            inputs: {},
            machineId: params.machineId,
            executionTarget: { kind: "session" },
            workspaceTarget: { project: { machineId: params.machineId, directory: "/repo", checkoutRootPath: "/repo" } },
            origin: { kind: "direct" },
            authorization: { principal: { kind: "host" } } },
        }),
    }));
}
function encryptedCheckpointEnvelope(accountId: string, runId: string, rootRecordId: string) {
    return serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
        ...e2eeWorkflowContent,
        binding: { v: 1, purpose: "checkpoint", accountId, runId },
        checkpoint: { kind: "happier.workflow-checkpoint.v1", rootRecordId, nextSequence: "1", frontier: { nextBlockOrdinal: 1, paused: false } },
    }));
}
function encryptedProgressEnvelope(params: { accountId: string; runId: string; id: string }) {
    return serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        ...e2eeWorkflowContent,
        binding: { v: 1, purpose: "invocation_progress", accountId: params.accountId, runId: params.runId, recordId: params.id, sequence: "0", parentRecordId: null, memberOrdinal: "0", attempt: "0" },
        progress: {
            kind: "happier.workflow-progress.v1",
            invocationPath: { blockId: "$root", scope: [] },
            blockKind: "root",
            attempt: "0",
            logicalInvocationRecordId: params.id,
        },
    }));
}
function checkpointEnvelope(accountId: string, runId: string, rootRecordId: string, nextSequence: bigint) {
    return serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
        mode: "plain",
        binding: { v: 1, purpose: "checkpoint", accountId, runId },
        checkpoint: { kind: "happier.workflow-checkpoint.v1", rootRecordId, nextSequence: nextSequence.toString(), frontier: { nextBlockOrdinal: Number(nextSequence), paused: false } },
    }));
}
function progressEnvelope(params: { accountId: string; runId: string; id: string; sequence: bigint; parentRecordId: string | null; memberOrdinal: bigint; attempt?: bigint; previousAttemptRecordId?: string; logicalInvocationRecordId?: string; reason?: string; result?: string; review?: WorkflowReviewV1; blockKind?: "root" | "step" | "parallel"; blockId?: string; container?: { kind: "parallel"; nextBranchOrdinal: string }; stepProgress?: { completed: number; total: number } }) {
    const attempt = params.attempt ?? 0n;
    const isStructuralRoot = params.parentRecordId === null && attempt === 0n;
    return serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        mode: "plain",
        binding: { v: 1, purpose: "invocation_progress", accountId: params.accountId, runId: params.runId, recordId: params.id, sequence: params.sequence.toString(), parentRecordId: params.parentRecordId, memberOrdinal: params.memberOrdinal.toString(), attempt: attempt.toString() },
        progress: {
            kind: "happier.workflow-progress.v1",
            invocationPath: { blockId: params.blockId ?? (isStructuralRoot ? "$root" : "step"), scope: [] },
            blockKind: params.blockKind ?? (isStructuralRoot ? "root" : "step"),
            attempt: attempt.toString(),
            ...(params.container ? { container: params.container } : {}),
            ...(params.stepProgress ? { stepProgress: params.stepProgress } : {}),
            ...(params.reason ? { reason: { code: params.reason } } : {}),
            ...(params.result === undefined ? {} : { result: params.result }),
            ...(params.review === undefined ? {} : { review: params.review }),
            ...(params.previousAttemptRecordId ? { previousAttemptRecordId: params.previousAttemptRecordId } : {}),
            logicalInvocationRecordId: params.logicalInvocationRecordId ?? params.id,
        },
    }));
}
function finalResultEnvelope(accountId: string, runId: string, value = "done") {
    return serializeWorkflowStoredContentEnvelopeV1(sealWorkflowFinalResultStoredEnvelopeV1({
        mode: "plain",
        binding: { v: 1, purpose: "final_result", accountId, runId },
        finalResult: {
            kind: "happier.workflow-final-result.v1",
            result: { kind: "text", value },
            producerInvocation: { recordId: "workflow-final-producer" },
        },
    }));
}

function workflowDefinitionEnvelope() {
    return JSON.stringify({ t: "plain", v: { definition, source: { definitionId: "workflow-definition", revision: "1" } } });
}

async function createReviewStorageApp(accountId: string, authority: "present_user" | "account_automation" = "present_user") {
    const [{ auth }, { enableAuthentication }, { registerWorkflowRunStorageRoutes }] = await Promise.all([
        import("@/app/auth/auth"), import("@/app/api/utils/enableAuthentication"),
        import("@/app/api/routes/automations/registerWorkflowRunStorageRoutes"),
    ]);
    if (authority === "account_automation") {
        // Terminal authority is determined by current Account policy, not its minted floor.
        await db.account.update({ where: { id: accountId }, data: { terminalPresentUserPolicy: "disallowed" } });
    }
    const token = await auth.createToken(accountId, undefined, { kind: authority === "present_user" ? "account" : "terminal", authority });
    await expect(auth.verifyToken(token)).resolves.toMatchObject({ authority });
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    enableAuthentication(app);
    registerWorkflowRunStorageRoutes(app);
    return { app, headers: { authorization: `Bearer ${token}` } };
}

describe("workflowRunService (integration)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: "happier-workflow-runs-", initAuth: true }); }, 120_000);
    afterAll(async () => { await harness.close(); });
    afterEach(async () => {
        harness.resetEnv();
        // A cleanup failure must invalidate the proof, not leak rows into the next race.
        const cleanup = [
            () => db.accountChange.deleteMany(),
            () => db.workflowRunInvocation.deleteMany(),
            () => db.automationRunAssignment.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.accountApiToken.deleteMany(),
            () => db.accessKey.deleteMany(),
            () => db.ephemeralRunnerActivation.deleteMany(),
            () => db.session.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ];
        for (const removeRows of cleanup) await removeRows();
    });

    it("honors an already-aborted wait before reading run state", async () => {
        const reason = new Error("caller stopped waiting");
        const controller = new AbortController();
        controller.abort(reason);

        await expect(waitWorkflowRun({
            accountId: randomUUID(),
            runId: randomUUID(),
            signal: controller.signal,
        })).rejects.toBe(reason);
    });

    async function seed() {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" }, select: { id: true } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: "{}" }, select: { id: true } });
        const session = await db.session.create({ data: { id: randomUUID(), tag: randomUUID(), accountId: account.id, metadata: "{}", encryptionMode: "plain" }, select: { id: true } });
        return { accountId: account.id, machineId: machine.id, sessionId: session.id };
    }

    it("pulls current origin delivery above a monotonic owner ack without keeping terminal custody", async () => {
        expect("pullWorkflowRunOriginDelivery" in workflowRunService).toBe(true);
        const seeded = await seed();
        const stranger = await seed();
        const runId = randomUUID();
        await admitWorkflowRun({ ...seeded, runId, origin: { kind: "direct", originSessionId: seeded.sessionId },
            acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId, originSessionId: seeded.sessionId }),
            resultDelivery: { kind: "originating_session" } });
        const request = { accountId: seeded.accountId, originSessionId: seeded.sessionId, pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES };
        await db.automationRun.update({ where: { id: runId }, data: { state: "running", revision: 4 } });
        expect((await workflowRunService.pullWorkflowRunOriginDelivery(request)).runs).toMatchObject([
            { run: { id: runId, state: "running", revision: 4, attentionRequired: false } },
        ]);
        await db.automationRun.update({ where: { id: runId }, data: {
            state: "succeeded", workflowCustodyState: "settled", revision: 5,
            resultEnvelope: finalResultEnvelope(seeded.accountId, runId),
        } });
        const page = await workflowRunService.pullWorkflowRunOriginDelivery(request);
        expect(page.runs).toHaveLength(1);
        expect(page.runs[0]).toMatchObject({ run: { id: runId, revision: 5, originDeliveryAckRevision: 0, workflowCustodyState: "settled" } });
        await expect(workflowRunService.ackWorkflowRunOriginDelivery({ accountId: stranger.accountId, runId, revision: 5 })).rejects.toMatchObject({ code: "run_not_found" });
        await expect(workflowRunService.ackWorkflowRunOriginDelivery({ accountId: seeded.accountId, runId, revision: 6 })).rejects.toMatchObject({ code: "invalid_input" });
        await workflowRunService.ackWorkflowRunOriginDelivery({ accountId: seeded.accountId, runId, revision: 5 });
        await workflowRunService.ackWorkflowRunOriginDelivery({ accountId: seeded.accountId, runId, revision: 3 });
        await workflowRunService.ackWorkflowRunOriginDelivery({ accountId: seeded.accountId, runId, revision: 5 });
        expect((await db.automationRun.findUniqueOrThrow({ where: { id: runId } })).originDeliveryAckRevision).toBe(5);
        expect((await workflowRunService.pullWorkflowRunOriginDelivery(request)).runs).toEqual([]);
        await expect(deleteWorkflowRun({ accountId: seeded.accountId, runId, expectedRevision: 5 })).resolves.toMatchObject({ deleted: true });
    });

    it("pulls delivery-off admitting origin rows under closed control with scoped Run pagination", async () => {
        expect("pullWorkflowRunOriginDelivery" in workflowRunService).toBe(true);
        const seeded = await seed();
        const runIds = [randomUUID(), randomUUID()];
        for (const runId of runIds) {
            await admitWorkflowRun({ ...seeded, runId, origin: { kind: "direct", originSessionId: seeded.sessionId },
                acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId, originSessionId: seeded.sessionId }) });
            const id = randomUUID();
            await db.workflowRunInvocation.create({ data: { id, runId, sequence: 1n, parentRecordId: null, memberOrdinal: 0n,
                lifecycle: "admitting", contentEnvelope: progressEnvelope({ ...seeded, runId, id, sequence: 1n, parentRecordId: null, memberOrdinal: 0n }) } });
            await db.automationRun.update({ where: { id: runId }, data: { state: "pause_requested" } });
        }
        const request = { accountId: seeded.accountId, originSessionId: seeded.sessionId, limit: 1, pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES };
        const first = await workflowRunService.pullWorkflowRunOriginDelivery(request);
        expect(first.runs).toHaveLength(1);
        expect(first.runs[0]).toMatchObject({ run: { state: "pause_requested", originDeliveryAckRevision: null }, invocations: [], hasOriginInputCandidates: true });
        const candidates = await listWorkflowRunInvocations({ accountId: seeded.accountId, runId: first.runs[0]!.run.id,
            lifecycles: ["admitting", "cancel_requested"], progressEnvelopes: true, pageByteLimit: request.pageByteLimit });
        expect(candidates.invocations).toMatchObject([{ lifecycle: "admitting" }]);
        expect(first.nextCursor).toBeTypeOf("string");
        const second = await workflowRunService.pullWorkflowRunOriginDelivery({ ...request, cursor: first.nextCursor! });
        expect(new Set([...first.runs, ...second.runs].map((item) => item.run.id))).toEqual(new Set(runIds));
        expect(second.nextCursor).toBeNull();
        await expect(workflowRunService.pullWorkflowRunOriginDelivery({ ...request, originSessionId: randomUUID(), cursor: first.nextCursor! })).rejects.toMatchObject({ code: "invalid_input" });
        await expect(workflowRunService.pullWorkflowRunOriginDelivery({ ...request, originSessionId: randomUUID() })).rejects.toMatchObject({ code: "run_not_found" });
    });

    it.each([false, true])("delivers the first attention hold from revision zero and re-entry after ack (origin offline: %s)", async (offline) => {
        const seeded = await seedPendingAdmission();
        // Exercise the zero ack boundary independently of unrelated allocation revisions.
        await db.automationRun.update({ where: { id: seeded.runId }, data: {
            revision: 0, originSessionId: seeded.sessionId, originDeliveryAckRevision: 0,
            workflowAcceptedSnapshotEnvelope: await acceptedEnvelope({ ...seeded, originSessionId: seeded.sessionId, deliver: true }),
        } });
        const request = { accountId: seeded.accountId, originSessionId: seeded.sessionId,
            pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES };
        expect((await workflowRunService.pullWorkflowRunOriginDelivery(request)).runs).toEqual([]);
        await commitWorkflowInvocationFact({ ...seeded.fact, lifecycle: "running" });
        expect((await getWorkflowRun(seeded)).run.revision).toBe(0);
        const { app, headers } = await createReviewStorageApp(seeded.accountId);
        const signal = new AbortController().signal;
        const originOptions = {
            accountId: seeded.accountId, originSessionId: seeded.sessionId, machineId: seeded.machineId,
            resolveEncryption: async (): Promise<ValidatedAutomationAccountEncryptionV1> => {
                const witness = await accountCurrentness(seeded.accountId);
                if (witness.mode !== "plain" || witness.contentKeyFingerprint !== null) throw new Error("expected plain fixture Account");
                return { kind: "available", witness: { ...witness, mode: "plain", contentKeyFingerprint: null } };
            },
            readDispatchFact: async () => "not_dispatched", onDispatchedInput: () => undefined,
            // Only the HTTP transport is substituted; authenticated routes, row storage,
            // shared attention, Run-key resolution, codecs and the origin port are real.
            storage: { execute: async (operation: Readonly<Record<string, unknown>>) => {
                const response = await app.inject({ method: "POST", url: "/v3/automations/runs/workflow-storage", headers, payload: operation });
                expect(response.statusCode, response.body).toBe(200);
                return response.json();
            } }, onError: (error: unknown) => { throw error; },
        };
        type PreparedUpdate = Readonly<{
            update: WorkerUpdateV1;
            recheckAdmission: (signal: AbortSignal) => Promise<boolean>;
            acknowledgeAccepted: () => void;
        }>;
        // Load real CLI source through Vitest's nearest-project alias resolver,
        // not the Server compiler's rootDir/aliases. This test-only projection
        // describes the exercised host boundary; no internal logic is mocked.
        const { createWorkflowOriginContextInputPort } = await vi.importActual<{
            createWorkflowOriginContextInputPort: (options: typeof originOptions) => {
                prepareWorkerUpdates: (input: Readonly<{ signal: AbortSignal; maxUtf8Bytes: number }>) => Promise<readonly PreparedUpdate[]>;
                take: (signal: AbortSignal) => Promise<(PreparedUpdate & { kind: "worker_update" }) | { kind: "workflow_step" } | null>;
            };
        }>("../../../../cli/src/agent/runtime/session/contextOnly/workflowOriginInput");
        const connectOrigin = () => createWorkflowOriginContextInputPort(originOptions);
        try {
            const onlineOrigin = offline ? null : connectOrigin();
            if (onlineOrigin) expect(await onlineOrigin.prepareWorkerUpdates!({ signal, maxUtf8Bytes: 65536 })).toEqual([]);
            await commitWorkflowInvocationFact({ ...seeded.fact, expectedLifecycle: "running", lifecycle: "waiting_for_review" });
            expect((await workflowRunService.pullWorkflowRunOriginDelivery(request)).runs).toMatchObject([
                { run: { id: seeded.runId, revision: 1, originDeliveryAckRevision: 0, attentionRequired: true } },
            ]);
            // An offline origin connects only after the hold is durable. Both
            // paths pull without receiving any Session hint through the harness.
            let origin = onlineOrigin ?? connectOrigin();
            const first = await origin.prepareWorkerUpdates!({ signal, maxUtf8Bytes: 65536 });
            expect(first).toHaveLength(1);
            expect(first[0]!.update).toMatchObject({ transcriptPointer: { kind: "workflow_run", runId: seeded.runId }, wake: "needs_you" });
            expect(await origin.take(signal)).toBeNull();
            expect(await first[0]!.recheckAdmission(signal)).toBe(true);
            expect((await getWorkflowRun(seeded)).run.originDeliveryAckRevision).toBe(0);
            first[0]!.acknowledgeAccepted();
            expect(await origin.prepareWorkerUpdates!({ signal, maxUtf8Bytes: 65536 })).toEqual([]);
            expect((await getWorkflowRun(seeded)).run.originDeliveryAckRevision).toBe(1);
            if (offline) origin = connectOrigin();
            expect(await origin.prepareWorkerUpdates!({ signal, maxUtf8Bytes: 65536 })).toEqual([]);

            // Publishing another fact inside the same hold is not a second event.
            await commitWorkflowInvocationFact({ ...seeded.fact, expectedLifecycle: "waiting_for_review", lifecycle: "waiting_for_review",
                contentEnvelope: progressEnvelope({ ...seeded, id: seeded.invocationId, sequence: 1n,
                    parentRecordId: seeded.rootId, memberOrdinal: 0n, result: "updated held result" }) });
            expect((await getWorkflowRun(seeded)).run.revision).toBe(1);
            await commitWorkflowInvocationFact({ ...seeded.fact, expectedLifecycle: "waiting_for_review", lifecycle: "running" });
            expect((await getWorkflowRun(seeded)).run.revision).toBe(2);
            expect(await origin.prepareWorkerUpdates!({ signal, maxUtf8Bytes: 65536 })).toEqual([]);
            await commitWorkflowInvocationFact({ ...seeded.fact, expectedLifecycle: "running", lifecycle: "waiting_for_approval" });
            const second = await origin.prepareWorkerUpdates!({ signal, maxUtf8Bytes: 65536 });
            expect(second).toHaveLength(1);
            expect(await second[0]!.recheckAdmission(signal)).toBe(true);
            expect((await getWorkflowRun(seeded)).run.revision).toBe(3);
            second[0]!.acknowledgeAccepted();
            expect(await origin.prepareWorkerUpdates!({ signal, maxUtf8Bytes: 65536 })).toEqual([]);
            if (offline) origin = connectOrigin();
            expect(await origin.prepareWorkerUpdates!({ signal, maxUtf8Bytes: 65536 })).toEqual([]);
            await expect(workflowRunService.ackWorkflowRunOriginDelivery({ accountId: seeded.accountId, runId: seeded.runId, revision: 1 }))
                .resolves.toEqual({ acknowledgedRevision: 3 });
            await commitWorkflowInvocationFact({ ...seeded.fact, expectedLifecycle: "waiting_for_approval", lifecycle: "completed" });
            expect(await second[0]!.recheckAdmission(signal)).toBe(false);
            const terminalResult = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowFinalResultStoredEnvelopeV1({
                mode: "plain", binding: { v: 1, purpose: "final_result", accountId: seeded.accountId, runId: seeded.runId },
                finalResult: { kind: "happier.workflow-final-result.v1", result: { kind: "text", value: "done" },
                    producerInvocation: { recordId: seeded.invocationId } },
            }));
            await transitionWorkflowRun({ ...seeded, parentAttempt: 1, expectedRevision: 4, state: "succeeded", custodyState: "settled",
                checkpointEnvelope: checkpointEnvelope(seeded.accountId, seeded.runId, seeded.rootId, 2n), resultEnvelope: terminalResult,
                invocationTransitions: [{ id: seeded.rootId, expectedLifecycle: "pending", lifecycle: "completed" }] });
            if (offline) origin = connectOrigin();
            const terminal = await origin.take(signal);
            expect(terminal).toMatchObject({ kind: "worker_update", update: { wake: "finished", result: "done" } });
            if (terminal?.kind !== "worker_update") throw new Error("expected terminal wake");
            expect(await terminal.recheckAdmission(signal)).toBe(true);
            terminal.acknowledgeAccepted();
            expect(await origin.take(signal)).toBeNull();
            expect((await getWorkflowRun(seeded)).run).toMatchObject({ revision: 5, originDeliveryAckRevision: 5, workflowCustodyState: "settled" });
        } finally {
            await app.close();
        }
    });

    it.each(["no_origin", "delivery_off", "delivery_on"] as const)("advances attention revision only when aggregate membership changes (%s)", async (delivery) => {
        const seeded = await seedPendingAdmission();
        await db.automationRun.update({ where: { id: seeded.runId }, data: {
            ...(delivery === "no_origin" ? {} : { originSessionId: seeded.sessionId }),
            originDeliveryAckRevision: delivery === "delivery_on" ? 0 : null,
        } });
        const siblingId = randomUUID();
        const siblingEnvelope = progressEnvelope({ ...seeded, id: siblingId, sequence: 2n, parentRecordId: seeded.rootId, memberOrdinal: 1n });
        await admitWorkflowInvocationsWithClaim({ ...seeded, expectedRevision: 2,
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, seeded.runId, seeded.rootId, 3n),
            invocations: [{ id: siblingId, sequence: 2n, parentRecordId: seeded.rootId, memberOrdinal: 1n, contentEnvelope: siblingEnvelope }] });
        await expect(commitWorkflowInvocationFact({ ...seeded.fact, lifecycle: "waiting_for_review" }))
            .resolves.toMatchObject({ parentRevision: 4 });
        expect((await getWorkflowRun(seeded)).run.revision).toBe(4);
        await expect(commitWorkflowInvocationFact({ ...seeded.fact, invocationId: siblingId, contentEnvelope: siblingEnvelope, lifecycle: "waiting_for_approval" }))
            .resolves.toMatchObject({ parentRevision: 4 });
        expect((await getWorkflowRun(seeded)).run.revision).toBe(4);
        await commitWorkflowInvocationFact({ ...seeded.fact, expectedLifecycle: "waiting_for_review", lifecycle: "completed" });
        expect((await getWorkflowRun(seeded)).run.revision).toBe(4);
        await expect(commitWorkflowInvocationFact({ ...seeded.fact, invocationId: siblingId, contentEnvelope: siblingEnvelope,
            expectedLifecycle: "waiting_for_approval", lifecycle: "completed" }))
            .resolves.toMatchObject({ parentRevision: 5 });
        expect((await getWorkflowRun(seeded)).run.revision).toBe(5);
    });

    it.each([true, false])("freezes the scoped Automation origin and explicit delivery request at accepted-snapshot resolution (delivery: %s)", async (deliver) => {
        const seeded = await seed();
        const automation = await db.automation.create({ data: { accountId: seeded.accountId, name: "Scoped workflow",
            scopeSessionId: seeded.sessionId, templateCiphertext: JSON.stringify({ t: "plain", v: {} }) } });
        const runId = randomUUID();
        await admitWorkflowRun({ ...seeded, runId, origin: { kind: "direct" }, acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }) });
        const definitionEnvelope = workflowDefinitionEnvelope();
        await db.automationRun.update({ where: { id: runId }, data: { originKind: "automation", automationId: automation.id,
            causeKind: "manual", causeOccurredAt: new Date(), claimedByMachineId: seeded.machineId, attempt: 1,
            workflowAcceptedSnapshotEnvelope: null, executionInputEnvelope: definitionEnvelope } });
        const request = { accountId: seeded.accountId, runId, automationId: automation.id, machineId: seeded.machineId,
            expectedAttempt: 1, expectedRevision: 0, accountCurrentness: await accountCurrentness(seeded.accountId),
            definitionEnvelope, acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId, automationId: automation.id,
                originSessionId: seeded.sessionId, deliver }),
            originSessionId: seeded.sessionId, ...(deliver ? { resultDelivery: { kind: "originating_session" as const } } : {}) };
        await expect(resolveAutomationWorkflowAcceptedSnapshotOwner({ ...request, originSessionId: randomUUID() }))
            .rejects.toMatchObject({ code: "currentness_conflict" });
        await expect(resolveAutomationWorkflowAcceptedSnapshotOwner({ ...request, originSessionId: undefined }))
            .rejects.toMatchObject({ code: "currentness_conflict" });
        const { app, headers } = await createReviewStorageApp(seeded.accountId);
        const keyPair = tweetnacl.sign.keyPair();
        const installationId = randomUUID();
        await db.machine.update({ where: { id: seeded.machineId }, data: { installationId,
            installationPublicKey: new Uint8Array(keyPair.publicKey) } });
        const path = "/v3/automations/runs/workflow-storage";
        const { accountId: _accountId, machineId, ...resolveInput } = request;
        const body = { operation: "accepted-snapshot.resolve", publisherMachineId: machineId, ...resolveInput };
        try {
            const response = await app.inject({ method: "POST", url: path, payload: body, headers: { ...headers,
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
                    keyPair, machineId, installationId, path, body,
                }),
            } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ run: { originDeliveryAckRevision: deliver ? 0 : null,
                origin: { kind: "automation", automationId: automation.id, originSessionId: seeded.sessionId,
                    cause: { kind: "manual" } } } });
        } finally {
            await app.close();
        }
        expect(await db.automationRun.findUniqueOrThrow({ where: { id: runId }, select: { originSessionId: true } })).toEqual({ originSessionId: seeded.sessionId });
        const stored = await db.automationRun.findUniqueOrThrow({ where: { id: runId }, select: automationRunWithAutomationSelect });
        expect(projectAutomationOriginRun(stored)).toMatchObject({ originKind: "automation", originSessionId: seeded.sessionId });
        expect(toAutomationV3WorkerClaimResponse({ run: stored, accountCurrentness: request.accountCurrentness })).toMatchObject({
            run: { automationId: automation.id, recipeKind: "workflow-v2", cause: { kind: "manual" } },
            automation: { id: automation.id },
        });
        if (deliver) await workflowRunService.ackWorkflowRunOriginDelivery({ accountId: seeded.accountId, runId, revision: 1 });
        // Lost-response rejoin uses frozen facts, not a subsequently edited Automation scope.
        await db.automation.update({ where: { id: automation.id }, data: { scopeSessionId: null } });
        await expect(resolveAutomationWorkflowAcceptedSnapshotOwner(request)).resolves.toMatchObject({
            disposition: "existing", run: { originDeliveryAckRevision: deliver ? 1 : null },
        });
        await expect(resolveAutomationWorkflowAcceptedSnapshotOwner({ ...request, originSessionId: randomUUID() })).rejects.toMatchObject({ code: "currentness_conflict" });
        await expect(resolveAutomationWorkflowAcceptedSnapshotOwner({ ...request,
            resultDelivery: deliver ? undefined : { kind: "originating_session" } })).rejects.toMatchObject({ code: "currentness_conflict" });
    });

    async function seedPendingAdmission() {
        const seeded = await seed();
        const runId = randomUUID();
        const rootId = randomUUID();
        const invocationId = randomUUID();
        await admitWorkflowRun({ ...seeded, runId, origin: { kind: "direct" }, acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }) });
        await initializeWorkflowRunExecution({ accountId: seeded.accountId, runId, expectedRevision: 0,
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 1n),
            rootInvocation: { id: rootId, contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }) } });
        const contentEnvelope = progressEnvelope({ ...seeded, runId, id: invocationId, sequence: 1n, parentRecordId: rootId, memberOrdinal: 0n });
        await admitWorkflowInvocationsWithClaim({ accountId: seeded.accountId, runId, expectedRevision: 1,
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 2n),
            invocations: [{ id: invocationId, sequence: 1n, parentRecordId: rootId, memberOrdinal: 0n, contentEnvelope }] });
        await db.automationRun.update({ where: { id: runId }, data: { state: "running" } });
        const fact = { accountId: seeded.accountId, runId, machineId: seeded.machineId, parentAttempt: 1,
            invocationId, invocationAttempt: 0n, expectedLifecycle: "pending" as const, lifecycle: "admitting" as const, contentEnvelope };
        return { ...seeded, runId, rootId, invocationId, fact };
    }

    it("rejects stale same-lifecycle content without changing the parent revision", async () => {
        const seeded = await seedPendingAdmission();
        const original = await getWorkflowRunInvocation({ ...seeded, invocationId: seeded.invocationId });
        expect(original.invocation.index).toMatchObject({ contentRevision: "0" });
        const first = progressEnvelope({ ...seeded, id: seeded.invocationId, sequence: 1n,
            parentRecordId: seeded.rootId, memberOrdinal: 0n, reason: "prepared-current-fact" });
        await commitWorkflowInvocationFactOwner({ ...seeded.fact,
            accountCurrentness: await accountCurrentness(seeded.accountId),
            expectedContentRevision: 0n, lifecycle: "pending", contentEnvelope: first });
        await expect(commitWorkflowInvocationFactOwner({ ...seeded.fact,
            accountCurrentness: await accountCurrentness(seeded.accountId),
            expectedContentRevision: 0n, lifecycle: "pending" }))
            .rejects.toMatchObject({ code: "currentness_conflict" });
        const current = await getWorkflowRunInvocation({ ...seeded, invocationId: seeded.invocationId });
        expect(current.invocation).toMatchObject({ index: { contentRevision: "1" }, contentEnvelope: first });
        expect(current.invocation.parentRevision).toBe(original.invocation.parentRevision);
    });

    it("publishes a draft through ordinary authenticated Account storage without releasing the invocation", async () => {
        const seeded = await seedPendingAdmission();
        await commitWorkflowInvocationFact(seeded.fact);
        const { app, headers } = await createReviewStorageApp(seeded.accountId);
        try {
            const contentEnvelope = progressEnvelope({ ...seeded, id: seeded.invocationId, sequence: 1n,
                parentRecordId: seeded.rootId, memberOrdinal: 0n, result: "private draft" });
            const response = await app.inject({ method: "POST", url: "/v3/automations/runs/workflow-storage",
                headers, payload: {
                    operation: "invocations.publish_draft", runId: seeded.runId,
                    invocationId: seeded.invocationId, invocationAttempt: "0", expectedContentRevision: "1",
                    accountCurrentness: await accountCurrentness(seeded.accountId), contentEnvelope,
                } });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({ invocation: { index: { lifecycle: "admitting", contentRevision: "2" }, contentEnvelope }, parentRevision: 2 });
            expect((await db.automationRun.findUniqueOrThrow({ where: { id: seeded.runId } })).revision).toBe(2);
        } finally {
            await app.close();
        }
    });

    it("rejects non-user review authority without mutating the held row", async () => {
        const seeded = await seedPendingAdmission();
        await commitWorkflowInvocationFact({ ...seeded.fact, lifecycle: "waiting_for_review" });
        const row = await db.workflowRunInvocation.findUniqueOrThrow({ where: { id: seeded.invocationId } });
        const parent = await db.automationRun.findUniqueOrThrow({ where: { id: seeded.runId } });
        const { app, headers } = await createReviewStorageApp(seeded.accountId, "account_automation");
        try {
            const response = await app.inject({ method: "POST", url: "/v3/automations/runs/workflow-storage", headers,
                payload: { operation: "invocations.complete_review", mode: "use_result", runId: seeded.runId,
                    invocationId: seeded.invocationId, invocationAttempt: "0", expectedContentRevision: "1",
                    accountCurrentness: await accountCurrentness(seeded.accountId), contentEnvelope: seeded.fact.contentEnvelope } });
            expect(response.statusCode).toBe(401);
            expect(await db.workflowRunInvocation.findUniqueOrThrow({ where: { id: seeded.invocationId } })).toEqual(row);
            expect(await db.automationRun.findUniqueOrThrow({ where: { id: seeded.runId } })).toEqual(parent);
        } finally {
            await app.close();
        }
        const presentUser = await createReviewStorageApp(seeded.accountId);
        try {
            const response = await presentUser.app.inject({ method: "POST", url: "/v3/automations/runs/workflow-storage", headers: presentUser.headers,
                payload: { operation: "invocations.complete_review", mode: "use_result", runId: seeded.runId,
                    invocationId: seeded.invocationId, invocationAttempt: "0", expectedContentRevision: "1",
                    accountCurrentness: await accountCurrentness(seeded.accountId), contentEnvelope: seeded.fact.contentEnvelope } });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({ disposition: "completed", invocation: { index: { lifecycle: "completed", contentRevision: "2" } } });
            expect(await db.workflowRunInvocation.findUniqueOrThrow({ where: { id: seeded.invocationId } }))
                .toMatchObject({ lifecycle: "completed", contentRevision: 2n });
            expect(await db.automationRun.findUniqueOrThrow({ where: { id: seeded.runId } }))
                .toMatchObject({ revision: parent.revision + 1 });
        } finally {
            await presentUser.app.close();
        }
    });

    it("replaces only the exact current held token without forking recovery", async () => {
        const seeded = await seedPendingAdmission();
        await commitWorkflowInvocationFact({ ...seeded.fact, lifecycle: "waiting_for_review" });
        const id = randomUUID();
        const contentEnvelope = progressEnvelope({ ...seeded, id, sequence: 2n,
            parentRecordId: seeded.rootId, memberOrdinal: 0n, attempt: 1n,
            previousAttemptRecordId: seeded.invocationId, logicalInvocationRecordId: seeded.invocationId });
        const request = { ...seeded, parentAttempt: 1, expectedRevision: 3,
            accountCurrentness: await accountCurrentness(seeded.accountId),
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, seeded.runId, seeded.rootId, 3n),
            invocations: [{ id, sequence: 2n, parentRecordId: seeded.rootId, memberOrdinal: 0n,
                contentEnvelope, replaces: { id: seeded.invocationId, attempt: 0n, contentRevision: 1n } }] };
        await expect(admitWorkflowInvocationsOwner({ ...request,
            invocations: [{ ...request.invocations[0], replaces: { ...request.invocations[0].replaces, contentRevision: 0n } }] }))
            .rejects.toMatchObject({ code: "currentness_conflict" });
        expect(await db.workflowRunInvocation.count({ where: { runId: seeded.runId } })).toBe(2);
        await expect(admitWorkflowInvocationsOwner(request)).resolves.toMatchObject({
            parentRevision: 4, disposition: "created", invocations: [{ id, attempt: "1", contentRevision: "0" }],
        });
        expect(await db.workflowRunInvocation.findUniqueOrThrow({ where: { id: seeded.invocationId } }))
            .toMatchObject({ lifecycle: "superseded", contentRevision: 2n });
        await expect(getCurrentWorkflowRunInvocation({ ...seeded, parentRecordId: seeded.rootId, memberOrdinal: 0n }))
            .resolves.toMatchObject({ invocation: { index: { id, attempt: "1", contentRevision: "0" }, contentEnvelope } });
        await expect(admitWorkflowInvocationsOwner(request)).resolves.toMatchObject({ disposition: "existing" });
        expect(await db.workflowRunInvocation.count({ where: { runId: seeded.runId } })).toBe(3);
    });

    it("refuses review parking while another current leaf has unresolved custody", async () => {
        for (const lifecycle of ["admitting", "waiting_for_approval", "cancel_requested"] as const) {
            const seeded = await seedPendingAdmission();
            const id = randomUUID();
            const contentEnvelope = progressEnvelope({ ...seeded, id, sequence: 2n,
                parentRecordId: seeded.rootId, memberOrdinal: 1n });
            await admitWorkflowInvocationsWithClaim({ ...seeded, expectedRevision: 2,
                checkpointEnvelope: checkpointEnvelope(seeded.accountId, seeded.runId, seeded.rootId, 3n),
                invocations: [{ id, sequence: 2n, parentRecordId: seeded.rootId, memberOrdinal: 1n, contentEnvelope }] });
            await commitWorkflowInvocationFact({ ...seeded.fact, lifecycle: "waiting_for_review" });
            await commitWorkflowInvocationFact({ ...seeded.fact, invocationId: id, lifecycle, contentEnvelope });
            const parent = await db.automationRun.findUniqueOrThrow({ where: { id: seeded.runId } });
            await expect(transitionWorkflowRun({ ...seeded, parentAttempt: 1, expectedRevision: parent.revision,
                state: "waiting_for_review", checkpointEnvelope: parent.workflowCheckpointEnvelope! }))
                .rejects.toMatchObject({ code: "currentness_conflict" });
            expect(await db.automationRun.findUniqueOrThrow({ where: { id: seeded.runId } })).toEqual(parent);
        }
    });

    it.each(["use_result", "generate"] as const)("serializes %s with parking in both orders without losing the wake", async (mode) => {
        for (const parkFirst of [false, true]) {
            const seeded = await seedPendingAdmission();
            await commitWorkflowInvocationFact({ ...seeded.fact, lifecycle: "waiting_for_review" });
            // Structural ancestors remain running while a reached leaf is held.
            await db.workflowRunInvocation.update({ where: { id: seeded.rootId }, data: { lifecycle: "running" } });
            const parent = await db.automationRun.findUniqueOrThrow({ where: { id: seeded.runId } });
            const held = await getWorkflowRunInvocation({ ...seeded, invocationId: seeded.invocationId });
            const park = () => transitionWorkflowRun({ ...seeded, parentAttempt: 1,
                expectedRevision: parent.revision, state: "waiting_for_review",
                checkpointEnvelope: checkpointEnvelope(seeded.accountId, seeded.runId, seeded.rootId, 2n) });
            const { app, headers } = await createReviewStorageApp(seeded.accountId);
            try {
                if (parkFirst) await park();
                const decision = await app.inject({ method: "POST", url: "/v3/automations/runs/workflow-storage",
                    headers, payload: {
                        operation: "invocations.complete_review", mode, runId: seeded.runId,
                        invocationId: seeded.invocationId, invocationAttempt: "0",
                        expectedContentRevision: held.invocation.index.contentRevision,
                        accountCurrentness: await accountCurrentness(seeded.accountId),
                        contentEnvelope: progressEnvelope({ ...seeded, id: seeded.invocationId, sequence: 1n,
                            parentRecordId: seeded.rootId, memberOrdinal: 0n, result: "accepted draft",
                            review: { decision: { kind: mode, requestedFromContentRevision: held.invocation.index.contentRevision } } }),
                    } });
                expect(decision.statusCode).toBe(200);
                if (!parkFirst) await expect(park()).rejects.toMatchObject({ code: "currentness_conflict" });
                const current = await db.automationRun.findUniqueOrThrow({ where: { id: seeded.runId } });
                expect(current).toMatchObject({ state: parkFirst ? "queued" : "running",
                    revision: parent.revision + (parkFirst ? 2 : 1), workflowCustodyState: "pending" });
                expect(current.dueAt).toEqual(parent.dueAt);
                if (parkFirst) expect(current).toMatchObject({ claimedByMachineId: null, claimedAt: null, leaseExpiresAt: null });
                const row = await getWorkflowRunInvocation({ ...seeded, invocationId: seeded.invocationId });
                expect(row.invocation.index).toMatchObject({ lifecycle: mode === "use_result" ? "completed" : "waiting_for_review",
                    contentRevision: "2" });
                expect(await db.workflowRunInvocation.count({ where: { runId: seeded.runId } })).toBe(2);
            } finally {
                await app.close();
            }
        }
    });

    it.each(["pause", "cancel"] as const)("serializes Generate with %s without allocating work or dropping custody", async (control) => {
        for (const decisionFirst of [false, true]) {
            const seeded = await seedPendingAdmission();
            await commitWorkflowInvocationFact({ ...seeded.fact, lifecycle: "waiting_for_review" });
            await transitionWorkflowRun({ ...seeded, parentAttempt: 1, expectedRevision: 3,
                state: "waiting_for_review", checkpointEnvelope: checkpointEnvelope(seeded.accountId, seeded.runId, seeded.rootId, 2n) });
            const { app, headers } = await createReviewStorageApp(seeded.accountId);
            const contentEnvelope = progressEnvelope({ ...seeded, id: seeded.invocationId, sequence: 1n,
                parentRecordId: seeded.rootId, memberOrdinal: 0n,
                review: { decision: { kind: "generate", requestedFromContentRevision: "1" } } });
            try {
                const decide = async () => app.inject({ method: "POST", url: "/v3/automations/runs/workflow-storage", headers,
                    payload: { operation: "invocations.complete_review", mode: "generate", runId: seeded.runId,
                        invocationId: seeded.invocationId, invocationAttempt: "0", expectedContentRevision: "1",
                        accountCurrentness: await accountCurrentness(seeded.accountId), contentEnvelope } });
                if (decisionFirst) expect((await decide()).statusCode).toBe(200);
                const parent = await db.automationRun.findUniqueOrThrow({ where: { id: seeded.runId } });
                await (control === "pause" ? pauseWorkflowRun : cancelWorkflowRun)({ ...seeded, expectedRevision: parent.revision });
                if (!decisionFirst) expect((await decide()).statusCode).toBe(control === "cancel" ? 409 : 200);
                const current = await db.automationRun.findUniqueOrThrow({ where: { id: seeded.runId } });
                const row = await getWorkflowRunInvocation({ ...seeded, invocationId: seeded.invocationId });
                expect(await db.workflowRunInvocation.count({ where: { runId: seeded.runId } })).toBe(2);
                if (control === "pause") {
                    expect(current).toMatchObject({ state: "paused", workflowCustodyState: "pending",
                        claimedByMachineId: null, claimedAt: null, leaseExpiresAt: null });
                    expect(row.invocation).toMatchObject({ index: { lifecycle: "waiting_for_review", contentRevision: "2" }, contentEnvelope });
                } else {
                    expect(current).toMatchObject({ state: decisionFirst ? "queued" : "cancelled",
                        workflowCustodyState: decisionFirst ? "pending" : "settled" });
                    expect(row.invocation.index.lifecycle).toBe("cancelled");
                    expect(row.invocation.index.contentRevision).toBe(decisionFirst ? "3" : "2");
                    if (decisionFirst) expect(row.invocation.contentEnvelope).toBe(contentEnvelope);
                }
            } finally {
                await app.close();
            }
        }
    });

    it.each(["pause_generate", "generate_pause", "pause_cancel"] as const)("preserves exact custody through live %s and refuses premature Resume", async (order) => {
        const seeded = await seedPendingAdmission();
        await commitWorkflowInvocationFact({ ...seeded.fact, lifecycle: "waiting_for_review" });
        await db.workflowRunInvocation.update({ where: { id: seeded.rootId }, data: { lifecycle: "running" } });
        const { app, headers } = await createReviewStorageApp(seeded.accountId);
        const generate = async () => app.inject({ method: "POST", url: "/v3/automations/runs/workflow-storage", headers,
            payload: { operation: "invocations.complete_review", mode: "generate", runId: seeded.runId,
                invocationId: seeded.invocationId, invocationAttempt: "0", expectedContentRevision: "1",
                accountCurrentness: await accountCurrentness(seeded.accountId), contentEnvelope: progressEnvelope({ ...seeded, id: seeded.invocationId,
                    sequence: 1n, parentRecordId: seeded.rootId, memberOrdinal: 0n,
                    review: { decision: { kind: "generate", requestedFromContentRevision: "1" } } }) } });
        try {
            if (order === "generate_pause") expect((await generate()).statusCode).toBe(200);
            let parent = await db.automationRun.findUniqueOrThrow({ where: { id: seeded.runId } });
            await pauseWorkflowRun({ ...seeded, expectedRevision: parent.revision });
            parent = await db.automationRun.findUniqueOrThrow({ where: { id: seeded.runId } });
            await expect(resumeWorkflowRunBoundary({ ...seeded, expectedRevision: parent.revision }))
                .rejects.toMatchObject({ code: "ineligible_state" });
            expect(await db.automationRun.findUniqueOrThrow({ where: { id: seeded.runId } })).toEqual(parent);
            if (order === "pause_generate") expect((await generate()).statusCode).toBe(200);
            if (order === "pause_cancel") {
                await cancelWorkflowRun({ ...seeded, expectedRevision: parent.revision });
                expect(await db.automationRun.findUniqueOrThrow({ where: { id: seeded.runId } }))
                    .toMatchObject({ state: "pause_requested", workflowCustodyState: "pending", claimedByMachineId: seeded.machineId });
                expect(await db.workflowRunInvocation.findUniqueOrThrow({ where: { id: seeded.invocationId } }))
                    .toMatchObject({ lifecycle: "cancelled", contentRevision: 2n });
                expect(await db.workflowRunInvocation.findUniqueOrThrow({ where: { id: seeded.rootId } }))
                    .toMatchObject({ lifecycle: "cancel_requested" });
            } else {
                parent = await db.automationRun.findUniqueOrThrow({ where: { id: seeded.runId } });
                expect(parent).toMatchObject({ state: "pause_requested", workflowCustodyState: "pending", claimedByMachineId: seeded.machineId });
                expect(await db.workflowRunInvocation.findUniqueOrThrow({ where: { id: seeded.invocationId } }))
                    .toMatchObject({ lifecycle: "waiting_for_review", contentRevision: 2n });
                const id = randomUUID();
                await expect(admitWorkflowInvocationsOwner({ ...seeded, parentAttempt: 1, expectedRevision: parent.revision,
                    accountCurrentness: await accountCurrentness(seeded.accountId),
                    checkpointEnvelope: checkpointEnvelope(seeded.accountId, seeded.runId, seeded.rootId, 3n),
                    invocations: [{ id, sequence: 2n, parentRecordId: seeded.rootId, memberOrdinal: 0n,
                        replaces: { id: seeded.invocationId, attempt: 0n, contentRevision: 2n },
                        contentEnvelope: progressEnvelope({ ...seeded, id, sequence: 2n, parentRecordId: seeded.rootId,
                            memberOrdinal: 0n, attempt: 1n, previousAttemptRecordId: seeded.invocationId }) }] }))
                    .rejects.toMatchObject({ code: "currentness_conflict" });
            }
            expect(await db.workflowRunInvocation.count({ where: { runId: seeded.runId } })).toBe(2);
            parent = await db.automationRun.findUniqueOrThrow({ where: { id: seeded.runId } });
            await transitionWorkflowRun({ ...seeded, parentAttempt: 1, expectedRevision: parent.revision,
                state: order === "pause_cancel" ? "cancelled" : "paused",
                ...(order === "pause_cancel" ? { custodyState: "settled" as const,
                    invocationTransitions: [{ id: seeded.rootId, expectedLifecycle: "cancel_requested" as const, lifecycle: "cancelled" as const }] } : {}),
                checkpointEnvelope: checkpointEnvelope(seeded.accountId, seeded.runId, seeded.rootId, 2n) });
            parent = await db.automationRun.findUniqueOrThrow({ where: { id: seeded.runId } });
            if (order === "pause_cancel") expect(parent).toMatchObject({ state: "cancelled", workflowCustodyState: "settled" });
            else {
                expect(parent.state).toBe("paused");
                await resumeWorkflowRunBoundary({ ...seeded, expectedRevision: parent.revision });
                expect(await db.automationRun.findUniqueOrThrow({ where: { id: seeded.runId } }))
                    .toMatchObject({ state: "queued", claimedByMachineId: null, claimedAt: null, leaseExpiresAt: null, dueAt: parent.dueAt });
            }
        } finally {
            await app.close();
        }
    });

    it("hints the origin owner only when a row enters admitting, attention changes, or the Run ends", async () => {
        const seeded = await seedPendingAdmission();
        await db.automationRun.update({ where: { id: seeded.runId }, data: {
            originSessionId: seeded.sessionId, originDeliveryAckRevision: 0,
        } });
        const change = () => db.accountChange.findFirst({ where: { kind: "session", entityId: seeded.sessionId }, orderBy: { cursor: "desc" } });
        expect(await change()).toBeNull();
        await commitWorkflowInvocationFact(seeded.fact);
        const admitted = await change();
        expect(admitted).toMatchObject({ accountId: seeded.accountId, hint: { kind: "workflow-run-delivery", runId: seeded.runId, revision: 2 } });
        await commitWorkflowInvocationFact({ ...seeded.fact, expectedLifecycle: "admitting", lifecycle: "running" });
        expect((await change())?.cursor).toBe(admitted?.cursor);
        await commitWorkflowInvocationFact({ ...seeded.fact, expectedLifecycle: "running", lifecycle: "waiting_for_approval" });
        const attention = await change();
        expect(attention!.cursor).toBeGreaterThan(admitted!.cursor);
        expect(attention).toMatchObject({ hint: { kind: "workflow-run-delivery", runId: seeded.runId, revision: 3 } });
        await commitWorkflowInvocationFact({ ...seeded.fact, expectedLifecycle: "waiting_for_approval", lifecycle: "completed" });
        const resolved = await change();
        expect(resolved!.cursor).toBeGreaterThan(attention!.cursor);
        expect(resolved).toMatchObject({ hint: { kind: "workflow-run-delivery", runId: seeded.runId, revision: 4 } });
        await transitionWorkflowRun({ ...seeded, parentAttempt: 1, expectedRevision: 4, state: "succeeded",
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, seeded.runId, seeded.rootId, 2n), custodyState: "settled",
            invocationTransitions: [{ id: seeded.rootId, expectedLifecycle: "pending", lifecycle: "completed" }] });
        const terminal = await change();
        expect(terminal!.cursor).toBeGreaterThan(resolved!.cursor);
        expect(terminal).toMatchObject({ accountId: seeded.accountId, hint: { kind: "workflow-run-delivery", runId: seeded.runId, revision: 5 } });
        expect(await db.accountChange.count({ where: { kind: "session", entityId: seeded.sessionId, accountId: { not: seeded.accountId } } })).toBe(0);
    });

    it.each(["pause", "cancel"] as const)("records an authoritative origin withdrawal after %s without a worker claim", async (control) => {
        expect("recordWorkflowRunOriginInputWithdrawn" in workflowRunService).toBe(true);
        const seeded = await seedPendingAdmission();
        await db.automationRun.update({ where: { id: seeded.runId }, data: { originSessionId: seeded.sessionId } });
        await commitWorkflowInvocationFact(seeded.fact);
        await (control === "pause" ? pauseWorkflowRun : cancelWorkflowRun)({ accountId: seeded.accountId, runId: seeded.runId, expectedRevision: 2 });
        await db.automationRun.update({ where: { id: seeded.runId }, data: { claimedByMachineId: null } });
        const currentEnvelope = progressEnvelope({ ...seeded, runId: seeded.runId, id: seeded.invocationId,
            sequence: 1n, parentRecordId: seeded.rootId, memberOrdinal: 0n, reason: "canonical-newer-fact" });
        await db.workflowRunInvocation.update({ where: { id: seeded.invocationId }, data: { contentEnvelope: currentEnvelope } });
        const request = { accountId: seeded.accountId, originSessionId: seeded.sessionId, runId: seeded.runId,
            invocationRecordId: seeded.invocationId, expectedRevision: 3, accountCurrentness: await accountCurrentness(seeded.accountId) };
        await db.workflowRunInvocation.update({ where: { id: seeded.invocationId }, data: { contentEnvelope: encryptedProgressEnvelope({ ...seeded, runId: seeded.runId, id: seeded.invocationId }) } });
        await expect(workflowRunService.recordWorkflowRunOriginInputWithdrawn(request)).rejects.toMatchObject({ code: "content_unavailable" });
        await db.workflowRunInvocation.update({ where: { id: seeded.invocationId }, data: { contentEnvelope: currentEnvelope } });
        await expect(workflowRunService.recordWorkflowRunOriginInputWithdrawn({ ...request, originSessionId: randomUUID() })).rejects.toMatchObject({ code: "run_not_found" });
        await expect(workflowRunService.recordWorkflowRunOriginInputWithdrawn({ ...request, expectedRevision: 2 })).rejects.toMatchObject({ code: "currentness_conflict" });
        await expect(workflowRunService.recordWorkflowRunOriginInputWithdrawn(request)).resolves.toMatchObject({ index: { id: seeded.invocationId, lifecycle: control === "pause" ? "pending" : "cancelled" } });
        expect(await db.workflowRunInvocation.findUniqueOrThrow({ where: { id: seeded.invocationId }, select: { contentEnvelope: true } }))
            .toEqual({ contentEnvelope: currentEnvelope });
        await expect(workflowRunService.recordWorkflowRunOriginInputWithdrawn(request)).resolves.toMatchObject({ index: { id: seeded.invocationId, lifecycle: control === "pause" ? "pending" : "cancelled" } });
        expect((await getWorkflowRun({ accountId: seeded.accountId, runId: seeded.runId })).run.revision).toBe(3);
    });

    it.each(["pause", "cancel"] as const)("fences pending admission against %s without a parent-revision argument", async (control) => {
        for (const admissionFirst of [false, true]) {
            const seeded = await seedPendingAdmission();
            if (admissionFirst) await commitWorkflowInvocationFact(seeded.fact);
            await (control === "pause" ? pauseWorkflowRun : cancelWorkflowRun)({ accountId: seeded.accountId, runId: seeded.runId, expectedRevision: 2 });
            await expect(commitWorkflowInvocationFact(seeded.fact)).rejects.toMatchObject({ code: "currentness_conflict" });
            const row = await db.workflowRunInvocation.findUniqueOrThrow({ where: { id: seeded.invocationId } });
            expect(row.lifecycle).toBe(control === "cancel" ? "cancel_requested" : admissionFirst ? "admitting" : "pending");
        }
    });

    it("rejects a different child slot after Cancel with stale and fresh parent revisions", async () => {
        const seeded = await seedPendingAdmission();
        const cancelled = await cancelWorkflowRun({ accountId: seeded.accountId, runId: seeded.runId, expectedRevision: 2 });
        expect(cancelled.run.state).toBe("running");
        const id = randomUUID();
        const request = { accountId: seeded.accountId, runId: seeded.runId,
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, seeded.runId, seeded.rootId, 3n),
            invocations: [{ id, sequence: 2n, parentRecordId: seeded.rootId, memberOrdinal: 1n,
                contentEnvelope: progressEnvelope({ ...seeded, id, sequence: 2n, parentRecordId: seeded.rootId, memberOrdinal: 1n }) }] };
        for (const expectedRevision of [2, cancelled.run.revision]) {
            await expect(admitWorkflowInvocationsWithClaim({ ...request, expectedRevision })).rejects.toMatchObject({ code: "currentness_conflict" });
        }
        expect(await db.workflowRunInvocation.count({ where: { id } })).toBe(0);
    });

    it("keeps sibling allocation and valid sibling facts independent of admission facts", async () => {
        const seeded = await seedPendingAdmission();
        const id = randomUUID();
        const contentEnvelope = progressEnvelope({ ...seeded, id, sequence: 2n, parentRecordId: seeded.rootId, memberOrdinal: 1n });
        await admitWorkflowInvocationsWithClaim({ accountId: seeded.accountId, runId: seeded.runId, expectedRevision: 2,
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, seeded.runId, seeded.rootId, 3n),
            invocations: [{ id, sequence: 2n, parentRecordId: seeded.rootId, memberOrdinal: 1n, contentEnvelope }] });
        await commitWorkflowInvocationFact(seeded.fact);
        await commitWorkflowInvocationFact({ ...seeded.fact, invocationId: id, contentEnvelope });
        await commitWorkflowInvocationFact({ ...seeded.fact, expectedLifecycle: "admitting", lifecycle: "completed" });
        await commitWorkflowInvocationFact({ ...seeded.fact, invocationId: id, contentEnvelope, expectedLifecycle: "admitting", lifecycle: "completed" });
        expect((await getWorkflowRun({ accountId: seeded.accountId, runId: seeded.runId })).run.revision).toBe(3);
    });

    it("revalidates an exact admitting fact before a subsequent input release", async () => {
        const seeded = await seedPendingAdmission();
        await commitWorkflowInvocationFact(seeded.fact);
        const repeated = { ...seeded.fact, expectedLifecycle: "admitting" as const };
        await expect(commitWorkflowInvocationFact(repeated)).resolves.toMatchObject({ lifecycle: "admitting" });
        await pauseWorkflowRun({ accountId: seeded.accountId, runId: seeded.runId, expectedRevision: 2 });
        await expect(commitWorkflowInvocationFact(repeated)).rejects.toMatchObject({ code: "currentness_conflict" });
        expect((await getWorkflowRun({ accountId: seeded.accountId, runId: seeded.runId })).run.revision).toBe(3);
    });

    it("pauses queued work directly and resumes by requeueing without its old claim", async () => {
        const seeded = await seed();
        const runId = randomUUID();
        await admitWorkflowRun({ ...seeded, runId, origin: { kind: "direct" }, acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }) });
        const dueAt = (await db.automationRun.findUniqueOrThrow({ where: { id: runId } })).dueAt;
        await expect(pauseWorkflowRun({ accountId: seeded.accountId, runId, expectedRevision: 0 })).resolves.toMatchObject({ run: { state: "paused", revision: 1 } });
        await db.automationRun.update({ where: { id: runId }, data: { claimedByMachineId: seeded.machineId, claimedAt: new Date(), leaseExpiresAt: new Date(Date.now() + 60_000) } });
        await expect(resumeWorkflowRunBoundary({ accountId: seeded.accountId, runId, expectedRevision: 1 })).resolves.toMatchObject({ run: { state: "queued", revision: 2 } });
        expect(await db.automationRun.findUniqueOrThrow({ where: { id: runId }, select: { dueAt: true, claimedByMachineId: true, claimedAt: true, leaseExpiresAt: true } }))
            .toEqual({ dueAt, claimedByMachineId: null, claimedAt: null, leaseExpiresAt: null });
    });

    it("offers boundary Resume for a paused Run that never needed a checkpoint", () => {
        expect(deriveWorkflowRunAvailability({ state: "paused", workflowCustodyState: "pending",
            hasExecution: false, hasCheckpoint: false })).toMatchObject({ resumeBoundary: true });
    });

    it.each([
        { origin: "direct", mode: "plain" },
        { origin: "direct", mode: "e2ee" },
        { origin: "automation", mode: "plain" },
    ] as const)("records keyless Resume under CAS and consumes it once in the worker claim ($origin, $mode)", async ({ origin, mode }) => {
        const seeded = await seed();
        const runId = randomUUID();
        if (mode === "e2ee") {
            const signing = tweetnacl.sign.keyPair();
            const contentPublicKey = new Uint8Array(tweetnacl.box.keyPair().publicKey);
            await db.account.update({ where: { id: seeded.accountId }, data: {
                publicKey: Buffer.from(signing.publicKey).toString("hex"), encryptionMode: "e2ee", contentPublicKey,
                contentPublicKeySig: signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey }),
            } });
        }
        await admitWorkflowRun({ ...seeded, runId, origin: { kind: "direct" },
            acceptedEnvelope: mode === "plain" ? await acceptedEnvelope({ ...seeded, runId }) : await encryptedAcceptedEnvelope({ ...seeded, runId }),
            ...(mode === "e2ee" ? { recipientKeyEnvelopes: [await encryptedRunOwnerEnvelope(seeded.accountId)] } : {}),
        });
        if (origin === "automation") {
            const automation = await db.automation.create({ data: { accountId: seeded.accountId,
                name: "Resumed workflow", targetType: null, templateCiphertext: workflowDefinitionEnvelope() } });
            await db.automationRun.update({ where: { id: runId }, data: {
                originKind: "automation", automationId: automation.id, causeKind: "manual", causeOccurredAt: new Date(),
                executionInputEnvelope: workflowDefinitionEnvelope(),
                workflowAcceptedSnapshotEnvelope: await acceptedEnvelope({ ...seeded, runId, automationId: automation.id }),
            } });
        }
        await pauseWorkflowRun({ ...seeded, runId, expectedRevision: 0 });
        await expect(resumeWorkflowRunBoundary({ ...seeded, runId, expectedRevision: 0 }))
            .rejects.toMatchObject({ code: "currentness_conflict" });
        expect(await db.automationRun.findUniqueOrThrow({ where: { id: runId } }))
            .toMatchObject({ state: "paused", revision: 1, workflowResumeRequestedRevision: null });
        await resumeWorkflowRunBoundary({ ...seeded, runId, expectedRevision: 1 });
        expect(await db.automationRun.findUniqueOrThrow({ where: { id: runId } }))
            .toMatchObject({ state: "queued", revision: 2, workflowResumeRequestedRevision: 2 });
        const unassigned = await db.machine.create({ data: { id: randomUUID(), accountId: seeded.accountId, metadata: "{}" } });
        expect((await claimAutomationRun({ ...seeded, machineId: unassigned.id, leaseDurationMs: 60_000,
            recipeFeaturePolicy: { workflowsEnabled: true } })).run).toBeNull();
        expect(await db.automationRun.findUniqueOrThrow({ where: { id: runId } }))
            .toMatchObject({ state: "queued", revision: 2, workflowResumeRequestedRevision: 2 });
        const installationId = randomUUID();
        await db.machine.update({ where: { id: seeded.machineId }, data: {
            installationId, installationPublicKey: new Uint8Array(tweetnacl.sign.keyPair().publicKey),
        } });
        const claimRequest = { machineInstallationId: installationId, nonce: randomUUID(), expiresAt: new Date(Date.now() + 60_000) };
        const claimed = await claimAutomationRun({ ...seeded, leaseDurationMs: 60_000,
            recipeFeaturePolicy: { workflowsEnabled: true }, claimRequest });
        expect(toAutomationV3WorkerClaimResponse(claimed).run)
            .toMatchObject({ id: runId, workflowResumeRequestedRevision: 2 });
        expect(await db.automationRun.findUniqueOrThrow({ where: { id: runId } }))
            .toMatchObject({ state: "claimed", workflowResumeRequestedRevision: null });
        const replayed = await claimAutomationRun({ ...seeded, leaseDurationMs: 60_000,
            recipeFeaturePolicy: { workflowsEnabled: true }, claimRequest });
        expect(toAutomationV3WorkerClaimResponse(replayed)).toEqual(toAutomationV3WorkerClaimResponse(claimed));
        await db.automationRun.update({ where: { id: runId }, data: { leaseExpiresAt: new Date(0) } });
        const reclaimed = await claimAutomationRun({ ...seeded, leaseDurationMs: 60_000,
            recipeFeaturePolicy: { workflowsEnabled: true } });
        expect(toAutomationV3WorkerClaimResponse(reclaimed).run).toMatchObject({ id: runId });
        expect(toAutomationV3WorkerClaimResponse(reclaimed).run).not.toHaveProperty("workflowResumeRequestedRevision");
    });

    it.each(["pause", "cancel"] as const)("supersedes an unclaimed Resume with %s", async (control) => {
        const seeded = await seed();
        const runId = randomUUID();
        await admitWorkflowRun({ ...seeded, runId, origin: { kind: "direct" }, acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }) });
        await pauseWorkflowRun({ ...seeded, runId, expectedRevision: 0 });
        await resumeWorkflowRunBoundary({ ...seeded, runId, expectedRevision: 1 });
        await (control === "pause" ? pauseWorkflowRun : cancelWorkflowRun)({ ...seeded, runId, expectedRevision: 2 });
        expect(await db.automationRun.findUniqueOrThrow({ where: { id: runId } }))
            .toMatchObject({ state: control === "pause" ? "paused" : "cancelled", workflowResumeRequestedRevision: null });
    });

    it.each(["direct", "automation"] as const)("reclaims expired pause_requested %s custody and renews only the exact claim before Resume", async (origin) => {
        const seeded = await seedPendingAdmission();
        if (origin === "automation") {
            const automation = await db.automation.create({ data: { accountId: seeded.accountId,
                name: "Paused workflow", targetType: null, templateCiphertext: workflowDefinitionEnvelope() }, select: { id: true } });
            await db.automationRun.update({ where: { id: seeded.runId }, data: {
                originKind: "automation", automationId: automation.id,
                causeKind: "manual", causeOccurredAt: new Date(),
                executionInputEnvelope: workflowDefinitionEnvelope(),
                workflowAcceptedSnapshotEnvelope: await acceptedEnvelope({ ...seeded, automationId: automation.id }),
            } });
        }
        await commitWorkflowInvocationFact(seeded.fact);
        await pauseWorkflowRun({ accountId: seeded.accountId, runId: seeded.runId, expectedRevision: 2 });
        await db.automationRun.update({ where: { id: seeded.runId }, data: { leaseExpiresAt: null } });
        const claim = () => claimAutomationRun({ accountId: seeded.accountId, machineId: seeded.machineId,
            leaseDurationMs: 30_000, recipeFeaturePolicy: { workflowsEnabled: true } });
        expect((await claim()).run).toBeNull();
        await db.automationRun.update({ where: { id: seeded.runId }, data: { leaseExpiresAt: new Date(Date.now() + 60_000) } });
        expect((await claim()).run).toBeNull();
        await db.automationRun.update({ where: { id: seeded.runId }, data: { leaseExpiresAt: new Date(Date.now() - 1_000) } });
        const reclaimed = await claim();
        expect(reclaimed.run).toMatchObject({ id: seeded.runId, state: "pause_requested", attempt: 2, revision: 4 });
        expect(toAutomationV3WorkerClaimResponse(reclaimed, seeded.accountId)).toMatchObject({
            run: { id: seeded.runId, recipeKind: "workflow-v2", attempt: 2, revision: 4 },
        });
        const heartbeat = { accountId: seeded.accountId, runId: seeded.runId, machineId: seeded.machineId,
            attempt: 2, leaseDurationMs: 30_000 };
        await expect(heartbeatAutomationRun({ ...heartbeat, attempt: 1 })).resolves.toMatchObject({ ok: false });
        await expect(heartbeatAutomationRun({ ...heartbeat, machineId: randomUUID() })).resolves.toMatchObject({ ok: false });
        await expect(heartbeatAutomationRun(heartbeat)).resolves.toMatchObject({ ok: true });
        await expect(commitWorkflowInvocationFact({ ...seeded.fact, parentAttempt: 2, expectedLifecycle: "admitting" }))
            .rejects.toMatchObject({ code: "currentness_conflict" });
        await expect(commitWorkflowInvocationFact({ ...seeded.fact, parentAttempt: 1,
            expectedLifecycle: "admitting", lifecycle: "completed" })).rejects.toMatchObject({ code: "currentness_conflict" });
        await expect(commitWorkflowInvocationFact({ ...seeded.fact, parentAttempt: 2,
            expectedLifecycle: "admitting", lifecycle: "completed" })).resolves.toMatchObject({ lifecycle: "completed" });
        expect((await getWorkflowRun({ accountId: seeded.accountId, runId: seeded.runId })).run.revision).toBe(4);
        await transitionWorkflowRun({ accountId: seeded.accountId, runId: seeded.runId, machineId: seeded.machineId,
            parentAttempt: 2, expectedRevision: 4, state: "paused",
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, seeded.runId, seeded.rootId, 2n) });
        await expect(resumeWorkflowRunBoundary({ accountId: seeded.accountId, runId: seeded.runId, expectedRevision: 5 }))
            .resolves.toMatchObject({ run: { state: "queued", revision: 6 } });
        await expect(heartbeatAutomationRun(heartbeat)).resolves.toMatchObject({ ok: false });
    });

    it("renews the exact pause_requested claim without advancing parent revision", async () => {
        const seeded = await seedPendingAdmission();
        await pauseWorkflowRun({ accountId: seeded.accountId, runId: seeded.runId, expectedRevision: 2 });
        await db.automationRun.update({ where: { id: seeded.runId }, data: { leaseExpiresAt: new Date(Date.now() + 60_000) } });
        const heartbeat = { accountId: seeded.accountId, runId: seeded.runId, machineId: seeded.machineId,
            attempt: 1, leaseDurationMs: 30_000 };
        await expect(heartbeatAutomationRun({ ...heartbeat, attempt: 0 })).resolves.toMatchObject({ ok: false });
        await expect(heartbeatAutomationRun({ ...heartbeat, machineId: randomUUID() })).resolves.toMatchObject({ ok: false });
        await expect(heartbeatAutomationRun(heartbeat)).resolves.toMatchObject({ ok: true });
        expect((await getWorkflowRun({ accountId: seeded.accountId, runId: seeded.runId })).run.revision).toBe(3);
    });

    it("does not require attention for unacknowledged origin delivery on settled work", async () => {
        const seeded = await seed();
        const settledRunId = randomUUID();
        const interruptedRunId = randomUUID();
        for (const runId of [settledRunId, interruptedRunId]) {
            await admitWorkflowRun({
                ...seeded,
                runId,
                origin: { kind: "direct" },
                acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }),
            });
        }
        await db.automationRun.update({
            where: { id: settledRunId },
            data: { state: "succeeded", workflowCustodyState: "settled", originDeliveryAckRevision: 0 },
        });
        await db.automationRun.update({
            where: { id: interruptedRunId },
            data: { state: "interrupted" },
        });

        const attention = await listWorkflowRuns({ accountId: seeded.accountId, attention: "required", pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES });
        expect(attention.runs.map((run) => run.id)).toEqual([interruptedRunId]);
        const all = await listWorkflowRuns({ accountId: seeded.accountId, pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES });
        expect(all.runs.map((run) => run.id)).toContain(settledRunId);
        const settledObservation = await waitWorkflowRun({
            accountId: seeded.accountId,
            runId: settledRunId,
            timeoutSeconds: 0,
        });
        expect(settledObservation).toMatchObject({ observation: "terminal", run: { id: settledRunId } });
    });

    it.each(["account", "terminal"] as const)("reads, cancels, pulls and acks retained runs with ordinary %s credentials without a publisher", async (authTokenKind) => {
        const [{ auth }, { enableAuthentication }, { registerWorkflowRunStorageRoutes }] = await Promise.all([
            import("@/app/auth/auth"),
            import("@/app/api/utils/enableAuthentication"),
            import("@/app/api/routes/automations/registerWorkflowRunStorageRoutes"),
        ]);
        await auth.init();
        const seeded = await seed();
        const runId = randomUUID();
        await admitWorkflowRun({ ...seeded, runId, origin: { kind: "direct", originSessionId: seeded.sessionId },
            acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId, originSessionId: seeded.sessionId }), resultDelivery: { kind: "originating_session" } });
        const token = await auth.createToken(seeded.accountId, undefined, { kind: authTokenKind, authority: authTokenKind === "account" ? "present_user" : "account_automation" });
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerWorkflowRunStorageRoutes(app);
        try {
            const read = await app.inject({ method: "POST", url: "/v3/automations/runs/workflow-storage", headers: { authorization: `Bearer ${token}` }, payload: { operation: "get", runId } });
            expect(read.statusCode).toBe(200);
            expect(read.json()).toMatchObject({ run: { id: runId }, acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId, originSessionId: seeded.sessionId }) });
            const cancel = await app.inject({ method: "POST", url: "/v3/automations/runs/workflow-storage", headers: { authorization: `Bearer ${token}` }, payload: { operation: "cancel", runId, expectedRevision: 0 } });
            expect(cancel.statusCode).toBe(200);
            expect(await db.automationRun.findUnique({ where: { id: runId }, select: { state: true } })).toEqual({ state: "cancelled" });
            const pullInput = { operation: "delivery.pull", originSessionId: seeded.sessionId, pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES };
            const pull = await app.inject({ method: "POST", url: "/v3/automations/runs/workflow-storage", headers: { authorization: `Bearer ${token}` }, payload: pullInput });
            expect(pull.statusCode).toBe(200);
            expect(pull.json()).toMatchObject({ runs: [{ run: { id: runId, originDeliveryAckRevision: 0 } }] });
            const ack = await app.inject({ method: "POST", url: "/v3/automations/runs/workflow-storage", headers: { authorization: `Bearer ${token}` }, payload: { operation: "delivery.ack", runId, revision: 1 } });
            expect(ack.statusCode).toBe(200);
            const afterAck = await app.inject({ method: "POST", url: "/v3/automations/runs/workflow-storage", headers: { authorization: `Bearer ${token}` }, payload: pullInput });
            expect(afterAck.json()).toMatchObject({ runs: [] });
        } finally {
            await app.close();
        }
    });

    it.each(["mode", "binding", "malformed"])("projects an unavailable list sidecar for a wrong accepted envelope %s without losing the row or cursor", async (mismatch) => {
        const seeded = await seed();
        const runId = randomUUID();
        const otherId = randomUUID();
        for (const id of [runId, otherId]) await admitWorkflowRun({ ...seeded, runId: id, origin: { kind: "direct" }, acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId: id }) });
        const invalid = mismatch === "mode"
            ? await encryptedAcceptedEnvelope({ ...seeded, runId })
            : mismatch === "binding"
                ? await acceptedEnvelope({ ...seeded, runId: randomUUID() })
                : "not-a-stored-envelope".repeat(4096);
        await db.automationRun.update({ where: { id: runId }, data: { workflowAcceptedSnapshotEnvelope: invalid, createdAt: new Date("2030-01-01") } });
        await expect(getWorkflowRun({ accountId: seeded.accountId, runId })).rejects.toMatchObject({ code: mismatch === "mode" ? "content_unavailable" : "invalid_input" });
        const page = await listWorkflowRuns({ accountId: seeded.accountId, limit: 1, pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES });
        expect(page.runs.map((run) => run.id)).toEqual([runId]);
        expect(page.acceptedEnvelopesByRunId).toEqual({ [runId]: null });
        expect(page.nextCursor).toBeTypeOf("string");
        const next = await listWorkflowRuns({ accountId: seeded.accountId, cursor: page.nextCursor, pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES });
        expect(next.runs.map((run) => run.id)).toEqual([otherId]);
        expect(next.acceptedEnvelopesByRunId[otherId]).toBe(await acceptedEnvelope({ ...seeded, runId: otherId }));
        expect(await db.automationRun.findUnique({ where: { id: runId }, select: { workflowAcceptedSnapshotEnvelope: true } })).toEqual({ workflowAcceptedSnapshotEnvelope: invalid });
    });

    it("qualifies storage credentials through real signed provenance and denies worker authority to an ordinary Account", async () => {
        const [{ auth }, { enableAuthentication }, { registerWorkflowRunStorageRoutes }] = await Promise.all([
            import("@/app/auth/auth"), import("@/app/api/utils/enableAuthentication"), import("@/app/api/routes/automations/registerWorkflowRunStorageRoutes"),
        ]);
        const seeded = await seed();
        const runId = randomUUID();
        await admitWorkflowRun({ ...seeded, runId, origin: { kind: "direct" }, acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }) });
        const accountToken = await auth.createToken(seeded.accountId, undefined, { kind: "account", authority: "present_user" });
        const directoryToken = await auth.createToken(seeded.accountId, undefined, { kind: "account_directory", authority: "present_user" });
        const pat = await auth.createApiToken({ accountId: seeded.accountId, tokenId: randomUUID(), label: "Workflow qualification" });
        const runner = await createMaterializedEphemeralRunnerFixture();
        await expect(auth.verifyToken(runner.token)).resolves.toMatchObject({ authTokenKind: "ephemeral_session_runner" });
        const generator = await privacyKit.createPersistentTokenGenerator({ service: "handy", seed: String(process.env.HANDY_MASTER_SECRET) });
        const malformed = await generator.new({ user: seeded.accountId, extras: { tokenEpoch: 0, provenance: { v: 2, kind: "account", authority: "present_user" } } });
        const unknown = await generator.new({ user: seeded.accountId, extras: { tokenEpoch: 0, provenance: { v: 1, kind: "unknown", authority: "present_user" } } });
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerWorkflowRunStorageRoutes(app);
        try {
            for (const [token, status] of [[directoryToken, 403], [pat.token, 403], [runner.token, 403], [malformed, 401], [unknown, 401]] as const) {
                const response = await app.inject({ method: "POST", url: "/v3/automations/runs/workflow-storage", headers: { authorization: `Bearer ${token}` }, payload: { operation: "cancel", runId, expectedRevision: 0 } });
                expect(response.statusCode).toBe(status);
            }
            const worker = await app.inject({ method: "POST", url: "/v3/automations/runs/workflow-storage", headers: { authorization: `Bearer ${accountToken}` }, payload: { operation: "recovery.list", publisherMachineId: seeded.machineId, pageByteLimit: 4096 } });
            expect(worker.statusCode).toBe(401);
            expect(await db.automationRun.findUnique({ where: { id: runId }, select: { state: true, revision: true } })).toEqual({ state: "queued", revision: 0 });
        } finally {
            await app.close();
        }
    });

    it("retains the signed external Action read path only with its exact publisher proof", async () => {
        const [{ auth }, { enableAuthentication }, { registerWorkflowRunStorageRoutes }] = await Promise.all([
            import("@/app/auth/auth"), import("@/app/api/utils/enableAuthentication"), import("@/app/api/routes/automations/registerWorkflowRunStorageRoutes"),
        ]);
        const seeded = await seed();
        const runId = randomUUID();
        await admitWorkflowRun({ ...seeded, runId, origin: { kind: "direct" }, acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }) });
        const keyPair = tweetnacl.sign.keyPair();
        const installationId = randomUUID();
        await db.machine.update({ where: { id: seeded.machineId }, data: { installationId, installationPublicKey: new Uint8Array(keyPair.publicKey) } });
        const pat = await auth.createApiToken({ accountId: seeded.accountId, tokenId: randomUUID(), label: "External Workflow read" });
        const principal = await auth.verifyPat(pat.token);
        if (!principal.ok) throw new Error("Expected current PAT fixture");
        const actionId = "workflow.run.get";
        const target = { kind: "machine" as const, machineId: seeded.machineId };
        const envelope = { v: 1 as const, requestId: randomUUID(), target, input: { runId } };
        const authorization = await auth.mintExternalActionExecutionAuthorization({
            accountId: principal.accountId, principalId: principal.principalId, credentialId: principal.credentialId, grant: principal.grant,
            serverIdentityId: await getOrCreateServerIdentityId(), machineId: seeded.machineId, actionId,
            requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target,
        });
        const path = "/v3/automations/runs/workflow-storage";
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerWorkflowRunStorageRoutes(app);
        const request = async (publisher: boolean, tamper = false) => {
            const body = { operation: "get", runId, ...(publisher ? { publisherMachineId: seeded.machineId } : {}) };
            const signature = signExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: actionId, target, installationId, requestId: envelope.requestId, method: "POST", path, body, privateKey: keyPair.secretKey });
            return await app.inject({ method: "POST", url: path, payload: body, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: tamper ? "invalid-signature" : signature,
                ...(publisher ? { [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({ keyPair, machineId: seeded.machineId, installationId, path, body }) } : {}),
            } });
        };
        try {
            expect((await request(false)).statusCode).toBe(401);
            const read = await request(true);
            expect(read.statusCode, read.body).toBe(200);
            expect(read.json()).toMatchObject({ run: { id: runId } });
            expect((await request(true, true)).statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it("rereads structural wait state without loading the accepted detail envelope", async () => {
        const seeded = await seed();
        const runId = randomUUID();
        await admitWorkflowRun({
            accountId: seeded.accountId,
            runId,
            origin: { kind: "direct" },
            machineId: seeded.machineId,
            acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }),
        });
        await db.automationRun.update({
            where: { id: runId },
            data: { workflowAcceptedSnapshotEnvelope: "not-a-stored-envelope" },
        });

        await expect(waitWorkflowRun({
            accountId: seeded.accountId,
            runId,
            afterRevision: 99,
            timeoutSeconds: 0,
        })).resolves.toMatchObject({ observation: "changed", run: { id: runId, revision: 0 } });
    });

    it("returns the exact nonterminal observation immediately without parking a server poll", async () => {
        const seeded = await seed();
        const runId = randomUUID();
        await admitWorkflowRun({
            accountId: seeded.accountId,
            runId,
            origin: { kind: "direct" },
            machineId: seeded.machineId,
            acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }),
        });
        // Hosts observe the Account feed and own their optional waiting deadline.
        await expect(waitWorkflowRun({
            accountId: seeded.accountId,
            runId,
        })).resolves.toMatchObject({ observation: "waiting", run: { id: runId, revision: 0 } });
        await expect(waitWorkflowRun({ accountId: seeded.accountId, runId, timeoutSeconds: 0 }))
            .resolves.toMatchObject({ observation: "timeout", run: { id: runId, revision: 0 } });
    });

    it("returns paused ahead of the observation deadline through the exact snapshot path", async () => {
        const seeded = await seed();
        const runId = randomUUID();
        await admitWorkflowRun({
            accountId: seeded.accountId,
            runId,
            origin: { kind: "direct" },
            machineId: seeded.machineId,
            acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }),
        });
        await pauseWorkflowRun({ accountId: seeded.accountId, runId, expectedRevision: 0 });
        // The daemon settles the requested boundary to `paused`; the control
        // request itself remains `pause_requested` until that settlement.
        await db.automationRun.update({ where: { id: runId }, data: { state: "paused" } });
        await expect(waitWorkflowRun({
            accountId: seeded.accountId,
            runId,
            timeoutSeconds: 0,
        })).resolves.toMatchObject({ observation: "paused", matchedCondition: "paused", run: { id: runId, revision: 1 } });
        await expect(waitWorkflowRun({ accountId: seeded.accountId, runId, conditions: ["terminal"] }))
            .resolves.toMatchObject({ observation: "waiting", run: { state: "paused", attentionRequired: false } });
        await expect(waitWorkflowRun({ accountId: seeded.accountId, runId, conditions: ["attention"], timeoutSeconds: 0 }))
            .resolves.toMatchObject({ observation: "timeout", run: { state: "paused" } });
    });

    it("returns terminal ahead of the observation deadline through the exact snapshot path", async () => {
        const seeded = await seed();
        const runId = randomUUID();
        await admitWorkflowRun({
            accountId: seeded.accountId,
            runId,
            origin: { kind: "direct" },
            machineId: seeded.machineId,
            acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }),
        });
        await cancelWorkflowRun({ accountId: seeded.accountId, runId, expectedRevision: 0 });
        await expect(waitWorkflowRun({
            accountId: seeded.accountId,
            runId,
            timeoutSeconds: 0,
        })).resolves.toMatchObject({ observation: "terminal", matchedCondition: "terminal", run: { id: runId, state: "cancelled" } });
        await expect(waitWorkflowRun({ accountId: seeded.accountId, runId, conditions: ["attention"], timeoutSeconds: 0 }))
            .resolves.toMatchObject({ observation: "not_matched_terminal", run: { state: "cancelled", attentionRequired: false } });
    });

    async function accountCurrentness(accountId: string) {
        const account = await db.account.findUniqueOrThrow({ where: { id: accountId }, select: automationAccountCurrentnessSelect });
        const witness = deriveAutomationAccountCurrentnessWitness(account);
        if (!witness) throw new Error("Expected a current workflow test Account");
        return witness;
    }

    async function encryptedRunOwnerEnvelope(accountId: string) {
        const account = await db.account.findUniqueOrThrow({ where: { id: accountId } });
        const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(account);
        if (readiness.status !== "available") throw new Error("Expected an available signed recipient fixture");
        return { recipientAccountId: accountId, recipientContentPublicKeyFingerprint: readiness.binding.contentPublicKeyFingerprint,
            encryptedDataKey: privacyKit.encodeBase64(new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: e2eeWorkflowContent.runDataKey,
                recipientPublicKey: readiness.binding.contentPublicKey, randomBytes: e2eeWorkflowContent.randomBytes }))) };
    }

    async function admitWorkflowRun(params: Omit<Parameters<typeof admitWorkflowRunOwner>[0], "accountCurrentness">) {
        return await admitWorkflowRunOwner({ ...params, accountCurrentness: await accountCurrentness(params.accountId) });
    }

    async function commitWorkflowInvocationFact(params: Omit<Extract<Parameters<typeof commitWorkflowInvocationFactOwner>[0], { parentAttempt: number }>, "accountCurrentness" | "expectedContentRevision"> & { expectedContentRevision?: bigint }) {
        const current = params.expectedContentRevision === undefined
            ? await db.workflowRunInvocation.findUnique({ where: { id: params.invocationId }, select: { contentRevision: true } }) : null;
        return await commitWorkflowInvocationFactOwner({ ...params,
            expectedContentRevision: params.expectedContentRevision ?? current?.contentRevision ?? 0n,
            accountCurrentness: await accountCurrentness(params.accountId) });
    }

    async function transitionWorkflowRun(params: Omit<Parameters<typeof transitionWorkflowRunOwner>[0], "accountCurrentness" | "invocationTransitions"> & {
        invocationTransitions?: readonly Omit<NonNullable<Parameters<typeof transitionWorkflowRunOwner>[0]["invocationTransitions"]>[number], "expectedContentRevision">[];
    }) {
        const invocationTransitions = params.invocationTransitions === undefined ? undefined : await Promise.all(params.invocationTransitions.map(async (item) => {
            const row = await db.workflowRunInvocation.findUnique({ where: { id: item.id }, select: { contentRevision: true } });
            return { ...item, expectedContentRevision: row?.contentRevision ?? 0n };
        }));
        return await transitionWorkflowRunOwner({ ...params, invocationTransitions, accountCurrentness: await accountCurrentness(params.accountId) });
    }

    async function resolveAutomationWorkflowAcceptedSnapshot(params: Omit<Parameters<typeof resolveAutomationWorkflowAcceptedSnapshotOwner>[0], "accountCurrentness">) {
        return await resolveAutomationWorkflowAcceptedSnapshotOwner({ ...params, accountCurrentness: await accountCurrentness(params.accountId) });
    }

    async function claimRun(runId: string, machineId: string, parentAttempt = 1): Promise<void> {
        await db.automationRun.update({
            where: { id: runId },
            data: { state: "claimed", claimedByMachineId: machineId, attempt: parentAttempt },
        });
    }

    async function seedTerminalWorkflowRunWithReplyCustody(
        replyHandoffState: "ready" | "handingOff" | "accepted" | "suppressed" | "blocked",
    ) {
        const seeded = await seed();
        const automation = await db.automation.create({
            data: {
                accountId: seeded.accountId,
                name: "Workflow reply custody",
                targetType: null,
                templateCiphertext: "{}",
            },
            select: { id: true },
        });
        const runId = randomUUID();
        const admittedAt = new Date();
        // Automation-backed parents are created only by canonical Automation
        // occurrence admission. This fixture materializes that persisted shape
        // directly; it must not revive the removed Workflow storage admission arm.
        await db.automationRun.create({
            data: {
                id: runId,
                accountId: seeded.accountId,
                automationId: automation.id,
                originKind: "automation",
                state: "queued",
                causeKind: "manual",
                causeOccurredAt: admittedAt,
                scheduledAt: admittedAt,
                dueAt: admittedAt,
                executionInputEnvelope: JSON.stringify({ t: "plain", v: {} }),
                workflowCustodyState: "pending",
                assignments: { create: { machineId: seeded.machineId, priority: 0 } },
            },
        });
        await db.automationRun.update({
            where: { id: runId },
            data: {
                state: "succeeded",
                causeKind: "conversation",
                occurrenceKey: `conversation-${runId}`,
                triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: {} }),
                workflowCustodyState: "settled",
                finishedAt: new Date(),
                resultEnvelope: JSON.stringify({ t: "plain", v: {} }),
                replyContextEnvelope: JSON.stringify({ t: "plain", v: {} }),
                replyHandoffActionPluginId: "happier.channels",
                replyHandoffActionLocalId: "automation/result-deliver-v1",
                replyHandoffTargetMachineId: seeded.machineId,
                replyHandoffTargetMachineInstallationId: "installation-workflow-delete",
                replyHandoffTargetMaterializationId: "materialization-workflow-delete",
                replyHandoffId: `handoff-${runId}`,
                replyHandoffState,
            },
        });
        return { ...seeded, runId };
    }

    async function initializeWorkflowRunExecution(params: Omit<Parameters<typeof initializeWorkflowRunExecutionOwner>[0], "accountCurrentness"> | Readonly<{
        accountId: string;
        runId: string;
        expectedRevision: number;
        checkpointEnvelope: string;
        rootInvocation: Readonly<{ id: string; contentEnvelope: string }>;
    }>) {
        if ("machineId" in params) return await initializeWorkflowRunExecutionOwner({ ...params, accountCurrentness: await accountCurrentness(params.accountId) });
        const assignment = await db.automationRunAssignment.findFirstOrThrow({
            where: { runId: params.runId },
            orderBy: { priority: "asc" },
            select: { machineId: true },
        });
        await claimRun(params.runId, assignment.machineId);
        return await initializeWorkflowRunExecutionOwner({ ...params, machineId: assignment.machineId, parentAttempt: 1, accountCurrentness: await accountCurrentness(params.accountId) });
    }

    async function admitWorkflowInvocationsWithClaim(params: Omit<Parameters<typeof admitWorkflowInvocationsOwner>[0], "machineId" | "parentAttempt" | "accountCurrentness">) {
        const assignment = await db.automationRunAssignment.findFirstOrThrow({
            where: { runId: params.runId },
            orderBy: { priority: "asc" },
            select: { machineId: true },
        });
        return await admitWorkflowInvocationsOwner({ ...params, machineId: assignment.machineId, parentAttempt: 1, accountCurrentness: await accountCurrentness(params.accountId) });
    }

    async function retryWorkflowInvocation(params: Readonly<{
        accountId: string;
        runId: string;
        expectedRevision: number;
        invocationId: string;
        newInvocationId: string;
        newSequence: bigint;
        contentEnvelope: string;
    }>) {
        const root = await db.workflowRunInvocation.findFirstOrThrow({ where: { runId: params.runId, parentRecordId: null }, select: { id: true } });
        const { newSequence, ...request } = params;
        const assignment = await db.automationRunAssignment.findFirstOrThrow({ where: { runId: params.runId }, orderBy: { priority: "asc" }, select: { machineId: true } });
        const result = await recoverWorkflowInvocationsOwner({
            accountId: request.accountId,
            machineId: assignment.machineId,
            runId: request.runId,
            expectedRevision: request.expectedRevision,
            checkpointEnvelope: checkpointEnvelope(params.accountId, params.runId, root.id, newSequence + 1n),
            accountCurrentness: await accountCurrentness(params.accountId),
            recoveries: [{
                invocationId: request.invocationId,
                newInvocationId: request.newInvocationId,
                contentEnvelope: request.contentEnvelope,
            }],
        });
        return { ...result, invocation: result.invocations[0] };
    }

    async function recoverWorkflowInvocations(params: Omit<Parameters<typeof recoverWorkflowInvocationsOwner>[0], "checkpointEnvelope" | "recoveries" | "accountCurrentness" | "machineId"> & Readonly<{
        machineId?: string;
        recoveries: readonly (Parameters<typeof recoverWorkflowInvocationsOwner>[0]["recoveries"][number] & Readonly<{ newSequence: bigint }>)[];
    }>) {
        const root = await db.workflowRunInvocation.findFirstOrThrow({ where: { runId: params.runId, parentRecordId: null }, select: { id: true } });
        const nextSequence = params.recoveries.reduce((maximum, recovery) => recovery.newSequence > maximum ? recovery.newSequence : maximum, -1n) + 1n;
        const recoveries = params.recoveries.map(({ newSequence: _callerSequence, ...recovery }) => recovery);
        const assignment = await db.automationRunAssignment.findFirstOrThrow({ where: { runId: params.runId }, orderBy: { priority: "asc" }, select: { machineId: true } });
        return await recoverWorkflowInvocationsOwner({ ...params, machineId: params.machineId ?? assignment.machineId, recoveries, checkpointEnvelope: checkpointEnvelope(params.accountId, params.runId, root.id, nextSequence), accountCurrentness: await accountCurrentness(params.accountId) });
    }

    it("admits a direct Run, initializes exactly one root, and commits a row fact without advancing parent revision", async () => {
        const seeded = await seed();
        const runId = randomUUID();
        const accepted = await acceptedEnvelope({ ...seeded, runId, originSessionId: seeded.sessionId, deliver: true });
        const initialCurrentness = await accountCurrentness(seeded.accountId);
        const admitted = await admitWorkflowRunOwner({ accountId: seeded.accountId, runId, origin: { kind: "direct", originSessionId: seeded.sessionId }, machineId: seeded.machineId, accountCurrentness: initialCurrentness, acceptedEnvelope: accepted, resultDelivery: { kind: "originating_session" } });
        expect(admitted.run).toMatchObject({ state: "queued", revision: 0, workflowCustodyState: "pending", originDeliveryAckRevision: 0 });
        await expect(db.automationRun.findUniqueOrThrow({ where: { id: runId }, select: { executionInputEnvelope: true } }))
            .resolves.toEqual({ executionInputEnvelope: accepted });
        await expect(admitWorkflowRun({ accountId: seeded.accountId, runId, origin: { kind: "direct", originSessionId: seeded.sessionId }, machineId: seeded.machineId, acceptedEnvelope: accepted, resultDelivery: { kind: "originating_session" } })).resolves.toMatchObject({ kind: "existing", run: { id: runId } });
        await expect(admitWorkflowRun({ accountId: seeded.accountId, runId, origin: { kind: "direct", originSessionId: seeded.sessionId }, machineId: seeded.machineId, acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId, originSessionId: seeded.sessionId, deliver: true, permission: "read-only" }), resultDelivery: { kind: "originating_session" } })).rejects.toMatchObject({ code: "currentness_conflict" });
        await claimRun(runId, seeded.machineId);
        const rootId = `workflow-root-é-${randomUUID()}`;
        const checkpoint = checkpointEnvelope(seeded.accountId, runId, rootId, 1n);
        const rootContentEnvelope = progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n });
        const initialize = { accountId: seeded.accountId, runId, machineId: seeded.machineId, parentAttempt: 1, expectedRevision: 0, checkpointEnvelope: checkpoint, rootInvocation: { id: rootId, contentEnvelope: rootContentEnvelope } } as const;
        await expect(initializeWorkflowRunExecutionOwner({ ...initialize, accountCurrentness: initialCurrentness })).resolves.toMatchObject({ initialization: "created" });
        await expect(initializeWorkflowRunExecution({ ...initialize, machineId: randomUUID() })).rejects.toMatchObject({ code: "currentness_conflict" });
        await expect(initializeWorkflowRunExecution(initialize)).resolves.toMatchObject({ initialization: "existing", run: { revision: 1 } });
        await commitWorkflowInvocationFact({ accountId: seeded.accountId, runId, machineId: seeded.machineId, parentAttempt: 1, invocationId: rootId, invocationAttempt: 0n, expectedLifecycle: "pending", lifecycle: "completed", contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }) });
        const completedEnvelope = progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n });
        await expect(commitWorkflowInvocationFact({ accountId: seeded.accountId, runId, machineId: seeded.machineId, parentAttempt: 1, invocationId: rootId, invocationAttempt: 0n, expectedLifecycle: "completed", lifecycle: "completed", contentEnvelope: completedEnvelope }))
            .resolves.toMatchObject({ id: rootId, lifecycle: "completed", attempt: "0" });
        const conflictingEnvelope = progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n, reason: "different-terminal-fact" });
        await expect(commitWorkflowInvocationFact({ accountId: seeded.accountId, runId, machineId: seeded.machineId, parentAttempt: 1, invocationId: rootId, invocationAttempt: 0n, expectedLifecycle: "completed", lifecycle: "completed", contentEnvelope: conflictingEnvelope }))
            .rejects.toMatchObject({ code: "currentness_conflict" });
        await expect(commitWorkflowInvocationFact({ accountId: seeded.accountId, runId, machineId: seeded.machineId, parentAttempt: 1, invocationId: rootId, invocationAttempt: 0n, expectedLifecycle: "completed", lifecycle: "failed", contentEnvelope: completedEnvelope }))
            .rejects.toMatchObject({ code: "currentness_conflict" });
        await expect(commitWorkflowInvocationFact({ accountId: seeded.accountId, runId, machineId: seeded.machineId, parentAttempt: 1, invocationId: rootId, invocationAttempt: 0n, expectedLifecycle: "failed", lifecycle: "completed", contentEnvelope: completedEnvelope }))
            .rejects.toMatchObject({ code: "currentness_conflict" });
        await expect(db.workflowRunInvocation.findUniqueOrThrow({ where: { id: rootId }, select: { lifecycle: true, contentEnvelope: true } }))
            .resolves.toEqual({ lifecycle: "completed", contentEnvelope: completedEnvelope });
        expect((await getWorkflowRun({ accountId: seeded.accountId, runId })).run.revision).toBe(1);
        const rows = await listWorkflowRunInvocations({ accountId: seeded.accountId, runId, pageByteLimit: 4096 });
        expect(rows.invocations).toEqual([expect.objectContaining({ id: rootId, sequence: "0", memberOrdinal: "0", attempt: "0", lifecycle: "completed" })]);
    });

    it("allows unrelated Account version changes but rejects same-mode content-key rotation before storing private workflow bytes", async () => {
        const signing = tweetnacl.sign.keyPair();
        const firstContentKey = new Uint8Array(tweetnacl.box.keyPair().publicKey);
        const account = await db.account.create({
            data: {
                publicKey: Buffer.from(signing.publicKey).toString("hex"),
                encryptionMode: "e2ee",
                contentPublicKey: firstContentKey,
                contentPublicKeySig: signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: firstContentKey }),
            },
            select: { id: true },
        });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: "{}" }, select: { id: true } });
        const seeded = { accountId: account.id, machineId: machine.id };
        const runId = randomUUID();
        const stale = await accountCurrentness(seeded.accountId);
        await db.account.update({ where: { id: seeded.accountId }, data: { seq: { increment: 1 } } });

        await expect(admitWorkflowRunOwner({
            accountId: seeded.accountId,
            runId,
            origin: { kind: "direct" },
            machineId: seeded.machineId,
            accountCurrentness: stale,
            recipientKeyEnvelopes: [await encryptedRunOwnerEnvelope(seeded.accountId)],
            acceptedEnvelope: await encryptedAcceptedEnvelope({ ...seeded, runId }),
        })).resolves.toMatchObject({ kind: "created" });
        await claimRun(runId, seeded.machineId);
        const rootId = randomUUID();
        const initialization = {
            accountId: seeded.accountId,
            runId,
            machineId: seeded.machineId,
            parentAttempt: 1,
            expectedRevision: 0,
            accountCurrentness: stale,
            checkpointEnvelope: encryptedCheckpointEnvelope(seeded.accountId, runId, rootId),
            rootInvocation: { id: rootId, contentEnvelope: encryptedProgressEnvelope({ ...seeded, runId, id: rootId }) },
        } as const;
        await expect(initializeWorkflowRunExecutionOwner(initialization))
            .resolves.toMatchObject({ initialization: "created" });

        const rotatedContentKey = new Uint8Array(tweetnacl.box.keyPair().publicKey);
        await db.account.update({
            where: { id: seeded.accountId },
            data: {
                contentPublicKey: rotatedContentKey,
                contentPublicKeySig: signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: rotatedContentKey }),
            },
        });
        const rejectedRunId = randomUUID();
        await expect(initializeWorkflowRunExecutionOwner(initialization))
            .rejects.toMatchObject({ code: "currentness_conflict" });
        await expect(admitWorkflowRunOwner({
            accountId: seeded.accountId,
            runId: rejectedRunId,
            origin: { kind: "direct" },
            machineId: seeded.machineId,
            accountCurrentness: stale,
            recipientKeyEnvelopes: [await encryptedRunOwnerEnvelope(seeded.accountId)],
            acceptedEnvelope: await encryptedAcceptedEnvelope({ ...seeded, runId: rejectedRunId }),
        })).rejects.toMatchObject({ code: "currentness_conflict" });
        await expect(db.automationRun.findUnique({ where: { id: rejectedRunId } })).resolves.toBeNull();
    });

    it("admits caller-bound invocation ids once and rejects conflicting or foreign parents", async () => {
        const seeded = await seed();
        const runId = randomUUID();
        await admitWorkflowRun({ accountId: seeded.accountId, runId, origin: { kind: "direct", originSessionId: seeded.sessionId }, machineId: seeded.machineId, acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId, originSessionId: seeded.sessionId }) });
        const rootId = randomUUID();
        await initializeWorkflowRunExecution({ accountId: seeded.accountId, runId, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 1n), rootInvocation: { id: rootId, contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }) } });
        const childId = `workflow-child-é-${randomUUID()}`;
        const request = {
            accountId: seeded.accountId,
            runId,
            expectedRevision: 1,
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 2n),
            invocations: [{ id: childId, sequence: 1n, parentRecordId: rootId, memberOrdinal: 0n, contentEnvelope: progressEnvelope({ ...seeded, runId, id: childId, sequence: 1n, parentRecordId: rootId, memberOrdinal: 0n }) }],
        } as const;
        await expect(admitWorkflowInvocationsWithClaim(request)).resolves.toMatchObject({ disposition: "created", parentRevision: 2, invocations: [{ id: childId, sequence: "1" }] });
        await expect(admitWorkflowInvocationsWithClaim(request)).resolves.toMatchObject({ disposition: "existing", parentRevision: 2, invocations: [{ id: childId, sequence: "1" }] });
        await expect(admitWorkflowInvocationsWithClaim({
            ...request,
            invocations: [{
                ...request.invocations[0],
                memberOrdinal: 1n,
                contentEnvelope: progressEnvelope({ ...seeded, runId, id: childId, sequence: 1n, parentRecordId: rootId, memberOrdinal: 1n }),
            }],
        })).rejects.toMatchObject({ code: "currentness_conflict" });

        const otherRunId = randomUUID();
        await admitWorkflowRun({ accountId: seeded.accountId, runId: otherRunId, origin: { kind: "direct" }, machineId: seeded.machineId, acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId: otherRunId }) });
        const otherRootId = randomUUID();
        await initializeWorkflowRunExecution({ accountId: seeded.accountId, runId: otherRunId, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope(seeded.accountId, otherRunId, otherRootId, 1n), rootInvocation: { id: otherRootId, contentEnvelope: progressEnvelope({ ...seeded, runId: otherRunId, id: otherRootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }) } });
        const foreignChildId = randomUUID();
        await expect(admitWorkflowInvocationsWithClaim({ ...request, expectedRevision: 2, checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 2n), invocations: [{ id: foreignChildId, sequence: 2n, parentRecordId: otherRootId, memberOrdinal: 1n, contentEnvelope: progressEnvelope({ ...seeded, runId, id: foreignChildId, sequence: 2n, parentRecordId: otherRootId, memberOrdinal: 1n }) }] })).rejects.toMatchObject({ code: "invalid_input" });
    });

    it("atomically resolves an Automation definition body to one accepted snapshot", async () => {
        const seeded = await seed();
        const automation = await db.automation.create({ data: {
            accountId: seeded.accountId,
            name: "Workflow automation",
            targetType: null,
            templateCiphertext: "{}",
        }, select: { id: true } });
        const runId = randomUUID();
        const definitionEnvelope = workflowDefinitionEnvelope();
        await db.automationRun.create({ data: {
            id: runId,
            accountId: seeded.accountId,
            originKind: "automation",
            automationId: automation.id,
            state: "claimed",
            causeKind: "manual",
            causeOccurredAt: new Date(),
            scheduledAt: new Date(),
            dueAt: new Date(),
            claimedByMachineId: seeded.machineId,
            attempt: 3,
            revision: 4,
            executionInputEnvelope: definitionEnvelope,
            workflowCustodyState: "pending",
            assignments: { create: { machineId: seeded.machineId, priority: 0 } },
        } });
        const accepted = await acceptedEnvelope({ ...seeded, runId });
        const request = {
            accountId: seeded.accountId,
            runId,
            automationId: automation.id,
            machineId: seeded.machineId,
            expectedAttempt: 3,
            expectedRevision: 4,
            definitionEnvelope,
            acceptedEnvelope: accepted,
        } as const;
        await expect(resolveAutomationWorkflowAcceptedSnapshot({ ...request, originSessionId: seeded.sessionId }))
            .rejects.toMatchObject({ code: "currentness_conflict" });
        await expect(resolveAutomationWorkflowAcceptedSnapshot({ ...request, resultDelivery: { kind: "originating_session" } }))
            .rejects.toMatchObject({ code: "invalid_input" });
        const stranger = await seed();
        await db.automation.update({ where: { id: automation.id }, data: { scopeSessionId: stranger.sessionId } });
        await expect(resolveAutomationWorkflowAcceptedSnapshot({ ...request, originSessionId: stranger.sessionId }))
            .rejects.toMatchObject({ code: "invalid_input" });
        await db.automation.update({ where: { id: automation.id }, data: { scopeSessionId: null } });
        await expect(resolveAutomationWorkflowAcceptedSnapshot(request)).resolves.toMatchObject({ disposition: "created", acceptedEnvelope: accepted, run: { revision: 5 } });
        await expect(resolveAutomationWorkflowAcceptedSnapshot(request)).resolves.toMatchObject({ disposition: "existing", acceptedEnvelope: accepted, run: { revision: 5 } });
        await expect(resolveAutomationWorkflowAcceptedSnapshot({
            ...request,
            acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId, permission: "read-only" }),
        })).rejects.toMatchObject({ code: "currentness_conflict" });
        await expect(resolveAutomationWorkflowAcceptedSnapshot({ ...request, machineId: randomUUID() })).rejects.toMatchObject({ code: "currentness_conflict" });
    });

    it("settles Automation-origin workflow success with the incumbent Automation terminal semantics", async () => {
        const seeded = await seed();
        const automation = await db.automation.create({ data: {
            accountId: seeded.accountId,
            name: "Workflow automation",
            targetType: null,
            templateCiphertext: "{}",
        }, select: { id: true } });
        const runId = randomUUID();
        const rootId = randomUUID();
        await db.automationRun.create({ data: {
            id: runId,
            accountId: seeded.accountId,
            originKind: "automation",
            automationId: automation.id,
            state: "claimed",
            causeKind: "manual",
            causeOccurredAt: new Date(),
            scheduledAt: new Date(),
            dueAt: new Date(),
            claimedByMachineId: seeded.machineId,
            leaseExpiresAt: new Date(Date.now() + 30_000),
            attempt: 1,
            executionInputEnvelope: workflowDefinitionEnvelope(),
            workflowAcceptedSnapshotEnvelope: await acceptedEnvelope({ ...seeded, runId }),
            workflowCustodyState: "pending",
            assignments: { create: { machineId: seeded.machineId, priority: 0 } },
        } });
        await initializeWorkflowRunExecutionOwner({
            accountId: seeded.accountId,
            accountCurrentness: await accountCurrentness(seeded.accountId),
            runId,
            machineId: seeded.machineId,
            parentAttempt: 1,
            expectedRevision: 0,
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 1n),
            rootInvocation: {
                id: rootId,
                contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }),
            },
        });
        await commitWorkflowInvocationFact({
            accountId: seeded.accountId,
            runId,
            machineId: seeded.machineId,
            parentAttempt: 1,
            invocationId: rootId,
            invocationAttempt: 0n,
            expectedLifecycle: "pending",
            lifecycle: "completed",
            contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }),
        });

        const revisionBeforeHeartbeat = (await getWorkflowRun({ accountId: seeded.accountId, runId })).run.revision;
        await expect(heartbeatAutomationRun({
            accountId: seeded.accountId,
            runId,
            machineId: seeded.machineId,
            attempt: 1,
            leaseDurationMs: 30_000,
        })).resolves.toMatchObject({ ok: true });

        await expect(pauseWorkflowRun({
            accountId: seeded.accountId,
            runId,
            expectedRevision: revisionBeforeHeartbeat,
        })).resolves.toMatchObject({
            intent: "pause_requested",
            run: { state: "pause_requested", revision: 2 },
        });

        await transitionWorkflowRun({
            accountId: seeded.accountId,
            runId,
            machineId: seeded.machineId,
            parentAttempt: 1,
            expectedRevision: 2,
            state: "succeeded",
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 1n),
            resultEnvelope: finalResultEnvelope(seeded.accountId, runId),
            custodyState: "settled",
        });

        await expect(db.automation.findUniqueOrThrow({ where: { id: automation.id }, select: { lastRunAt: true } }))
            .resolves.toEqual({ lastRunAt: expect.any(Date) });
        await expect(db.automationRunEvent.findMany({ where: { runId }, select: { type: true } }))
            .resolves.toEqual([expect.objectContaining({ type: "run_succeeded" })]);
        await expect(db.accountChange.findFirst({
            where: { accountId: seeded.accountId, kind: "automation", entityId: automation.id },
            select: { entityId: true },
        })).resolves.toEqual({ entityId: automation.id });
    });

    it.each([
        ["failed", "run_failed"],
        ["cancelled", "run_cancelled"],
        ["outcome_uncertain", "run_outcome_uncertain"],
    ] as const)("settles Automation-origin workflow %s with the incumbent Automation terminal semantics", async (state, eventType) => {
        const seeded = await seed();
        const automation = await db.automation.create({ data: {
            accountId: seeded.accountId,
            name: `Workflow automation ${state}`,
            targetType: null,
            templateCiphertext: "{}",
        }, select: { id: true } });
        const runId = randomUUID();
        const rootId = randomUUID();
        await db.automationRun.create({ data: {
            id: runId,
            accountId: seeded.accountId,
            originKind: "automation",
            automationId: automation.id,
            state: "claimed",
            causeKind: "manual",
            causeOccurredAt: new Date(),
            scheduledAt: new Date(),
            dueAt: new Date(),
            claimedByMachineId: seeded.machineId,
            attempt: 1,
            executionInputEnvelope: workflowDefinitionEnvelope(),
            workflowAcceptedSnapshotEnvelope: await acceptedEnvelope({ ...seeded, runId }),
            workflowCustodyState: "pending",
            assignments: { create: { machineId: seeded.machineId, priority: 0 } },
        } });
        await initializeWorkflowRunExecutionOwner({
            accountId: seeded.accountId,
            accountCurrentness: await accountCurrentness(seeded.accountId),
            runId,
            machineId: seeded.machineId,
            parentAttempt: 1,
            expectedRevision: 0,
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 1n),
            rootInvocation: {
                id: rootId,
                contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }),
            },
        });

        await expect(transitionWorkflowRun({
            accountId: seeded.accountId,
            runId,
            machineId: seeded.machineId,
            parentAttempt: 1,
            expectedRevision: 1,
            state,
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 1n),
            custodyState: "settled",
            invocationTransitions: [{ id: rootId, expectedLifecycle: "pending", lifecycle: state }],
        })).resolves.toMatchObject({ state, workflowCustodyState: "settled" });
        await expect(db.automationRunEvent.findMany({ where: { runId }, select: { type: true } }))
            .resolves.toEqual([{ type: eventType }]);
        await expect(db.automation.findUniqueOrThrow({ where: { id: automation.id }, select: { lastRunAt: true } }))
            .resolves.toEqual({ lastRunAt: expect.any(Date) });
        await expect(db.accountChange.findFirst({
            where: { accountId: seeded.accountId, kind: "automation", entityId: automation.id },
            select: { entityId: true },
        })).resolves.toEqual({ entityId: automation.id });
    });

    it.each([
        "succeeded",
        "failed",
        "cancelled",
        "outcome_uncertain",
    ] as const)("keeps a terminal %s workflow Run and its invocation facts immutable", async (terminalState) => {
        const seeded = await seed();
        const runId = randomUUID();
        await admitWorkflowRun({
            accountId: seeded.accountId,
            runId,
            origin: { kind: "direct" },
            machineId: seeded.machineId,
            acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }),
        });
        const rootId = randomUUID();
        await initializeWorkflowRunExecution({
            accountId: seeded.accountId,
            runId,
            expectedRevision: 0,
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 1n),
            rootInvocation: {
                id: rootId,
                contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }),
            },
        });
        await transitionWorkflowRun({
            accountId: seeded.accountId,
            runId,
            machineId: seeded.machineId,
            parentAttempt: 1,
            expectedRevision: 1,
            state: terminalState,
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 1n),
            resultEnvelope: finalResultEnvelope(seeded.accountId, runId, "terminal-result"),
            custodyState: "pending",
        });
        const parentSelect = {
            state: true,
            revision: true,
            workflowCheckpointEnvelope: true,
            resultEnvelope: true,
            finishedAt: true,
            updatedAt: true,
        } as const;
        const invocationSelect = {
            id: true,
            runId: true,
            sequence: true,
            parentRecordId: true,
            memberOrdinal: true,
            attempt: true,
            lifecycle: true,
            contentEnvelope: true,
            createdAt: true,
            updatedAt: true,
        } as const;
        const parentBefore = await db.automationRun.findUniqueOrThrow({ where: { id: runId }, select: parentSelect });
        const invocationBefore = await db.workflowRunInvocation.findUniqueOrThrow({ where: { id: rootId }, select: invocationSelect });
        const rejoinedBefore = await getWorkflowRun({ accountId: seeded.accountId, runId });

        await expect(transitionWorkflowRun({
            accountId: seeded.accountId,
            runId,
            machineId: seeded.machineId,
            parentAttempt: 1,
            expectedRevision: parentBefore.revision,
            state: "running",
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 2n),
            resultEnvelope: finalResultEnvelope(seeded.accountId, runId, "mutated-result"),
            custodyState: "pending",
            invocationTransitions: [{ id: rootId, expectedLifecycle: "pending", lifecycle: "running" }],
        })).rejects.toMatchObject({ code: "currentness_conflict" });

        await expect(db.automationRun.findUniqueOrThrow({ where: { id: runId }, select: parentSelect }))
            .resolves.toEqual(parentBefore);
        await expect(db.workflowRunInvocation.findUniqueOrThrow({ where: { id: rootId }, select: invocationSelect }))
            .resolves.toEqual(invocationBefore);
        await expect(getWorkflowRun({ accountId: seeded.accountId, runId }))
            .resolves.toEqual(rejoinedBefore);
    });

    it("settles exact recovery-shaped terminal custody without replaying Automation terminal effects", async () => {
        const seeded = await seed();
        const automation = await db.automation.create({ data: {
            accountId: seeded.accountId,
            name: "Recovered workflow settlement",
            targetType: null,
            templateCiphertext: "{}",
        }, select: { id: true } });
        const runId = randomUUID();
        const rootId = randomUUID();
        const checkpoint = checkpointEnvelope(seeded.accountId, runId, rootId, 1n);
        await db.automationRun.create({ data: {
            id: runId,
            accountId: seeded.accountId,
            originKind: "automation",
            automationId: automation.id,
            state: "claimed",
            causeKind: "manual",
            causeOccurredAt: new Date(),
            scheduledAt: new Date(),
            dueAt: new Date(),
            claimedByMachineId: seeded.machineId,
            attempt: 1,
            executionInputEnvelope: workflowDefinitionEnvelope(),
            workflowAcceptedSnapshotEnvelope: await acceptedEnvelope({ ...seeded, runId }),
            workflowCustodyState: "pending",
            assignments: { create: { machineId: seeded.machineId, priority: 0 } },
        } });
        await initializeWorkflowRunExecutionOwner({
            accountId: seeded.accountId,
            accountCurrentness: await accountCurrentness(seeded.accountId),
            runId,
            machineId: seeded.machineId,
            parentAttempt: 1,
            expectedRevision: 0,
            checkpointEnvelope: checkpoint,
            rootInvocation: {
                id: rootId,
                contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }),
            },
        });
        await transitionWorkflowRun({
            accountId: seeded.accountId,
            runId,
            machineId: seeded.machineId,
            parentAttempt: 1,
            expectedRevision: 1,
            state: "succeeded",
            checkpointEnvelope: checkpoint,
            custodyState: "pending",
            invocationTransitions: [{ id: rootId, expectedLifecycle: "pending", lifecycle: "completed" }],
        });
        const invocationBeforeSettlement = await db.workflowRunInvocation.findUniqueOrThrow({
            where: { id: rootId },
            select: { lifecycle: true, contentEnvelope: true, updatedAt: true },
        });

        await expect(transitionWorkflowRun({
            accountId: seeded.accountId,
            runId,
            machineId: seeded.machineId,
            parentAttempt: 1,
            expectedRevision: 2,
            state: "succeeded",
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 2n),
            custodyState: "settled",
            invocationTransitions: [{ id: rootId, expectedLifecycle: "completed", lifecycle: "completed" }],
        })).rejects.toMatchObject({ code: "currentness_conflict" });
        await expect(transitionWorkflowRun({
            accountId: seeded.accountId,
            runId,
            machineId: seeded.machineId,
            parentAttempt: 1,
            expectedRevision: 2,
            state: "succeeded",
            checkpointEnvelope: checkpoint,
            custodyState: "settled",
            invocationTransitions: [{ id: rootId, expectedLifecycle: "completed", lifecycle: "needs_attention" }],
        })).rejects.toMatchObject({ code: "currentness_conflict" });

        await expect(transitionWorkflowRun({
            accountId: seeded.accountId,
            runId,
            machineId: seeded.machineId,
            parentAttempt: 1,
            expectedRevision: 2,
            state: "succeeded",
            checkpointEnvelope: checkpoint,
            custodyState: "settled",
            invocationTransitions: [{ id: rootId, expectedLifecycle: "completed", lifecycle: "completed" }],
        })).resolves.toMatchObject({
            state: "succeeded",
            workflowCustodyState: "settled",
            revision: 3,
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: runId },
            select: { workflowCheckpointEnvelope: true, resultEnvelope: true },
        })).resolves.toEqual({ workflowCheckpointEnvelope: checkpoint, resultEnvelope: null });
        await expect(db.workflowRunInvocation.findUniqueOrThrow({
            where: { id: rootId },
            select: { lifecycle: true, contentEnvelope: true, updatedAt: true },
        })).resolves.toEqual(invocationBeforeSettlement);
        await expect(db.automationRunEvent.findMany({ where: { runId }, select: { type: true } }))
            .resolves.toEqual([{ type: "run_succeeded" }]);
    });

    it.each(["ready", "handingOff"] as const)(
        "retains a terminal workflow Run while reply custody is %s",
        async (replyHandoffState) => {
            const seeded = await seedTerminalWorkflowRunWithReplyCustody(replyHandoffState);

            await expect(deleteWorkflowRun({
                accountId: seeded.accountId,
                runId: seeded.runId,
                expectedRevision: 0,
            })).rejects.toMatchObject({ code: "custody_pending" });
            await expect(db.automationRun.findUnique({ where: { id: seeded.runId }, select: { id: true } }))
                .resolves.toEqual({ id: seeded.runId });
        },
    );

    it.each(["accepted", "suppressed", "blocked"] as const)(
        "deletes a terminal workflow Run after reply custody is %s",
        async (replyHandoffState) => {
            const seeded = await seedTerminalWorkflowRunWithReplyCustody(replyHandoffState);

            await expect(deleteWorkflowRun({
                accountId: seeded.accountId,
                runId: seeded.runId,
                expectedRevision: 0,
            })).resolves.toEqual({ deleted: true, runId: seeded.runId });
            await expect(db.automationRun.findUnique({ where: { id: seeded.runId }, select: { id: true } }))
                .resolves.toBeNull();
        },
    );

    it("reports a stale revision on an otherwise deletable Run as a currentness conflict, not an ineligible state", async () => {
        const seeded = await seedTerminalWorkflowRunWithReplyCustody("accepted");

        await expect(deleteWorkflowRun({
            accountId: seeded.accountId,
            runId: seeded.runId,
            expectedRevision: 7,
        })).rejects.toMatchObject({ code: "currentness_conflict" });
        await expect(db.automationRun.findUnique({ where: { id: seeded.runId }, select: { id: true } }))
            .resolves.toEqual({ id: seeded.runId });
    });

    it.each(["running", "paused", "interrupted"] as const)(
        "rejects settled custody while the workflow parent remains %s",
        async (state) => {
            const seeded = await seed();
            const runId = randomUUID();
            await admitWorkflowRun({
                accountId: seeded.accountId,
                runId,
                origin: { kind: "direct" },
                machineId: seeded.machineId,
                acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }),
            });
            await db.automationRun.update({
                where: { id: runId },
                data: { state, claimedByMachineId: seeded.machineId, attempt: 1 },
            });

            await expect(transitionWorkflowRun({
                accountId: seeded.accountId,
                runId,
                machineId: seeded.machineId,
                parentAttempt: 1,
                expectedRevision: 0,
                state,
                checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, randomUUID(), 1n),
                custodyState: "settled",
            })).rejects.toMatchObject({ code: "currentness_conflict" });
            await expect(db.automationRun.findUniqueOrThrow({
                where: { id: runId },
                select: { state: true, workflowCustodyState: true, revision: true },
            })).resolves.toEqual({ state, workflowCustodyState: "pending", revision: 0 });
        },
    );

    it("allows a terminal workflow transition to settle eligible custody", async () => {
        const seeded = await seed();
        const runId = randomUUID();
        await admitWorkflowRun({
            accountId: seeded.accountId,
            runId,
            origin: { kind: "direct" },
            machineId: seeded.machineId,
            acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }),
        });
        await db.automationRun.update({
            where: { id: runId },
            data: { state: "running", claimedByMachineId: seeded.machineId, attempt: 1 },
        });

        await expect(transitionWorkflowRun({
            accountId: seeded.accountId,
            runId,
            machineId: seeded.machineId,
            parentAttempt: 1,
            expectedRevision: 0,
            state: "succeeded",
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, randomUUID(), 1n),
            custodyState: "settled",
        })).resolves.toMatchObject({
            state: "succeeded",
            workflowCustodyState: "settled",
            revision: 1,
            // The terminal transition's own instant, so a reader can state when the Run finished.
            finishedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        });
    });

    it("finds off-page invocation attention and settles terminal invocation custody independently of origin delivery", async () => {
        const seeded = await seed();
        const runId = randomUUID();
        await admitWorkflowRun({ accountId: seeded.accountId, runId, origin: { kind: "direct", originSessionId: seeded.sessionId }, machineId: seeded.machineId, acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId, originSessionId: seeded.sessionId, deliver: true }), resultDelivery: { kind: "originating_session" } });
        await expect(getWorkflowRun({ accountId: seeded.accountId, runId })).resolves.toMatchObject({
            run: {
                availability: {
                    inspectExecution: false,
                    disabledReasons: expect.arrayContaining([
                        expect.objectContaining({ operation: "inspect_execution", code: "execution_not_admitted" }),
                    ]),
                },
            },
        });
        const rootId = randomUUID();
        await initializeWorkflowRunExecution({ accountId: seeded.accountId, runId, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 1n), rootInvocation: { id: rootId, contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }) } });
        await expect(getWorkflowRun({ accountId: seeded.accountId, runId })).resolves.toMatchObject({
            run: { availability: { inspectExecution: true } },
        });
        const approvalId = randomUUID();
        await db.workflowRunInvocation.create({ data: { id: approvalId, runId, sequence: 1n, parentRecordId: rootId, memberOrdinal: 0n, attempt: 0n, lifecycle: "waiting_for_approval", contentEnvelope: progressEnvelope({ ...seeded, runId, id: approvalId, sequence: 1n, parentRecordId: rootId, memberOrdinal: 0n }) } });
        const attention = await listWorkflowRuns({ accountId: seeded.accountId, attention: "required", limit: 1, pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES });
        expect(attention.runs.map((run) => run.id)).toContain(runId);
        await db.workflowRunInvocation.update({ where: { id: approvalId }, data: { lifecycle: "waiting_for_review" } });
        await expect(waitWorkflowRun({ accountId: seeded.accountId, runId, conditions: ["attention"] }))
            .resolves.toMatchObject({ observation: "needs_attention", matchedCondition: "attention", run: { attentionRequired: true } });
        await expect(waitWorkflowRun({ accountId: seeded.accountId, runId, conditions: ["terminal"], timeoutSeconds: 0 }))
            .resolves.toMatchObject({ observation: "timeout", run: { attentionRequired: true } });
        await expect(waitWorkflowRun({ accountId: seeded.accountId, runId, timeoutSeconds: 0 }))
            .resolves.toMatchObject({ observation: "needs_attention", run: { id: runId } });
        await db.workflowRunInvocation.update({ where: { id: approvalId }, data: { lifecycle: "cancel_requested" } });
        await expect(waitWorkflowRun({ accountId: seeded.accountId, runId, timeoutSeconds: 0 }))
            .resolves.toMatchObject({ observation: "needs_attention", run: { id: runId } });
        // Direct workflow states are broader than the incumbent Automation
        // state machine and must not be parsed by Automation success effects.
        await db.automationRun.update({ where: { id: runId }, data: { state: "interrupted" } });
        await transitionWorkflowRun({
            accountId: seeded.accountId,
            runId,
            machineId: seeded.machineId,
            parentAttempt: 1,
            expectedRevision: 1,
            state: "succeeded",
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 2n),
            resultEnvelope: finalResultEnvelope(seeded.accountId, runId),
            custodyState: "pending",
            invocationTransitions: [{ id: rootId, expectedLifecycle: "pending", lifecycle: "completed" }],
        });
        await expect(transitionWorkflowRun({ accountId: seeded.accountId, runId, machineId: seeded.machineId, parentAttempt: 1, expectedRevision: 2,
            state: "succeeded", checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 2n), custodyState: "settled" }))
            .rejects.toMatchObject({ code: "currentness_conflict" });
        await db.workflowRunInvocation.update({ where: { id: approvalId }, data: { lifecycle: "completed" } });
        const settled = await transitionWorkflowRun({ accountId: seeded.accountId, runId, machineId: seeded.machineId, parentAttempt: 1, expectedRevision: 2,
            state: "succeeded", checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 2n), custodyState: "settled" });
        expect(settled).toMatchObject({ state: "succeeded", workflowCustodyState: "settled", originDeliveryAckRevision: 0 });
    });

    it("selects one exact Run through the lean list page without reading history", async () => {
        const seeded = await seed();
        const runId = randomUUID();
        const otherRunId = randomUUID();
        for (const id of [runId, otherRunId]) {
            await admitWorkflowRun({
                accountId: seeded.accountId,
                runId: id,
                origin: { kind: "direct" },
                machineId: seeded.machineId,
                acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId: id }),
            });
        }

        const page = await listWorkflowRuns({ accountId: seeded.accountId, runId, pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES });

        // The exact selection returns the lean row and exact opaque sidecars:
        // no child invocation pages, no usage scan, no cursor to follow.
        expect(page.runs.map((run) => run.id)).toEqual([runId]);
        expect(Object.keys(page.acceptedEnvelopesByRunId)).toEqual([runId]);
        expect(page.nextCursor).toBeUndefined();
        await expect(listWorkflowRuns({
            accountId: seeded.accountId,
            runId: randomUUID(),
            pageByteLimit: 4096,
        })).resolves.toMatchObject({ runs: [] });
    });

    it("shortens Run and invocation pages for the complete external Action response envelope", async () => {
        const seeded = await seed();
        const runIds = [randomUUID(), randomUUID(), randomUUID()];
        for (const runId of runIds) {
            await admitWorkflowRun({
                accountId: seeded.accountId,
                runId,
                origin: { kind: "direct" },
                machineId: seeded.machineId,
                acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }),
            });
        }

        const firstRunPage = await listWorkflowRuns({
            accountId: seeded.accountId,
            limit: 1,
            pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
        });
        expect(firstRunPage).toMatchObject({ runs: [expect.any(Object)], nextCursor: expect.any(String) });
        const runPageByteLimit = measureExternalActionResultResponseEnvelopeUtf8BytesV1(firstRunPage);
        const boundedRunPage = await listWorkflowRuns({
            accountId: seeded.accountId,
            pageByteLimit: runPageByteLimit,
        });
        expect(boundedRunPage.runs).toHaveLength(1);
        expect(boundedRunPage.nextCursor).toEqual(expect.any(String));

        const runId = runIds[0]!;
        const rootId = randomUUID();
        await initializeWorkflowRunExecution({
            accountId: seeded.accountId,
            runId,
            expectedRevision: 0,
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 1n),
            rootInvocation: {
                id: rootId,
                contentEnvelope: progressEnvelope({
                    ...seeded,
                    runId,
                    id: rootId,
                    sequence: 0n,
                    parentRecordId: null,
                    memberOrdinal: 0n,
                }),
            },
        });
        for (let sequence = 1n; sequence <= 3n; sequence += 1n) {
            const id = randomUUID();
            await db.workflowRunInvocation.create({
                data: {
                    id,
                    runId,
                    sequence,
                    parentRecordId: rootId,
                    memberOrdinal: sequence - 1n,
                    attempt: 0n,
                    lifecycle: "pending",
                    contentEnvelope: progressEnvelope({
                        ...seeded,
                        runId,
                        id,
                        sequence,
                        parentRecordId: rootId,
                        memberOrdinal: sequence - 1n,
                    }),
                },
            });
        }
        const firstInvocationPage = await listWorkflowRunInvocations({
            accountId: seeded.accountId,
            runId,
            limit: 1,
            pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
        });
        expect(firstInvocationPage).toMatchObject({ invocations: [expect.any(Object)], nextCursor: expect.any(String) });
        const invocationPageByteLimit = measureExternalActionResultResponseEnvelopeUtf8BytesV1(firstInvocationPage);
        const boundedInvocationPage = await listWorkflowRunInvocations({
            accountId: seeded.accountId,
            runId,
            pageByteLimit: invocationPageByteLimit,
        });
        expect(boundedInvocationPage.invocations).toHaveLength(1);
        expect(boundedInvocationPage.nextCursor).toEqual(expect.any(String));

        for (const [actionId, result] of [
            ["workflow.run.list", boundedRunPage],
            ["workflow.run.invocations.list", boundedInvocationPage],
        ] as const) {
            const prepared = prepareExternalActionResponseEnvelopeV1({
                v: 1,
                actionId,
                requestId: "paging-regression",
                execution: { ok: true, result },
            });
            expect(prepared.response.execution).toMatchObject({ ok: true });
            expect(prepared.byteLength).toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
        }
    });

    it("pages private progress envelopes beside the same history rows inside the exact response-byte boundary", async () => {
        const seeded = await seed();
        const runId = randomUUID();
        await admitWorkflowRun({ accountId: seeded.accountId, runId, origin: { kind: "direct" }, machineId: seeded.machineId, acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }) });
        const rootId = randomUUID();
        await initializeWorkflowRunExecution({
            accountId: seeded.accountId,
            runId,
            expectedRevision: 0,
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 1n),
            rootInvocation: { id: rootId, contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }) },
        });
        const envelopes = new Map<string, string>([[rootId, (await db.workflowRunInvocation.findUniqueOrThrow({ where: { id: rootId } })).contentEnvelope]]);
        for (let sequence = 1n; sequence <= 3n; sequence += 1n) {
            const id = randomUUID();
            const contentEnvelope = progressEnvelope({ ...seeded, runId, id, sequence, parentRecordId: rootId, memberOrdinal: sequence - 1n });
            envelopes.set(id, contentEnvelope);
            await db.workflowRunInvocation.create({ data: { id, runId, sequence, parentRecordId: rootId, memberOrdinal: sequence - 1n, attempt: 0n, lifecycle: "completed", contentEnvelope } });
        }

        // The public history page never carries private content.
        const publicPage = await listWorkflowRunInvocations({ accountId: seeded.accountId, runId, pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES });
        expect(publicPage).not.toHaveProperty("progressEnvelopesByInvocationId");

        const firstPage = await listWorkflowRunInvocations({ accountId: seeded.accountId, runId, limit: 1, progressEnvelopes: true, pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES });
        expect(firstPage.invocations.map((row) => row.id)).toEqual([rootId]);
        if (!("progressEnvelopesByInvocationId" in firstPage)) throw new Error("Expected private history sidecars");
        expect(firstPage.progressEnvelopesByInvocationId).toEqual({ [rootId]: envelopes.get(rootId) });
        // Sizing the limit to the largest one-row sidecar page admits exactly
        // one row per page: the envelope bytes count against the same boundary.
        let pageByteLimit = 0;
        for (let single: Awaited<ReturnType<typeof listWorkflowRunInvocations>> | undefined = firstPage; single;) {
            pageByteLimit = Math.max(pageByteLimit, measureExternalActionResultResponseEnvelopeUtf8BytesV1(single));
            single = single.nextCursor
                ? await listWorkflowRunInvocations({ accountId: seeded.accountId, runId, limit: 1, progressEnvelopes: true, cursor: single.nextCursor, pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES })
                : undefined;
        }
        const collected = new Map<string, string>();
        let cursor: string | undefined;
        let pages = 0;
        do {
            const page = await listWorkflowRunInvocations({ accountId: seeded.accountId, runId, progressEnvelopes: true, pageByteLimit, ...(cursor ? { cursor } : {}) });
            pages += 1;
            expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(page)).toBeLessThanOrEqual(pageByteLimit);
            if (!("progressEnvelopesByInvocationId" in page)) throw new Error("Expected private history sidecars");
            const sidecars = page.progressEnvelopesByInvocationId;
            if (typeof sidecars !== "object" || sidecars === null || Array.isArray(sidecars)) throw new Error("Expected private history sidecar object");
            expect(Object.keys(sidecars)).toEqual(page.invocations.map((row) => row.id));
            for (const [id, envelope] of Object.entries(sidecars)) {
                if (typeof envelope !== "string") throw new Error("Expected private history envelope text");
                collected.set(id, envelope);
            }
            cursor = page.nextCursor;
        } while (cursor);
        expect(pages).toBe(envelopes.size);
        expect(collected).toEqual(envelopes);

        // The sidecar request shape is part of the opaque cursor binding.
        const publicCursor = (await listWorkflowRunInvocations({ accountId: seeded.accountId, runId, limit: 1, pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES })).nextCursor!;
        await expect(listWorkflowRunInvocations({ accountId: seeded.accountId, runId, progressEnvelopes: true, cursor: publicCursor, pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES }))
            .rejects.toMatchObject({ code: "invalid_input" });

        // Disclosing private bytes applies the same Account-mode outer check as
        // the exact detail read; the index-only public page discloses none.
        const mismatchedId = randomUUID();
        await db.workflowRunInvocation.create({ data: { id: mismatchedId, runId, sequence: 4n, parentRecordId: rootId, memberOrdinal: 3n, attempt: 0n, lifecycle: "completed", contentEnvelope: JSON.stringify({ t: "encrypted", c: "AAAA" }) } });
        await expect(getWorkflowRunInvocation({ accountId: seeded.accountId, runId, invocationId: mismatchedId }))
            .rejects.toMatchObject({ code: "content_unavailable" });
        await expect(listWorkflowRunInvocations({ accountId: seeded.accountId, runId, progressEnvelopes: true, pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES }))
            .rejects.toMatchObject({ code: "content_unavailable" });
        await expect(listWorkflowRunInvocations({ accountId: seeded.accountId, runId, pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES }))
            .resolves.toMatchObject({ invocations: expect.arrayContaining([expect.objectContaining({ id: mismatchedId })]) });
    });

    it("reads the greatest attempt for one exact direct-member slot independently of preceding siblings", async () => {
        const seeded = await seed();
        const runId = randomUUID();
        await admitWorkflowRun({ accountId: seeded.accountId, runId, origin: { kind: "direct" }, machineId: seeded.machineId, acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }) });
        const rootId = randomUUID();
        await initializeWorkflowRunExecution({
            accountId: seeded.accountId,
            runId,
            expectedRevision: 0,
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 1n),
            rootInvocation: { id: rootId, contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }) },
        });
        const rows = Array.from({ length: 500 }, (_, ordinal) => {
            const id = randomUUID();
            const sequence = BigInt(ordinal + 1);
            return {
                id,
                runId,
                sequence,
                parentRecordId: rootId,
                memberOrdinal: BigInt(ordinal),
                attempt: 0n,
                lifecycle: "completed",
                contentEnvelope: progressEnvelope({ ...seeded, runId, id, sequence, parentRecordId: rootId, memberOrdinal: BigInt(ordinal) }),
            } as const;
        });
        await db.workflowRunInvocation.createMany({ data: rows });
        const previous = rows[499]!;
        const newestId = randomUUID();
        await db.workflowRunInvocation.create({
            data: {
                ...previous,
                id: newestId,
                sequence: 501n,
                attempt: 1n,
                lifecycle: "running",
                contentEnvelope: progressEnvelope({ ...seeded, runId, id: newestId, sequence: 501n, parentRecordId: rootId, memberOrdinal: 499n, attempt: 1n, previousAttemptRecordId: previous.id, logicalInvocationRecordId: previous.id }),
            },
        });

        await expect(getCurrentWorkflowRunInvocation({ accountId: seeded.accountId, runId, parentRecordId: rootId, memberOrdinal: 499n }))
            .resolves.toMatchObject({ invocation: { index: { id: newestId, memberOrdinal: "499", attempt: "1", lifecycle: "running" } } });
    });

    it("keeps multibyte Run and invocation continuation pages inside the incumbent 24 MB Action boundary", () => {
        const maximumMultibyteId = `${"😀".repeat(45)}identifier`;
        const timestamp = "2026-09-12T00:00:00.000Z";
        const run = {
            id: maximumMultibyteId,
            origin: { kind: "automation" as const, automationId: maximumMultibyteId },
            state: "running" as const,
            revision: 1,
            machineId: maximumMultibyteId,
            workflowCustodyState: "pending" as const,
            originDeliveryAckRevision: null,
            availability: {
                pause: true,
                resumeBoundary: false,
                restoreWorkspace: false,
                cancel: true,
                inspectExecution: true,
                disabledReasons: [],
            },
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        const invocation = {
            id: maximumMultibyteId,
            runId: maximumMultibyteId,
            sequence: "1",
            parentRecordId: maximumMultibyteId,
            memberOrdinal: "1",
            attempt: "0",
            lifecycle: "running" as const,
            createdAt: timestamp,
            updatedAt: timestamp,
        };

        for (const [actionId, row, projectPage] of [
            ["workflow.run.list", run, (rows: readonly unknown[], nextCursor?: string) => ({ runs: rows, ...(nextCursor ? { nextCursor } : {}) })],
            ["workflow.run.invocations.list", invocation, (rows: readonly unknown[], nextCursor?: string) => ({ invocations: rows, ...(nextCursor ? { nextCursor } : {}), parentRevision: 1 })],
        ] as const) {
            const serializedRowBytes = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
            const candidates = Array.from(
                { length: Math.ceil(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / serializedRowBytes) + 2 },
                () => row,
            );
            const bounded = appendBoundedPage({
                existing: [],
                existingBytes: 2,
                candidates,
                byteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
                serializeMembers: (candidate) => [JSON.stringify(candidate)],
                emptyPage: (nextCursor) => projectPage([], nextCursor),
                nextCursorFor: () => "opaque-continuation",
                hasMoreAfter: () => true,
            });
            expect(bounded.rows.length).toBeGreaterThan(0);
            expect(bounded.rows.length).toBeLessThan(candidates.length);

            const result = projectPage(bounded.rows, "opaque-continuation");
            const prepared = prepareExternalActionResponseEnvelopeV1({
                v: 1,
                actionId,
                requestId: "😀".repeat(32),
                execution: { ok: true, result },
            });
            expect(prepared.response.execution).toMatchObject({ ok: true });
            expect(prepared.byteLength).toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
        }
    });

    it("keeps settled terminal history after the originating Session is deleted", async () => {
        const seeded = await seed();
        const runId = randomUUID();
        await admitWorkflowRun({
            accountId: seeded.accountId,
            runId,
            origin: { kind: "direct", originSessionId: seeded.sessionId },
            machineId: seeded.machineId,
            acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId, originSessionId: seeded.sessionId, deliver: true }),
            resultDelivery: { kind: "originating_session" },
        });
        await claimRun(runId, seeded.machineId);
        const rootId = randomUUID();
        await initializeWorkflowRunExecutionOwner({
            accountId: seeded.accountId,
            accountCurrentness: await accountCurrentness(seeded.accountId),
            runId,
            machineId: seeded.machineId,
            parentAttempt: 1,
            expectedRevision: 0,
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 1n),
            rootInvocation: {
                id: rootId,
                contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }),
            },
        });
        await transitionWorkflowRun({
            accountId: seeded.accountId,
            runId,
            machineId: seeded.machineId,
            parentAttempt: 1,
            expectedRevision: 1,
            state: "succeeded",
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 1n),
            resultEnvelope: finalResultEnvelope(seeded.accountId, runId),
            custodyState: "settled",
            invocationTransitions: [{ id: rootId, expectedLifecycle: "pending", lifecycle: "completed" }],
        });
        await db.session.delete({ where: { id: seeded.sessionId } });

        await expect(getWorkflowRun({ accountId: seeded.accountId, runId })).resolves.toMatchObject({
            run: { origin: { kind: "direct" }, originDeliveryAckRevision: 0, workflowCustodyState: "settled" },
        });
        await expect(db.workflowRunInvocation.findUnique({ where: { id: rootId }, select: { lifecycle: true } }))
            .resolves.toEqual({ lifecycle: "completed" });
    });

    it("returns exact-machine terminal custody and nonterminal cancellation recovery without generic active Runs", async () => {
        const seeded = await seed();
        const otherMachine = await db.machine.create({
            data: { id: randomUUID(), accountId: seeded.accountId, metadata: "{}" },
            select: { id: true },
        });
        const terminalRunId = randomUUID();
        const activeRunId = randomUUID();
        const quietRunId = randomUUID();
        const otherMachineRunId = randomUUID();
        for (const [runId, machineId] of [
            [terminalRunId, seeded.machineId],
            [activeRunId, seeded.machineId],
            [quietRunId, seeded.machineId],
            [otherMachineRunId, otherMachine.id],
        ] as const) {
            await admitWorkflowRun({
                accountId: seeded.accountId,
                runId,
                origin: { kind: "direct" },
                machineId,
                acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId, machineId }),
            });
        }
        await db.automationRun.update({
            where: { id: terminalRunId },
            data: {
                state: "succeeded",
                attempt: 1,
                finishedAt: new Date(),
                originDeliveryAckRevision: 0,
            },
        });
        const rootId = randomUUID();
        await initializeWorkflowRunExecution({
            accountId: seeded.accountId,
            runId: activeRunId,
            expectedRevision: 0,
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, activeRunId, rootId, 1n),
            rootInvocation: {
                id: rootId,
                contentEnvelope: progressEnvelope({ ...seeded, runId: activeRunId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }),
            },
        });
        await db.workflowRunInvocation.update({ where: { id: rootId }, data: { lifecycle: "cancel_requested" } });
        await db.automationRun.update({
            where: { id: otherMachineRunId },
            data: { state: "failed", finishedAt: new Date() },
        });

        const first = await listWorkflowRunsForRecovery({
            accountId: seeded.accountId,
            machineId: seeded.machineId,
            limit: 10,
            pageByteLimit: 4_096,
        });
        expect(first.candidates).toHaveLength(2);
        expect(first.candidates.every((candidate) => candidate.parentAttempt === 1)).toBe(true);
        expect(first.nextCursor).toBeUndefined();
        expect(first.candidates.map((candidate) => candidate.run.id).sort())
            .toEqual([activeRunId, terminalRunId].sort());
    });

    it("fails workflow reads closed while the Account encryption state is inconsistent", async () => {
        const seeded = await seed();
        const runId = randomUUID();
        await admitWorkflowRun({
            accountId: seeded.accountId,
            runId,
            origin: { kind: "direct" },
            machineId: seeded.machineId,
            acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }),
        });
        await db.account.update({
            where: { id: seeded.accountId },
            data: { encryptionMode: "e2ee", contentPublicKey: null, contentPublicKeySig: null },
        });

        await expect(listWorkflowRuns({ accountId: seeded.accountId, pageByteLimit: 4_096 }))
            .rejects.toMatchObject({ code: "content_unavailable" });
        await expect(getWorkflowRun({ accountId: seeded.accountId, runId }))
            .rejects.toMatchObject({ code: "content_unavailable" });
    });

    it("finds lifecycle candidates off page while excluding slots whose newest attempt no longer matches", async () => {
        const seeded = await seed();
        const runId = randomUUID();
        await admitWorkflowRun({ accountId: seeded.accountId, runId, origin: { kind: "direct" }, machineId: seeded.machineId, acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }) });
        const rootId = randomUUID();
        await initializeWorkflowRunExecution({ accountId: seeded.accountId, runId, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 1n), rootInvocation: { id: rootId, contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }) } });
        const childIds = Array.from({ length: 130 }, () => randomUUID());
        const attentionId = randomUUID();
        const staleAttentionId = randomUUID();
        const completedRetryId = randomUUID();
        await db.workflowRunInvocation.createMany({ data: [
            ...childIds.map((id, index) => ({ id, runId, sequence: BigInt(index + 1), parentRecordId: rootId, memberOrdinal: BigInt(index), attempt: 0n, lifecycle: "completed" as const, contentEnvelope: progressEnvelope({ ...seeded, runId, id, sequence: BigInt(index + 1), parentRecordId: rootId, memberOrdinal: BigInt(index) }) })),
            { id: attentionId, runId, sequence: 131n, parentRecordId: rootId, memberOrdinal: 130n, attempt: 0n, lifecycle: "waiting_for_approval" as const, contentEnvelope: progressEnvelope({ ...seeded, runId, id: attentionId, sequence: 131n, parentRecordId: rootId, memberOrdinal: 130n }) },
            { id: staleAttentionId, runId, sequence: 132n, parentRecordId: rootId, memberOrdinal: 131n, attempt: 0n, lifecycle: "waiting_for_approval" as const, contentEnvelope: progressEnvelope({ ...seeded, runId, id: staleAttentionId, sequence: 132n, parentRecordId: rootId, memberOrdinal: 131n }) },
            { id: completedRetryId, runId, sequence: 133n, parentRecordId: rootId, memberOrdinal: 131n, attempt: 1n, lifecycle: "completed" as const, contentEnvelope: progressEnvelope({ ...seeded, runId, id: completedRetryId, sequence: 133n, parentRecordId: rootId, memberOrdinal: 131n, attempt: 1n, previousAttemptRecordId: staleAttentionId, logicalInvocationRecordId: staleAttentionId }) },
        ] });
        const page = await listWorkflowRunInvocations({ accountId: seeded.accountId, runId, parentRecordId: rootId, lifecycles: ["waiting_for_approval"], limit: 2, pageByteLimit: 4096 });
        expect(page.invocations).toEqual([expect.objectContaining({ memberOrdinal: "130", lifecycle: "waiting_for_approval" })]);
        expect(page.nextCursor).toBeUndefined();

        const cancelled = await cancelWorkflowRun({ accountId: seeded.accountId, runId, expectedRevision: 1 });
        expect(cancelled).toMatchObject({ intent: "cancel_requested", run: { state: "running", revision: 2 } });
        expect(await db.workflowRunInvocation.findUniqueOrThrow({ where: { id: rootId }, select: { lifecycle: true } })).toEqual({ lifecycle: "cancel_requested" });
    });

    it("settles cancellation before root admission and prevents a later launch", async () => {
        const seeded = await seed();
        const directRunId = randomUUID();
        await admitWorkflowRun({
            accountId: seeded.accountId,
            runId: directRunId,
            origin: { kind: "direct", originSessionId: seeded.sessionId },
            machineId: seeded.machineId,
            acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId: directRunId, originSessionId: seeded.sessionId, deliver: true }),
            resultDelivery: { kind: "originating_session" },
        });
        await expect(cancelWorkflowRun({ accountId: seeded.accountId, runId: directRunId, expectedRevision: 0 }))
            .resolves.toMatchObject({
                intent: "cancelled",
                run: {
                    state: "cancelled",
                    workflowCustodyState: "settled",
                    originDeliveryAckRevision: 0,
                },
            });

        const automation = await db.automation.create({ data: {
            accountId: seeded.accountId,
            name: "Claimed workflow cancellation",
            targetType: null,
            templateCiphertext: "{}",
        }, select: { id: true } });
        const claimedRunId = randomUUID();
        await db.automationRun.create({ data: {
            id: claimedRunId,
            accountId: seeded.accountId,
            originKind: "automation",
            automationId: automation.id,
            state: "claimed",
            causeKind: "manual",
            causeOccurredAt: new Date(),
            scheduledAt: new Date(),
            dueAt: new Date(),
            claimedByMachineId: seeded.machineId,
            attempt: 1,
            executionInputEnvelope: workflowDefinitionEnvelope(),
            workflowAcceptedSnapshotEnvelope: await acceptedEnvelope({ ...seeded, runId: claimedRunId }),
            workflowCustodyState: "pending",
            assignments: { create: { machineId: seeded.machineId, priority: 0 } },
        } });
        const cancelled = await cancelWorkflowRun({ accountId: seeded.accountId, runId: claimedRunId, expectedRevision: 0 });
        expect(cancelled).toMatchObject({
            intent: "cancelled",
            run: { state: "cancelled", workflowCustodyState: "settled" },
        });
        await expect(db.automationRunEvent.findMany({ where: { runId: claimedRunId }, select: { type: true } }))
            .resolves.toEqual([{ type: "run_cancelled" }]);
        const lateRootId = randomUUID();
        await expect(initializeWorkflowRunExecutionOwner({
            accountId: seeded.accountId,
            accountCurrentness: await accountCurrentness(seeded.accountId),
            runId: claimedRunId,
            machineId: seeded.machineId,
            parentAttempt: 1,
            expectedRevision: cancelled.run.revision,
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, claimedRunId, lateRootId, 1n),
            rootInvocation: {
                id: lateRootId,
                contentEnvelope: progressEnvelope({ ...seeded, runId: claimedRunId, id: lateRootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }),
            },
        })).rejects.toMatchObject({ code: "currentness_conflict" });
        await expect(db.workflowRunInvocation.count({ where: { runId: claimedRunId } })).resolves.toBe(0);
    });

    it("does not let cancellation mutate any terminal parent with pending custody", async () => {
        const seeded = await seed();
        for (const terminalState of AUTOMATION_RUN_TERMINAL_STATES) {
            const runId = randomUUID();
            await admitWorkflowRun({
                accountId: seeded.accountId,
                runId,
                origin: { kind: "direct" },
                machineId: seeded.machineId,
                acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }),
            });
            const rootId = randomUUID();
            await initializeWorkflowRunExecution({
                accountId: seeded.accountId,
                runId,
                expectedRevision: 0,
                checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 1n),
                rootInvocation: {
                    id: rootId,
                    contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }),
                },
            });
            await db.automationRun.update({
                where: { id: runId },
                data: { state: terminalState, finishedAt: new Date() },
            });
            await db.workflowRunInvocation.update({
                where: { id: rootId },
                data: { lifecycle: "needs_attention" },
            });

            await expect(cancelWorkflowRun({ accountId: seeded.accountId, runId, expectedRevision: 1 }))
                .rejects.toMatchObject({ code: "currentness_conflict" });
            await expect(db.automationRun.findUniqueOrThrow({ where: { id: runId }, select: { state: true, revision: true } }))
                .resolves.toEqual({ state: terminalState, revision: 1 });
            await expect(db.workflowRunInvocation.findUniqueOrThrow({ where: { id: rootId }, select: { lifecycle: true } }))
                .resolves.toEqual({ lifecycle: "needs_attention" });
        }
    });

    it("routes retained Automation cancellation through Workflow invocation custody", async () => {
        const seeded = await seed();
        const automation = await db.automation.create({ data: {
            accountId: seeded.accountId,
            name: "Workflow cancellation custody",
            targetType: null,
            templateCiphertext: "{}",
        }, select: { id: true } });
        for (const state of ["running", "interrupted"] as const) {
            const runId = randomUUID();
            const rootId = randomUUID();
            await db.automationRun.create({ data: {
                id: runId,
                accountId: seeded.accountId,
                originKind: "automation",
                automationId: automation.id,
                state,
                causeKind: "manual",
                causeOccurredAt: new Date(),
                scheduledAt: new Date(),
                dueAt: new Date(),
                claimedByMachineId: seeded.machineId,
                attempt: 1,
                executionInputEnvelope: workflowDefinitionEnvelope(),
                workflowAcceptedSnapshotEnvelope: await acceptedEnvelope({ ...seeded, runId }),
                workflowCheckpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 1n),
                workflowCustodyState: "pending",
                assignments: { create: { machineId: seeded.machineId, priority: 0 } },
                workflowInvocations: { create: {
                    id: rootId,
                    sequence: 0n,
                    parentRecordId: null,
                    memberOrdinal: 0n,
                    attempt: 0n,
                    lifecycle: "needs_attention",
                    contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }),
                } },
            } });

            await expect(cancelAutomationRun({
                accountId: seeded.accountId,
                runId,
            })).resolves.toMatchObject({ id: runId, state, revision: 1, workflowCustodyState: "pending" });
            await expect(db.workflowRunInvocation.findUniqueOrThrow({ where: { id: rootId }, select: { lifecycle: true } }))
                .resolves.toEqual({ lifecycle: "cancel_requested" });
        }
    });

    it("settles a paused Automation workflow cancellation through Automation terminal effects", async () => {
        const seeded = await seed();
        const automation = await db.automation.create({ data: {
            accountId: seeded.accountId,
            name: "Paused workflow cancellation",
            targetType: null,
            templateCiphertext: "{}",
        }, select: { id: true } });
        const runId = randomUUID();
        await db.automationRun.create({ data: {
            id: runId,
            accountId: seeded.accountId,
            originKind: "automation",
            automationId: automation.id,
            state: "paused",
            causeKind: "manual",
            causeOccurredAt: new Date(),
            scheduledAt: new Date(),
            dueAt: new Date(),
            claimedByMachineId: seeded.machineId,
            attempt: 1,
            executionInputEnvelope: workflowDefinitionEnvelope(),
            workflowAcceptedSnapshotEnvelope: await acceptedEnvelope({ ...seeded, runId }),
            workflowCheckpointEnvelope: checkpointEnvelope(seeded.accountId, runId, randomUUID(), 1n),
            workflowCustodyState: "pending",
            assignments: { create: { machineId: seeded.machineId, priority: 0 } },
        } });

        await expect(cancelWorkflowRun({ accountId: seeded.accountId, runId, expectedRevision: 0 }))
            .resolves.toMatchObject({
                intent: "cancelled",
                run: { state: "cancelled", workflowCustodyState: "settled" },
            });
        await expect(db.automationRunEvent.findMany({ where: { runId }, select: { type: true } }))
            .resolves.toEqual([{ type: "run_cancelled" }]);
    });

    it("uses the parent revision as the retry CAS", async () => {
        const seeded = await seed();
        const runId = randomUUID();
        await admitWorkflowRun({ accountId: seeded.accountId, runId, origin: { kind: "direct" }, machineId: seeded.machineId, acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }) });
        const rootId = randomUUID();
        await initializeWorkflowRunExecution({ accountId: seeded.accountId, runId, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 1n), rootInvocation: { id: rootId, contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }) } });
        await db.workflowRunInvocation.update({ where: { id: rootId }, data: { lifecycle: "failed" } });
        await db.automationRun.update({ where: { id: runId }, data: { state: "interrupted" } });
        const retryId = `workflow-retry-é-${randomUUID()}`;
        const retryRequest = { accountId: seeded.accountId, runId, expectedRevision: 1, invocationId: rootId, newInvocationId: retryId, newSequence: 99n, contentEnvelope: progressEnvelope({ ...seeded, runId, id: retryId, sequence: 1n, parentRecordId: null, memberOrdinal: 0n, attempt: 1n, previousAttemptRecordId: rootId, logicalInvocationRecordId: rootId }) } as const;
        await expect(retryWorkflowInvocation(retryRequest)).resolves.toMatchObject({ disposition: "accepted", run: { revision: 2 }, invocation: { sequence: "1", attempt: "1" } });
        await expect(retryWorkflowInvocation(retryRequest)).resolves.toMatchObject({ disposition: "existing", run: { revision: 2 }, invocation: { id: retryId } });
        await expect(retryWorkflowInvocation({ ...retryRequest, newInvocationId: randomUUID(), newSequence: 2n, expectedRevision: 2 }))
            .rejects.toMatchObject({ code: "currentness_conflict" });
        const staleRetryId = randomUUID();
        await expect(retryWorkflowInvocation({ accountId: seeded.accountId, runId, expectedRevision: 1, invocationId: rootId, newInvocationId: staleRetryId, newSequence: 2n, contentEnvelope: progressEnvelope({ ...seeded, runId, id: staleRetryId, sequence: 2n, parentRecordId: null, memberOrdinal: 0n, attempt: 1n, previousAttemptRecordId: rootId, logicalInvocationRecordId: rootId }) })).rejects.toMatchObject({ code: "currentness_conflict" });
    });

    it("does not let acknowledgement replace an invocation whose outcome may still be active", async () => {
        const seeded = await seed();
        const runId = randomUUID();
        await admitWorkflowRun({ accountId: seeded.accountId, runId, origin: { kind: "direct" }, machineId: seeded.machineId, acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }) });
        const rootId = randomUUID();
        await initializeWorkflowRunExecution({ accountId: seeded.accountId, runId, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 1n), rootInvocation: { id: rootId, contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }) } });
        await db.workflowRunInvocation.update({ where: { id: rootId }, data: { lifecycle: "outcome_uncertain" } });
        await db.automationRun.update({ where: { id: runId }, data: { state: "interrupted" } });
        const retryId = randomUUID();

        await expect(retryWorkflowInvocation({ accountId: seeded.accountId, runId, expectedRevision: 1, invocationId: rootId, newInvocationId: retryId, newSequence: 1n,
            contentEnvelope: progressEnvelope({ ...seeded, runId, id: retryId, sequence: 1n, parentRecordId: null, memberOrdinal: 0n, attempt: 1n, previousAttemptRecordId: rootId, logicalInvocationRecordId: rootId }) }))
            .rejects.toMatchObject({ code: "ineligible_state" });

        await expect(transitionWorkflowRun({
            accountId: seeded.accountId,
            runId,
            machineId: seeded.machineId,
            parentAttempt: 1,
            expectedRevision: 1,
            state: "outcome_uncertain",
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 1n),
            custodyState: "settled",
        })).rejects.toMatchObject({ code: "currentness_conflict" });
        await expect(deleteWorkflowRun({ accountId: seeded.accountId, runId, expectedRevision: 1 }))
            .rejects.toMatchObject({ code: "custody_pending" });

        const reconciledEnvelope = progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n, reason: "observed-stopped" });
        await expect(commitWorkflowInvocationFact({
            accountId: seeded.accountId,
            runId,
            machineId: seeded.machineId,
            parentAttempt: 1,
            invocationId: rootId,
            invocationAttempt: 0n,
            expectedLifecycle: "outcome_uncertain",
            lifecycle: "outcome_uncertain",
            contentEnvelope: reconciledEnvelope,
        })).rejects.toMatchObject({ code: "currentness_conflict" });
        const stoppedResolution: Parameters<typeof commitWorkflowInvocationFact>[0] = {
            accountId: seeded.accountId,
            runId,
            machineId: seeded.machineId,
            parentAttempt: 1,
            invocationId: rootId,
            invocationAttempt: 0n,
            expectedLifecycle: "outcome_uncertain",
            lifecycle: "needs_attention",
            contentEnvelope: reconciledEnvelope,
            resolution: "observed_terminal_execution" as const,
        };
        await expect(commitWorkflowInvocationFact(stoppedResolution)).resolves.toMatchObject({ lifecycle: "needs_attention" });
        await expect(commitWorkflowInvocationFact(stoppedResolution)).resolves.toMatchObject({ lifecycle: "needs_attention" });
        await expect(db.workflowRunInvocation.findUniqueOrThrow({ where: { id: rootId }, select: { lifecycle: true, contentEnvelope: true } }))
            .resolves.toEqual({ lifecycle: "needs_attention", contentEnvelope: reconciledEnvelope });
        await expect(retryWorkflowInvocation({ accountId: seeded.accountId, runId, expectedRevision: 1, invocationId: rootId, newInvocationId: retryId, newSequence: 1n,
            contentEnvelope: progressEnvelope({ ...seeded, runId, id: retryId, sequence: 1n, parentRecordId: null, memberOrdinal: 0n, attempt: 1n, previousAttemptRecordId: rootId, logicalInvocationRecordId: rootId }) }))
            .resolves.toMatchObject({ disposition: "accepted", invocation: { attempt: "1" } });
    });

    it("keeps interrupted cancellation in stop custody instead of acknowledging terminal cancellation", async () => {
        const seeded = await seed();
        const runId = randomUUID();
        await admitWorkflowRun({ accountId: seeded.accountId, runId, origin: { kind: "direct" }, machineId: seeded.machineId, acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }) });
        const rootId = randomUUID();
        await initializeWorkflowRunExecution({ accountId: seeded.accountId, runId, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 1n), rootInvocation: { id: rootId, contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }) } });
        await db.workflowRunInvocation.update({ where: { id: rootId }, data: { lifecycle: "needs_attention" } });
        await db.automationRun.update({ where: { id: runId }, data: { state: "interrupted" } });

        await expect(cancelWorkflowRun({ accountId: seeded.accountId, runId, expectedRevision: 1 }))
            .resolves.toMatchObject({ intent: "cancel_requested", run: { state: "interrupted" } });
        await expect(db.workflowRunInvocation.findUniqueOrThrow({ where: { id: rootId }, select: { lifecycle: true } }))
            .resolves.toEqual({ lifecycle: "cancel_requested" });
    });

    it("rejects a late row fact from an attempt superseded by retry", async () => {
        const seeded = await seed();
        const runId = randomUUID();
        await admitWorkflowRun({ accountId: seeded.accountId, runId, origin: { kind: "direct" }, machineId: seeded.machineId, acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }) });
        const rootId = randomUUID();
        await initializeWorkflowRunExecution({ accountId: seeded.accountId, runId, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 1n), rootInvocation: { id: rootId, contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }) } });
        await db.automationRun.update({ where: { id: runId }, data: { claimedByMachineId: seeded.machineId, attempt: 1 } });
        await db.workflowRunInvocation.update({ where: { id: rootId }, data: { lifecycle: "failed" } });
        await db.automationRun.update({ where: { id: runId }, data: { state: "interrupted" } });
        const retryId = randomUUID();
        await retryWorkflowInvocation({ accountId: seeded.accountId, runId, expectedRevision: 1, invocationId: rootId, newInvocationId: retryId, newSequence: 1n, contentEnvelope: progressEnvelope({ ...seeded, runId, id: retryId, sequence: 1n, parentRecordId: null, memberOrdinal: 0n, attempt: 1n, previousAttemptRecordId: rootId, logicalInvocationRecordId: rootId }) });

        await expect(commitWorkflowInvocationFact({
            accountId: seeded.accountId,
            runId,
            machineId: seeded.machineId,
            parentAttempt: 1,
            invocationId: rootId,
            invocationAttempt: 0n,
            expectedLifecycle: "superseded",
            lifecycle: "completed",
            contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }),
        })).rejects.toMatchObject({ code: "currentness_conflict" });
        await expect(db.workflowRunInvocation.findUniqueOrThrow({ where: { id: rootId }, select: { lifecycle: true } }))
            .resolves.toEqual({ lifecycle: "superseded" });
        await expect(db.automationRun.findUniqueOrThrow({ where: { id: runId }, select: { revision: true } }))
            .resolves.toEqual({ revision: 2 });
    });

    it("recovers several interrupted invocations in one rejoinable parent CAS bound to the signed publisher Machine", async () => {
        const [{ auth }, { enableAuthentication }, { registerWorkflowRunStorageRoutes }] = await Promise.all([
            import("@/app/auth/auth"), import("@/app/api/utils/enableAuthentication"), import("@/app/api/routes/automations/registerWorkflowRunStorageRoutes"),
        ]);
        const seeded = await seed();
        const runId = randomUUID();
        await admitWorkflowRun({ accountId: seeded.accountId, runId, origin: { kind: "direct" }, machineId: seeded.machineId, acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }) });
        const rootId = randomUUID();
        await initializeWorkflowRunExecution({ accountId: seeded.accountId, runId, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 3n), rootInvocation: { id: rootId, contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }) } });
        const previousIds = [randomUUID(), randomUUID()];
        await db.workflowRunInvocation.createMany({ data: previousIds.map((id, index) => ({
            id, runId, sequence: BigInt(index + 1), parentRecordId: rootId, memberOrdinal: BigInt(index), attempt: 0n,
            lifecycle: "needs_attention" as const,
            contentEnvelope: progressEnvelope({ ...seeded, runId, id, sequence: BigInt(index + 1), parentRecordId: rootId, memberOrdinal: BigInt(index) }),
        })) });
        await db.automationRun.update({ where: { id: runId }, data: { state: "interrupted" } });
        const newIds = [`workflow-recovery-é-${randomUUID()}`, randomUUID()];
        const request = {
            accountId: seeded.accountId,
            machineId: seeded.machineId,
            runId,
            expectedRevision: 1,
            recoveries: newIds.map((newInvocationId, index) => ({
                invocationId: previousIds[index]!,
                newInvocationId,
                newSequence: BigInt(index + 3),
                contentEnvelope: progressEnvelope({ ...seeded, runId, id: newInvocationId, sequence: BigInt(index + 3), parentRecordId: rootId, memberOrdinal: BigInt(index), attempt: 1n, previousAttemptRecordId: previousIds[index]!, logicalInvocationRecordId: previousIds[index]! }),
            })),
        } as const;
        const publisherKeys = tweetnacl.sign.keyPair();
        const installationId = randomUUID();
        const otherMachineId = randomUUID();
        await createTrustedMachineInstallation({ accountId: seeded.accountId, machineId: otherMachineId, installationId, keyPair: publisherKeys });
        const token = await auth.createToken(seeded.accountId, undefined, { kind: "account", authority: "present_user" });
        const body = {
            operation: "invocations.recover",
            publisherMachineId: otherMachineId,
            runId,
            expectedRevision: request.expectedRevision,
            accountCurrentness: await accountCurrentness(seeded.accountId),
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 5n),
            recoveries: request.recoveries.map(({ newSequence: _sequence, ...recovery }) => recovery),
        };
        const path = "/v3/automations/runs/workflow-storage";
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerWorkflowRunStorageRoutes(app);
        const wrongPublisher = () => app.inject({ method: "POST", url: path, headers: {
            authorization: `Bearer ${token}`,
            [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({ keyPair: publisherKeys, machineId: otherMachineId, installationId, path, body }),
        }, payload: body });
        try {
            const refused = await wrongPublisher();
            expect(refused.statusCode, refused.body).toBe(409);
            expect(refused.json()).toEqual({ error: "currentness_conflict" });
            expect(await db.workflowRunInvocation.count({ where: { id: { in: newIds } } })).toBe(0);
            await expect(recoverWorkflowInvocations(request)).resolves.toMatchObject({ disposition: "accepted", run: { revision: 2, state: "queued" }, invocations: [{ id: newIds[0] }, { id: newIds[1] }] });
            await expect(recoverWorkflowInvocations(request)).resolves.toMatchObject({ disposition: "existing", run: { revision: 2 } });
            const refusedRejoin = await wrongPublisher();
            expect(refusedRejoin.statusCode, refusedRejoin.body).toBe(409);
            expect(refusedRejoin.json()).toEqual({ error: "currentness_conflict" });
        } finally {
            await app.close();
        }
    });

    it("recovers a structural attention closure parent-before-child once while retaining its completed sibling", async () => {
        const seeded = await seed();
        const runId = randomUUID();
        await admitWorkflowRun({ accountId: seeded.accountId, runId, origin: { kind: "direct" }, machineId: seeded.machineId, acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }) });
        const rootId = randomUUID();
        await initializeWorkflowRunExecution({ accountId: seeded.accountId, runId, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 5n), rootInvocation: { id: rootId, contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }) } });
        const parentId = randomUUID();
        const childIds = [randomUUID(), randomUUID()];
        await db.workflowRunInvocation.create({ data: {
            id: parentId, runId, sequence: 1n, parentRecordId: rootId, memberOrdinal: 0n, attempt: 0n, lifecycle: "needs_attention",
            contentEnvelope: progressEnvelope({ ...seeded, runId, id: parentId, sequence: 1n, parentRecordId: rootId, memberOrdinal: 0n, blockKind: "parallel", blockId: "parallel-1", container: { kind: "parallel", nextBranchOrdinal: "3" } }),
        } });
        await db.workflowRunInvocation.createMany({ data: childIds.map((id, index) => ({
            id, runId, sequence: BigInt(index + 2), parentRecordId: parentId, memberOrdinal: BigInt(index), attempt: 0n,
            lifecycle: index === 0 ? "failed" as const : "cancelled" as const,
            contentEnvelope: progressEnvelope({ ...seeded, runId, id, sequence: BigInt(index + 2), parentRecordId: parentId, memberOrdinal: BigInt(index), reason: index === 0 ? "step_failed" : `container_fail_stop:${parentId}` }),
        })) });
        const completedId = randomUUID();
        const completedEnvelope = progressEnvelope({ ...seeded, runId, id: completedId, sequence: 4n, parentRecordId: parentId, memberOrdinal: 2n, result: "completed C must not replay" });
        await db.workflowRunInvocation.create({ data: {
            id: completedId, runId, sequence: 4n, parentRecordId: parentId, memberOrdinal: 2n, attempt: 0n,
            lifecycle: "completed", contentEnvelope: completedEnvelope,
        } });
        const completedBeforeRecovery = await db.workflowRunInvocation.findUniqueOrThrow({ where: { id: completedId } });
        await db.automationRun.update({ where: { id: runId }, data: { state: "interrupted" } });
        const newParentId = randomUUID();
        const newChildIds = [randomUUID(), randomUUID()];
        const recoveries = [{
            invocationId: parentId, newInvocationId: newParentId, newSequence: 5n,
            contentEnvelope: progressEnvelope({ ...seeded, runId, id: newParentId, sequence: 5n, parentRecordId: rootId, memberOrdinal: 0n, attempt: 1n, previousAttemptRecordId: parentId, logicalInvocationRecordId: parentId, blockKind: "parallel", blockId: "parallel-1", container: { kind: "parallel", nextBranchOrdinal: "0" } }),
        }, ...newChildIds.map((newInvocationId, index) => ({
            invocationId: childIds[index]!, newInvocationId, newSequence: BigInt(index + 6),
            contentEnvelope: progressEnvelope({ ...seeded, runId, id: newInvocationId, sequence: BigInt(index + 6), parentRecordId: newParentId, memberOrdinal: BigInt(index), attempt: 1n, previousAttemptRecordId: childIds[index]!, logicalInvocationRecordId: childIds[index]! }),
        }))];
        await expect(recoverWorkflowInvocations({
            accountId: seeded.accountId, runId, expectedRevision: 1,
            recoveries: [recoveries[1]!, recoveries[0]!, recoveries[2]!],
        })).rejects.toMatchObject({ code: "invalid_input" });
        await expect(db.workflowRunInvocation.findMany({ where: { id: { in: [newParentId, ...newChildIds] } } })).resolves.toHaveLength(0);
        const request = { accountId: seeded.accountId, runId, expectedRevision: 1, recoveries };
        const results = await Promise.all([recoverWorkflowInvocations(request), recoverWorkflowInvocations(request)]);
        expect(results.map((result) => result.disposition).sort()).toEqual(["accepted", "existing"]);
        for (const result of results) {
            expect(result).toMatchObject({ run: { state: "queued", revision: 2 }, invocations: [
                { id: newParentId, parentRecordId: rootId },
                { id: newChildIds[0], parentRecordId: newParentId },
                { id: newChildIds[1], parentRecordId: newParentId },
            ] });
        }
        await expect(recoverWorkflowInvocations(request)).resolves.toMatchObject({ disposition: "existing", run: { revision: 2 } });
        expect(await db.workflowRunInvocation.count({ where: { runId } })).toBe(8);
        expect(await db.workflowRunInvocation.findUniqueOrThrow({ where: { id: completedId } })).toEqual(completedBeforeRecovery);
        await expect(getCurrentWorkflowRunInvocation({ accountId: seeded.accountId, runId, parentRecordId: parentId, memberOrdinal: 2n }))
            .resolves.toMatchObject({ invocation: { index: { id: completedId, lifecycle: "completed", attempt: "0" }, contentEnvelope: completedEnvelope } });
    });

    it.each([
        ["needs_attention", "completed"],
        ["outcome_uncertain", "failed"],
        ["outcome_uncertain", "cancelled"],
        ["outcome_uncertain", "needs_attention"],
    ] as const)("commits exact signed reattach observation without claiming or reopening an interrupted Run (%s → %s)", async (expectedLifecycle, lifecycle) => {
        const [{ auth }, { enableAuthentication }, { registerWorkflowRunStorageRoutes }] = await Promise.all([
            import("@/app/auth/auth"), import("@/app/api/utils/enableAuthentication"), import("@/app/api/routes/automations/registerWorkflowRunStorageRoutes"),
        ]);
        const seeded = { ...await seed(), machineId: randomUUID() };
        const publisherKeys = tweetnacl.sign.keyPair();
        const installationId = randomUUID();
        await createTrustedMachineInstallation({ ...seeded, installationId, keyPair: publisherKeys });
        const runId = randomUUID();
        const rootId = randomUUID();
        const invocationId = randomUUID();
        await admitWorkflowRun({ accountId: seeded.accountId, runId, origin: { kind: "direct" }, machineId: seeded.machineId, acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }) });
        await initializeWorkflowRunExecution({ accountId: seeded.accountId, runId, expectedRevision: 0,
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 2n),
            rootInvocation: { id: rootId, contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }) } });
        await db.workflowRunInvocation.create({ data: {
            id: invocationId, runId, sequence: 1n, parentRecordId: rootId, memberOrdinal: 0n, attempt: 0n, lifecycle: expectedLifecycle,
            contentEnvelope: progressEnvelope({ ...seeded, runId, id: invocationId, sequence: 1n, parentRecordId: rootId, memberOrdinal: 0n }),
        } });
        await db.automationRun.update({ where: { id: runId }, data: { state: "interrupted", claimedByMachineId: null, claimedAt: null, leaseExpiresAt: null } });
        const parentBefore = await db.automationRun.findUniqueOrThrow({ where: { id: runId } });
        const token = await auth.createToken(seeded.accountId, undefined, { kind: "account", authority: "present_user" });
        const path = "/v3/automations/runs/workflow-storage";
        const body = {
            operation: "invocations.fact", publisherMachineId: seeded.machineId, runId, expectedRevision: 1,
            accountCurrentness: await accountCurrentness(seeded.accountId), invocationId, invocationAttempt: "0", expectedContentRevision: "0",
            expectedLifecycle, lifecycle, resolution: "observed_terminal_execution",
            contentEnvelope: progressEnvelope({ ...seeded, runId, id: invocationId, sequence: 1n, parentRecordId: rootId, memberOrdinal: 0n, result: "observed exact settlement" }),
        } as const;
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerWorkflowRunStorageRoutes(app);
        const observe = (payload: Readonly<Record<string, unknown>>) => app.inject({
            method: "POST", url: path, headers: {
                authorization: `Bearer ${token}`,
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({ keyPair: publisherKeys, machineId: seeded.machineId, installationId, path, body: payload }),
            }, payload,
        });
        try {
            const observed = await observe(body);
            expect(observed.statusCode, observed.body).toBe(200);
            expect(observed.json()).toMatchObject({ id: invocationId, lifecycle, attempt: "0" });
            if (expectedLifecycle === "needs_attention") {
                const rootBody = { ...body, invocationId: rootId, expectedLifecycle: "pending", lifecycle: "pending", resolution: "root_list_progress",
                    contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n,
                        stepProgress: { completed: 1, total: 1 } }) };
                const rootPublished = await observe(rootBody);
                expect(rootPublished.statusCode, rootPublished.body).toBe(200);
                expect(rootPublished.json()).toMatchObject({ id: rootId, lifecycle: "pending", contentRevision: "1" });
                expect((await observe({ ...rootBody, expectedContentRevision: "1", lifecycle: "completed" })).statusCode).toBe(422);
                expect((await observe({ ...rootBody, invocationId, expectedLifecycle: lifecycle, lifecycle,
                    expectedContentRevision: "1", contentEnvelope: body.contentEnvelope })).statusCode).toBe(422);
            }
            const freshBody = { ...body, expectedContentRevision: "1" };
            const rejectedAdmission = await observe({ ...body, lifecycle: "admitting" });
            expect(rejectedAdmission.statusCode, rejectedAdmission.body).toBe(422);
            const stale = await observe({ ...body, expectedRevision: 0 });
            expect(stale.statusCode, stale.body).toBe(409);
            const ambiguousAuthority = await observe({ ...body, parentAttempt: 1 });
            expect(ambiguousAuthority.statusCode, ambiguousAuthority.body).toBe(400);
            const missingObservationProof = await observe({ ...body, resolution: undefined });
            expect(missingObservationProof.statusCode, missingObservationProof.body).toBe(400);
            const wrongBinding = await observe({ ...freshBody, contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }) });
            expect(wrongBinding.statusCode, wrongBinding.body).toBe(422);
            expect((await observe(body)).statusCode).toBe(409);
            const rejoined = await observe(freshBody);
            expect(rejoined.statusCode, rejoined.body).toBe(200);
            expect(await db.workflowRunInvocation.count({ where: { runId } })).toBe(2);
            expect(await db.automationRun.findUniqueOrThrow({ where: { id: runId } })).toEqual(parentBefore);
            await expect(db.workflowRunInvocation.findUniqueOrThrow({ where: { id: invocationId }, select: { lifecycle: true, contentEnvelope: true } }))
                .resolves.toEqual({ lifecycle, contentEnvelope: body.contentEnvelope });
            for (const state of ["queued", "running", "paused", "succeeded"] as const) {
                await db.automationRun.update({ where: { id: runId }, data: { state } });
                const ineligible = await observe(body);
                expect(ineligible.statusCode, ineligible.body).toBe(409);
            }
            await db.automationRun.update({ where: { id: runId }, data: { state: "interrupted", workflowCustodyState: "settled" } });
            const settled = await observe(body);
            expect(settled.statusCode, settled.body).toBe(409);
            await db.automationRun.update({ where: { id: runId }, data: { workflowCustodyState: "pending" } });
            const otherMachine = await db.machine.create({ data: { id: randomUUID(), accountId: seeded.accountId, metadata: "{}" } });
            await db.automationRunAssignment.updateMany({ where: { runId }, data: { machineId: otherMachine.id } });
            const wrongMachine = await observe(body);
            expect(wrongMachine.statusCode, wrongMachine.body).toBe(409);
            await db.automationRunAssignment.updateMany({ where: { runId }, data: { machineId: seeded.machineId } });
            const replacementId = randomUUID();
            await db.workflowRunInvocation.create({ data: {
                id: replacementId, runId, sequence: 2n, parentRecordId: rootId, memberOrdinal: 0n, attempt: 1n, lifecycle: "needs_attention",
                contentEnvelope: progressEnvelope({ ...seeded, runId, id: replacementId, sequence: 2n, parentRecordId: rootId, memberOrdinal: 0n, attempt: 1n, previousAttemptRecordId: invocationId, logicalInvocationRecordId: invocationId }),
            } });
            const staleAttempt = await observe(body);
            expect(staleAttempt.statusCode, staleAttempt.body).toBe(409);
            await expect(db.workflowRunInvocation.findUniqueOrThrow({ where: { id: invocationId }, select: { lifecycle: true, contentEnvelope: true } }))
                .resolves.toEqual({ lifecycle, contentEnvelope: body.contentEnvelope });
        } finally {
            await app.close();
        }
    });

    it("refuses recovery of an older failed attempt even when the parent revision is current", async () => {
        const seeded = await seed();
        const runId = randomUUID();
        const rootId = randomUUID();
        await admitWorkflowRun({ accountId: seeded.accountId, runId, origin: { kind: "direct" }, machineId: seeded.machineId, acceptedEnvelope: await acceptedEnvelope({ ...seeded, runId }) });
        await initializeWorkflowRunExecution({ accountId: seeded.accountId, runId, expectedRevision: 0,
            checkpointEnvelope: checkpointEnvelope(seeded.accountId, runId, rootId, 1n),
            rootInvocation: { id: rootId, contentEnvelope: progressEnvelope({ ...seeded, runId, id: rootId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n }) } });
        await db.workflowRunInvocation.update({ where: { id: rootId }, data: { lifecycle: "failed" } });
        const currentId = randomUUID();
        await db.workflowRunInvocation.create({ data: {
            id: currentId, runId, sequence: 1n, parentRecordId: null, memberOrdinal: 0n, attempt: 1n, lifecycle: "cancelled",
            contentEnvelope: progressEnvelope({ ...seeded, runId, id: currentId, sequence: 1n, parentRecordId: null, memberOrdinal: 0n, attempt: 1n, previousAttemptRecordId: rootId, logicalInvocationRecordId: rootId }),
        } });
        await db.automationRun.update({ where: { id: runId }, data: { state: "interrupted" } });
        const newId = randomUUID();
        await expect(recoverWorkflowInvocations({ accountId: seeded.accountId, runId, expectedRevision: 1, recoveries: [{
            invocationId: rootId, newInvocationId: newId, newSequence: 2n,
            contentEnvelope: progressEnvelope({ ...seeded, runId, id: newId, sequence: 2n, parentRecordId: null, memberOrdinal: 0n, attempt: 1n, previousAttemptRecordId: rootId, logicalInvocationRecordId: rootId }),
        }] })).rejects.toMatchObject({ code: "ineligible_state" });
        expect(await db.workflowRunInvocation.count({ where: { runId } })).toBe(2);
        await expect(db.automationRun.findUniqueOrThrow({ where: { id: runId }, select: { state: true, revision: true } }))
            .resolves.toEqual({ state: "interrupted", revision: 1 });
    });
});
