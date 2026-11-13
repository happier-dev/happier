import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { materializeWorkflowAcceptedSnapshotFixture } from "@/testkit/workflowAcceptedSnapshot";
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from "@happier-dev/protocol/workflows";

const mocks = vi.hoisted(() => ({
    transactionAttempts: 0,
    recoveryWhere: null as unknown,
    acceptedEnvelope: "",
    tx: {},
    accountSeq: 1,
}));

const transactions = await vi.hoisted(async () => {
    const { createDbTransactionMock, inTxPostgresControlStatementMock } = await import("@/app/api/testkit/dbMocks");
    return createDbTransactionMock(() => {
        mocks.transactionAttempts += 1;
        return { ...inTxPostgresControlStatementMock, ...mocks.tx };
    });
});

// Only the interactive database transports are replaced. Admission, envelope
// validation, Account fences and transaction recovery all use their real owners.
vi.mock("@/storage/db", () => ({ db: transactions.wrapDb({}) }));
vi.mock("@/storage/prisma", async importOriginal => ({
    ...await importOriginal<typeof import("@/storage/prisma")>(),
    withSqliteReadSnapshot: transactions.readSnapshot,
}));

import { admitWorkflowRun, deriveWorkflowRunAvailability, listWorkflowRunsForRecovery } from "./workflowRunService";

beforeEach(async () => {
    vi.stubEnv("HAPPIER_DB_PROVIDER", "postgres");
    vi.stubEnv("HAPPY_DB_PROVIDER", "postgres");
    vi.stubEnv("HAPPIER_SERVER_IDENTITY_ID", "");
    mocks.transactionAttempts = 0;
    mocks.accountSeq = 1;
    mocks.recoveryWhere = null;
    mocks.acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: "plain", binding: { v: 1, purpose: "accepted_snapshot", accountId: "account-1", runId: "11111111-1111-4111-8111-111111111111" },
        acceptedSnapshot: await materializeWorkflowAcceptedSnapshotFixture({
            definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: "wait", id: "answer",
                document: { text: "Wait", references: [], attachments: [] }, result: { kind: "text" } }] },
            context: { source: { kind: "inline" }, inputs: {}, machineId: "machine-1", executionTarget: { kind: "session" },
                workspaceTarget: { project: { machineId: "machine-1", directory: "/repo", checkoutRootPath: "/repo" } },
                origin: { kind: "direct" }, authorization: { principal: { kind: "host" } } },
        }),
    }));
    const account = { id: "account-1", seq: 1, publicKey: "ab".repeat(32), encryptionMode: "plain",
        contentPublicKey: null, contentPublicKeySig: null, settings: null, settingsVersion: 0 };
    const winner = {
            id: "11111111-1111-4111-8111-111111111111",
            accountId: "account-1",
            originKind: "direct",
            automationId: null,
            sourceArtifactId: null,
            visibleTeamId: null,
            originSessionId: null,
            state: "queued",
            revision: 0,
            attempt: 0,
            claimedByMachineId: null,
            workflowCustodyState: "pending",
            originDeliveryAckRevision: null,
            workflowAcceptedSnapshotEnvelope: mocks.acceptedEnvelope,
            executionInputEnvelope: mocks.acceptedEnvelope,
            workflowCheckpointEnvelope: null,
            resultEnvelope: null,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            assignments: [{ machineId: "machine-1" }],
            workflowInvocations: [],
            _count: { workflowInvocations: 0 },
            producedSessionId: null,
            account: { encryptionMode: "plain" },
        };
    mocks.tx = {
            $queryRawUnsafe: async (query: string) => {
                if (query.includes('SET "seq" = "seq" + 1')) mocks.accountSeq += 1;
                return [{ id: account.id, accountId: account.id, cursor: mocks.accountSeq }];
            },
            account: { findUnique: async () => ({ ...account, seq: mocks.accountSeq }) },
            simpleCache: { findUnique: async () => null },
            session: { findMany: async () => [] },
            sessionFollowEdge: { findMany: async () => [] },
            automationTrigger: { findMany: async () => [] },
            automationRun: {
                findUnique: vi.fn(async () => mocks.transactionAttempts === 1 ? null : winner),
                findMany: vi.fn(async (args: { where: unknown }) => {
                    mocks.recoveryWhere = args.where;
                    return mocks.transactionAttempts === 1 ? [] : [winner];
                }),
                findFirst: vi.fn(async () => {
                    throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
                }),
                create: vi.fn(async () => {
                    throw Object.assign(new Error("duplicate run"), { code: "P2002" });
                }),
            },
            // Workflow admission reads the full Machine facts through the canonical access owner.
            machine: {
                findUnique: async () => ({ id: "machine-1", accountId: account.id, kind: "regular", active: true,
                    revokedAt: null, replacedByMachineId: null, installationId: "installation-1",
                    account: { encryptionMode: "plain", status: "active" },
                    metadata: null, daemonState: null, dataEncryptionKey: null, managedResource: null,
                    grants: [],   }),
                findFirst: async () => ({ id: "machine-1" }),
                findMany: async () => [{ accountId: account.id }],
            },
    };
});

afterEach(() => vi.unstubAllEnvs());

it("selects exact-machine terminal custody, cancellation and interrupted uncertainty recovery", async () => {
    await expect(listWorkflowRunsForRecovery({
        accountId: "account-1",
        machineId: "machine-1",
        pageByteLimit: 4_096,
    })).resolves.toEqual({ candidates: [] });

    expect(mocks.recoveryWhere).toEqual({
        accountId: "account-1",
        workflowCustodyState: { not: null },
        assignments: { some: { machineId: "machine-1" } },
        OR: [
            {
                state: { in: [
                    "succeeded",
                    "failed",
                    "cancelled",
                    "expired",
                    "dispatch_failed",
                    "skipped",
                    "missed",
                    "outcome_uncertain",
                ] },
                workflowCustodyState: "pending",
            },
            {
                state: { notIn: [
                    "succeeded",
                    "failed",
                    "cancelled",
                    "expired",
                    "dispatch_failed",
                    "skipped",
                    "missed",
                    "outcome_uncertain",
                ] },
                workflowCustodyState: "pending",
                workflowInvocations: { some: { OR: [
                    { lifecycle: "cancel_requested" },
                    { parentRecordId: null, lifecycle: "cancelled" },
                ] } },
            },
            {
                state: "interrupted",
                workflowCustodyState: "pending",
            },
        ],
    });
});

it("restarts the complete admission transaction after a unique Run race and rejoins the committed winner", async () => {
    await expect(admitWorkflowRun({
        accountId: "account-1",
        runId: "11111111-1111-4111-8111-111111111111",
        origin: { kind: "direct" },
        machineId: "machine-1",
        acceptedEnvelope: mocks.acceptedEnvelope,
        accountCurrentness: { mode: "plain", version: 1, contentKeyFingerprint: null },
    })).resolves.toMatchObject({ kind: "existing", run: { id: "11111111-1111-4111-8111-111111111111" } });
    expect(mocks.transactionAttempts).toBe(2);
    expect(mocks.accountSeq).toBe(1);
});

it("projects only coarse workspace-restore availability from server-visible Run facts", () => {
    expect(deriveWorkflowRunAvailability({
        state: "interrupted",
        workflowCustodyState: "pending",
        hasExecution: true,
    })).toMatchObject({ restoreWorkspace: true });

    expect(deriveWorkflowRunAvailability({
        state: "interrupted",
        workflowCustodyState: "pending",
        hasExecution: false,
    })).toMatchObject({
        restoreWorkspace: false,
        disabledReasons: expect.arrayContaining([
            { operation: "restore_workspace", code: "execution_not_admitted" },
        ]),
    });
});
