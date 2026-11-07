import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { WorkflowRunSummaryV1Schema } from "@happier-dev/protocol/workflows/workflowProgressV1";
import { WorkflowRunRecipientCensusResponseV1Schema } from "@happier-dev/protocol/workflows/workflowRunKeyV1";
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from "@happier-dev/protocol/workflows";
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, sealEncryptedDataKeyEnvelopeV1 } from "@happier-dev/protocol";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { logger } from "@/utils/logging/log";
import { materializeWorkflowAcceptedSnapshotFixture } from "@/testkit/workflowAcceptedSnapshot";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { deriveAccountRecipientEnvelopeReadinessFromRow } from "@/app/encryption/accountRecipientEnvelopeReadiness";
import { getWorkflowRun, listWorkflowRunInvocations, listWorkflowRuns, summarizeWorkflowRuns } from "./workflowRunService";
import { applyAutomationRunTerminalEffectsTx } from "@/app/automations/automationRunSucceeded";
import { inTx } from "@/storage/inTx";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerAutomationV3Routes } from "@/app/api/routes/automations/registerAutomationV3Routes";
import { registerWorkflowRunStorageRoutes } from "@/app/api/routes/automations/registerWorkflowRunStorageRoutes";
import { AutomationDefinitionListResponseSchema } from "@happier-dev/protocol/automations/automationApiV3";
import { deriveAutomationOccurrenceKeyV1 } from "@happier-dev/protocol/automations/automationOccurrenceV1";
import { encodeAutomationRunCause } from "@/app/automations/automationRunCauseCodec";
import { AutomationTriggerIdSchema } from "@happier-dev/protocol/automations/automationTriggerIdentity";
import type { Prisma } from "@prisma/client";

// Native database boundary only: all SQL, snapshots, policy and keys stay real.
type NativeDatabaseBoundary = Pick<typeof db, "$transaction" | "$executeRawUnsafe">;
let nativePrototype: NativeDatabaseBoundary | undefined;
let nativeTransaction: NativeDatabaseBoundary["$transaction"] | undefined;
let nativeExecute: NativeDatabaseBoundary["$executeRawUnsafe"] | undefined;
const nativeTransactions: { leases: number; afterCommit?: () => Promise<void> } = { leases: 0 };
async function afterNativeRead() {
    const hook = nativeTransactions.afterCommit;
    nativeTransactions.afterCommit = undefined;
    await hook?.();
}

let harness: LightSqliteHarness;
let previousLogLevel: string;
beforeAll(async () => {
    previousLogLevel = logger.level;
    // Phase observations use the real logging boundary, whose debug gate is explicit.
    logger.level = "debug";
    harness = await createLightSqliteHarness({ tempDirPrefix: "happier-run-list-keys-",
        env: { HAPPIER_WEB_LATENCY_TRACE: "1" } });
    const client: unknown = Reflect.get(db, "_originalClient");
    if (!client || typeof client !== "object") throw new Error("Native Prisma test boundary unavailable");
    const prototype: unknown = Object.getPrototypeOf(client);
    if (!prototype || typeof prototype !== "object" || !("$transaction" in prototype)
        || typeof prototype.$transaction !== "function" || !("$executeRawUnsafe" in prototype)
        || typeof prototype.$executeRawUnsafe !== "function") throw new Error("Native Prisma prototype unavailable");
    // Narrow the validated, actually loaded native client boundary, not a second module instance.
    nativePrototype = prototype as NativeDatabaseBoundary;
    nativeTransaction = nativePrototype.$transaction;
    nativeExecute = nativePrototype.$executeRawUnsafe;
    nativePrototype.$transaction = new Proxy(nativeTransaction, {
        async apply(target, receiver, args) {
            nativeTransactions.leases++;
            let result: unknown;
            try { result = await Reflect.apply(target, receiver, args); }
            finally { nativeTransactions.leases--; }
            await afterNativeRead();
            return result;
        },
    });
    nativePrototype.$executeRawUnsafe = new Proxy(nativeExecute, {
        async apply(target, receiver, args) {
            const sql = typeof args[0] === "string" ? args[0].trim().toUpperCase() : "";
            const result: unknown = await Reflect.apply(target, receiver, args);
            if (sql === "BEGIN DEFERRED;") nativeTransactions.leases++;
            if (sql === "ROLLBACK;") {
                nativeTransactions.leases--;
                await afterNativeRead();
            }
            return result;
        },
    });
}, 180_000);
afterAll(async () => {
    logger.level = previousLogLevel;
    if (nativePrototype && nativeTransaction && nativeExecute) {
        nativePrototype.$transaction = nativeTransaction;
        nativePrototype.$executeRawUnsafe = nativeExecute;
    }
    if (harness) await harness.close();
});

it("filters trigger history before paging and binds continuation to that trigger through the storage route", async () => {
    const owner = await db.account.create({ data: { encryptionMode: "plain" } });
    const other = await db.account.create({ data: { encryptionMode: "plain" } });
    const viewer = await db.account.create({ data: { encryptionMode: "plain" } });
    const team = await db.team.create({ data: { name: "Trigger history" } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: viewer.id, role: "member" } });
    const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
        header: new Uint8Array(privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: "workflow-definition.v1" }))),
        body: new Uint8Array(privacyKit.decodeBase64(encodePlainArtifactStoredContent({}))),
        dataEncryptionKey: new Uint8Array(privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)) } });
    await db.artifactTeamGrant.create({ data: { artifactId: artifact.id, teamId: team.id,
        accessLevel: "view", createdByAccountId: owner.id } });
    const automation = await db.automation.create({ data: { accountId: owner.id, name: "Trigger history",
        targetType: null, templateCiphertext: "{}" } });
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, metadata: "{}" } });
    const triggerId = AutomationTriggerIdSchema.parse(crypto.randomUUID());
    const siblingTriggerId = AutomationTriggerIdSchema.parse(crypto.randomUUID());
    const runIds = Array.from({ length: 4 }, () => crypto.randomUUID());
    await db.automationRun.createMany({ data: runIds.map((id, index) => {
        const selectedTriggerId = [triggerId, siblingTriggerId, triggerId, null][index];
        const occurredAt = Date.UTC(2026, 10, 1, 0, 0, index);
        return { id, accountId: owner.id, automationId: automation.id, originKind: "automation", state: "failed",
            sourceArtifactId: artifact.id, visibleTeamId: index === 2 ? team.id : null,
            ...encodeAutomationRunCause(selectedTriggerId ? { kind: "trigger", triggerId: selectedTriggerId,
                triggerKind: "schedule", triggerRevision: 0, occurredAt,
                occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId: selectedTriggerId,
                    evidence: { v: 1, kind: "schedule", scheduledFor: occurredAt } }),
                evidence: { scheduledFor: occurredAt } } : { kind: "manual", invokedAt: occurredAt }),
            createdAt: new Date(occurredAt), scheduledAt: new Date(occurredAt), dueAt: new Date(occurredAt),
            workflowCustodyState: "settled", workflowAcceptedSnapshotEnvelope: "unopened retained content" };
    }) });
    await db.automationRunAssignment.createMany({ data: runIds.map(runId => ({ runId, machineId: machine.id, priority: 0 })) });
    const app = createAuthenticatedTestApp();
    registerWorkflowRunStorageRoutes(app);
    await app.ready();
    const read = (request: object, accountId = owner.id) => app.inject({ method: "POST",
        url: "/v3/automations/runs/workflow-storage", headers: { "x-test-user-id": accountId },
        payload: { operation: "list", request: { automationId: automation.id, ...request }, pageByteLimit: 1_000_000 } });
    try {
        const firstResponse = await read({ triggerId, limit: 1 });
        expect(firstResponse.statusCode, firstResponse.body).toBe(200);
        const first: Awaited<ReturnType<typeof listWorkflowRuns>> = firstResponse.json();
        expect(first.runs.map(run => run.id)).toEqual([runIds[2]]);
        expect(first.nextCursor).toBeTypeOf("string");
        const secondResponse = await read({ triggerId, limit: 1, cursor: first.nextCursor });
        expect(secondResponse.statusCode, secondResponse.body).toBe(200);
        expect(secondResponse.json()).toMatchObject({ runs: [{ id: runIds[0] }] });
        expect(secondResponse.json().nextCursor).toBeUndefined();
        expect((await read({ triggerId: siblingTriggerId })).json()).toMatchObject({ runs: [{ id: runIds[1] }] });
        expect((await read({ triggerId: crypto.randomUUID() })).json()).toMatchObject({ runs: [] });
        expect((await read({ triggerId }, other.id)).json()).toMatchObject({ runs: [] });
        const teamResponse = await read({ triggerId }, viewer.id);
        expect(teamResponse.statusCode, teamResponse.body).toBe(200);
        expect(teamResponse.json().runs.map((run: { id: string }) => run.id)).toEqual([runIds[2]]);
        await db.artifactTeamGrant.deleteMany({ where: { artifactId: artifact.id, teamId: team.id } });
        expect((await read({ triggerId }, viewer.id)).json()).toMatchObject({ runs: [] });
        expect((await read({})).json().runs.map((run: { id: string }) => run.id)).toEqual([...runIds].reverse());
        expect((await read({ triggerId: siblingTriggerId, cursor: first.nextCursor })).statusCode).toBe(422);
        expect((await read({ cursor: first.nextCursor })).statusCode).toBe(422);
    } finally { await app.close(); }
});

it("reports only actually started Runs as last run for Library and Habits, preserving unstarted history", async () => {
    const owner = await db.account.create({ data: { encryptionMode: "plain" } });
    const source = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
        header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array() } });
    const [automation, neverStarted] = await Promise.all(["Started", "Never started"].map(name =>
        db.automation.create({ data: { accountId: owner.id, name, targetType: null, templateCiphertext: "{}" } })));
    const createdAt = new Date("2026-10-30T08:00:00.000Z");
    const latestStart = new Date(createdAt.getTime() + 60_000);
    const startedId = crypto.randomUUID();
    const queuedId = crypto.randomUUID();
    // Only public retained metadata is needed; private content must not be opened.
    const retainedRuns = [
        { id: startedId, automationId: automation.id, state: "failed", createdAt, startedAt: latestStart },
        { id: crypto.randomUUID(), automationId: automation.id, state: "succeeded",
            createdAt: new Date(createdAt.getTime() + 1_000), startedAt: new Date(createdAt.getTime() + 30_000) },
        { id: crypto.randomUUID(), automationId: automation.id, state: "cancelled",
            createdAt: new Date(createdAt.getTime() + 90_000), startedAt: null },
        { id: queuedId, automationId: automation.id, state: "queued",
            createdAt: new Date(createdAt.getTime() + 100_000), startedAt: null },
        { id: crypto.randomUUID(), automationId: neverStarted.id, state: "skipped",
            createdAt: new Date(createdAt.getTime() + 120_000), startedAt: null },
    ] satisfies Pick<Prisma.AutomationRunCreateManyInput, "id" | "automationId" | "state" | "createdAt" | "startedAt">[];
    await db.automationRun.createMany({ data: retainedRuns.map(row => ({ ...row, accountId: owner.id, sourceArtifactId: source.id, originKind: "automation",
        causeKind: "manual", causeOccurredAt: row.createdAt, scheduledAt: row.createdAt, dueAt: row.createdAt,
        workflowCustodyState: row.state === "queued" ? "pending" : "settled",
        workflowAcceptedSnapshotEnvelope: "unopened private content" } satisfies Prisma.AutomationRunCreateManyInput)) });
    const habits = await summarizeWorkflowRuns({ accountId: owner.id,
        automationIds: [automation.id, neverStarted.id], pageByteLimit: 1_000_000 });
    expect(habits.automationSummaries).toMatchObject([
        { automationId: automation.id, lastRun: { id: startedId, state: "failed", startedAt: latestStart.toISOString() } },
        { automationId: neverStarted.id, lastRun: null },
    ]);
    const library = await summarizeWorkflowRuns({ accountId: owner.id, sourceArtifactIds: [source.id],
        recent: 1, pageByteLimit: 1_000_000 });
    expect(library.summaries[0]?.lastRun).toMatchObject({ runId: startedId, state: "failed", startedAt: latestStart.toISOString() });
    expect(library.summaries[0]?.recent).toMatchObject([{ state: "skipped" }]);
});

it("reports a legacy started Run through the same public Automation summary", async () => {
    const owner = await db.account.create({ data: { encryptionMode: "plain" } });
    const automation = await db.automation.create({ data: { accountId: owner.id, name: "Legacy started",
        targetType: null, templateCiphertext: "{}" } });
    const startedAt = new Date("2026-10-30T08:01:00.000Z");
    const run = await db.automationRun.create({ data: { id: crypto.randomUUID(), accountId: owner.id, automationId: automation.id,
        originKind: "automation", causeKind: "manual", causeOccurredAt: startedAt,
        state: "failed", startedAt, scheduledAt: startedAt, dueAt: startedAt } });
    const result = await summarizeWorkflowRuns({ accountId: owner.id, automationIds: [automation.id], pageByteLimit: 1_000_000 });
    expect(result.automationSummaries).toMatchObject([{ automationId: automation.id,
        lastRun: { id: run.id, state: "failed", workflowCustodyState: null, startedAt: startedAt.toISOString() } }]);
});

it("projects the summary-derived Automation timestamp for existing definition clients", async () => {
    const owner = await db.account.create({ data: { encryptionMode: "plain" } });
    const retainedTimestamp = new Date("2026-10-29T08:00:00.000Z");
    const automation = await db.automation.create({ data: { accountId: owner.id, name: "Existing client",
        targetType: "new_session", templateVersion: 1, lastRunAt: retainedTimestamp,
        templateCiphertext: JSON.stringify({ kind: "happier_automation_template_plain_v1", payload: { prompt: "Legacy work" } }) } });
    const startedAt = new Date("2026-10-30T08:01:00.000Z");
    await db.automationRun.create({ data: { id: crypto.randomUUID(), accountId: owner.id, automationId: automation.id,
        originKind: "automation", causeKind: "manual", causeOccurredAt: startedAt,
        state: "failed", startedAt, scheduledAt: startedAt, dueAt: startedAt } });
    const app = createAuthenticatedTestApp();
    registerAutomationV3Routes(app);
    await app.ready();
    try {
        const response = await app.inject({ method: "POST", url: "/v3/automations/query",
            headers: { "x-test-user-id": owner.id }, payload: {} });
        expect(response.statusCode, response.body).toBe(200);
        expect(AutomationDefinitionListResponseSchema.parse(response.json()).automations)
            .toMatchObject([{ id: automation.id, lastRunAt: startedAt.getTime() }]);
        expect((await db.automation.findUniqueOrThrow({ where: { id: automation.id } })).lastRunAt).toEqual(retainedTimestamp);
    } finally { await app.close(); }
});

it("applies terminal consequences without rewriting the authored Automation timestamp", async () => {
    const owner = await db.account.create({ data: { encryptionMode: "plain" } });
    const retainedTimestamp = new Date("2026-10-29T08:00:00.000Z");
    const automation = await db.automation.create({ data: { accountId: owner.id, name: "Terminal consequences",
        targetType: null, templateCiphertext: "{}", lastRunAt: retainedTimestamp } });
    const now = new Date("2026-10-30T08:00:00.000Z");
    const run = await db.automationRun.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
        automationId: automation.id, originKind: "automation", causeKind: "manual", causeOccurredAt: now,
        state: "failed", startedAt: now, finishedAt: now, scheduledAt: now, dueAt: now,
        workflowCustodyState: "settled" } });
    let definitionWrites = 0;
    const stop = observeSqliteRequests({ before: request => {
        if (request.model === "Automation" && ["updateOne", "updateMany"].includes(request.action)) definitionWrites++;
    } });
    try {
        await inTx(tx => applyAutomationRunTerminalEffectsTx({ tx, accountId: owner.id, runId: run.id,
            previousState: "running", state: "failed", now }));
    } finally { stop(); }
    expect(definitionWrites).toBe(0);
    expect(await db.automationRunEvent.findMany({ where: { runId: run.id }, select: { type: true } }))
        .toEqual([{ type: "run_failed" }]);
    expect((await db.automation.findUniqueOrThrow({ where: { id: automation.id } })).lastRunAt)
        .toEqual(retainedTimestamp);
});

it.each(["mode", "change-cursor", "deletion"] as const)("retains admitted public latest status through an Account %s change", async change => {
    const owner = await db.account.create({ data: { encryptionMode: "plain" } });
    const automation = await db.automation.create({ data: { accountId: owner.id, name: "Latest status", targetType: null, templateCiphertext: "{}" } });
    const runId = crypto.randomUUID();
    await db.automationRun.create({ data: { id: runId, accountId: owner.id, automationId: automation.id,
        originKind: "automation", causeKind: "manual", causeOccurredAt: new Date(), state: "failed",
        startedAt: new Date(), scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: "pending", workflowAcceptedSnapshotEnvelope: "unopened" } });
    let changed = false;
    const leases: number[] = [];
    const debug = vi.spyOn(logger, "debug").mockImplementation(record => {
        if (record && typeof record === "object" && "phase" in record && record.phase === "workflow.summaries.materialize") leases.push(nativeTransactions.leases);
    });
    nativeTransactions.afterCommit = async () => {
        changed = true;
        if (change === "deletion") await db.automationRun.delete({ where: { id: runId } });
        else await db.account.update({ where: { id: owner.id }, data: change === "mode" ? { encryptionMode: "e2ee" } : { seq: { increment: 1 } } });
    };
    try {
        const result = await Promise.allSettled([summarizeWorkflowRuns({ accountId: owner.id, automationIds: [automation.id], pageByteLimit: 1_000_000 })]);
        if (!changed && result[0].status === "rejected") throw result[0].reason;
        expect(changed).toBe(true);
        expect(leases).toEqual([0]);
        expect(nativeTransactions.leases).toBe(0);
        expect(result).toMatchObject([{ status: "fulfilled", value: {
            automationSummaries: [{ automationId: automation.id, lastRun: { id: runId, attentionRequired: true } }], remainingAutomationIds: [],
        } }]);
        const next = await summarizeWorkflowRuns({ accountId: owner.id, automationIds: [automation.id], pageByteLimit: 1_000_000 });
        if (change === 'deletion') expect(next.automationSummaries[0]?.lastRun).toBeNull();
        else expect(next.automationSummaries[0]?.lastRun).toMatchObject({ id: runId });
    } finally { nativeTransactions.afterCommit = undefined; debug.mockRestore(); }
});

it("keeps summary queries set-oriented for 1129 requested ids without acquiring private payload columns or imposing a cap", async () => {
    const owner = await db.account.create({ data: { encryptionMode: "plain" } });
    const automationIds = Array.from({ length: 129 }, () => crypto.randomUUID());
    await db.automation.createMany({ data: automationIds.map(id => ({ id, accountId: owner.id, name: "Status", targetType: null, templateCiphertext: "{}" })) });
    await db.automationRun.createMany({ data: automationIds.map(automationId => ({ id: crypto.randomUUID(), automationId, accountId: owner.id,
        originKind: "automation", causeKind: "manual", causeOccurredAt: new Date(), state: "succeeded", startedAt: new Date(), workflowCustodyState: "settled",
        scheduledAt: new Date(), dueAt: new Date(), workflowAcceptedSnapshotEnvelope: "unopened accepted", workflowCheckpointEnvelope: "unopened checkpoint" })) });
    // Initialize the storage-owned SQLite read connection before observing domain queries.
    await summarizeWorkflowRuns({ accountId: owner.id, automationIds: automationIds.slice(0, 1), pageByteLimit: 1_000_000 });
    const client: unknown = Reflect.get(db, "_originalClient");
    if (!client || typeof client !== "object") throw new Error("Native Prisma boundary unavailable");
    // SQLite's coherent reads use a second native client of this same provider constructor.
    const boundary: unknown = Object.getPrototypeOf(client);
    if (!boundary || typeof boundary !== "object") throw new Error("Native Prisma prototype unavailable");
    const request: unknown = Reflect.get(boundary, "_request");
    if (typeof request !== "function") throw new Error("Native Prisma request boundary unavailable");
    let rawQueries = 0;
    let privatePayloadColumns = 0;
    let keyEnvelopeReads = 0;
    const stop = observeSqliteRequests({ before: request => {
        if (request.model === 'WorkflowRunDataKeyEnvelope') keyEnvelopeReads++;
    } });
    Reflect.set(boundary, "_request", new Proxy(request, { async apply(target, receiver, args) {
        const result: unknown = await Reflect.apply(target, receiver, args);
        if (args[0] && typeof args[0] === "object" && "action" in args[0] && args[0].action === "queryRaw") {
            rawQueries++;
        }
        for (const row of Array.isArray(result) ? result : [result]) if (row && typeof row === "object") {
            for (const field of ["workflowAcceptedSnapshotEnvelope", "workflowCheckpointEnvelope", "contentEnvelope"]) {
                if (Object.hasOwn(row, field)) privatePayloadColumns++;
            }
        }
        return result;
    } }));
    try {
        const one = await summarizeWorkflowRuns({ accountId: owner.id, automationIds: automationIds.slice(0, 1), pageByteLimit: 1_000_000 });
        expect(one.automationSummaries).toHaveLength(1);
        expect(keyEnvelopeReads, 'public status consumes no private Run key census').toBe(0);
        const singleQueries = rawQueries;
        rawQueries = 0;
        const many = await summarizeWorkflowRuns({ accountId: owner.id, automationIds, pageByteLimit: 1_000_000 });
        expect(many.automationSummaries.map(summary => summary.automationId)).toEqual(automationIds);
        expect({ singleQueries, pageQueries: rawQueries, privatePayloadColumns }).toEqual({ singleQueries: 1, pageQueries: 1, privatePayloadColumns: 0 });
        const oversizedIds = [...automationIds, ...Array.from({ length: 1000 }, () => crypto.randomUUID())];
        rawQueries = 0;
        const oversized = await summarizeWorkflowRuns({ accountId: owner.id, automationIds: oversizedIds, pageByteLimit: 1_000_000 });
        expect(oversized.automationSummaries.map(summary => summary.automationId)).toEqual(oversizedIds);
        expect(oversized.remainingAutomationIds).toEqual([]);
        const automationQueries = rawQueries;
        rawQueries = 0;
        const sources = await summarizeWorkflowRuns({ accountId: owner.id, sourceArtifactIds: oversizedIds, recent: 1, pageByteLimit: 1_000_000 });
        expect(sources.summaries.map(summary => summary.sourceArtifactId)).toEqual(oversizedIds);
        expect(sources.summaries.every(summary => summary.lastRun === null)).toBe(true);
        expect(sources.remainingSourceArtifactIds).toEqual([]);
        expect({ automationQueries, sourceQueries: rawQueries, privatePayloadColumns })
            .toEqual({ automationQueries: 1, sourceQueries: 1, privatePayloadColumns: 0 });
        console.info("PERF-S4-workflow-summary-queries", { singleQueries, pageQueries: 1, requestedIds: oversizedIds.length,
            automationQueries, sourceQueries: rawQueries, privatePayloadColumns });
    } finally { stop(); Reflect.set(boundary, "_request", request); }
});

it("selects no unused checkpoint for public list availability while exact detail retains the frozen bytes", async () => {
    const owner = await db.account.create({ data: { encryptionMode: "plain" } });
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, metadata: "test" } });
    const runId = crypto.randomUUID();
    const checkpoint = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
        mode: "plain", binding: { v: 1, purpose: "checkpoint", accountId: owner.id, runId },
        checkpoint: { kind: "happier.workflow-checkpoint.v1", rootRecordId: "root", nextSequence: "1",
            frontier: { nextBlockOrdinal: 0, paused: false } },
    }));
    const snapshot = await materializeWorkflowAcceptedSnapshotFixture({
        definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: "wait", id: "answer",
            document: { text: "Answer", references: [], attachments: [] }, result: { kind: "text" } }] },
        context: { source: { kind: "inline" }, inputs: {}, machineId: machine.id, executionTarget: { kind: "session" },
            workspaceTarget: { project: { machineId: machine.id, directory: "/repo", checkoutRootPath: "/repo" } },
            origin: { kind: "direct" }, authorization: { principal: { kind: "host" } } },
    });
    const accepted = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: "plain", binding: { v: 1, purpose: "accepted_snapshot", accountId: owner.id, runId }, acceptedSnapshot: snapshot,
    }));
    await db.automationRun.create({ data: { id: runId, accountId: owner.id, originKind: "direct", causeKind: null,
        state: "paused", scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: "pending",
        workflowAcceptedSnapshotEnvelope: accepted, workflowCheckpointEnvelope: checkpoint,
        assignments: { create: { machineId: machine.id, priority: 0 } } } });
    // Real provider boundary, shared by the storage-owned read client and the exact detail client.
    const client: unknown = Reflect.get(db, "_originalClient");
    if (!client || typeof client !== "object") throw new Error("Native Prisma boundary unavailable");
    const boundary: unknown = Object.getPrototypeOf(client);
    if (!boundary || typeof boundary !== "object") throw new Error("Native Prisma prototype unavailable");
    const request: unknown = Reflect.get(boundary, "_request");
    if (typeof request !== "function") throw new Error("Native Prisma request boundary unavailable");
    let checkpointBytes = 0;
    Reflect.set(boundary, "_request", new Proxy(request, { async apply(target, receiver, args) {
        const result: unknown = await Reflect.apply(target, receiver, args);
        for (const row of Array.isArray(result) ? result : [result]) {
            if (row && typeof row === "object" && "workflowCheckpointEnvelope" in row
                && typeof row.workflowCheckpointEnvelope === "string") checkpointBytes += Buffer.byteLength(row.workflowCheckpointEnvelope);
        }
        return result;
    } }));
    try {
        expect((await getWorkflowRun({ accountId: owner.id, runId })).checkpointEnvelope).toBe(checkpoint);
        expect(checkpointBytes, "real detail acquisition must positively calibrate the observer").toBeGreaterThan(0);
        const detailCheckpointBytes = checkpointBytes;
        checkpointBytes = 0;
        const page = await listWorkflowRuns({ accountId: owner.id, runIds: [runId], pageByteLimit: 1_000_000 });
        expect(page.runs).toEqual([expect.objectContaining({ id: runId, availability: expect.objectContaining({ resumeBoundary: true }) })]);
        console.info("PERF-S4-workflow-checkpoint", { detailCheckpointBytes, listCheckpointBytes: checkpointBytes });
        expect(checkpointBytes, "public availability does not consume the frozen checkpoint").toBe(0);
    } finally { Reflect.set(boundary, "_request", request); }
    expect((await getWorkflowRun({ accountId: owner.id, runId })).checkpointEnvelope).toBe(checkpoint);
});

it.each(["membership", "automation-status"] as const)("retains admitted Team %s and refuses its revoked source grant on the next request", async projection => {
    const owner = await db.account.create({ data: { encryptionMode: "plain" } });
    const viewer = await db.account.create({ data: { encryptionMode: "plain" } });
    const team = await db.team.create({ data: { name: "Compact attention" } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: viewer.id, role: "member" } });
    const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
        header: new Uint8Array(privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: "workflow-definition.v1" }))),
        body: new Uint8Array(privacyKit.decodeBase64(encodePlainArtifactStoredContent({}))),
        dataEncryptionKey: new Uint8Array(privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)) } });
    await db.artifactTeamGrant.create({ data: { artifactId: artifact.id, teamId: team.id, accessLevel: "view", createdByAccountId: owner.id } });
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, metadata: "test" } });
    const runId = crypto.randomUUID();
    const automation = await db.automation.create({ data: { accountId: owner.id, name: "Team status", targetType: null, templateCiphertext: "{}" } });
    await db.automationRun.create({ data: { id: runId, accountId: owner.id, sourceArtifactId: artifact.id, visibleTeamId: team.id,
        originKind: "automation", automationId: automation.id, causeKind: "manual", causeOccurredAt: new Date(), state: "failed", scheduledAt: new Date(), dueAt: new Date(),
        startedAt: new Date(), workflowCustodyState: "pending", workflowAcceptedSnapshotEnvelope: "unopened private content",
        assignments: { create: { machineId: machine.id, priority: 0 } } } });
    const recordId = crypto.randomUUID();
    await db.workflowRunInvocation.create({ data: { id: recordId, runId, sequence: 0n, memberOrdinal: 0n,
        attempt: 0n, lifecycle: 'needs_attention',
        contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
            mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: owner.id, runId,
                recordId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
            progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
                blockKind: 'root', attempt: '0', logicalInvocationRecordId: recordId },
        })),
    } });
    let revoked = false;
    nativeTransactions.afterCommit = async () => {
        revoked = true;
        await db.artifactTeamGrant.deleteMany({ where: { artifactId: artifact.id, teamId: team.id } });
    };
    try {
        const read = () => projection === "membership"
            ? listWorkflowRuns({ accountId: viewer.id, attention: "required", projection: "membership", pageByteLimit: 1_000_000 })
            : summarizeWorkflowRuns({ accountId: viewer.id, automationIds: [automation.id], pageByteLimit: 1_000_000 });
        expect(await read()).toMatchObject(projection === 'membership'
            ? { runs: [{ id: runId }] }
            : { automationSummaries: [{ automationId: automation.id, lastRun: { id: runId } }] });
        expect(await read()).toMatchObject(projection === 'membership'
            ? { runs: [] }
            : { automationSummaries: [{ automationId: automation.id, lastRun: null }] });
        expect(revoked).toBe(true);
        expect(nativeTransactions.leases).toBe(0);
    } finally { nativeTransactions.afterCommit = undefined; }
});

it.each(["plain", "e2ee"] as const)("serves access-only %s membership through the route without private reads and observes revocation on the next request", async mode => {
    const [owner, viewer, other] = await Promise.all([0, 1, 2].map(() => db.account.create({ data: {
        encryptionMode: mode, ...(mode === "e2ee" ? createSignedAccountContentBinding() : {}),
    } })));
    const team = await db.team.create({ data: { name: "Access-only membership" } });
    await db.teamMembership.createMany({ data: [viewer, other].map(account => ({
        teamId: team.id, accountId: account.id, role: "member" as const,
    })) });
    const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
        header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array() } });
    await db.artifactTeamGrant.create({ data: { artifactId: artifact.id, teamId: team.id,
        accessLevel: "view", createdByAccountId: owner.id } });
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, metadata: "test" } });
    const runId = crypto.randomUUID();
    await db.automationRun.create({ data: { id: runId, accountId: owner.id, sourceArtifactId: artifact.id,
        visibleTeamId: team.id, originKind: "direct", causeKind: null, state: "failed",
        workflowCustodyState: "settled", scheduledAt: new Date(), dueAt: new Date(),
        workflowAcceptedSnapshotEnvelope: "unopened retained private content",
        assignments: { create: { machineId: machine.id, priority: 0 } } } });
    // A Team member's attention comes from a real hold, not the owner's unseen failure.
    await db.workflowRunInvocation.create({ data: { id: crypto.randomUUID(), runId, sequence: 0n,
        memberOrdinal: 0n, attempt: 0n, lifecycle: "waiting_for_review", contentEnvelope: "unopened retained hold" } });
    const app = createAuthenticatedTestApp();
    registerWorkflowRunStorageRoutes(app);
    await app.ready();
    const privateReads: string[] = [];
    const stop = observeSqliteRequests({ before: request => {
        if (request.model === "WorkflowRunDataKeyEnvelope") privateReads.push(request.model);
        if (request.args && typeof request.args === "object" && "select" in request.args) {
            const select = request.args.select;
            if (select && typeof select === "object") for (const field of ["workflowAcceptedSnapshotEnvelope", "contentEnvelope",
                "contentPublicKey", "contentPublicKeySig", "publicKey"]) {
                if (Reflect.get(select, field)) privateReads.push(`${request.model}.${field}`);
            }
        }
    } });
    const read = async (accountId = viewer.id) => {
        const response = await app.inject({ method: "POST", url: "/v3/automations/runs/workflow-storage",
            headers: { "x-test-user-id": accountId }, payload: { operation: "list",
                request: { projection: "membership", attention: "required", sourceArtifactId: artifact.id }, pageByteLimit: 1_000_000 } });
        expect(response.statusCode, response.body).toBe(200);
        const page: Awaited<ReturnType<typeof listWorkflowRuns>> = response.json();
        return page;
    };
    let rotated = false;
    nativeTransactions.afterCommit = async () => {
        await db.account.update({ where: { id: other.id }, data: createSignedAccountContentBinding() });
        rotated = true;
    };
    try {
        expect(await read()).toMatchObject({ projection: "membership", runs: [{ id: runId }],
            acceptedEnvelopesByRunId: {}, keyCensusByRunId: {}, rootProgressByRunId: {}, heldProgressByRunId: {} });
        expect(rotated).toBe(true);
        expect(await read(owner.id)).toMatchObject({ runs: [{ id: runId }] });
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: viewer.id } }, data: { status: "suspended" } });
        expect(await read()).toMatchObject({ runs: [] });
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: viewer.id } }, data: { status: "active" } });
        expect(await read()).toMatchObject({ runs: [{ id: runId }] });
        await db.artifactTeamGrant.deleteMany({ where: { artifactId: artifact.id, teamId: team.id } });
        expect(await read()).toMatchObject({ runs: [] });
        expect(await read(owner.id)).toMatchObject({ runs: [{ id: runId }] });
        await db.artifactTeamGrant.create({ data: { artifactId: artifact.id, teamId: team.id,
            accessLevel: "view", createdByAccountId: owner.id } });
        expect(await read()).toMatchObject({ runs: [{ id: runId }] });
        expect(privateReads).toEqual([]);
    } finally { nativeTransactions.afterCommit = undefined; stop(); await app.close(); }
});

it.each(["plain", "e2ee"] as const)("projects %s collection keys without per-Run reads or crossing Run envelopes", async mode => {
    const owner = await db.account.create({ data: { encryptionMode: mode,
        ...(mode === "e2ee" ? createSignedAccountContentBinding() : {}) } });
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, metadata: "test", metadataVersion: 1 } });
    const runs = Array.from({ length: 12 }, () => ({ id: crypto.randomUUID(), dataKey: tweetnacl.randomBytes(32) }));
    const runIds = runs.map(run => run.id);
    const snapshot = await materializeWorkflowAcceptedSnapshotFixture({
        definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: "wait", id: "answer",
            document: { text: "Answer", references: [], attachments: [] }, result: { kind: "text" } }] },
        context: { source: { kind: "inline" }, inputs: {}, machineId: machine.id, executionTarget: { kind: "session" },
            workspaceTarget: { project: { machineId: machine.id, directory: "/repo", checkoutRootPath: "/repo" } },
            origin: { kind: "direct" }, authorization: { principal: { kind: "host" } } },
    });
    await db.automationRun.createMany({ data: runs.map(({ id, dataKey }) => ({
        id, accountId: owner.id, originKind: "direct", causeKind: null, state: "queued", scheduledAt: new Date(), dueAt: new Date(),
        workflowAcceptedSnapshotEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
            ...(mode === "plain" ? { mode: "plain" as const }
                : { mode: "e2ee" as const, runDataKey: dataKey, randomBytes: tweetnacl.randomBytes }),
            binding: { v: 1, purpose: "accepted_snapshot", accountId: owner.id, runId: id }, acceptedSnapshot: snapshot,
        })),
        workflowCustodyState: "pending",
    })) });
    await db.automationRunAssignment.createMany({ data: runIds.map(runId => ({ runId, machineId: machine.id, priority: 0 })) });
    const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(owner);
    const envelopes = mode === "plain" ? [] : runs.map(run => {
        if (readiness.status !== "available") throw new Error("Fixture signing binding unavailable");
        return { runId: run.id, recipientAccountId: owner.id,
            recipientContentPublicKeyFingerprint: readiness.binding.contentPublicKeyFingerprint,
            encryptedDataKey: new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: run.dataKey,
                recipientPublicKey: readiness.binding.contentPublicKey, randomBytes: tweetnacl.randomBytes })) };
    });
    if (envelopes.length) await db.workflowRunDataKeyEnvelope.createMany({ data: envelopes });
    const keysByRunId = new Map(envelopes.map(row => [row.runId, privacyKit.encodeBase64(row.encryptedDataKey)]));
    const requests: string[] = [];
    const stop = observeSqliteRequests({ before: request => {
        if (request.model) requests.push(`${request.model}.${request.action}`);
    } });
    try {
        const page = await listWorkflowRuns({ accountId: owner.id, runIds, pageByteLimit: 1_000_000 });
        expect(new Set(page.runs.map(run => WorkflowRunSummaryV1Schema.parse(run).id))).toEqual(new Set(runIds));
        for (const id of runIds) {
            const key = keysByRunId.get(id) ?? null;
            expect(WorkflowRunRecipientCensusResponseV1Schema.parse(page.keyCensusByRunId[id])).toMatchObject({
                runId: id, ownerAccountId: owner.id, access: "owner", encryptionMode: mode,
                dataEncryptionKey: key, callerDataEncryptionKey: key,
                recipients: [{ recipientAccountId: owner.id, encryptedDataKey: key }],
            });
        }
        // These are the expensive N+1 reads observed in the live Voice latency trace.
        // The admitted page acquires the key set once, never one read per Run.
        expect(requests.filter(request => request === 'WorkflowRunDataKeyEnvelope.findMany')).toHaveLength(1);
        expect(requests.filter(request => request === 'AutomationRun.findUnique')).toHaveLength(0);
    } finally { stop(); }
});

it.each((["mode", "change-cursor", "deletion"] as const).flatMap(change => [
    { change, projection: undefined }, { change, projection: "membership" as const },
]))("retains $projection admitted content through an Account $change change", async ({ change, projection }) => {
    const owner = await db.account.create({ data: { encryptionMode: "plain" } });
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, metadata: "test" } });
    const runId = crypto.randomUUID();
    await db.automationRun.create({ data: {
        id: runId, accountId: owner.id, originKind: "direct", causeKind: null, state: "failed",
        scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: "pending",
        workflowAcceptedSnapshotEnvelope: "malformed retained content",
        assignments: { create: { machineId: machine.id, priority: 0 } },
    } });
    // The native database/diagnostic boundary remains real. Change policy only
    // after its capture closes; this request retains the admitted content.
    let changed = false;
    const materializationLeases: number[] = [];
    const debug = vi.spyOn(logger, "debug").mockImplementation(record => {
        if (record !== null && typeof record === "object" && "phase" in record
            && record.phase === "workflow.list.materialize") materializationLeases.push(nativeTransactions.leases);
    });
    nativeTransactions.afterCommit = async () => {
        changed = true;
        if (change === "deletion") await db.automationRun.delete({ where: { id: runId } });
        else await db.account.update({ where: { id: owner.id }, data: change === "mode"
            ? { encryptionMode: "e2ee" } : { seq: { increment: 1 } } });
    };
    try {
        const result = await Promise.allSettled([listWorkflowRuns({ accountId: owner.id, runIds: [runId], pageByteLimit: 1_000_000,
            ...(projection ? { projection, attention: "required" as const } : {}) })]);
        if (!changed && result[0].status === "rejected") throw result[0].reason;
        expect(changed).toBe(true);
        expect(materializationLeases, "validation and page serialization must run without a native lease").toEqual([0]);
        expect(nativeTransactions.leases).toBe(0);
        expect(result).toMatchObject([{ status: "fulfilled", value: {
            runs: [{ id: runId }], acceptedEnvelopesByRunId: projection ? {} : { [runId]: null },
            keyCensusByRunId: projection ? {} : { [runId]: { encryptionMode: "plain" } },
        } }]);
        const next = listWorkflowRuns({ accountId: owner.id, runIds: [runId], pageByteLimit: 1_000_000,
            ...(projection ? { projection, attention: 'required' as const } : {}) });
        if (change === 'mode' && !projection) await expect(next).rejects.toMatchObject({ code: 'content_unavailable' });
        else if (change === 'deletion') expect((await next).runs).toEqual([]);
        else expect((await next).runs.map(run => run.id)).toEqual([runId]);
    } finally {
        nativeTransactions.afterCommit = undefined;
        debug.mockRestore();
    }
});

it.each(['grant', 'mode'] as const)('retains one admitted authority across internal pages after a %s change', async change => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
    const team = await db.team.create({ data: { name: 'Paged admitted workflow' } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: viewer.id, role: 'member' } });
    const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
        header: new Uint8Array(privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1' }))),
        body: new Uint8Array(privacyKit.decodeBase64(encodePlainArtifactStoredContent({}))),
        dataEncryptionKey: new Uint8Array(privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)) } });
    await db.artifactTeamGrant.create({ data: { artifactId: artifact.id, teamId: team.id, accessLevel: 'view', createdByAccountId: owner.id } });
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, metadata: 'test' } });
    // Existing continuation coverage establishes 129 Runs crosses the owner's
    // 128-row database transport page without imposing a result limit.
    const runIds = Array.from({ length: 129 }, () => crypto.randomUUID());
    await db.automationRun.createMany({ data: runIds.map(id => ({ id, accountId: owner.id,
        sourceArtifactId: artifact.id, visibleTeamId: team.id, originKind: 'direct', causeKind: null,
        state: 'queued', scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: 'pending',
        workflowAcceptedSnapshotEnvelope: 'malformed retained content' })) });
    await db.automationRunAssignment.createMany({ data: runIds.map(runId => ({ runId, machineId: machine.id, priority: 0 })) });
    const request = { accountId: viewer.id, runIds, pageByteLimit: 10_000_000 };
    let changed = false;
    const laterAuthorityReads: string[] = [];
    const stop = observeSqliteRequests({ before: request => {
        if (changed && request.model && ['TeamMembership', 'ArtifactTeamGrant', 'Account'].includes(request.model)) {
            laterAuthorityReads.push(`${request.model}.${request.action}`);
        }
    } });
    nativeTransactions.afterCommit = async () => {
        if (change === 'grant') await db.artifactTeamGrant.deleteMany({ where: { artifactId: artifact.id } });
        else await db.account.update({ where: { id: owner.id }, data: { encryptionMode: 'e2ee' } });
        changed = true;
    };
    try {
        const page = await listWorkflowRuns(request);
        expect(changed).toBe(true);
        expect(new Set(page.runs.map(run => run.id))).toEqual(new Set(runIds));
        expect(page.nextCursor).toBeUndefined();
        expect(Object.values(page.keyCensusByRunId).every(census => census.encryptionMode === 'plain')).toBe(true);
        expect(laterAuthorityReads).toEqual([]);
        changed = false;
        if (change === 'grant') expect((await listWorkflowRuns(request)).runs).toEqual([]);
        else await expect(listWorkflowRuns(request)).rejects.toMatchObject({ code: 'content_unavailable' });
    } finally { nativeTransactions.afterCommit = undefined; stop(); }
});

it.each([undefined, "membership"] as const)("keeps %s exact list continuation across native capture batches", async projection => {
    const owner = await db.account.create({ data: { encryptionMode: "plain" } });
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, metadata: "test" } });
    const runIds = Array.from({ length: 129 }, () => crypto.randomUUID());
    await db.automationRun.createMany({ data: runIds.map(id => ({
        id, accountId: owner.id, originKind: "direct", causeKind: null, state: "failed",
        scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: "pending",
        workflowAcceptedSnapshotEnvelope: "malformed retained content",
    })) });
    await db.automationRunAssignment.createMany({ data: runIds.map(runId => ({ runId, machineId: machine.id, priority: 0 })) });
    const request = { accountId: owner.id, runIds, pageByteLimit: 1_000_000,
        attention: "required" as const, ...(projection ? { projection } : {}) };
    const materializationLeases: number[] = [];
    const debug = vi.spyOn(logger, "debug").mockImplementation(record => {
        if (record !== null && typeof record === "object" && "phase" in record
            && record.phase === "workflow.list.materialize") materializationLeases.push(nativeTransactions.leases);
    });
    try {
        const whole = await listWorkflowRuns(request);
        const first = await listWorkflowRuns({ ...request, limit: 128 });
        const second = await listWorkflowRuns({ ...request, cursor: first.nextCursor });
        expect(whole.runs).toHaveLength(129);
        expect(first.runs).toHaveLength(128);
        expect(second.runs).toHaveLength(1);
        expect(second.nextCursor).toBeUndefined();
        expect([...first.runs, ...second.runs]).toEqual(whole.runs);
        expect(new Set(whole.runs.map(run => run.id))).toEqual(new Set(runIds));
        expect(Object.values(whole.acceptedEnvelopesByRunId)).toEqual(projection ? [] : Array.from({ length: 129 }, () => null));
        // Whole-page capture crosses the native batch boundary; both CPU phases
        // must release it, as must each of the two separately continued pages.
        expect(materializationLeases).toEqual([0, 0, 0, 0]);
        await expect(listWorkflowRuns({ ...request, cursor: first.nextCursor,
            projection: projection ? undefined : "membership" })).rejects.toMatchObject({ code: "invalid_input" });
    } finally { debug.mockRestore(); }
});

it("pages only selected parent histories through SQLite JSON membership, retaining retry history and cursor scope", async () => {
    const owner = await db.account.create({ data: { encryptionMode: "plain" } });
    const runId = crypto.randomUUID();
    const rootId = crypto.randomUUID();
    const firstParentId = crypto.randomUUID();
    const secondParentId = crypto.randomUUID();
    const firstReply = crypto.randomUUID();
    const secondReply = crypto.randomUUID();
    const retriedReply = crypto.randomUUID();
    await db.automationRun.create({ data: { id: runId, accountId: owner.id, originKind: "direct", causeKind: null,
        state: "running", scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: "pending",
        workflowAcceptedSnapshotEnvelope: "unopened accepted" } });
    const rows = [[rootId, null, 0], [firstParentId, rootId, 1], [secondParentId, rootId, 2],
        [firstReply, firstParentId, 3], [secondReply, secondParentId, 4], [retriedReply, firstParentId, 5]] as const;
    const envelopes = new Map<string, string>();
    for (const [id, parentRecordId, sequence] of rows) {
        const attempt = id === retriedReply ? 1 : 0;
        const memberOrdinal = id === secondParentId ? 1 : 0;
        const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
            mode: "plain", binding: { v: 1, purpose: "invocation_progress", accountId: owner.id, runId,
                recordId: id, sequence: String(sequence), parentRecordId, memberOrdinal: String(memberOrdinal), attempt: String(attempt) },
            progress: { kind: "happier.workflow-progress.v1", invocationPath: { blockId: sequence === 0 ? "$root" : "work", scope: [] },
                blockKind: sequence === 0 ? "root" : "step", attempt: String(attempt), logicalInvocationRecordId: attempt ? firstReply : id,
                ...(attempt ? { previousAttemptRecordId: firstReply } : {}) },
        }));
        envelopes.set(id, contentEnvelope);
        await db.workflowRunInvocation.create({ data: { id, runId, parentRecordId, sequence: BigInt(sequence),
            memberOrdinal: BigInt(memberOrdinal), attempt: BigInt(attempt), lifecycle: id === firstReply ? "superseded" : "completed", contentEnvelope } });
    }
    const request = { accountId: owner.id, runId, parentRecordIds: [secondParentId, firstParentId],
        limit: 1, progressEnvelopes: true as const, pageByteLimit: 1_000_000 };
    const first = await listWorkflowRunInvocations(request);
    const second = await listWorkflowRunInvocations({ ...request, parentRecordIds: [...request.parentRecordIds].reverse(), cursor: first.nextCursor });
    const third = await listWorkflowRunInvocations({ ...request, cursor: second.nextCursor });
    expect([first, second, third].flatMap(page => page.invocations.map(row => row.id))).toEqual([firstReply, secondReply, retriedReply]);
    expect(first.progressEnvelopesByInvocationId).toEqual({ [firstReply]: envelopes.get(firstReply) });
    expect(third.nextCursor).toBeUndefined();
    await expect(listWorkflowRunInvocations({ ...request, parentRecordIds: [firstParentId], cursor: first.nextCursor }))
        .rejects.toMatchObject({ code: "invalid_input" });
    expect((await listWorkflowRunInvocations({ ...request, parentRecordIds: ["absent"] })).invocations).toEqual([]);
    const current = await listWorkflowRunInvocations({ ...request, parentRecordIds: undefined,
        parentRecordId: firstParentId, memberOrdinal: "0" });
    expect(current.invocations.map(row => row.id)).toEqual([retriedReply]);
});
