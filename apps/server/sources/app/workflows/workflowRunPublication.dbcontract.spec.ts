import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as workflowStorage from "./workflowRunService";
import * as privacyKit from "privacy-kit";
import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    AutomationRunCauseSchema,
    encodePlainArtifactStoredContent,
    deriveAutomationOccurrenceKeyV1,
    serializeAutomationStoredWorkflowDefinitionRecipeV2,
} from "@happier-dev/protocol";
import { db, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { encodeAutomationRunCause } from "@/app/automations/automationRunCauseCodec";
import { automationAccountCurrentnessSelect, deriveAutomationAccountCurrentnessWitness } from "@/app/automations/automationAccountCurrentness";
import { materializeWorkflowAcceptedSnapshotFixture } from "@/testkit/workflowAcceptedSnapshot";
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from "@happier-dev/protocol/workflows";
import { admitWorkflowRun, cancelWorkflowRun, commitWorkflowInvocationFact } from "./workflowRunService";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { observeLazyPrismaQuery } from "@/app/changes/accountPublicationContention.testkit";
import { cancelAutomationRun } from "@/app/automations/automationRunService";
import { revokeMachineInTx } from "@/app/machines/machineMutations";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { encodeAutomationSessionLifecycleConfiguration } from "@/app/automations/automationSessionLifecycleConfigurationCodec";
import { updateAutomationTrigger } from "@/app/automations/automationCrudService";
import { workflowRunAttentionSql, workflowRunAttentionWhere, workflowRunSqlIdentifier } from './workflowRunAttention';
import { prismaRuntime } from '@/storage/prisma';

const provider = process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres";

function sqlState(error: unknown): string | null {
    if (error === null || typeof error !== "object" || !("meta" in error)) return null;
    const meta = error.meta;
    return meta !== null && typeof meta === "object" && "code" in meta && typeof meta.code === "string"
        ? meta.code : null;
}

function accountLockRows(query: string, result: unknown): string[] {
    if (!query.includes('FROM "Account"') || !query.includes("FOR ") || !Array.isArray(result)) return [];
    return result.flatMap(row => row !== null && typeof row === "object" && "id" in row && typeof row.id === "string"
        ? [row.id] : []);
}

describe.skipIf(provider !== "postgres" && provider !== "postgresql")("Workflow ordered publication (real PostgreSQL)", () => {
    const accountIds: string[] = [];
    const teamIds: string[] = [];
    let connected = false;
    let restoreTransport: (() => void) | null = null;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("Missing disposable DATABASE_URL for Workflow DB contract");
        initDbPostgres();
        await db.$connect();
        connected = true;
    });

    afterEach(async () => {
        restoreTransport?.();
        restoreTransport = null;
        vi.unstubAllEnvs();
        await db.automationTrigger.deleteMany({ where: { automation: { accountId: { in: accountIds } } } });
        await db.automationRun.deleteMany({ where: { accountId: { in: accountIds } } });
        await db.automation.deleteMany({ where: { accountId: { in: accountIds } } });
        await db.artifact.deleteMany({ where: { accountId: { in: accountIds } } });
        await db.session.deleteMany({ where: { accountId: { in: accountIds } } });
        await db.team.deleteMany({ where: { id: { in: teamIds } } });
        await db.machine.deleteMany({ where: { accountId: { in: accountIds } } });
        await db.account.deleteMany({ where: { id: { in: accountIds } } });
        accountIds.length = 0;
        teamIds.length = 0;
    });

    afterAll(async () => { if (connected) await db.$disconnect(); });

    async function fixture() {
        const stem = `workflow-publication-${randomUUID()}`;
        const accounts = await Promise.all(["a", "b", "c", "0-review"].map(suffix => db.account.create({ data: {
            id: `${stem}-${suffix}`, publicKey: `${stem}-${suffix}`, encryptionMode: "plain",
        } })));
        accountIds.push(...accounts.map(account => account.id));
        const team = await db.team.create({ data: { name: stem } });
        teamIds.push(team.id);
        const runAudience = accounts.slice(0, 3);
        await db.teamMembership.createMany({ data: runAudience.map(account => ({ teamId: team.id, accountId: account.id, role: "member" })) });
        const recipe = serializeAutomationStoredWorkflowDefinitionRecipeV2({ v: 2, templateVersion: 1, triggerEvidence: null,
            workflow: { t: "plain", v: { workspace: { directory: "/repo" }, executionTarget: { kind: "session" },
                inlineDefinition: { version: 1, blocks: [{ kind: "action", id: "notice", actionId: "notifications.notify_me",
                    input: { message: { kind: "literal", value: "Run finished" } } }] } } } });
        if (recipe.kind !== "available") throw new Error("Workflow watcher recipe unavailable");
        const watcherMachine = await db.machine.create({ data: { id: randomUUID(), accountId: accounts[2].id, metadata: "{}" } });
        const watcher = await db.automation.create({ data: { accountId: accounts[2].id, name: stem, enabled: true,
            templateCiphertext: recipe.serialized, templateVersion: 1 } });
        await db.automationAssignment.create({ data: { automationId: watcher.id, machineId: watcherMachine.id, enabled: true } });
        // This independent review Run publishes only when it changes. Admission
        // of another occurrence must not republish its historical Session origin.
        const reviewSession = await db.session.create({ data: { accountId: accounts[2].id, tag: randomUUID(), encryptionMode: "plain", metadata: "{}" } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: reviewSession.id, createdByAccountId: accounts[2].id,
            accountId: accounts[3].id, accessLevel: "view" } });
        const reviewTriggerId = randomUUID();
        const reviewOccurrence = { v: 1 as const, kind: "sessionLifecycle" as const, event: "parentTurnCompleted" as const,
            sourceSessionId: reviewSession.id, sourceTurnId: randomUUID(), occurredAt: Date.now() };
        const reviewRun = await db.automationRun.create({ data: { accountId: accounts[2].id, automationId: watcher.id, originKind: "automation",
            state: "queued", scheduledAt: new Date(), dueAt: new Date(),
            workflowCustodyState: "pending", workflowAcceptedSnapshotEnvelope: "{}",
            assignments: { create: { machineId: watcherMachine.id, priority: 0 } },
            ...encodeAutomationRunCause(AutomationRunCauseSchema.parse({ kind: "trigger", triggerKind: "sessionLifecycle",
                triggerId: reviewTriggerId, triggerRevision: 0, occurredAt: reviewOccurrence.occurredAt,
                occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId: reviewTriggerId, evidence: reviewOccurrence }),
                evidence: { event: reviewOccurrence.event, sourceSessionId: reviewSession.id, sourceTurnId: reviewOccurrence.sourceTurnId,
                    policy: { kind: "everyMatch" } } })) } });
        const sources = [];
        for (const owner of accounts.slice(0, 2)) {
            const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: "plain", metadata: "{}" } });
            const sourceMachine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: "{}" } });
            const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
                header: new Uint8Array(privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: "workflow-definition.v1" }))),
                body: new Uint8Array(privacyKit.decodeBase64(encodePlainArtifactStoredContent({}))),
                dataEncryptionKey: new Uint8Array(privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)) } });
            await db.artifactGrant.create({ data: { principalKind: 'team' as const, artifactId: artifact.id, teamId: team.id, accessLevel: "view", createdByAccountId: owner.id } });
            const run = await db.automationRun.create({ data: { id: randomUUID(), accountId: owner.id, originKind: "direct", causeKind: null,
                originSessionId: session.id, originDeliveryAckRevision: 0, sourceArtifactId: artifact.id, visibleTeamId: team.id,
                state: "queued", workflowCustodyState: "pending", workflowAcceptedSnapshotEnvelope: "{}",
                scheduledAt: new Date(), dueAt: new Date(), assignments: { create: { machineId: sourceMachine.id, priority: 0 } } } });
            const trigger = await db.automationTrigger.create({ data: { automationId: watcher.id, kind: "runLifecycle", enabled: true,
                sourceRunId: run.id, remainingOccurrences: 1, runLifecycleConfigurationJson: JSON.stringify({ kind: "runLifecycle",
                    source: { kind: "workflow_run", runId: run.id }, condition: "terminal" }) } });
            sources.push({ owner, session, artifact, run, trigger });
        }
        return { accounts, runAudience, watcher, reviewSession, reviewRun, sources };
    }

    it('keeps seen failures out of ORM and SQL attention across custody revisions with owner-only publication', async () => {
        const f = await fixture();
        const source = f.sources[0];
        const failedAt = new Date('2026-10-23T10:00:00.000Z');
        await db.automationRun.update({ where: { id: source.run.id }, data: { state: 'failed', startedAt: failedAt, finishedAt: failedAt, revision: 2 } });
        const membership = async (accountId: string) => {
            const orm = await db.automationRun.findMany({ where: { id: source.run.id, AND: [workflowRunAttentionWhere(accountId)] }, select: { id: true } });
            const id = workflowRunSqlIdentifier;
            const sql = await db.$queryRaw<Array<{ id: string }>>(prismaRuntime.sql`SELECT r.${id('id')} AS ${id('id')}
                FROM ${id('AutomationRun')} r WHERE r.${id('id')} = ${source.run.id} AND ${workflowRunAttentionSql(accountId)}`);
            expect(sql).toEqual(orm);
            return orm.length === 1;
        };
        expect(await membership(source.owner.id)).toBe(true);
        expect(await membership(f.accounts[2].id)).toBe(false);
        const before = await db.account.findMany({ where: { id: { in: f.runAudience.map(account => account.id) } }, select: { id: true, seq: true } });
        await workflowStorage.setWorkflowRunReadState({ accountId: source.owner.id, runId: source.run.id, revision: 2, failedAt: failedAt.toISOString() });
        const after = await db.account.findMany({ where: { id: { in: before.map(account => account.id) } }, select: { id: true, seq: true } });
        for (const account of after) expect(account.seq).toBe(before.find(row => row.id === account.id)!.seq + (account.id === source.owner.id ? 1 : 0));
        expect(await db.automationRun.count({ where: { automationId: f.watcher.id } })).toBe(1);
        await db.automationRun.update({ where: { id: source.run.id }, data: { revision: 3, workflowCustodyState: 'settled' } });
        expect(await membership(source.owner.id)).toBe(false);
        const summary = await workflowStorage.summarizeWorkflowRuns({ accountId: source.owner.id,
            sourceArtifactIds: [source.artifact.id], recent: 1, pageByteLimit: 1_000_000 });
        expect(summary.summaries[0]).toMatchObject({ needsYouCount: 0,
            lastRun: { failureUnseen: false, invocationAttentionRequired: false, attentionRequired: false } });
        await db.workflowRunInvocation.create({ data: { id: randomUUID(), runId: source.run.id,
            sequence: 0n, memberOrdinal: 0n, lifecycle: 'waiting_for_review', contentEnvelope: '{}' } });
        expect(await membership(source.owner.id)).toBe(true);
        expect(await membership(f.accounts[2].id)).toBe(true);
    });

    it.each(["initialize", "allocate", "publish", "review", "transition", "pause", "resume", "cancel", "recover", "withdraw", "trigger-update", "automation-cancel", "exhaustion"] as const)(
        "%s storage commits while unrelated Account cursors advance", async operation => {
        const f = await fixture();
        const source = f.sources[0];
        const assignment = await db.automationRunAssignment.findFirstOrThrow({ where: { runId: source.run.id } });
        const accountCurrentness = deriveAutomationAccountCurrentnessWitness(await db.account.findUniqueOrThrow({
            where: { id: source.owner.id }, select: automationAccountCurrentnessSelect,
        }));
        if (!accountCurrentness) throw new Error("fixture Account currentness unavailable");
        const rootId = randomUUID();
        const leafId = randomUUID();
        const progress = (id: string, sequence: bigint, parentRecordId: string | null, attempt = 0n, result?: string) =>
            serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: "plain",
                binding: { v: 1, purpose: "invocation_progress", accountId: source.owner.id, runId: source.run.id,
                    recordId: id, sequence: String(sequence), parentRecordId, memberOrdinal: "0", attempt: String(attempt) },
                progress: { kind: "happier.workflow-progress.v1", invocationPath: { blockId: parentRecordId ? "answer" : "$root", scope: [] },
                    blockKind: parentRecordId ? "step" : "root", attempt: String(attempt),
                    logicalInvocationRecordId: attempt === 0n ? id : leafId,
                    ...(attempt === 0n ? {} : { previousAttemptRecordId: leafId }),
                    ...(result === undefined ? {} : { result }) },
            }));
        const checkpoint = (nextSequence: number) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
            mode: "plain", binding: { v: 1, purpose: "checkpoint", accountId: source.owner.id, runId: source.run.id },
            checkpoint: { kind: "happier.workflow-checkpoint.v1", rootRecordId: rootId, nextSequence: String(nextSequence),
                frontier: { nextBlockOrdinal: nextSequence, paused: false } },
        }));
        const state = operation === "recover" ? "interrupted"
            : ["resume", "withdraw", "cancel", "automation-cancel"].includes(operation) ? "paused" : "running";
        await db.automationRun.update({ where: { id: source.run.id }, data: {
            state, claimedByMachineId: assignment.machineId, attempt: 1,
            workflowCheckpointEnvelope: operation === "initialize" ? null : checkpoint(2),
        } });
        if (operation !== "initialize") {
            await db.workflowRunInvocation.create({ data: { id: rootId, runId: source.run.id, sequence: 0n,
                parentRecordId: null, memberOrdinal: 0n, attempt: 0n, lifecycle: "running", contentEnvelope: progress(rootId, 0n, null) } });
            if (operation !== "allocate") await db.workflowRunInvocation.create({ data: {
                id: leafId, runId: source.run.id, sequence: 1n, parentRecordId: rootId, memberOrdinal: 0n, attempt: 0n,
                lifecycle: operation === "recover" ? "failed" : operation === "review" ? "waiting_for_review" : operation === "withdraw" ? "admitting" : "running",
                contentEnvelope: progress(leafId, 1n, rootId),
            } });
        }
        if (operation === "automation-cancel") {
            const automation = await db.automation.create({ data: { accountId: source.owner.id, name: "Cancellation under publication",
                enabled: true, templateCiphertext: f.watcher.templateCiphertext, templateVersion: 1 } });
            await db.automationRun.update({ where: { id: source.run.id }, data: { automationId: automation.id, originKind: "automation",
                ...encodeAutomationRunCause(AutomationRunCauseSchema.parse({ kind: "manual", invokedAt: Date.now() })) } });
        }
        const originalTransaction = db.$transaction.bind(db);
        const conflicts: string[] = [];
        let publications = 0;
        let publishingPeer = false;
        // A real concurrent publisher advances Account.seq after the snapshot's
        // audience read and before its first ordered Account lock on every attempt.
        // All storage decisions, locks, CAS predicates and watcher owners stay real.
        const interleaved = async (body: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof originalTransaction>[1]) =>
            publishingPeer ? originalTransaction(body, options) : originalTransaction(async tx => {
                let advanced = false;
                return body(new Proxy(tx, { get(target, property, receiver) {
                    if (property !== "$queryRawUnsafe") return Reflect.get(target, property, receiver);
                    return (query: string, ...values: unknown[]) => observeLazyPrismaQuery(target.$queryRawUnsafe(query, ...values), () => ({
                        started() {},
                        settled(succeeded, error) { if (!succeeded) { const state = sqlState(error); if (state) conflicts.push(state); } },
                    }), async () => {
                        if (!advanced && query.includes('FROM "Account"') && query.includes("FOR ")) {
                            advanced = true;
                            publishingPeer = true;
                            try {
                                await inTx(cursorTx => markAccountChanged(cursorTx, {
                                    accountId: source.owner.id, kind: "account", entityId: "unrelated-storage-publication",
                                }));
                            } finally { publishingPeer = false; }
                            publications++;
                        }
                    });
                } }));
            }, operation === "exhaustion" ? { ...options, isolationLevel: "Serializable" } : options);
        db.$transaction = interleaved as typeof db.$transaction;
        restoreTransport = () => { db.$transaction = originalTransaction; };
        const worker = { accountId: source.owner.id, runId: source.run.id, machineId: assignment.machineId,
            parentAttempt: 1, expectedRevision: 0, accountCurrentness };
        const review = { ...worker, invocationId: leafId, invocationAttempt: 0n,
            expectedContentRevision: 0n, contentEnvelope: progress(leafId, 1n, rootId) };
        const replacementId = randomUUID();
        switch (operation) {
            case "initialize":
                expect(await workflowStorage.initializeWorkflowRunExecution({ ...worker, checkpointEnvelope: checkpoint(1),
                    rootInvocation: { id: rootId, contentEnvelope: progress(rootId, 0n, null) } })).toMatchObject({ initialization: "created" });
                break;
            case "allocate":
                expect(await workflowStorage.admitWorkflowInvocations({ ...worker, checkpointEnvelope: checkpoint(3), invocations: [0n, 1n].map(ordinal => {
                    const id = randomUUID();
                    const sequence = ordinal + 1n;
                    return { id, sequence, parentRecordId: rootId, memberOrdinal: ordinal,
                        contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: "plain",
                            binding: { v: 1, purpose: "invocation_progress", accountId: source.owner.id, runId: source.run.id,
                                recordId: id, sequence: String(sequence), parentRecordId: rootId, memberOrdinal: String(ordinal), attempt: "0" },
                            progress: { kind: "happier.workflow-progress.v1", invocationPath: { blockId: `role-${ordinal}`, scope: [] },
                                blockKind: "step", attempt: "0", logicalInvocationRecordId: id } })) };
                }) })).toMatchObject({ disposition: "created", invocations: [{ sequence: "1" }, { sequence: "2" }] });
                break;
            case "publish":
                expect(await workflowStorage.publishWorkflowInvocationDraft({ ...review,
                    contentEnvelope: progress(leafId, 1n, rootId, 0n, "Updated role result") }))
                    .toMatchObject({ invocation: { index: { contentRevision: "1" } } });
                break;
            case "review":
                expect(await workflowStorage.completeWorkflowInvocationReview({ ...review, mode: "use_result" }))
                    .toMatchObject({ disposition: "completed", invocation: { index: { lifecycle: "completed" } } });
                break;
            case "transition":
                expect(await workflowStorage.transitionWorkflowRun({ ...worker, state: "interrupted", checkpointEnvelope: checkpoint(2) }))
                    .toMatchObject({ state: "interrupted", revision: 1 });
                break;
            case "pause": expect(await workflowStorage.pauseWorkflowRun(worker)).toMatchObject({ run: { state: "pause_requested" } }); break;
            case "resume": expect(await workflowStorage.resumeWorkflowRunBoundary(worker)).toMatchObject({ run: { state: "queued" } }); break;
            case "cancel": expect(await workflowStorage.cancelWorkflowRun(worker)).toMatchObject({ run: { state: "cancelled" } }); break;
            case "recover":
                expect(await workflowStorage.recoverWorkflowInvocations({ ...worker, checkpointEnvelope: checkpoint(3), recoveries: [{
                    invocationId: leafId, newInvocationId: replacementId, contentEnvelope: progress(replacementId, 2n, rootId, 1n),
                }] })).toMatchObject({ disposition: "accepted", invocations: [{ attempt: "1" }] });
                break;
            case "withdraw":
                expect(await workflowStorage.recordWorkflowRunOriginInputWithdrawn({ ...worker, originSessionId: source.session.id,
                    invocationRecordId: leafId })).toMatchObject({ index: { lifecycle: "pending" } });
                break;
            case "trigger-update":
                await updateAutomationTrigger({ accountId: f.accounts[2].id, automationId: f.watcher.id,
                    triggerId: source.trigger.id, expectedRevision: 0, enabled: false });
                expect(await db.automationTrigger.findUniqueOrThrow({ where: { id: source.trigger.id } })).toMatchObject({ enabled: false });
                break;
            case "automation-cancel":
                await cancelAutomationRun({ accountId: source.owner.id, runId: source.run.id });
                expect(await db.automationRun.findUniqueOrThrow({ where: { id: source.run.id } })).toMatchObject({ state: "cancelled" });
                break;
            case "exhaustion": {
                const { registerWorkflowRunStorageRoutes } = await import("@/app/api/routes/automations/registerWorkflowRunStorageRoutes");
                const app = createAuthenticatedTestApp();
                registerWorkflowRunStorageRoutes(app);
                await app.ready();
                try {
                    const response = await app.inject({ method: "POST", url: "/v3/automations/runs/workflow-storage",
                        headers: { "x-test-user-id": source.owner.id },
                        payload: { operation: "pause", runId: source.run.id, expectedRevision: 0 } });
                    expect(response.statusCode, response.body).toBe(503);
                    expect(response.json()).toEqual({ error: "database_transaction_conflict_exhausted" });
                    expect(conflicts.length).toBeGreaterThan(0);
                    expect(await db.automationRun.findUniqueOrThrow({ where: { id: source.run.id } })).toMatchObject({ state, revision: 0 });
                } finally { await app.close(); }
                break;
            }
        }
        expect(publications).toBeGreaterThan(0);
        if (operation !== "exhaustion") expect(conflicts).toEqual([]);
    });

    it("commits an invocation fact after an unrelated Account cursor write without serialization rollback", async () => {
        const f = await fixture();
        const source = f.sources[0];
        const assignment = await db.automationRunAssignment.findFirstOrThrow({ where: { runId: source.run.id } });
        await db.automationRun.update({ where: { id: source.run.id }, data: {
            state: "running", claimedByMachineId: assignment.machineId, attempt: 1,
        } });
        const accountCurrentness = deriveAutomationAccountCurrentnessWitness(await db.account.findUniqueOrThrow({
            where: { id: source.owner.id }, select: automationAccountCurrentnessSelect,
        }));
        if (!accountCurrentness) throw new Error("fixture Account currentness unavailable");
        const invocationId = randomUUID();
        const envelope = (result?: string) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
            mode: "plain", binding: { v: 1, purpose: "invocation_progress", accountId: source.owner.id,
                runId: source.run.id, recordId: invocationId, sequence: "0", parentRecordId: null, memberOrdinal: "0", attempt: "0" },
            progress: { kind: "happier.workflow-progress.v1", invocationPath: { blockId: "$root", scope: [] },
                blockKind: "root", attempt: "0", logicalInvocationRecordId: invocationId,
                ...(result === undefined ? {} : { result }) },
        }));
        await db.workflowRunInvocation.create({ data: { id: invocationId, runId: source.run.id, sequence: 0n,
            parentRecordId: null, memberOrdinal: 0n, attempt: 0n, lifecycle: "running", contentEnvelope: envelope() } });
        const originalTransaction = db.$transaction.bind(db);
        const conflicts: string[] = [];
        let publishingPeer = false;
        // Interleave at the real Prisma boundary, after the audience read has
        // established a snapshot but before its first Account lock. Cursor
        // publication and all Workflow internals execute their real owners.
        const interleaved = async (operation: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof originalTransaction>[1]) => {
            if (publishingPeer) return originalTransaction(operation, options);
            return originalTransaction(async tx => {
                let advanced = false;
                const boundary = new Proxy(tx, { get(target, property, receiver) {
                    if (property !== "$queryRawUnsafe") return Reflect.get(target, property, receiver);
                    return (query: string, ...values: unknown[]) => observeLazyPrismaQuery(target.$queryRawUnsafe(query, ...values), () => ({
                        started() {},
                        settled(succeeded, error) { if (!succeeded) { const state = sqlState(error); if (state) conflicts.push(state); } },
                    }), async () => {
                        if (!advanced && query.includes('FROM "Account"') && query.includes("FOR ")) {
                            advanced = true;
                            publishingPeer = true;
                            try {
                                await inTx(cursorTx => markAccountChanged(cursorTx, {
                                    accountId: source.owner.id, kind: "account", entityId: "unrelated-cursor-publication",
                                }));
                            } finally { publishingPeer = false; }
                        }
                    });
                } });
                return operation(boundary);
            }, options);
        };
        db.$transaction = interleaved as typeof db.$transaction;
        restoreTransport = () => { db.$transaction = originalTransaction; };
        const contentEnvelope = envelope("first leaf input prepared");
        await expect(commitWorkflowInvocationFact({ accountId: source.owner.id, runId: source.run.id,
            machineId: assignment.machineId, invocationId, invocationAttempt: 0n, expectedContentRevision: 0n,
            expectedLifecycle: "running", lifecycle: "running", contentEnvelope, parentAttempt: 1, accountCurrentness,
        })).resolves.toMatchObject({ contentRevision: "1", parentRevision: source.run.revision });
        expect(conflicts).toEqual([]);
        expect(await db.workflowRunInvocation.findUniqueOrThrow({ where: { id: invocationId } }))
            .toMatchObject({ contentEnvelope, contentRevision: 1n, lifecycle: "running" });
    });

    it.each(["session", "run"] as const)("creates and rejoins a %s trigger set while unrelated Account cursors advance", async kind => {
        const { registerAutomationV3Routes } = await import("@/app/api/routes/automations/registerAutomationV3Routes");
        const f = await fixture();
        const source = f.sources[kind === "session" ? 0 : 1];
        const assignment = await db.automationRunAssignment.findFirstOrThrow({ where: { runId: source.run.id } });
        const automationId = randomUUID();
        const payload = {
            automationId, name: "Current Workflow trigger", enabled: true,
            executionRecipe: JSON.parse(f.watcher.templateCiphertext),
            assignments: [{ machineId: assignment.machineId }],
            ...(kind === "session" ? { scopeSessionId: source.session.id, workflowDefinitionId: "builtin:keep-going" } : {}),
            triggers: [{ triggerId: randomUUID(), trigger: kind === "session"
                ? { kind: "sessionLifecycle", enabled: true, sourceSessionId: source.session.id,
                    events: ["parentTurnCompleted"], policy: { kind: "everyMatch" } }
                : { kind: "runLifecycle", enabled: true, source: { kind: "workflow_run", runId: f.sources[0].run.id },
                    condition: "terminal" } }],
        };
        const originalTransaction = db.$transaction.bind(db);
        const conflicts: string[] = [];
        let publishingPeer = false;
        // Real cursor publication lands after audience discovery, before the
        // first ordered Account lock, on every attempt. No internal owner is
        // replaced: HTTP admission, mode/access fences and storage stay real.
        const interleaved = async (operation: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof originalTransaction>[1]) => {
            if (publishingPeer) return originalTransaction(operation, options);
            return originalTransaction(async tx => {
                let advanced = false;
                return operation(new Proxy(tx, { get(target, property, receiver) {
                    if (property !== "$queryRawUnsafe") return Reflect.get(target, property, receiver);
                    return (query: string, ...values: unknown[]) => observeLazyPrismaQuery(target.$queryRawUnsafe(query, ...values), () => ({
                        started() {},
                        settled(succeeded, error) { if (!succeeded) { const state = sqlState(error); if (state) conflicts.push(state); } },
                    }), async () => {
                        if (!advanced && query.includes('FROM "Account"') && query.includes("FOR ")) {
                            advanced = true;
                            publishingPeer = true;
                            try {
                                await inTx(cursorTx => markAccountChanged(cursorTx, {
                                    accountId: source.owner.id, kind: "account", entityId: "unrelated-create-publication",
                                }));
                            } finally { publishingPeer = false; }
                        }
                    });
                } }));
            }, options);
        };
        db.$transaction = interleaved as typeof db.$transaction;
        restoreTransport = () => { db.$transaction = originalTransaction; };
        const app = createAuthenticatedTestApp();
        registerAutomationV3Routes(app);
        await app.ready();
        try {
            for (let repeat = 0; repeat < 2; repeat++) {
                const response = await app.inject({ method: "POST", url: "/v3/automations",
                    headers: { "x-test-user-id": source.owner.id }, payload });
                expect({ statusCode: response.statusCode, conflicts }).toEqual({ statusCode: 200, conflicts: [] });
                expect(response.json()).toMatchObject({ id: automationId, templateVersion: 1 });
            }
            expect(await db.automation.count({ where: { id: automationId } })).toBe(1);
            expect(await db.automationTrigger.count({ where: { automationId } })).toBe(1);
            const conflicting = await app.inject({ method: "POST", url: "/v3/automations",
                headers: { "x-test-user-id": source.owner.id }, payload: { ...payload, name: "Different request" } });
            expect(conflicting.statusCode).toBe(409);
        } finally { await app.close(); }
    });

    it("reciprocal shared Run cancellation commits with current mode fences, origin hints and watcher admission without a physical deadlock", async () => {
        const f = await fixture();
        const owners = f.sources.map(source => source.owner.id);
        const heldOwners = new Set<string>();
        const deadlocks: string[] = [];
        let releaseOwners!: () => void;
        const bothOwnersHeld = new Promise<void>(resolve => { releaseOwners = resolve; });
        const originalTransaction = db.$transaction.bind(db);
        let attempts = 0;
        // This adapter interleaves only real database locks. All admission,
        // mode fencing, publication and lifecycle owners execute unchanged.
        const interleaved = async (operation: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof originalTransaction>[1]) => {
            const attempt = attempts++;
            return originalTransaction(async tx => {
                const locked = new Set<string>();
                const boundary = new Proxy(tx, { get(target, property, receiver) {
                    if (property !== "$queryRawUnsafe") return Reflect.get(target, property, receiver);
                    return async (query: string, ...values: unknown[]) => {
                        try {
                            const result = await target.$queryRawUnsafe(query, ...values);
                            for (const id of accountLockRows(query, result)) locked.add(id);
                            if (attempt < 2 && owners.some(id => locked.has(id)) && !owners.every(id => locked.has(id))) {
                                for (const id of owners) if (locked.has(id)) heldOwners.add(id);
                                if (heldOwners.size === owners.length) releaseOwners();
                                await bothOwnersHeld;
                            }
                            return result;
                        } catch (error) {
                            if (sqlState(error) === "40P01") deadlocks.push("40P01");
                            throw error;
                        }
                    };
                } });
                return operation(boundary);
            }, { ...options, isolationLevel: "ReadCommitted" });
        };
        // Prisma overloads share this one interactive transport at this boundary.
        db.$transaction = interleaved as typeof db.$transaction;
        restoreTransport = () => { db.$transaction = originalTransaction; };
        const outcomes = await Promise.allSettled(f.sources.map(source => cancelWorkflowRun({
            accountId: source.owner.id, runId: source.run.id, expectedRevision: 0,
        })));
        expect(deadlocks).toEqual([]);
        for (const outcome of outcomes) {
            if (outcome.status === "rejected") throw outcome.reason;
            expect(outcome.value.run.state).toBe("cancelled");
        }
        for (const source of f.sources) {
            expect(await db.accountChange.findMany({ where: { entityId: `workflow-run:${source.run.id}` },
                orderBy: { accountId: "asc" }, select: { accountId: true } })).toEqual(f.runAudience.map(account => ({ accountId: account.id })));
            expect(await db.accountChange.findUniqueOrThrow({ where: { accountId_kind_entityId: {
                accountId: source.owner.id, kind: "session", entityId: source.session.id,
            } }, select: { hint: true } })).toMatchObject({ hint: { kind: "workflow-run-delivery", runId: source.run.id } });
            expect((await db.automationTrigger.findUniqueOrThrow({ where: { id: source.trigger.id } })).remainingOccurrences).toBe(0);
            expect(await db.automationRun.count({ where: { triggerId: source.trigger.id } })).toBe(1);
        }
        expect(await db.accountChange.findUnique({ where: { accountId_kind_entityId: {
            accountId: f.accounts[3].id, kind: "session", entityId: f.reviewSession.id,
        } }, select: { accountId: true } })).toBeNull();
    });

    it.each(["existing", "new", "review", "automation", "machine", "archive", "registration"] as const)("%s publication waits for the lower Account before acquiring the owner's mode fence", async kind => {
        const f = await fixture();
        const [, owner, watcher] = f.accounts;
        const lower = kind === "review" || kind === "archive" ? f.accounts[3] : f.accounts[0];
        const source = f.sources[1];
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: "{}" } });
        if (kind === "machine") {
            await db.automationRunAssignment.deleteMany({ where: { runId: source.run.id } });
            await db.automationRunAssignment.create({ data: { runId: source.run.id, machineId: machine.id, priority: 0 } });
        }
        if (kind === "automation") {
            const automation = await db.automation.create({ data: { accountId: owner.id, name: "Workflow cancellation", enabled: true,
                templateCiphertext: f.watcher.templateCiphertext, templateVersion: 1 } });
            await db.automationRun.update({ where: { id: source.run.id }, data: { automationId: automation.id, originKind: "automation",
                ...encodeAutomationRunCause(AutomationRunCauseSchema.parse({ kind: "manual", invokedAt: Date.now() })) } });
        }
        const archiveSession = kind === "archive" ? await db.session.create({ data: {
            accountId: watcher.id, tag: randomUUID(), encryptionMode: "plain", metadata: "{}", active: false,
        } }) : null;
        if (archiveSession) {
            await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: archiveSession.id, createdByAccountId: watcher.id,
                accountId: lower.id, accessLevel: "view" } });
            await db.automationTrigger.create({ data: { automationId: f.watcher.id, kind: "sessionLifecycle", enabled: true,
                ...encodeAutomationSessionLifecycleConfiguration({ kind: "sessionLifecycle", sourceSessionId: archiveSession.id,
                    events: ["sessionArchived"], policy: { kind: "everyMatch" } }) } });
        }
        const app = archiveSession ? createAuthenticatedTestApp() : null;
        if (app) {
            const { registerSessionArchiveRoutes } = await import("@/app/api/routes/session/registerSessionArchiveRoutes");
            registerSessionArchiveRoutes(app);
            await app.ready();
        }
        const runId = randomUUID();
        const currentness = deriveAutomationAccountCurrentnessWitness(await db.account.findUniqueOrThrow({
            where: { id: owner.id }, select: automationAccountCurrentnessSelect,
        }));
        if (!currentness) throw new Error("Plain fixture Account currentness unavailable");
        const acceptedEnvelope = kind === "new" ? serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
            mode: "plain", binding: { v: 1, purpose: "accepted_snapshot", accountId: owner.id, runId },
            acceptedSnapshot: await materializeWorkflowAcceptedSnapshotFixture({ definition: { version: 1, inputs: [], defaults: {},
                blocks: [{ kind: "wait", id: "answer", document: { text: "Answer", references: [], attachments: [] }, result: { kind: "text" } }] },
                context: { source: { kind: "inline", sourceArtifactId: source.artifact.id }, inputs: {}, machineId: machine.id,
                    executionTarget: { kind: "session" }, workspaceTarget: { project: { machineId: machine.id, directory: "/repo", checkoutRootPath: "/repo" } },
                    origin: { kind: "direct", originSessionId: source.session.id }, authorization: { principal: { kind: "host" } } } }),
        })) : null;
        let release!: () => void;
        const mayCommit = new Promise<void>(resolve => { release = resolve; });
        let ready!: () => void;
        const holderReady = new Promise<void>(resolve => { ready = resolve; });
        const holder = inTx(async tx => {
            await tx.$queryRawUnsafe('SELECT "id" FROM "Account" WHERE "id" = $1 FOR UPDATE', lower.id);
            ready();
            await mayCommit;
        }, { isolationLevel: "ReadCommitted" });
        const holderOutcome = Promise.allSettled([holder]);
        await holderReady;
        let pid = -1;
        const originalTransaction = db.$transaction.bind(db);
        const observed = async (operation: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof originalTransaction>[1]) =>
            originalTransaction(async tx => {
                const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid");
                pid = row.pid;
                return operation(tx);
            }, { ...options, isolationLevel: "ReadCommitted" });
        // Observe the real interactive database boundary without replacing owners.
        db.$transaction = observed as typeof db.$transaction;
        restoreTransport = () => { db.$transaction = originalTransaction; };
        let finished = false;
        const mutation = kind === "new" && acceptedEnvelope !== null
            ? admitWorkflowRun({ accountId: owner.id, runId, machineId: machine.id, accountCurrentness: currentness,
                acceptedEnvelope, sourceArtifactId: source.run.sourceArtifactId, visibleTeamId: source.run.visibleTeamId,
                origin: { kind: "direct", originSessionId: source.session.id } })
            : kind === "automation"
                ? cancelAutomationRun({ accountId: owner.id, runId: source.run.id })
                : kind === "machine"
                    ? inTx(tx => revokeMachineInTx(tx, { accountId: owner.id, machineId: machine.id }), { isolationLevel: "ReadCommitted" })
                : app && archiveSession
                    ? app.inject({ method: "POST", url: `/v2/sessions/${archiveSession.id}/archive`, headers: { "x-test-user-id": watcher.id } })
                : kind === "registration"
                    ? updateAutomationTrigger({ accountId: watcher.id, automationId: f.watcher.id,
                        triggerId: source.trigger.id, expectedRevision: 0, enabled: true })
                : kind === "review"
                    ? cancelWorkflowRun({ accountId: watcher.id, runId: f.reviewRun.id, expectedRevision: 0 })
                : cancelWorkflowRun({ accountId: owner.id, runId: source.run.id, expectedRevision: 0 });
        const mutationOutcome = Promise.allSettled([mutation]).finally(() => { finished = true; });
        try {
            while (!finished) {
                const [row] = await db.$queryRawUnsafe<{ waiting: boolean }[]>(
                    "SELECT cardinality(pg_blocking_pids($1::int)) > 0 AS waiting", pid);
                if (row.waiting) break;
            }
            expect(finished).toBe(false);
            restoreTransport();
            await expect(inTx(tx => tx.$queryRawUnsafe<{ id: string }[]>(
                'SELECT "id" FROM "Account" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR UPDATE NOWAIT', [owner.id, watcher.id],
            ), { isolationLevel: "ReadCommitted" })).resolves.toEqual([owner, watcher].map(account => ({ id: account.id })));
            if (archiveSession) {
                await expect(inTx(tx => tx.$queryRawUnsafe<{ id: string }[]>(
                    'SELECT "id" FROM "Session" WHERE "id" = $1 FOR NO KEY UPDATE NOWAIT', archiveSession.id,
                ), { isolationLevel: "ReadCommitted" })).resolves.toEqual([{ id: archiveSession.id }]);
            } else if (kind !== "new") {
                const mutatedRunId = kind === "review" ? f.reviewRun.id : source.run.id;
                await expect(inTx(tx => tx.$queryRawUnsafe<{ id: string }[]>(
                    'SELECT "id" FROM "AutomationRun" WHERE "id" = $1 FOR NO KEY UPDATE NOWAIT', mutatedRunId,
                ), { isolationLevel: "ReadCommitted" })).resolves.toEqual([{ id: mutatedRunId }]);
            }
        } finally {
            release();
            const outcomes = [...await holderOutcome, ...await mutationOutcome];
            await app?.close();
            for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
            if (kind === "archive") {
                expect(outcomes[1]).toMatchObject({ status: "fulfilled", value: { statusCode: 200 } });
            }
        }
    });
});
