import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES, WorkflowRunSummaryV1Schema,
    sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from "@happier-dev/protocol";
import { db, prismaRuntime } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { materializeWorkflowAcceptedSnapshotFixture } from "@/testkit/workflowAcceptedSnapshot";
import { buildInboxWorkGroups } from "../../../../ui/sources/activity/presentation/buildInboxWorkGroups";
import { buildInboxItems } from "../../../../ui/sources/components/inbox/inboxItems";
import { workflowRunRowFromSummary } from "../../../../ui/sources/sync/store/domains/workflowRuns";
import type { Session } from "../../../../ui/sources/sync/domains/state/storageTypes";
import { projectSessionAwarenessV1 } from "@happier-dev/protocol/sessions/awareness/projectV1";
import type { InboxSessionAttentionEntry } from "../../../../ui/sources/activity/presentation/buildInboxSessionPresentation";
import { listAutomationRuns } from "../automations/automationCrudService";
import { workflowRunAttentionSql, workflowRunAttentionWhere, workflowRunSqlIdentifier } from "./workflowRunAttention";
import { deleteWorkflowRun, listWorkflowRuns } from "./workflowRunService";

describe("workflow Run attention to Inbox through SQLite", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: "happier-workflow-attention-" }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it("indexes only human attention and keeps SQL summaries consistent with relational membership", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: "{}" } });
        const finishedAt = new Date('2026-10-23T10:00:00.000Z');
        const scenarios: ReadonlyArray<{ state: string; lifecycle: string; attention: boolean; seen?: Date | null; finishedAt?: Date }> = [
            { state: "cancelled", lifecycle: "cancel_requested", attention: false },
            { state: "cancelled", lifecycle: "waiting_for_review", attention: false },
            { state: "interrupted", lifecycle: "failed", attention: false },
            { state: "interrupted", lifecycle: "cancel_requested", attention: false },
            { state: "interrupted", lifecycle: "needs_attention", attention: true },
            { state: "interrupted", lifecycle: "outcome_uncertain", attention: true },
            { state: "running", lifecycle: "waiting_for_review", attention: true },
            { state: "running", lifecycle: "waiting_for_approval", attention: true },
            { state: "failed", lifecycle: "failed", attention: true },
            { state: "failed", lifecycle: "failed", attention: false, seen: finishedAt, finishedAt },
            { state: "failed", lifecycle: "failed", attention: true, seen: finishedAt, finishedAt: new Date('2026-10-23T11:00:00.000Z') },
            { state: "failed", lifecycle: "waiting_for_approval", attention: true, seen: finishedAt, finishedAt },
            { state: "succeeded", lifecycle: "completed", attention: false },
        ];
        const expectedIds = new Set<string>();
        const expectedHeldCounts = new Map<string, number>();
        for (const scenario of scenarios) {
            const runId = randomUUID();
            const acceptedSnapshot = await materializeWorkflowAcceptedSnapshotFixture({
                definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: "wait", id: "human",
                    document: { text: "Review", references: [], attachments: [] } }] },
                context: { source: { kind: "inline" }, inputs: {}, machineId: machine.id, executionTarget: { kind: "session" },
                    workspaceTarget: { project: { machineId: machine.id, directory: "/repo", checkoutRootPath: "/repo" } },
                    origin: { kind: "direct" }, authorization: { principal: { kind: "host" } } },
            });
            const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
                mode: "plain", binding: { v: 1, purpose: "accepted_snapshot", accountId: account.id, runId }, acceptedSnapshot,
            }));
            const run = await db.automationRun.create({ data: { id: runId, accountId: account.id, originKind: "direct",
                automationId: null, causeKind: null, causeOccurredAt: null,
                workflowAcceptedSnapshotEnvelope: acceptedEnvelope,
                state: scenario.state, scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: "pending",
                finishedAt: scenario.finishedAt ?? (scenario.state === 'failed' ? finishedAt : null), attentionSeenFailureAt: scenario.seen ?? null,
                assignments: { create: { machineId: machine.id, priority: 0 } } } });
            await db.workflowRunInvocation.create({ data: { id: randomUUID(), runId: run.id, sequence: 0n,
                memberOrdinal: 0n, lifecycle: scenario.lifecycle, contentEnvelope: "unopened-private-progress" } });
            if (scenario.attention) expectedIds.add(run.id);
            expectedHeldCounts.set(run.id, scenario.state !== "cancelled" && scenario.lifecycle === "waiting_for_review" ? 1 : 0);
        }
        const relational = await db.automationRun.findMany({ where: { accountId: account.id,
            AND: [workflowRunAttentionWhere(account.id)] }, select: { id: true } });
        const id = workflowRunSqlIdentifier;
        const sql = await db.$queryRaw<Array<{ id: string }>>(prismaRuntime.sql`
            SELECT r.${id("id")} AS ${id("id")} FROM ${id("AutomationRun")} r
            WHERE r.${id("accountId")} = ${account.id} AND ${workflowRunAttentionSql(account.id)}`);
        expect(new Set(relational.map(run => run.id))).toEqual(expectedIds);
        expect(new Set(sql.map(run => run.id))).toEqual(expectedIds);
        // Exercise the actual Run projection, rather than a hand-written summary
        // fixture, through the exact strict consumer used by UI and Actions.
        const page = await listWorkflowRuns({ accountId: account.id, pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES });
        expect(page.runs).toHaveLength(scenarios.length);
        for (const produced of page.runs) {
            const consumed = WorkflowRunSummaryV1Schema.parse(produced);
            expect(consumed.heldCount).toBe(expectedHeldCounts.get(consumed.id));
            expect(consumed.attentionRequired).toBe(expectedIds.has(consumed.id));
            expect(WorkflowRunSummaryV1Schema.safeParse({ ...produced, unknown: true }).success).toBe(false);
        }
        const needsYou = await listWorkflowRuns({ accountId: account.id, attention: "required",
            pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES });
        expect(new Set(needsYou.runs.map(run => run.id))).toEqual(expectedIds);
        const inbox = buildInboxWorkGroups({ workflowRuns: needsYou.runs.map(run => workflowRunRowFromSummary(run, null)),
            sessionEntries: [], automationRuns: [], automationServerId: "home", openApprovals: [], stalledSessions: [],
            landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null });
        const runItems = inbox.flatMap(group => group.items).filter(item => item.kind === "workflow_run");
        expect(new Set(runItems.map(item => item.runId))).toEqual(expectedIds);
        expect(runItems.filter(item => item.row.summary?.heldCount === 1)).toHaveLength(1);
    });

    it("surfaces each failed managed occurrence once through Workflow attention, including without any Session", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const other = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: "{}" } });
        const automation = await db.automation.create({ data: { accountId: account.id,
            name: "Failed manual Workflow", templateCiphertext: "unopened-private-definition" } });
        const acceptedSnapshot = await materializeWorkflowAcceptedSnapshotFixture({
            definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: "wait", id: "human",
                document: { text: "Review", references: [], attachments: [] } }] },
            context: { source: { kind: "automation", automationId: automation.id }, inputs: {}, machineId: machine.id, executionTarget: { kind: "session" },
                workspaceTarget: { project: { machineId: machine.id, directory: "/repo", checkoutRootPath: "/repo" } },
                authorization: { principal: { kind: "host" } } },
        });
        const managedIds: string[] = [];
        for (let occurrence = 0; occurrence < 2; occurrence += 1) {
            const runId = randomUUID();
            const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
                mode: "plain", binding: { v: 1, purpose: "accepted_snapshot", accountId: account.id, runId }, acceptedSnapshot,
            }));
            await db.automationRun.create({ data: { id: runId, accountId: account.id, originKind: "automation",
                automationId: automation.id, causeKind: "manual", causeOccurredAt: new Date(),
                workflowAcceptedSnapshotEnvelope: acceptedEnvelope, workflowCustodyState: "settled",
                state: "failed", scheduledAt: new Date(), dueAt: new Date(),
                assignments: { create: { machineId: machine.id, priority: 0 } } } });
            managedIds.push(runId);
        }
        const ordinary = await db.automationRun.create({ data: { accountId: account.id, originKind: "automation",
            automationId: automation.id, causeKind: "manual", causeOccurredAt: new Date(), state: "failed",
            scheduledAt: new Date(), dueAt: new Date() } });
        // Managed Session correspondence is Session.originRunId; producedSessionId
        // remains null even after a real Workflow child Session exists.
        const child = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}",
            encryptionMode: "plain", originKind: "run_step", originRunId: managedIds[1] } });
        expect(await db.automationRun.findMany({ where: { id: { in: managedIds } }, select: { producedSessionId: true } }))
            .toEqual([{ producedSessionId: null }, { producedSessionId: null }]);
        const request = { accountId: account.id, attention: "required" as const,
            pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES };
        const attention = await listWorkflowRuns(request);
        expect(new Set(attention.runs.map(run => run.id))).toEqual(new Set(managedIds));
        const ordinaryAttention = await listAutomationRuns({ accountId: account.id, attention: "required" });
        expect(ordinaryAttention.runs.map(run => run.id)).toEqual([ordinary.id]);
        expect((await listWorkflowRuns({ ...request, accountId: other.id })).runs).toEqual([]);
        const session: Session = { id: child.id, serverId: "home", origin: { kind: "run_step", runId: child.originRunId! },
            seq: child.seq, encryptionMode: "plain", createdAt: child.createdAt.getTime(), updatedAt: child.updatedAt.getTime(),
            active: child.active, activeAt: child.lastActiveAt.getTime(), metadata: null, metadataVersion: child.metadataVersion,
            agentState: null, agentStateVersion: child.agentStateVersion, thinking: child.thinking, thinkingAt: 0 };
        const entry: InboxSessionAttentionEntry = { candidate: {
            session, sessionId: session.id, serverId: "home", title: "Failed step", subtitle: "", attentionState: "failed",
            hasAttention: true, priority: 0, lastTurnCompletedAt: null,
            personalAttention: { needsAttention: true, reasons: ["failed"], primary: "failed", presentation: "full" },
            awareness: projectSessionAwarenessV1({ sessionId: session.id, nowMs: 1, origin: session.origin,
                lifecycle: {}, runtime: { presence: "offline" }, pending: {}, content: { mode: "plain" },
                currentness: { lifecycle: "observed", runtime: "observed", pending: "observed" } }),
            reasons: { hasUnread: false, hasPendingPermissionRequests: false, hasPendingUserActionRequests: false,
                hasBlockedPendingDelivery: false, hasQueuedUserInput: false, isThinking: false },
        }, pendingPermissions: [], pendingUserActions: [] };
        const inbox = buildInboxWorkGroups({ workflowRuns: attention.runs.map(run =>
            workflowRunRowFromSummary(WorkflowRunSummaryV1Schema.parse(run), null)), sessionEntries: [entry],
            automationRuns: [], automationServerId: "home", openApprovals: [], stalledSessions: [], landings: [], snoozed: [],
            resolveSession: id => id === session.id ? session : null,
            resolveOriginRunId: value => value.candidate.awareness.origin?.kind === "run_step"
                ? value.candidate.awareness.origin.runId ?? null : null });
        expect(inbox).toHaveLength(2);
        expect(inbox.flatMap(group => group.items).filter(item => item.kind === "workflow_run").map(item => item.runId).sort())
            .toEqual([...managedIds].sort());
        expect(inbox.find(group => group.root.kind === "run" && group.root.runId === managedIds[1])?.items)
            .toContainEqual(expect.objectContaining({ kind: "session", foldedUnderRunId: managedIds[1] }));
        expect(inbox.some(group => group.root.kind === "other")).toBe(false);
        const items = buildInboxItems({ workGroups: inbox, workflowServerId: "home", accountServerId: "home", notices: [],
            sessionPresentation: { sessionsNeedingAttention: [entry], readySessions: [],
                markAllReadTargets: [], pendingRequestHydrationTargets: [] } });
        for (const runId of managedIds) {
            const rows = items.filter(item => item.source.id === runId);
            expect(rows).toHaveLength(1);
            expect(rows[0]?.source.kind).toBe("workflow_run");
            expect(new URL(rows[0]!.pageRoute, "https://home.invalid").searchParams.get("serverId")).toBe("home");
        }
        // A fresh read (the reload path) retains the same canonical membership.
        expect(new Set((await listWorkflowRuns(request)).runs.map(run => run.id))).toEqual(new Set(managedIds));
        await deleteWorkflowRun({ accountId: account.id, runId: managedIds[0]!, expectedRevision: 0 });
        expect((await listWorkflowRuns(request)).runs.map(run => run.id)).toEqual([managedIds[1]]);
    });
});
