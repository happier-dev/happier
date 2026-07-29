import { beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION } from "@happier-dev/protocol";
import { createEnvPatcher } from "@/testkit/env";
import {
    getLatestSessionSystemRecord,
    getSessionSystemRecord,
    listSessionSystemRecords,
    upsertSessionSystemRecord,
} from "./sessionSystemRecordService";

type TxMock = {
    session: {
        findUnique: ReturnType<typeof vi.fn>;
    };
    sessionSystemRecord: {
        findUnique: ReturnType<typeof vi.fn>;
        findMany: ReturnType<typeof vi.fn>;
        findFirst: ReturnType<typeof vi.fn>;
        create: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
    };
};

const testState = vi.hoisted(() => ({
    checkSessionAccess: vi.fn(),
    currentTx: null as TxMock | null,
}));

vi.mock("@/app/share/accessControl", () => ({
    checkSessionAccess: testState.checkSessionAccess,
}));

vi.mock("@/storage/inTx", () => ({
    inTx: async <T>(fn: (tx: TxMock) => Promise<T>) => await fn(testState.currentTx as TxMock),
}));

function workflowRunPayload(overrides: Record<string, unknown> = {}) {
    return {
        v: 1,
        projectionVersion: SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
        runId: "wf_demo",
        backendId: "claude",
        title: "Demo workflow",
        status: "active",
        recordRevision: "1",
        updatedAt: 1000,
        totalAgents: 1,
        completedAgents: 0,
        phases: [{ id: "phase:1", title: "Research", order: 1, agentIds: ["a1"] }],
        agents: [{ id: "a1", title: "web_search", status: "active", phaseIndex: 1, updatedAt: 1000 }],
        ...overrides,
    };
}

describe("sessionSystemRecordService account scoping", () => {
    const storagePolicyEnv = createEnvPatcher(["HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY"]);

    beforeEach(() => {
        storagePolicyEnv.restore();
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
        vi.clearAllMocks();
        testState.checkSessionAccess.mockResolvedValue({ level: "edit", isOwner: false });
        testState.currentTx = {
            session: {
                findUnique: vi.fn(),
            },
            sessionSystemRecord: {
                findUnique: vi.fn(),
                findMany: vi.fn(),
                findFirst: vi.fn(),
                create: vi.fn(),
                update: vi.fn(),
            },
        };
    });

    it("stores shared-editor activity workflow records under the session owner account", async () => {
        const createdAt = new Date("2026-06-26T10:00:00.000Z");
        const currentTx = testState.currentTx as TxMock;
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findUnique.mockResolvedValue(null);
        currentTx.sessionSystemRecord.create.mockResolvedValue({
            id: "rec-wf",
            accountId: "owner-account",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
            localId: "activity:workflow_run:v1:wf_demo",
            content: { t: "plain", v: workflowRunPayload() },
            createdAt,
            updatedAt: createdAt,
        });

        const result = await upsertSessionSystemRecord({
            actorUserId: "shared-editor",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
            localId: "activity:workflow_run:v1:wf_demo",
            content: { t: "plain", v: workflowRunPayload() },
        });

        expect(result).toMatchObject({ ok: true, didCreate: true });
        expect(currentTx.sessionSystemRecord.findUnique).toHaveBeenCalledWith({
            where: {
                accountId_sessionId_namespace_localId: {
                    accountId: "owner-account",
                    sessionId: "s1",
                    namespace: "activity",
                    localId: "activity:workflow_run:v1:wf_demo",
                },
            },
            select: expect.any(Object),
        });
        expect(currentTx.sessionSystemRecord.create).toHaveBeenCalledWith({
            data: {
                accountId: "owner-account",
                sessionId: "s1",
                namespace: "activity",
                kind: "workflow_run.v1",
                localId: "activity:workflow_run:v1:wf_demo",
                content: { t: "plain", v: workflowRunPayload() },
            },
            select: expect.any(Object),
        });
    });

    it("keeps memory records actor-private for shared editors", async () => {
        const createdAt = new Date("2026-06-26T10:00:00.000Z");
        const currentTx = testState.currentTx as TxMock;
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findUnique.mockResolvedValue(null);
        currentTx.sessionSystemRecord.create.mockResolvedValue({
            id: "rec-memory",
            accountId: "shared-editor",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: "memory:synopsis:v1:2",
            content: { t: "plain", v: { v: 1, seqTo: 2, updatedAtMs: 3, synopsis: "hello" } },
            createdAt,
            updatedAt: createdAt,
        });

        const result = await upsertSessionSystemRecord({
            actorUserId: "shared-editor",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: "memory:synopsis:v1:2",
            content: { t: "plain", v: { v: 1, seqTo: 2, updatedAtMs: 3, synopsis: "hello" } },
        });

        expect(result).toMatchObject({ ok: true, didCreate: true });
        expect(currentTx.sessionSystemRecord.findUnique).toHaveBeenCalledWith({
            where: {
                accountId_sessionId_namespace_localId: {
                    accountId: "shared-editor",
                    sessionId: "s1",
                    namespace: "memory",
                    localId: "memory:synopsis:v1:2",
                },
            },
            select: expect.any(Object),
        });
    });

    it("reads shared activity workflow records from the session owner account", async () => {
        const createdAt = new Date("2026-06-26T10:00:00.000Z");
        const ownerRecord = {
            id: "rec-wf",
            accountId: "owner-account",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
            localId: "activity:workflow_run:v1:wf_demo",
            content: { t: "plain", v: workflowRunPayload() },
            createdAt,
            updatedAt: createdAt,
        };
        const currentTx = testState.currentTx as TxMock;
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findUnique.mockResolvedValue(ownerRecord);
        currentTx.sessionSystemRecord.findMany.mockResolvedValue([ownerRecord]);
        currentTx.sessionSystemRecord.findFirst.mockResolvedValue(ownerRecord);

        await getSessionSystemRecord({
            actorUserId: "shared-editor",
            sessionId: "s1",
            namespace: "activity",
            localId: "activity:workflow_run:v1:wf_demo",
        });
        await listSessionSystemRecords({
            actorUserId: "shared-editor",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
        });
        await getLatestSessionSystemRecord({
            actorUserId: "shared-editor",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
        });

        expect(currentTx.sessionSystemRecord.findUnique).toHaveBeenCalledWith({
            where: {
                accountId_sessionId_namespace_localId: {
                    accountId: "owner-account",
                    sessionId: "s1",
                    namespace: "activity",
                    localId: "activity:workflow_run:v1:wf_demo",
                },
            },
            select: expect.any(Object),
        });
        expect(currentTx.sessionSystemRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                sessionId: "s1",
                OR: [
                    {
                        accountId: "owner-account",
                        namespace: "activity",
                        kind: { in: ["workflow_run.v1"] },
                    },
                ],
            }),
        }));
        expect(currentTx.sessionSystemRecord.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                accountId: "owner-account",
                sessionId: "s1",
                namespace: "activity",
                kind: "workflow_run.v1",
            }),
        }));
    });

    it("keeps private historical-import rows outside unfiltered public pagination", async () => {
        const currentTx = testState.currentTx as TxMock;
        const createdAt = new Date("2026-07-25T23:30:00.000Z");
        const publicMemoryRecord = {
            id: "rec-memory",
            accountId: "owner-account",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: "memory:synopsis:v1:2",
            content: {
                t: "plain",
                v: { v: 1, seqTo: 2, updatedAtMs: 3, synopsis: "hello" },
            },
            createdAt,
            updatedAt: new Date(createdAt.getTime() - 1),
        };
        const publicActivityRecord = {
            id: "rec-activity",
            accountId: "owner-account",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
            localId: "activity:workflow_run:v1:wf_demo",
            content: { t: "plain", v: workflowRunPayload() },
            createdAt,
            updatedAt: new Date(createdAt.getTime() - 2),
        };
        const privateHistoricalImportRecord = {
            id: "rec-private-import",
            accountId: "owner-account",
            sessionId: "s1",
            namespace: "external_sessions",
            kind: "historical_import",
            localId: "historical-import:operation-1",
            content: {
                v: 1,
                materializationPublicationId: "private-publication-must-not-leak",
            },
            createdAt,
            updatedAt: createdAt,
        };
        currentTx.session.findUnique.mockResolvedValue({
            encryptionMode: "plain",
            accountId: "owner-account",
        });
        currentTx.sessionSystemRecord.findMany.mockImplementation(
            async ({ where, take }: {
                where: {
                    OR?: readonly { namespace?: string }[];
                    AND?: readonly { OR?: readonly { namespace?: string }[] }[];
                };
                take: number;
            }) => {
                const admittedNamespaces = new Set(
                    [
                        ...(where.OR ?? []),
                        ...(where.AND?.flatMap((scope) => scope.OR ?? []) ?? []),
                    ].flatMap((scope) => scope.namespace ? [scope.namespace] : []),
                );
                return [
                    privateHistoricalImportRecord,
                    publicMemoryRecord,
                    publicActivityRecord,
                ].filter((record) => (
                    admittedNamespaces.size === 0
                    || admittedNamespaces.has(record.namespace)
                )).slice(0, take);
            },
        );

        const result = await listSessionSystemRecords({
            actorUserId: "owner-account",
            sessionId: "s1",
            limit: 2,
        });

        expect(result).toMatchObject({
            ok: true,
            records: [
                { id: "rec-memory", namespace: "memory" },
                { id: "rec-activity", namespace: "activity" },
            ],
            nextCursor: null,
        });
        expect(JSON.stringify(result)).not.toContain("private-publication-must-not-leak");
        expect(currentTx.sessionSystemRecord.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    OR: expect.arrayContaining([
                        expect.objectContaining({ namespace: "memory" }),
                        expect.objectContaining({ namespace: "activity" }),
                    ]),
                }),
                take: 3,
            }),
        );

        const cursor = Buffer.from(
            `v1:${createdAt.getTime()}:rec-private-import`,
            "utf8",
        ).toString("base64url");
        const cursorPage = await listSessionSystemRecords({
            actorUserId: "owner-account",
            sessionId: "s1",
            limit: 2,
            cursor,
        });

        expect(cursorPage).toMatchObject({
            ok: true,
            records: [
                { id: "rec-memory", namespace: "memory" },
                { id: "rec-activity", namespace: "activity" },
            ],
            nextCursor: null,
        });
        expect(JSON.stringify(cursorPage)).not.toContain(
            "private-publication-must-not-leak",
        );
    });
});
