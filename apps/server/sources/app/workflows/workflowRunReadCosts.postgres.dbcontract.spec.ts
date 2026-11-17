import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { measureExternalActionResultResponseEnvelopeUtf8BytesV1, serializeAutomationStoredDefinitionExecutionRecipeV1, serializeAutomationStoredWorkflowDefinitionRecipeV2 } from "@happier-dev/protocol";
import { WorkflowRunInvocationIndexV1Schema } from "@happier-dev/protocol/workflows/workflowProgressV1";
import { openWorkflowProgressStoredEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from "@happier-dev/protocol/workflows";
import { AutomationRunState, AutomationTargetType, db, initDbPostgres } from "@/storage/db";
import { getAutomation } from "@/app/automations/automationCrudService";
import { observePrismaRequests } from "@/testkit/observeSqliteRequests";
import { encodeAutomationSessionLifecycleConfiguration } from "@/app/automations/automationSessionLifecycleConfigurationCodec";
import { encodeAutomationRunCause } from "@/app/automations/automationRunCauseCodec";
import { deriveAutomationOccurrenceKeyV1 } from "@happier-dev/protocol/automations/automationOccurrenceV1";
import { AutomationTriggerIdSchema } from "@happier-dev/protocol/automations/automationTriggerIdentity";
import { loadAutomationSessionLifecycleStatusProjections } from "@/app/automations/automationSessionLifecycleStatusProjection";
import { applySessionTurnMutation } from "@/app/session/sessionWriteService";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerWorkflowRunStorageRoutes } from "@/app/api/routes/automations/registerWorkflowRunStorageRoutes";
import { eventRouter } from "@/app/events/eventRouter";
import type { Socket } from 'socket.io';
import { createFakeSocket } from '@/app/api/testkit/socketHarness';
import { replayWorkflowRunMachineWakes } from './workflowRunMachineRouting';
import { inTx } from '@/storage/inTx';
import { tryClaimAutomationRunInTx } from '@/app/automations/automationRunClaim';
import { admitWorkflowInvocations, commitWorkflowInvocationFact, completeWorkflowInvocationReview, listWorkflowRunInvocations, listWorkflowRuns, listWorkflowRunsForRecovery, recordWorkflowRequesterCustodyUnavailable, summarizeWorkflowRuns } from "./workflowRunService";
import { createDbMaintenanceClient, onDbClientQuery, type PrismaClientType } from "@/storage/prisma";

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== "postgres")("Workflow narrow reads and publication costs (PostgreSQL)", () => {
    const statements: Prisma.QueryEvent[] = [];
    let client: PrismaClientType;
    let originalTransaction: typeof db.$transaction;
    let ownerId: string;
    let machineId: string;
    let runId: string;
    let rootId: string;
    let children: string[];
    let latestId: string;
    const envelopes = new Map<string, string>();

    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
        client = await createDbMaintenanceClient("postgres", undefined, { log: [{ emit: "event", level: "query" }] });
        onDbClientQuery(client, event => statements.push(event));
        await client.$connect();
        originalTransaction = db.$transaction;
        // Observe the real native SQL boundary; storage, policy, envelopes and
        // transaction admission remain production-owned.
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(client.$transaction, client, args);
        } });
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        ownerId = owner.id;
        machineId = randomUUID();
        runId = randomUUID();
        rootId = randomUUID();
        children = Array.from({ length: 500 }, () => randomUUID());
        latestId = randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: ownerId, metadata: "{}" } });
        await db.automationRun.create({ data: { id: runId, accountId: ownerId, originKind: "direct", causeKind: null,
            state: "running", workflowCustodyState: "pending", workflowAcceptedSnapshotEnvelope: "unopened-accepted",
            claimedByMachineId: machineId, attempt: 1, scheduledAt: new Date(), dueAt: new Date(),
            assignments: { create: { machineId, priority: 0 } } } });
        const row = (id: string, sequence: number, ordinal: number, attempt = 0) => {
            const parentRecordId = sequence === 0 ? null : rootId;
            const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
                mode: "plain", binding: { v: 1, purpose: "invocation_progress", accountId: ownerId, runId,
                    recordId: id, sequence: String(sequence), parentRecordId, memberOrdinal: String(ordinal), attempt: String(attempt) },
                progress: { kind: "happier.workflow-progress.v1", invocationPath: { blockId: sequence === 0 ? "$root" : "work", scope: [] },
                    blockKind: sequence === 0 ? "root" : "step", attempt: String(attempt),
                    logicalInvocationRecordId: attempt === 0 ? id : children[7]!,
                    ...(attempt === 0 ? {} : { previousAttemptRecordId: children[7]! }), result: "x".repeat(2048) },
            }));
            envelopes.set(id, contentEnvelope);
            return { id, runId, sequence: BigInt(sequence), parentRecordId, memberOrdinal: BigInt(ordinal),
                attempt: BigInt(attempt), lifecycle: "running" as const, contentEnvelope };
        };
        await db.workflowRunInvocation.createMany({ data: [row(rootId, 0, 0),
            ...children.map((id, index) => row(id, index + 1, index)), row(latestId, 501, 7, 1)] });
    });
    afterAll(async () => {
        if (originalTransaction) db.$transaction = originalTransaction;
        if (ownerId) {
            await db.automationRun.deleteMany({ where: { accountId: ownerId } });
            await db.machine.deleteMany({ where: { accountId: ownerId } });
            await db.account.delete({ where: { id: ownerId } });
        }
        await client?.$disconnect();
        await db.$disconnect();
    });

    it("filters known invocation revisions in PostgreSQL before paging or loading historical bodies", async () => {
        const indices = await db.workflowRunInvocation.findMany({ where: { runId }, select: { id: true, contentRevision: true } });
        const knownContentRevisions = Object.fromEntries(indices.filter(row => row.id !== latestId)
            .map(row => [row.id, row.id === children[7] ? "999" : row.contentRevision.toString()]));
        const request = { accountId: ownerId, runId, knownContentRevisions, limit: 1, pageByteLimit: 1_000_000 };
        statements.length = 0;
        const first = await listWorkflowRunInvocations(request);
        expect(first.invocations.map(row => row.id)).toEqual([children[7]]);
        expect(first.nextCursor).toEqual(expect.any(String));
        const second = await listWorkflowRunInvocations({ ...request, cursor: first.nextCursor });
        expect(second.invocations.map(row => row.id)).toEqual([latestId]);
        expect(second.nextCursor).toBeUndefined();
        const selects = statements.filter(event => /^SELECT\b/i.test(event.query.trimStart()) && event.query.includes('"WorkflowRunInvocation"'));
        expect(selects.some(event => event.query.includes('jsonb_to_recordset'))).toBe(true);
        expect(selects.every(event => !event.query.includes('"contentEnvelope"'))).toBe(true);
        const readCosts = costs();
        const selection = selects.find(event => event.query.includes('jsonb_to_recordset'))!;
        type PlanNode = { 'Node Type': string; 'Actual Rows': number; 'Actual Loops': number;
            'Rows Removed by Filter'?: number; 'Rows Removed by Join Filter'?: number; Plans?: PlanNode[] };
        // Native PostgreSQL EXPLAIN JSON is the database instrumentation boundary.
        const explained = await client.$queryRawUnsafe<Array<{ 'QUERY PLAN': { Plan: PlanNode }[] }>>(
            `EXPLAIN (ANALYZE, FORMAT JSON) ${selection.query}`, ...JSON.parse(selection.params));
        const nodes: PlanNode[] = [];
        const visit = (node: PlanNode) => { nodes.push(node); node.Plans?.forEach(visit); };
        visit(explained[0]!['QUERY PLAN'][0]!.Plan);
        // Repeated PK probes examine one retained row; replaying a materialized
        // JSON inventory per history row violates this proportional-work shape.
        for (const node of nodes.filter(node => node['Actual Loops'] > 1)) {
            expect(node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Join Filter'] ?? 0)).toBeLessThanOrEqual(1);
        }
        console.info('WORKFLOW_INVOCATION_DELTA_POSTGRES_PLAN', nodes.map(node => ({
            type: node['Node Type'], rows: node['Actual Rows'], loops: node['Actual Loops'],
            filtered: node['Rows Removed by Filter'] ?? node['Rows Removed by Join Filter'] ?? 0,
        })));
        console.info("WORKFLOW_INVOCATION_DELTA_SQL", JSON.stringify({ retained: indices.length,
            returnedRows: first.invocations.length + second.invocations.length, ...readCosts }));
    });

    function costs() {
        const sql = statements.filter(event => !/^(BEGIN|COMMIT|ROLLBACK|SET|SHOW)\b/i.test(event.query.trimStart()));
        const invocationSelects = sql.filter(event => /^SELECT\b/i.test(event.query.trimStart()) && event.query.includes('"WorkflowRunInvocation"'));
        return { totalStatements: statements.length, statements: sql.length, invocationSelects: invocationSelects.length,
            maxBindParameters: Math.max(0, ...sql.flatMap(event => [...event.query.matchAll(/\$(\d+)/g)].map(match => Number(match[1])))) };
    }

    it("preserves the selected executor when an admitted sibling reports missing custody in PostgreSQL", async () => {
        const guest = await db.account.create({ data: { encryptionMode: 'plain' } });
        const sibling = await db.machine.create({ data: { id: randomUUID(), accountId: ownerId, metadata: '{}' } });
        const installationId = randomUUID();
        const siblingInstallationId = randomUUID();
        const selectedRunId = randomUUID();
        const queuedRunId = randomUUID();
        for (const id of [selectedRunId, queuedRunId]) await db.automationRun.create({ data: {
            id, accountId: guest.id, originKind: 'direct', causeKind: null, state: 'queued',
            workflowCustodyState: 'pending', workflowAcceptedSnapshotEnvelope: 'private accepted content',
            scheduledAt: new Date(), dueAt: new Date(), assignments: { create: [
                { machineId, admittedMachineInstallationId: installationId },
                { machineId: sibling.id, admittedMachineInstallationId: siblingInstallationId },
            ] },
        } });
        try {
            const now = new Date();
            expect(await inTx(tx => tryClaimAutomationRunInTx({ tx, runId: selectedRunId, previousState: 'queued',
                expectedRunRevision: 0, executionInputEnvelope: null, now, machineId,
                leaseExpiresAt: new Date(now.getTime() + 30_000) }))).toEqual({ count: 1 });
            const selected = await db.automationRun.findUniqueOrThrow({ where: { id: selectedRunId } });
            await recordWorkflowRequesterCustodyUnavailable({ runId: selectedRunId, machineId: sibling.id,
                installationId: siblingInstallationId });
            expect(await db.automationRun.findUniqueOrThrow({ where: { id: selectedRunId } })).toEqual(selected);
            await recordWorkflowRequesterCustodyUnavailable({ runId: selectedRunId, machineId, installationId });
            expect(await db.automationRun.findUniqueOrThrow({ where: { id: selectedRunId } })).toMatchObject({
                state: 'failed', errorCode: 'requester_custody_unavailable', claimedByMachineId: machineId,
                attempt: 1, revision: 2, workflowCustodyState: 'settled',
            });
            const queued = await db.automationRun.findUniqueOrThrow({ where: { id: queuedRunId } });
            await recordWorkflowRequesterCustodyUnavailable({ runId: queuedRunId, machineId: sibling.id,
                installationId: 'different-installation' });
            expect(await db.automationRun.findUniqueOrThrow({ where: { id: queuedRunId } })).toEqual(queued);
            await recordWorkflowRequesterCustodyUnavailable({ runId: queuedRunId, machineId: sibling.id,
                installationId: siblingInstallationId });
            expect(await db.automationRun.findUniqueOrThrow({ where: { id: queuedRunId } })).toMatchObject({
                state: 'failed', errorCode: 'requester_custody_unavailable', claimedByMachineId: sibling.id,
                attempt: 1, revision: 2, workflowCustodyState: 'settled',
            });
        } finally {
            await db.automationRun.deleteMany({ where: { accountId: guest.id } });
            await db.machine.delete({ where: { id: sibling.id } });
            await db.account.delete({ where: { id: guest.id } });
        }
    });

    it("replays terminal pending guest custody through the exact-installation PostgreSQL lookup", async () => {
        const guest = await db.account.create({ data: { encryptionMode: 'plain' } });
        const installationId = randomUUID();
        const terminalPendingId = randomUUID();
        const queuedId = randomUUID();
        for (const [id, state, custody, installation] of [
            [terminalPendingId, 'succeeded', 'pending', installationId],
            [queuedId, 'queued', 'pending', installationId],
            [randomUUID(), 'succeeded', 'settled', installationId],
            [randomUUID(), 'succeeded', 'pending', 'different-installation'],
        ] as const) await db.automationRun.create({ data: {
            id, accountId: guest.id, originKind: 'direct', causeKind: null, state,
            workflowCustodyState: custody, workflowAcceptedSnapshotEnvelope: 'private accepted content',
            scheduledAt: new Date(), dueAt: new Date(), assignments: { create: {
                machineId, admittedMachineInstallationId: installation,
            } },
        } });
        const socket = createFakeSocket();
        let assignmentReads = 0;
        const stop = observePrismaRequests(db, { before(request) {
            if (request.model === 'AutomationRunAssignment' && request.action === 'findMany') assignmentReads += 1;
        } });
        try {
            await replayWorkflowRunMachineWakes({ custodianAccountId: ownerId, machineId, installationId,
                socket: socket as unknown as Socket });
            const wakes = socket.emit.mock.calls.filter(([event]) => event === 'update').map(([, update]) => update.body);
            expect(wakes.map(wake => wake.runId).sort()).toEqual([queuedId, terminalPendingId].sort());
            expect(wakes).toContainEqual(expect.objectContaining({ runId: terminalPendingId, state: 'succeeded',
                requesterScope: { kind: 'workflow_trigger', id: terminalPendingId } }));
            expect(JSON.stringify(wakes)).not.toContain('private accepted content');
            expect(assignmentReads).toBe(1);
        } finally {
            stop();
            await db.automationRun.deleteMany({ where: { accountId: guest.id } });
            await db.account.delete({ where: { id: guest.id } });
        }
    });

    it("filters interleaved trigger history in the paginated PostgreSQL read", async () => {
        const automation = await db.automation.create({ data: { accountId: ownerId, name: "Trigger history",
            targetType: null, templateCiphertext: "{}" } });
        const triggerId = AutomationTriggerIdSchema.parse(randomUUID());
        const siblingTriggerId = AutomationTriggerIdSchema.parse(randomUUID());
        const runIds = Array.from({ length: 4 }, () => randomUUID());
        await db.automationRun.createMany({ data: runIds.map((id, index) => {
            const selectedTriggerId = [triggerId, siblingTriggerId, triggerId, null][index];
            const occurredAt = Date.UTC(2026, 10, 1, 0, 0, index);
            return { id, accountId: ownerId, automationId: automation.id, originKind: "automation", state: "failed",
                ...encodeAutomationRunCause(selectedTriggerId ? { kind: "trigger", triggerId: selectedTriggerId,
                    triggerKind: "schedule", triggerRevision: 0, occurredAt,
                    occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId: selectedTriggerId,
                        evidence: { v: 1, kind: "schedule", scheduledFor: occurredAt } }),
                    evidence: { scheduledFor: occurredAt } } : { kind: "manual", invokedAt: occurredAt }),
                createdAt: new Date(occurredAt), scheduledAt: new Date(occurredAt), dueAt: new Date(occurredAt),
                workflowCustodyState: "settled", workflowAcceptedSnapshotEnvelope: "unopened retained content" };
        }) });
        await db.automationRunAssignment.createMany({ data: runIds.map(runId => ({ runId, machineId, priority: 0 })) });
        const request = { accountId: ownerId, automationId: automation.id, triggerId, limit: 1, pageByteLimit: 1_000_000 };
        try {
            statements.length = 0;
            const first = await listWorkflowRuns(request);
            expect(first.runs.map(run => run.id)).toEqual([runIds[2]]);
            expect(first.nextCursor).toBeTypeOf("string");
            const selectedRunReads = statements.filter(event => /^SELECT\b/.test(event.query.trimStart())
                && /FROM\s+"public"\."AutomationRun"(?:\s|$)/.test(event.query) && event.params.includes(triggerId));
            expect(selectedRunReads).toHaveLength(1);
            const second = await listWorkflowRuns({ ...request, cursor: first.nextCursor });
            expect(second.runs.map(run => run.id)).toEqual([runIds[0]]);
            expect(second.nextCursor).toBeUndefined();
            expect((await listWorkflowRuns({ ...request, triggerId: siblingTriggerId })).runs.map(run => run.id)).toEqual([runIds[1]]);
            await expect(listWorkflowRuns({ ...request, triggerId: siblingTriggerId, cursor: first.nextCursor }))
                .rejects.toMatchObject({ code: "invalid_input" });
        } finally {
            await db.automationRun.deleteMany({ where: { id: { in: runIds } } });
            await db.automation.delete({ where: { id: automation.id } });
        }
    });

    it("reads one exact invocation and newest parent slot without opening the other 500 progress bodies", async () => {
        const base = { accountId: ownerId, runId, progressEnvelopes: true as const, pageByteLimit: 4_000_000 };
        statements.length = 0;
        const exact = await listWorkflowRunInvocations({ ...base, invocationId: children[7]! });
        const exactCosts = costs();
        console.info("WORKFLOW_EXACT_READ_SQL", JSON.stringify({ historyRows: 502, ...exactCosts,
            returnedRows: exact.invocations.length, progressBodies: Object.keys(exact.progressEnvelopesByInvocationId ?? {}).length }));
        expect(exact.invocations.map(row => row.id)).toEqual([children[7]]);
        expect(exact.progressEnvelopesByInvocationId).toEqual({ [children[7]!]: envelopes.get(children[7]!) });
        statements.length = 0;
        const slot = await listWorkflowRunInvocations({ ...base, parentRecordId: rootId, memberOrdinal: "7" });
        const slotCosts = costs();
        expect(slot.invocations.map(row => row.id)).toEqual([latestId]);
        expect(slot.progressEnvelopesByInvocationId).toEqual({ [latestId]: envelopes.get(latestId) });
        expect(exactCosts.invocationSelects).toBe(1);
        expect(slotCosts.invocationSelects).toBe(1);
        const replacementRoot = randomUUID();
        const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: "plain",
            binding: { v: 1, purpose: "invocation_progress", accountId: ownerId, runId, recordId: replacementRoot,
                sequence: "502", parentRecordId: null, memberOrdinal: "0", attempt: "1" },
            progress: { kind: "happier.workflow-progress.v1", blockKind: "root", invocationPath: { blockId: "$root", scope: [] },
                attempt: "1", logicalInvocationRecordId: rootId, previousAttemptRecordId: rootId } }));
        await db.workflowRunInvocation.create({ data: { id: replacementRoot, runId, sequence: 502n, parentRecordId: null,
            memberOrdinal: 0n, attempt: 1n, lifecycle: "pending", contentEnvelope: rootEnvelope } });
        try {
            statements.length = 0;
            const roots = await listWorkflowRunInvocations({ ...base, parentRecordId: null, memberOrdinal: "0" });
            const rootCosts = costs();
            expect(roots.invocations.map(row => row.id)).toEqual([replacementRoot]);
            expect(roots.progressEnvelopesByInvocationId).toEqual({ [replacementRoot]: rootEnvelope });
            expect(rootCosts.invocationSelects).toBe(1);
            console.info("WORKFLOW_CURRENT_ROOT_SQL", JSON.stringify({ historyRows: 503, ...rootCosts, progressBodies: 1 }));
        } finally { await db.workflowRunInvocation.delete({ where: { id: replacementRoot } }); }
        console.info("WORKFLOW_NARROW_READ_SQL", JSON.stringify({ historyRows: 502, exact: exactCosts, slot: slotCosts,
            exactProgressBodies: Object.keys(exact.progressEnvelopesByInvocationId!).length,
            slotProgressBodies: Object.keys(slot.progressEnvelopesByInvocationId!).length }));
        await expect(listWorkflowRunInvocations({ ...base, invocationId: randomUUID() })).resolves.toMatchObject({ invocations: [], progressEnvelopesByInvocationId: {} });
        await db.workflowRunInvocation.update({ where: { id: children[7] }, data: { lifecycle: "waiting_for_review" } });
        try {
            const held = await listWorkflowRunInvocations({ ...base, parentRecordId: rootId, memberOrdinal: "7", lifecycles: ["waiting_for_review"] });
            expect(held.invocations).toEqual([]);
        } finally { await db.workflowRunInvocation.update({ where: { id: children[7] }, data: { lifecycle: "running" } }); }
    });

    it("reads only control facts and the requested root, without fetching accepted program content", async () => {
        const app = createAuthenticatedTestApp();
        registerWorkflowRunStorageRoutes(app);
        await app.ready();
        const read = (projection: string, accountId = ownerId) => app.inject({ method: "POST", url: "/v3/automations/runs/workflow-storage",
            headers: { "x-test-user-id": accountId }, payload: { operation: "get", runId, projection } });
        const stranger = await db.account.create({ data: { encryptionMode: "plain" } });
        try {
            for (const projection of ["control", "revision"]) {
                statements.length = 0;
                const response = await read(projection);
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toEqual({ run: { state: "running", revision: 0 },
                    ...(projection === "control" ? { rootProgress: { index: expect.objectContaining({ id: rootId }), contentEnvelope: envelopes.get(rootId) } } : {}) });
                const selected = statements.filter(event => /^SELECT\b/i.test(event.query.trimStart()));
                const contentReads = selected.filter(event => /SELECT[^;]*"workflowAcceptedSnapshotEnvelope"[^;]*FROM/s.test(event.query));
                expect(contentReads).toHaveLength(0);
                expect(selected.filter(event => event.query.includes('"WorkflowRunInvocation"'))).toHaveLength(projection === "control" ? 1 : 0);
                console.info("WORKFLOW_CONTROL_READ_SQL", JSON.stringify({ projection, acceptedProgramReads: contentReads.length, ...costs() }));
            }
            expect((await read("control", stranger.id)).statusCode).not.toBe(200);
            await db.workflowRunInvocation.update({ where: { id: rootId }, data: { contentEnvelope: envelopes.get(children[0]!)! } });
            expect((await read("control")).json()).toMatchObject({ rootProgress: null });
            await db.workflowRunInvocation.update({ where: { id: rootId }, data: { contentEnvelope: envelopes.get(rootId)! } });
            await db.automationRun.update({ where: { id: runId }, data: { state: "pause_requested", revision: { increment: 1 } } });
            expect((await read("control")).json()).toMatchObject({ run: { state: "pause_requested", revision: 1 } });
            await db.account.update({ where: { id: ownerId }, data: { encryptionMode: 'e2ee' } });
            expect((await read("control")).statusCode).not.toBe(200);
        } finally {
            await db.account.update({ where: { id: ownerId }, data: { encryptionMode: 'plain' } });
            await db.workflowRunInvocation.update({ where: { id: rootId }, data: { contentEnvelope: envelopes.get(rootId)! } });
            await db.automationRun.update({ where: { id: runId }, data: { state: "running", revision: 0 } });
            await db.account.delete({ where: { id: stranger.id } });
            await app.close();
        }
    });

    it("discloses byte-bounded parent progress through the real HTTP route and rejects mis-bound reads", async () => {
        const app = createAuthenticatedTestApp();
        registerWorkflowRunStorageRoutes(app);
        await app.ready();
        const read = (input: object) => app.inject({ method: "POST", url: "/v3/automations/runs/workflow-storage",
            headers: { "x-test-user-id": ownerId }, payload: { operation: "invocations.list", runId, pageByteLimit: 5000, ...input } });
        try {
            const response = await read({ parentRecordId: rootId, progressEnvelopes: true });
            expect(response.statusCode, response.body).toBe(200);
            const page: Awaited<ReturnType<typeof listWorkflowRunInvocations>> = response.json();
            expect(page.invocations).toHaveLength(1);
            const index = WorkflowRunInvocationIndexV1Schema.parse(page.invocations[0]);
            expect(page.progressEnvelopesByInvocationId).toEqual({ [page.invocations[0]!.id]: envelopes.get(page.invocations[0]!.id) });
            expect(openWorkflowProgressStoredEnvelopeV1({ mode: "plain", binding: { v: 1, purpose: "invocation_progress", accountId: ownerId,
                runId, recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId,
                memberOrdinal: index.memberOrdinal, attempt: index.attempt },
                envelope: JSON.parse(page.progressEnvelopesByInvocationId![index.id]!) })).toMatchObject({ kind: "available" });
            expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(page)).toBeLessThanOrEqual(5000);
            expect(page.nextCursor).toBeTypeOf("string");
            const second = await read({ parentRecordId: rootId, progressEnvelopes: true, cursor: page.nextCursor });
            expect(second.statusCode, second.body).toBe(200);
            const secondPage: Awaited<ReturnType<typeof listWorkflowRunInvocations>> = second.json();
            expect(secondPage.invocations[0]!.id).not.toBe(page.invocations[0]!.id);
            expect((await read({ parentRecordId: rootId, memberOrdinal: "7", progressEnvelopes: true })).json()).toMatchObject({ invocations: [{ id: latestId }] });
            const rootResponse = await read({ parentRecordId: null, memberOrdinal: "0", progressEnvelopes: true });
            expect(rootResponse.statusCode, rootResponse.body).toBe(200);
            const rootPage: Awaited<ReturnType<typeof listWorkflowRunInvocations>> = rootResponse.json();
            expect(rootPage.invocations.map(row => row.id)).toEqual([rootId]);
            expect(rootPage.progressEnvelopesByInvocationId).toEqual({ [rootId]: envelopes.get(rootId) });
            expect(rootPage.nextCursor).toBeUndefined();
            expect((await read({ invocationId: children[7], progressEnvelopes: true })).json()).toMatchObject({ invocations: [{ id: children[7] }] });
            expect((await read({ parentRecordIds: [rootId], progressEnvelopes: true, limit: 1 })).json()).toMatchObject({ invocations: [{ id: children[0] }] });
            // A selector cannot be silently dropped or reused as a broad history cursor.
            expect((await read({ invocationId: children[7], parentRecordId: rootId })).statusCode).toBe(400);
            expect((await read({ invocationId: children[7], cursor: page.nextCursor })).statusCode).toBe(422);
            expect((await read({ invocationId: children[7], runId: randomUUID() })).statusCode).not.toBe(200);
        } finally { await app.close(); }
    });

    it("set-reads directly selected parent histories beyond PostgreSQL's bind count without unrelated root bodies", async () => {
        // Invocation ids are bounded NFC strings, not necessarily UUIDs. This
        // caller set fits the HTTP input byte budget but exceeds 32767 binds.
        const parentRecordIds = [rootId, ...Array.from({ length: 35_000 }, (_, index) => `absent-${index}`)];
        statements.length = 0;
        const page = await listWorkflowRunInvocations({ accountId: ownerId, runId, parentRecordIds,
            progressEnvelopes: true, limit: 1, pageByteLimit: 5000, lifecycles: ["running"] });
        const batchCosts = costs();
        console.info("WORKFLOW_PARENT_BATCH_SQL", JSON.stringify({ requestedParents: parentRecordIds.length,
            requestBytes: Buffer.byteLength(JSON.stringify({ operation: "invocations.list", runId, parentRecordIds,
                progressEnvelopes: true, limit: 1, pageByteLimit: 5000 })), ...batchCosts,
            returnedRows: page.invocations.length, progressBodies: Object.keys(page.progressEnvelopesByInvocationId ?? {}).length }));
        expect(page.invocations.map(row => row.id)).toEqual([children[0]]);
        expect(page.progressEnvelopesByInvocationId).toEqual({ [children[0]!]: envelopes.get(children[0]!) });
        expect(page.nextCursor).toBeTypeOf("string");
        expect(batchCosts.invocationSelects).toBe(2);
        expect(batchCosts.maxBindParameters).toBeLessThan(10);
        const second = await listWorkflowRunInvocations({ accountId: ownerId, runId, parentRecordIds: [...parentRecordIds].reverse(),
            progressEnvelopes: true, limit: 1, cursor: page.nextCursor, pageByteLimit: 5000, lifecycles: ["running"] });
        expect(second.invocations.map(row => row.id)).toEqual([children[1]]);
        await expect(listWorkflowRunInvocations({ accountId: ownerId, runId, parentRecordIds: [rootId],
            cursor: page.nextCursor, pageByteLimit: 5000 })).rejects.toMatchObject({ code: "invalid_input" });
    });

    it("measures summary, membership and changed versus repeated publication without private-body fanout", async () => {
        const sourceIds = Array.from({ length: 500 }, () => randomUUID());
        statements.length = 0;
        const summary = await summarizeWorkflowRuns({ accountId: ownerId, sourceArtifactIds: sourceIds, recent: 3, pageByteLimit: 1_000_000 });
        const summaryCosts = costs();
        expect(summary.summaries).toHaveLength(500);
        const summaryPrivateColumns = statements.some(event => /"(?:workflowAcceptedSnapshotEnvelope|workflowCheckpointEnvelope|contentEnvelope)"/.test(event.query));
        expect(summaryPrivateColumns).toBe(false);
        statements.length = 0;
        expect((await listWorkflowRuns({ accountId: ownerId, attention: "required", projection: "membership", pageByteLimit: 1_000_000 })).runs).toEqual([]);
        const attentionCosts = costs();
        const publication = vi.spyOn(eventRouter, "emitUpdate");
        const input = { accountId: ownerId, runId, machineId, parentAttempt: 1, invocationId: children[0]!, invocationAttempt: 0n,
            expectedContentRevision: 0n, expectedLifecycle: "running" as const, lifecycle: "waiting_for_review" as const,
            contentEnvelope: envelopes.get(children[0]!)!, accountCurrentness: { mode: "plain" as const, version: 0, contentKeyFingerprint: null } };
        try {
            statements.length = 0;
            const changed = await commitWorkflowInvocationFact(input);
            const changedCosts = costs();
            const changedEmissions = publication.mock.calls.length;
            publication.mockClear();
            statements.length = 0;
            await commitWorkflowInvocationFact({ ...input, expectedContentRevision: BigInt(changed.contentRevision), expectedLifecycle: "waiting_for_review" });
            const repeatedCosts = costs();
            expect(publication.mock.calls).toHaveLength(0);
            console.info("WORKFLOW_SERVER_COSTS", JSON.stringify({ historyRows: 502, requestedSources: 500,
                summary: summaryCosts, summaryPrivateColumns, attention: attentionCosts,
                changed: { ...changedCosts, socketEmissions: changedEmissions }, repeated: { ...repeatedCosts, socketEmissions: 0 } }));
            const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: "plain",
                binding: { v: 1, purpose: "checkpoint", accountId: ownerId, runId },
                checkpoint: { kind: "happier.workflow-checkpoint.v1", rootRecordId: rootId, nextSequence: "503",
                    frontier: { nextBlockOrdinal: 1, paused: false } },
            }));
            await db.automationRun.update({ where: { id: runId }, data: { workflowCheckpointEnvelope: checkpointEnvelope } });
            const nextId = randomUUID();
            const nextEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: "plain",
                binding: { v: 1, purpose: "invocation_progress", accountId: ownerId, runId,
                    recordId: nextId, sequence: "502", parentRecordId: rootId, memberOrdinal: "500", attempt: "0" },
                progress: { kind: "happier.workflow-progress.v1", invocationPath: { blockId: "work", scope: [] },
                    blockKind: "step", attempt: "0", logicalInvocationRecordId: nextId },
            }));
            statements.length = 0;
            const admission = await admitWorkflowInvocations({ accountId: ownerId, runId, machineId, parentAttempt: 1,
                expectedRevision: changed.parentRevision, accountCurrentness: input.accountCurrentness, checkpointEnvelope,
                invocations: [{ id: nextId, sequence: 502n, parentRecordId: rootId, memberOrdinal: 500n, contentEnvelope: nextEnvelope }] });
            const admissionCosts = costs();
            expect(admission.disposition).toBe("created");
            statements.length = 0;
            const resolved = await completeWorkflowInvocationReview({ ...input,
                expectedContentRevision: BigInt(changed.contentRevision), mode: "use_result" });
            const resolutionCosts = costs();
            expect(resolved.disposition).toBe("completed");
            await db.automationRun.update({ where: { id: runId }, data: { state: "interrupted" } });
            statements.length = 0;
            const recovery = await listWorkflowRunsForRecovery({ accountId: ownerId, machineId, pageByteLimit: 1_000_000 });
            const recoveryCosts = costs();
            expect(recovery.candidates.map(candidate => candidate.run.id)).toEqual([runId]);
            console.info("WORKFLOW_STORAGE_PHASE_SQL", JSON.stringify({ historyRows: 502, admission: admissionCosts,
                holdResolution: resolutionCosts, recoveryEnumeration: recoveryCosts }));
        } finally { publication.mockRestore(); }
    });

    it("selects exact recovery custody before reading a fleet of pending Runs", async () => {
        const ids = Array.from({ length: 1_000 }, () => randomUUID());
        const createdAt = new Date();
        await db.automationRun.createMany({ data: ids.map(id => ({ id, accountId: ownerId, originKind: "direct", causeKind: null,
            state: "succeeded", workflowCustodyState: "pending", workflowAcceptedSnapshotEnvelope: "unopened-accepted",
            claimedByMachineId: machineId, attempt: 3, scheduledAt: createdAt, dueAt: createdAt, createdAt })) });
        await db.automationRunAssignment.createMany({ data: ids.map(runId => ({ runId, machineId, priority: 0 })) });
        try {
            statements.length = 0;
            const exact = await listWorkflowRunsForRecovery({ accountId: ownerId, machineId, runId: ids[0]!, pageByteLimit: 1_000_000 });
            const selection = statements.filter(event => /^SELECT\b/i.test(event.query.trimStart()) && event.query.includes('"AutomationRun"'));
            expect(exact.candidates.map(candidate => [candidate.run.id, candidate.parentAttempt])).toEqual([[ids[0], 3]]);
            expect(exact.nextCursor).toBeUndefined();
            expect(selection).toHaveLength(1);
            expect(selection[0]!.params).toContain(ids[0]);
            console.info("WORKFLOW_EXACT_RECOVERY_SQL", JSON.stringify({ pendingRuns: ids.length, returnedRows: exact.candidates.length, ...costs() }));
            const absent = await listWorkflowRunsForRecovery({ accountId: ownerId, machineId, runId: randomUUID(), pageByteLimit: 4096 });
            expect(absent.candidates).toEqual([]);
            const foreignMachine = await listWorkflowRunsForRecovery({ accountId: ownerId, machineId: randomUUID(), runId: ids[0]!, pageByteLimit: 4096 });
            expect(foreignMachine.candidates).toEqual([]);
            const foreignAccount = await db.account.create({ data: { encryptionMode: "plain" } });
            try {
                expect((await listWorkflowRunsForRecovery({ accountId: foreignAccount.id, machineId, runId: ids[0]!, pageByteLimit: 4096 })).candidates).toEqual([]);
            } finally { await db.account.delete({ where: { id: foreignAccount.id } }); }
            await db.automationRun.update({ where: { id: ids[0] }, data: { workflowCustodyState: "settled" } });
            expect((await listWorkflowRunsForRecovery({ accountId: ownerId, machineId, runId: ids[0]!, pageByteLimit: 4096 })).candidates).toEqual([]);
        } finally { await db.automationRun.deleteMany({ where: { id: { in: ids } } }); }
    });

    it("reads only the latest applicable lifecycle Run per trigger in one PostgreSQL query regardless of retained history", async () => {
        const sourceSession = await db.session.create({ data: {
            accountId: ownerId, tag: `lifecycle-cost-${randomUUID()}`, encryptionMode: "plain", metadata: "{}",
        } });
        const sourceTurnId = `turn-${randomUUID()}`;
        const authentication = createPresentUserSessionAccessAuthentication();
        const mutateTurn = (action: "begin" | "complete") => {
            const common = { v: 1 as const, sessionId: sourceSession.id, turnId: sourceTurnId,
                mutationId: `${action}-${randomUUID()}`, observedAt: Date.now() };
            return applySessionTurnMutation({ actorUserId: ownerId, authentication,
                mutation: action === "begin"
                    ? { ...common, action, initiator: "user", workDepth: 0 }
                    : { ...common, action },
            });
        };
        const recipe = serializeAutomationStoredDefinitionExecutionRecipeV1({
            v: 1, templateVersion: 1, template: { t: "plain", v: { v: 1, prompt: "Latest lifecycle status" } },
            triggerEvidence: null, target: { kind: "newSession", spawn: {
                executionTarget: { serverId: `server-${machineId}`, machineId },
                directory: { kind: "path", path: "/tmp/lifecycle-cost" },
                agentTarget: { kind: "agent", identity: { pluginId: "happier.agent.codex", localId: "codex" } },
            } },
        });
        const workflowRecipe = serializeAutomationStoredWorkflowDefinitionRecipeV2({
            v: 2, templateVersion: 1, triggerEvidence: null,
            workflow: { t: "plain", v: { workspace: { directory: "/tmp/lifecycle-cost" }, executionTarget: { kind: "session" } } },
        });
        if (recipe.kind !== "available" || workflowRecipe.kind !== "available") throw new Error("Lifecycle cost recipe unavailable");
        const automationIds = [randomUUID(), randomUUID()];
        try {
            expect(await mutateTurn("begin")).toMatchObject({ ok: true, didApply: true });
            await db.automation.createMany({ data: automationIds.map((id, index) => ({
                id, accountId: ownerId, name: "Lifecycle read costs", enabled: true, templateVersion: 1,
                targetType: index === 0 ? AutomationTargetType.new_session : null,
                templateCiphertext: index === 0 ? recipe.serialized : workflowRecipe.serialized,
                ...(index === 0 ? {} : { workflowDefinitionId: "builtin:keep-going" }),
            })) });
            await db.automationAssignment.createMany({ data: automationIds.map(automationId => ({
                automationId, machineId, enabled: true,
            })) });
            const createTrigger = (automationId: string, recurring: boolean, enabled = true) => db.automationTrigger.create({ data: {
                automationId, kind: "sessionLifecycle", enabled, revision: 1,
                ...encodeAutomationSessionLifecycleConfiguration({
                    kind: "sessionLifecycle", sourceSessionId: sourceSession.id, events: ["parentTurnCompleted"],
                    policy: recurring ? { kind: "everyMatch" } : { kind: "currentTurn", sourceTurnId },
                }),
            } });
            const exact = await createTrigger(automationIds[0]!, false);
            const recurring = await createTrigger(automationIds[1]!, true);
            const noRun = await createTrigger(automationIds[1]!, false, false);
            expect(await mutateTurn("complete")).toMatchObject({ ok: true, didApply: true });
            const exactRun = await db.automationRun.findFirstOrThrow({ where: { triggerId: exact.id } });
            const recurringRun = await db.automationRun.findFirstOrThrow({ where: { triggerId: recurring.id } });
            expect(recurringRun.workflowCustodyState).toBe("pending");
            await db.automationRun.update({ where: { id: exactRun.id }, data: { state: AutomationRunState.succeeded } });
            const latestAt = new Date(Date.now() + 1_000);
            const parkedId = `z-${randomUUID()}`;
            const history: Prisma.AutomationRunCreateManyInput[] = [
                ...[exactRun, recurringRun].flatMap(run => Array.from({ length: 40 }, (_, index) => ({
                    ...run, id: randomUUID(), occurrenceKey: `history-${randomUUID()}`,
                    createdAt: new Date(run.createdAt.getTime() - index - 1), state: AutomationRunState.succeeded,
                }))),
                { ...exactRun, id: randomUUID(), occurrenceKey: `other-turn-${randomUUID()}`,
                    createdAt: latestAt, causeSourceTurnId: `other-${sourceTurnId}`, state: AutomationRunState.running },
                { ...recurringRun, id: `a-${randomUUID()}`, occurrenceKey: `tie-${randomUUID()}`,
                    createdAt: latestAt, state: AutomationRunState.succeeded },
                { ...recurringRun, id: parkedId, occurrenceKey: `parked-${randomUUID()}`,
                    createdAt: latestAt, state: AutomationRunState.waiting_for_review },
            ];
            await db.automationRun.createMany({ data: history });
            const automations = await Promise.all(automationIds.map(async automationId => {
                const automation = await getAutomation({ accountId: ownerId, automationId });
                if (!automation) throw new Error("Expected lifecycle Automation fixture");
                return automation;
            }));
            const returnedRunIds: string[] = [];
            let returnedRunRows = 0;
            const read = async (expectedRecurringRunId: string) => {
                const retainedRuns = await db.automationRun.count({ where: { automationId: { in: automationIds } } });
                statements.length = 0;
                returnedRunRows = 0;
                returnedRunIds.length = 0;
                const stop = observePrismaRequests(client, { after(request, rows) {
                    if (request.model === "AutomationRun" && request.action === "findMany"
                        || request.model === undefined && request.action === "queryRaw") {
                        if (Array.isArray(rows)) {
                            returnedRunRows += rows.length;
                            for (const row of rows) {
                                if (row && typeof row === "object" && "id" in row && typeof row.id === "string") returnedRunIds.push(row.id);
                            }
                        }
                    }
                } });
                const statuses = await (async () => {
                    try {
                        return await db.$transaction(tx => loadAutomationSessionLifecycleStatusProjections({ automations, tx }));
                    } finally { stop(); }
                })();
                const runSelects = statements.filter(event => /^SELECT\b/i.test(event.query.trimStart()) && event.query.includes('"AutomationRun"'));
                expect(runSelects).toHaveLength(1);
                expect(returnedRunRows).toBe(2);
                expect(returnedRunIds.sort()).toEqual([exactRun.id, expectedRecurringRunId].sort());
                console.info("WORKFLOW_LIFECYCLE_STATUS_SQL", JSON.stringify({
                    retainedRuns, demandedTriggers: 3, returnedRunRows, runSelects: runSelects.length, ...costs(),
                }));
                return statuses;
            };
            const statuses = await read(parkedId);
            expect(statuses.get(exact.automationId)?.get(exact.id)).toEqual({ state: "finished", runId: exactRun.id });
            expect(statuses.get(recurring.automationId)?.get(recurring.id)).toEqual({ state: "running", runId: parkedId });
            expect(statuses.get(noRun.automationId)?.get(noRun.id)).toEqual({ state: "finished", runId: null });
            const newestId = randomUUID();
            await db.automationRun.create({ data: { ...recurringRun, id: newestId,
                occurrenceKey: `newest-${randomUUID()}`, createdAt: new Date(latestAt.getTime() + 1), state: AutomationRunState.queued } });
            expect((await read(newestId)).get(recurring.automationId)?.get(recurring.id))
                .toEqual({ state: "triggered", runId: newestId });
        } finally {
            await db.automationRun.deleteMany({ where: { automationId: { in: automationIds } } });
            await db.automation.deleteMany({ where: { id: { in: automationIds } } });
            await db.session.delete({ where: { id: sourceSession.id } });
        }
    });

    it("summarizes actual starts in one metadata query per selection without dropping newer unstarted history", async () => {
        const sourceId = randomUUID();
        const automationId = randomUUID();
        const startedId = randomUUID();
        const unstartedId = randomUUID();
        const createdAt = new Date("2026-10-30T08:00:00.000Z");
        const startedAt = new Date("2026-10-30T08:01:00.000Z");
        await db.artifact.create({ data: { id: sourceId, accountId: ownerId,
            header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array() } });
        await db.automation.create({ data: { id: automationId, accountId: ownerId, name: "Summary starts", targetType: null, templateCiphertext: "{}" } });
        try {
            await db.automationRun.createMany({ data: [
                { id: startedId, state: AutomationRunState.failed, createdAt, startedAt },
                { id: unstartedId, state: AutomationRunState.cancelled, createdAt: new Date(startedAt.getTime() + 1_000), startedAt: null },
            ].map(row => ({ ...row, accountId: ownerId, automationId, sourceArtifactId: sourceId,
                originKind: "automation", causeKind: "manual", causeOccurredAt: createdAt, scheduledAt: createdAt, dueAt: createdAt,
                workflowCustodyState: "settled", workflowAcceptedSnapshotEnvelope: "unopened private content" })) });
            statements.length = 0;
            const automation = await summarizeWorkflowRuns({ accountId: ownerId, automationIds: [automationId], pageByteLimit: 1_000_000 });
            const source = await summarizeWorkflowRuns({ accountId: ownerId, sourceArtifactIds: [sourceId], recent: 1, pageByteLimit: 1_000_000 });
            expect(automation.automationSummaries[0]?.lastRun).toMatchObject({ id: startedId, startedAt: startedAt.toISOString() });
            expect(source.summaries[0]?.lastRun).toMatchObject({ runId: startedId, startedAt: startedAt.toISOString() });
            expect(source.summaries[0]?.recent).toMatchObject([{ runId: unstartedId, state: "cancelled" }]);
            expect(statements.filter(event => event.query.includes('"AutomationRun"'))).toHaveLength(2);
        } finally {
            await db.automationRun.deleteMany({ where: { automationId } });
            await db.automation.delete({ where: { id: automationId } });
            await db.artifact.delete({ where: { id: sourceId } });
        }
    });

    // Opt-in regression supplied to the active SRVQ summary owner. Keep the
    // ordinary FIN validation usable while that separate corridor is in flight.
    it.skipIf(process.env.HAPPIER_PERF_FIN_RT_SUMMARY_PROBE !== "1").each(["source", "automation"] as const)(
        "reads %s summaries beyond PostgreSQL's bind boundary", async kind => {
        const ids = Array.from({ length: 35_000 }, (_, index) => `absent-${index}`);
        const request = kind === "source" ? { sourceArtifactIds: ids, recent: 1 } : { automationIds: ids };
        console.info("WORKFLOW_SUMMARY_BIND_BOUNDARY", JSON.stringify({ kind, requestedIds: ids.length,
            requestBytes: Buffer.byteLength(JSON.stringify({ operation: "summaries", request, pageByteLimit: 4_000_000 })) }));
        try {
            const result = await summarizeWorkflowRuns({ accountId: ownerId, ...request, pageByteLimit: 4_000_000 });
            expect("summaries" in result ? result.summaries.length : result.automationSummaries.length).toBe(ids.length);
        } catch (error) {
            console.info("WORKFLOW_SUMMARY_BIND_FAILURE", { kind,
                code: error !== null && typeof error === "object" && "code" in error ? error.code : null });
            throw error;
        }
    });
});
