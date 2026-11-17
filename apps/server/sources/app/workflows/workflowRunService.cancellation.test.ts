import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { matchesDbMockWhere as matches } from "@/app/api/testkit/dbMocks";

const boundary = await vi.hoisted(async () => {
    const { createDbMaintenanceClient } = await import("@/storage/prisma");
    // Field references come from a real client; the unreachable URL is never connected.
    const client = await createDbMaintenanceClient("postgres", "postgresql://fields:fields@127.0.0.1:1/fields");
    return { tx: {}, runFields: client.automationRun.fields };
});
const transactions = await vi.hoisted(async () => {
    const { createDbTransactionMock, inTxPostgresControlStatementMock } = await import("@/app/api/testkit/dbMocks");
    return createDbTransactionMock(() => ({ ...inTxPostgresControlStatementMock, ...boundary.tx }));
});

// Only database transports are replaced. inTx, cancellation, claim, access,
// Account encryption fences and recovery selection use their real owners.
vi.mock("@/storage/db", async importOriginal => ({
    ...await importOriginal<typeof import("@/storage/db")>(),
    db: transactions.wrapDb({ automationRun: { fields: boundary.runFields } }),
}));
vi.mock("@/storage/prisma", async importOriginal => ({
    ...await importOriginal<typeof import("@/storage/prisma")>(),
    withSqliteReadSnapshot: transactions.readSnapshot,
}));

import { claimAutomationRun } from "@/app/automations/automationClaimService";
import { cancelWorkflowRun, listWorkflowRunsForRecovery } from "./workflowRunService";

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function apply(row: Record<string, unknown>, data: Record<string, unknown>) {
    for (const [key, value] of Object.entries(data)) {
        if (record(value) && "increment" in value) {
            const prior = row[key];
            if (typeof prior === "bigint") row[key] = prior + BigInt(String(value.increment));
            else if (typeof prior === "number" && typeof value.increment === "number") row[key] = prior + value.increment;
            else throw new Error("Invalid database increment");
        } else row[key] = value;
    }
}

const now = new Date("2026-10-11T10:00:00.000Z");
let row: Record<string, unknown>;
let children: Record<string, unknown>[];
let runEvents: Record<string, unknown>[];
let renewBeforeWrite: boolean;

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    renewBeforeWrite = false;
    runEvents = [];
    children = [{ id: "root", runId: "run", parentRecordId: null, lifecycle: "cancel_requested", contentRevision: 3n },
        { id: "child", runId: "run", parentRecordId: "root", lifecycle: "cancel_requested", contentRevision: 3n }];
    row = { id: "run", accountId: "account", originKind: "direct", automationId: null,
        sourceArtifactId: null, visibleTeamId: null, originSessionId: null, producedSessionId: null, state: "claimed", revision: 140,
        attempt: 138, claimedByMachineId: "old-machine", leaseExpiresAt: new Date(now.getTime() - 1),
        workflowCustodyState: "pending", workflowResumeRequestedRevision: null,
        workflowAcceptedSnapshotEnvelope: "accepted", workflowCheckpointEnvelope: null, resultEnvelope: null,
        originDeliveryAckRevision: null, executionInputEnvelope: null, triggerId: null, dueAt: now,
        scheduledAt: now, startedAt: now, createdAt: now, updatedAt: now, finishedAt: null, attentionSeenFailureAt: null,
        account: { encryptionMode: "plain" },
        assignments: [{ machineId: "old-machine" }], workflowInvocations: children };
    const runSnapshot = () => ({ ...row, leaseExpiresAt: row.leaseExpiresAt,
        workflowInvocations: children.map(child => ({ ...child })),
        _count: { workflowInvocations: children.filter(child => child.lifecycle === "waiting_for_review").length },
    });
    const account = { seq: 1, publicKey: "ab".repeat(32), encryptionMode: "plain",
        contentPublicKey: null, contentPublicKeySig: null, settings: null, settingsVersion: 0 };
    const accountChanges = new Map<string, Record<string, unknown>>();
    boundary.tx = {
        $queryRawUnsafe: async (query: string) => {
            if (query.includes('SET "seq" = "seq" + 1')) account.seq += 1;
            return [{ id: "account", accountId: "account", cursor: account.seq }];
        },
        $executeRawUnsafe: async () => 1,
        account: {
            findUnique: async () => ({ ...account }),
            update: async ({ data }: { data: Record<string, unknown> }) => {
                apply(account, data);
                return { ...account };
            },
        },
        accountChange: { upsert: async ({ create }: { create: Record<string, unknown> & { entityId: string } }) => {
            accountChanges.set(create.entityId, create);
            return create;
        } },
        machine: { findFirst: async () => ({ id: "old-machine", installationId: "installation" }),
            findMany: async () => [{ id: "old-machine", accountId: "account" }] },
        simpleCache: { findUnique: async () => null },
        automation: { findMany: async () => [{ id: "automation", accountId: "account", scopeSessionId: null, assignments: [] }] },
        automationTrigger: { findMany: async () => [] },
        automationRunEvent: { create: async ({ data }: { data: Record<string, unknown> }) => {
            runEvents.push(data);
            return data;
        } },
        sessionFollowEdge: { findMany: async () => [] },
        automationRun: {
            findUnique: async () => runSnapshot(),
            findUniqueOrThrow: async () => runSnapshot(),
            findFirst: async ({ where }: { where: unknown }) => matches(row, where) ? runSnapshot() : null,
            findMany: async ({ where }: { where: unknown }) => matches(row, where) ? [runSnapshot()] : [],
            updateMany: async ({ where, data }: { where: unknown; data: Record<string, unknown> }) => {
                if (renewBeforeWrite) { row.leaseExpiresAt = new Date(now.getTime() + 30_000); renewBeforeWrite = false; }
                if (!matches(row, where)) return { count: 0 };
                apply(row, data);
                return { count: 1 };
            },
        },
        workflowRunInvocation: {
            groupBy: async ({ where }: { where: unknown }) =>
                [...new Set(children.filter(child => matches(child, where)).map(child => child.runId))].map(runId => ({ runId })),
            findFirst: async ({ where }: { where: unknown }) => children.find(child => matches(child, where)) ?? null,
            updateMany: async ({ where, data }: { where: unknown; data: Record<string, unknown> }) => {
                const selected = children.filter(child => matches(child, where));
                for (const child of selected) apply(child, data);
                return { count: selected.length };
            },
        },
    };
});

afterEach(() => vi.useRealTimers());

it("lets the same cancel owner settle a queued Run before Workflow custody", async () => {
    Object.assign(row, { originKind: "automation", automationId: "automation", causeKind: "manual", causeOccurredAt: now,
        state: "queued", workflowCustodyState: null, workflowAcceptedSnapshotEnvelope: null,
        executionDispatchState: null, startedAt: null, claimedByMachineId: null, leaseExpiresAt: null });
    children = [];
    await expect(cancelWorkflowRun({ accountId: "foreign-account", runId: "run", expectedRevision: 140 }))
        .rejects.toMatchObject({ code: "run_not_found" });
    const result = await cancelWorkflowRun({ accountId: "account", runId: "run", expectedRevision: 140 });
    expect(result).toMatchObject({ intent: "cancelled", run: { state: "cancelled", revision: 141,
        workflowCustodyState: null, finishedAt: now.toISOString() } });
    expect(row).toMatchObject({ state: "cancelled", revision: 141, finishedAt: now });
    expect(children).toEqual([]);
    expect(runEvents.map(event => event.type)).toEqual(["run_cancelled"]);
});

it("lets Stop end an expired cancelled claim without inventing child settlement or reclaiming it", async () => {
    children[1].lifecycle = "running";
    children.push({ id: "unknown-child", runId: "run", parentRecordId: "root", lifecycle: "outcome_uncertain", contentRevision: 3n });
    const result = await cancelWorkflowRun({ accountId: "account", runId: "run", expectedRevision: 140 });
    expect(result).toMatchObject({ intent: "cancelled", run: { state: "cancelled", workflowCustodyState: "pending",
        finishedAt: now.toISOString(), availability: { cancel: false } } });
    expect(children.map(child => child.lifecycle)).toEqual(["cancel_requested", "cancel_requested", "outcome_uncertain"]);
    const stoppedRevision = row.revision;
    const stoppedAttempt = row.attempt;
    await expect(cancelWorkflowRun({ accountId: "account", runId: "run", expectedRevision: result.run.revision }))
        .rejects.toMatchObject({ code: "currentness_conflict" });
    for (let count = 0; count < 2; count += 1) {
        await expect(claimAutomationRun({ accountId: "account", machineId: "old-machine", leaseDurationMs: 30_000,
            scope: "workflow", recipeFeaturePolicy: { workflowsEnabled: true } })).resolves.toEqual({ run: null, accountCurrentness: null });
    }
    expect({ revision: row.revision, attempt: row.attempt }).toEqual({ revision: stoppedRevision, attempt: stoppedAttempt });
    // The same exact-Machine custody reader still reaches the terminal pending Run.
    await expect(listWorkflowRunsForRecovery({ accountId: "account", machineId: "old-machine", pageByteLimit: 4096 }))
        .resolves.toMatchObject({ candidates: [{ run: { id: "run", state: "cancelled", workflowCustodyState: "pending" } }] });
    await expect(listWorkflowRunsForRecovery({ accountId: "account", machineId: "replacement-machine", pageByteLimit: 4096 }))
        .resolves.toEqual({ candidates: [] });
});

it.each([null, new Date(now.getTime()), new Date(now.getTime() + 1)])("keeps Stop as intent while the lease is not expired (%s)", async leaseExpiresAt => {
    row.leaseExpiresAt = leaseExpiresAt;
    await expect(cancelWorkflowRun({ accountId: "account", runId: "run", expectedRevision: 140 }))
        .resolves.toMatchObject({ intent: "cancel_requested", run: { state: "claimed", workflowCustodyState: "pending", finishedAt: null } });
});

it("refuses expired-claim settlement if the incumbent lease renewed without a revision bump", async () => {
    renewBeforeWrite = true;
    await expect(cancelWorkflowRun({ accountId: "account", runId: "run", expectedRevision: 140 }))
        .rejects.toMatchObject({ code: "currentness_conflict" });
    expect(row).toMatchObject({ state: "claimed", revision: 140, finishedAt: null });
    expect(children.map(child => child.contentRevision)).toEqual([3n, 3n]);
});
