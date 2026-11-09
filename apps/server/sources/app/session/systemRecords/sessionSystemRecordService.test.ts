import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION } from "@happier-dev/protocol";
import { createEnvPatcher } from "@/testkit/env";
import { createDbMocks, installDbModuleMock } from "../../api/testkit/dbMocks";

const checkSessionAccess = vi.fn();
const requireAccessLevel = vi.fn((access: { level: string }, required: string) => {
    const levels = ["view", "edit", "admin", "owner"];
    return levels.indexOf(access.level) >= levels.indexOf(required);
});
vi.mock("@/app/share/accessControl", () => ({
    checkSessionAccess,
    requireAccessLevel,
}));

const markSessionParticipantsChanged = vi.fn();
vi.mock("@/app/session/changeTracking/markSessionParticipantsChanged", () => ({
    markSessionParticipantsChanged,
}));

const markAccountChanged = vi.fn();
vi.mock("@/app/changes/markAccountChanged", () => ({
    markAccountChanged,
}));

let currentTx: {
    session: {
        findUnique: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
    };
    sessionMessage: {
        create: ReturnType<typeof vi.fn>;
    };
    sessionSystemRecord: {
        findUnique: ReturnType<typeof vi.fn>;
        findMany: ReturnType<typeof vi.fn>;
        findFirst: ReturnType<typeof vi.fn>;
        create: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
    };
};

vi.mock("@/storage/inTx", () => ({
    IN_TX_OPERATION_LABELS: { sessionSystemRecordWrite: "session.system-record.write" },
    inTx: async (fn: (tx: typeof currentTx) => Promise<unknown>) => await fn(currentTx),
}));

const dbMocks = createDbMocks({
    session: ["findUnique"],
} as const);
installDbModuleMock({ db: dbMocks.db });

let upsertSessionSystemRecord: typeof import("./sessionSystemRecordService").upsertSessionSystemRecord;
let listSessionSystemRecords: typeof import("./sessionSystemRecordService").listSessionSystemRecords;
let getSessionSystemRecord: typeof import("./sessionSystemRecordService").getSessionSystemRecord;
let getLatestSessionSystemRecord: typeof import("./sessionSystemRecordService").getLatestSessionSystemRecord;

function synopsisPayload(overrides: Record<string, unknown> = {}) {
    return {
        v: 1,
        seqTo: 2,
        updatedAtMs: 3,
        synopsis: "hello",
        ...overrides,
    };
}

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

describe("sessionSystemRecordService", () => {
    const storagePolicyEnv = createEnvPatcher(["HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY"]);

    beforeAll(async () => {
        ({
            upsertSessionSystemRecord,
            listSessionSystemRecords,
            getSessionSystemRecord,
            getLatestSessionSystemRecord,
        } = await import("./sessionSystemRecordService"));
    });

    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
        storagePolicyEnv.restore();
        checkSessionAccess.mockResolvedValue({ level: "owner", isOwner: true });
        requireAccessLevel.mockClear();
        currentTx = {
            session: {
                findUnique: vi.fn(),
                update: vi.fn(),
            },
            sessionMessage: {
                create: vi.fn(),
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

    it("creates an accessible encrypted system record without transcript side effects", async () => {
        const createdAt = new Date("2026-05-19T10:00:00.000Z");
        checkSessionAccess.mockResolvedValueOnce({ level: "owner", isOwner: true });
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee" });
        currentTx.sessionSystemRecord.findUnique.mockResolvedValue(null);
        currentTx.sessionSystemRecord.create.mockResolvedValue({
            id: "rec-1",
            accountId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "summary_shard.v1",
            localId: "memory:summary_shard:v1:1-2",
            content: { t: "encrypted", c: "cipher" },
            createdAt,
            updatedAt: createdAt,
        });

        const result = await upsertSessionSystemRecord({
            actorUserId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "summary_shard.v1",
            localId: "memory:summary_shard:v1:1-2",
            content: { t: "encrypted", c: "cipher" },
        });

        expect(result).toEqual({
            ok: true,
            didCreate: true,
            didUpdate: false,
            record: {
                id: "rec-1",
                sessionId: "s1",
                namespace: "memory",
                kind: "summary_shard.v1",
                localId: "memory:summary_shard:v1:1-2",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            },
        });
        expect(checkSessionAccess).toHaveBeenCalledWith("u1", "s1");
        expect(requireAccessLevel).toHaveBeenCalledWith({ level: "owner", isOwner: true }, "edit");
        expect(currentTx.sessionSystemRecord.create).toHaveBeenCalledWith({
            data: {
                accountId: "u1",
                sessionId: "s1",
                namespace: "memory",
                kind: "summary_shard.v1",
                localId: "memory:summary_shard:v1:1-2",
                content: { t: "encrypted", c: "cipher" },
            },
            select: expect.any(Object),
        });
        expect(currentTx.session.update).not.toHaveBeenCalled();
        expect(currentTx.sessionMessage.create).not.toHaveBeenCalled();
        expect(markSessionParticipantsChanged).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
    });

    it("roundtrips an encrypted activity workflow record through the same generic service", async () => {
        const createdAt = new Date("2026-06-26T10:00:00.000Z");
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee", accountId: "u1" });
        currentTx.sessionSystemRecord.findUnique.mockResolvedValue(null);
        currentTx.sessionSystemRecord.create.mockResolvedValue({
            id: "rec-wf",
            accountId: "u1",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
            localId: "activity:workflow_run:v1:wf_demo",
            content: { t: "encrypted", c: "cipher" },
            createdAt,
            updatedAt: createdAt,
        });

        const result = await upsertSessionSystemRecord({
            actorUserId: "u1",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
            localId: "activity:workflow_run:v1:wf_demo",
            content: { t: "encrypted", c: "cipher" },
        });

        expect(result).toEqual({
            ok: true,
            didCreate: true,
            didUpdate: false,
            record: {
                id: "rec-wf",
                sessionId: "s1",
                namespace: "activity",
                kind: "workflow_run.v1",
                localId: "activity:workflow_run:v1:wf_demo",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            },
        });
        expect(currentTx.sessionSystemRecord.create).toHaveBeenCalledWith({
            data: {
                accountId: "u1",
                sessionId: "s1",
                namespace: "activity",
                kind: "workflow_run.v1",
                localId: "activity:workflow_run:v1:wf_demo",
                content: { t: "encrypted", c: "cipher" },
            },
            select: expect.any(Object),
        });
    });

    it("stores activity workflow records under the session owner account for shared editors", async () => {
        const createdAt = new Date("2026-06-26T10:00:00.000Z");
        checkSessionAccess.mockResolvedValueOnce({ level: "edit", isOwner: false });
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findUnique.mockResolvedValue(null);
        currentTx.sessionSystemRecord.create.mockResolvedValue({
            id: "rec-wf",
            accountId: "owner-account",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
            localId: "activity:workflow_run:v1:wf_demo",
            content: { t: "encrypted", c: "cipher" },
            createdAt,
            updatedAt: createdAt,
        });

        const result = await upsertSessionSystemRecord({
            actorUserId: "shared-editor",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
            localId: "activity:workflow_run:v1:wf_demo",
            content: { t: "encrypted", c: "cipher" },
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
                content: { t: "encrypted", c: "cipher" },
            },
            select: expect.any(Object),
        });
    });

    it("writes a plain activity workflow record for a plain session", async () => {
        const createdAt = new Date("2026-06-26T10:00:00.000Z");
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain" });
        currentTx.sessionSystemRecord.findUnique.mockResolvedValue(null);
        currentTx.sessionSystemRecord.create.mockResolvedValue({
            id: "rec-wf",
            accountId: "u1",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
            localId: "activity:workflow_run:v1:wf_demo",
            content: { t: "plain", v: workflowRunPayload() },
            createdAt,
            updatedAt: createdAt,
        });

        const result = await upsertSessionSystemRecord({
            actorUserId: "u1",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
            localId: "activity:workflow_run:v1:wf_demo",
            content: { t: "plain", v: workflowRunPayload() },
        });

        expect(result.ok).toBe(true);
        expect(currentTx.sessionSystemRecord.create).toHaveBeenCalled();
    });

    it("rejects plain activity workflow content for an e2ee session exactly like memory records", async () => {
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "required_e2ee");
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee" });

        const result = await upsertSessionSystemRecord({
            actorUserId: "u1",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
            localId: "activity:workflow_run:v1:wf_demo",
            content: { t: "plain", v: workflowRunPayload() },
        });

        expect(result).toEqual({ ok: false, error: "invalid-params", code: "storage_policy_requires_e2ee" });
        expect(currentTx.sessionSystemRecord.create).not.toHaveBeenCalled();
    });

    it("rejects plain activity content that does not match the workflow_run.v1 payload schema", async () => {
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain" });

        const result = await upsertSessionSystemRecord({
            actorUserId: "u1",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
            localId: "activity:workflow_run:v1:wf_demo",
            content: { t: "plain", v: workflowRunPayload({ status: "running" }) },
        });

        expect(result).toEqual({ ok: false, error: "invalid-params" });
        expect(currentTx.sessionSystemRecord.create).not.toHaveBeenCalled();
    });

    it("forbids view-only access from upserting durable system records", async () => {
        const createdAt = new Date("2026-05-19T10:00:00.000Z");
        checkSessionAccess.mockResolvedValueOnce({ level: "view", isOwner: false });
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee" });
        currentTx.sessionSystemRecord.findUnique.mockResolvedValue(null);
        currentTx.sessionSystemRecord.create.mockResolvedValue({
            id: "rec-viewer",
            accountId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "summary_shard.v1",
            localId: "memory:summary_shard:v1:1-2",
            content: { t: "encrypted", c: "cipher" },
            createdAt,
            updatedAt: createdAt,
        });

        const result = await upsertSessionSystemRecord({
            actorUserId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "summary_shard.v1",
            localId: "memory:summary_shard:v1:1-2",
            content: { t: "encrypted", c: "cipher" },
        });

        expect(result).toEqual({ ok: false, error: "forbidden" });
        expect(checkSessionAccess).toHaveBeenCalledWith("u1", "s1");
        expect(requireAccessLevel).toHaveBeenCalledWith({ level: "view", isOwner: false }, "edit");
        expect(currentTx.session.findUnique).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.findUnique).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.create).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.update).not.toHaveBeenCalled();
    });

    it("returns an existing record idempotently when kind and content match", async () => {
        const createdAt = new Date("2026-05-19T10:00:00.000Z");
        const existing = {
            id: "rec-existing",
            accountId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: "memory:synopsis:v1:2",
            content: { t: "encrypted", c: "cipher" },
            createdAt,
            updatedAt: createdAt,
        };
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee" });
        currentTx.sessionSystemRecord.findUnique.mockResolvedValue(existing);

        const result = await upsertSessionSystemRecord({
            actorUserId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: "memory:synopsis:v1:2",
            content: { t: "encrypted", c: "cipher" },
        });

        expect(result).toEqual({
            ok: true,
            didCreate: false,
            didUpdate: false,
            record: {
                id: "rec-existing",
                sessionId: "s1",
                namespace: "memory",
                kind: "synopsis.v1",
                localId: "memory:synopsis:v1:2",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            },
        });
        expect(currentTx.sessionSystemRecord.create).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.update).not.toHaveBeenCalled();
    });

    it("recovers idempotently when a concurrent create wins the unique localId race", async () => {
        const createdAt = new Date("2026-05-19T10:00:00.000Z");
        const existing = {
            id: "rec-existing",
            accountId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: "memory:synopsis:v1:2",
            content: { t: "encrypted", c: "cipher" },
            createdAt,
            updatedAt: createdAt,
        };
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee" });
        currentTx.sessionSystemRecord.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(existing);
        currentTx.sessionSystemRecord.create.mockRejectedValue({ code: "P2002" });

        const result = await upsertSessionSystemRecord({
            actorUserId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: "memory:synopsis:v1:2",
            content: { t: "encrypted", c: "cipher" },
        });

        expect(result).toEqual({
            ok: true,
            didCreate: false,
            didUpdate: false,
            record: {
                id: "rec-existing",
                sessionId: "s1",
                namespace: "memory",
                kind: "synopsis.v1",
                localId: "memory:synopsis:v1:2",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            },
        });
        expect(currentTx.sessionSystemRecord.findUnique).toHaveBeenCalledTimes(2);
        expect(currentTx.sessionSystemRecord.update).not.toHaveBeenCalled();
    });

    it("rejects localId reuse with a different kind", async () => {
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee" });
        currentTx.sessionSystemRecord.findUnique.mockResolvedValue({
            id: "rec-existing",
            accountId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: "memory:shared",
            content: { t: "encrypted", c: "cipher" },
            createdAt: new Date(1),
            updatedAt: new Date(1),
        });

        const result = await upsertSessionSystemRecord({
            actorUserId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "summary_shard.v1",
            localId: "memory:shared",
            content: { t: "encrypted", c: "cipher" },
        });

        expect(result).toEqual({ ok: false, error: "conflict" });
        expect(currentTx.sessionSystemRecord.create).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.update).not.toHaveBeenCalled();
    });

    it("updates an existing record when kind matches and content differs", async () => {
        const createdAt = new Date("2026-05-19T10:00:00.000Z");
        const updatedAt = new Date("2026-05-19T10:02:00.000Z");
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain" });
        currentTx.sessionSystemRecord.findUnique.mockResolvedValue({
            id: "rec-existing",
            accountId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: "memory:synopsis:v1:2",
            content: { t: "plain", v: synopsisPayload({ synopsis: "old" }) },
            createdAt,
            updatedAt: createdAt,
        });
        currentTx.sessionSystemRecord.update.mockResolvedValue({
            id: "rec-existing",
            accountId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: "memory:synopsis:v1:2",
            content: { t: "plain", v: synopsisPayload({ synopsis: "next" }) },
            createdAt,
            updatedAt,
        });
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");

        const result = await upsertSessionSystemRecord({
            actorUserId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: "memory:synopsis:v1:2",
            content: { t: "plain", v: synopsisPayload({ synopsis: "next" }) },
        });

        expect(result).toEqual({
            ok: true,
            didCreate: false,
            didUpdate: true,
            record: {
                id: "rec-existing",
                sessionId: "s1",
                namespace: "memory",
                kind: "synopsis.v1",
                localId: "memory:synopsis:v1:2",
                content: { t: "plain", v: synopsisPayload({ synopsis: "next" }) },
                createdAt,
                updatedAt,
            },
        });
        expect(currentTx.sessionSystemRecord.update).toHaveBeenCalledWith({
            where: { id: "rec-existing" },
            data: { content: { t: "plain", v: synopsisPayload({ synopsis: "next" }) } },
            select: expect.any(Object),
        });
        expect(currentTx.session.update).not.toHaveBeenCalled();
    });

    it("rejects plain content for an e2ee session", async () => {
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "required_e2ee");
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee" });

        const result = await upsertSessionSystemRecord({
            actorUserId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: "memory:synopsis:v1:2",
            content: { t: "plain", v: synopsisPayload() },
        });

        expect(result).toEqual({ ok: false, error: "invalid-params", code: "storage_policy_requires_e2ee" });
        expect(currentTx.sessionSystemRecord.create).not.toHaveBeenCalled();
    });

    it("rejects plain content that does not match the registered memory payload schema", async () => {
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain" });

        const result = await upsertSessionSystemRecord({
            actorUserId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: "memory:synopsis:v1:2",
            content: { t: "plain", v: { anything: true } },
        });

        expect(result).toEqual({ ok: false, error: "invalid-params" });
        expect(currentTx.sessionSystemRecord.findUnique).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.create).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.update).not.toHaveBeenCalled();
    });

    it("rejects encrypted content for a plain session", async () => {
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain" });

        const result = await upsertSessionSystemRecord({
            actorUserId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: "memory:synopsis:v1:2",
            content: { t: "encrypted", c: "cipher" },
        });

        expect(result).toEqual({ ok: false, error: "invalid-params", code: "session_encryption_mode_mismatch" });
        expect(currentTx.sessionSystemRecord.create).not.toHaveBeenCalled();
    });

    it("lists only records owned by the authenticated account", async () => {
        const createdAt = new Date("2026-05-19T10:00:00.000Z");
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee" });
        currentTx.sessionSystemRecord.findMany.mockResolvedValue([
            {
                id: "rec-1",
                accountId: "u2",
                sessionId: "s1",
                namespace: "memory",
                kind: "summary_shard.v1",
                localId: "memory:summary_shard:v1:1-2",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            },
        ]);

        const result = await listSessionSystemRecords({
            actorUserId: "u2",
            sessionId: "s1",
            namespace: "memory",
            kind: "summary_shard.v1",
            localId: "memory:summary_shard:v1:1-2",
            limit: 50,
        });

        expect(result).toEqual({
            ok: true,
            records: [
                {
                    id: "rec-1",
                    sessionId: "s1",
                    namespace: "memory",
                    kind: "summary_shard.v1",
                    localId: "memory:summary_shard:v1:1-2",
                    content: { t: "encrypted", c: "cipher" },
                    createdAt,
                    updatedAt: createdAt,
                },
            ],
            nextCursor: null,
        });
        expect(currentTx.sessionSystemRecord.findMany).toHaveBeenCalledWith({
            where: {
                accountId: "u2",
                sessionId: "s1",
                namespace: "memory",
                kind: "summary_shard.v1",
                localId: "memory:summary_shard:v1:1-2",
            },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            take: 51,
            select: expect.any(Object),
        });
    });

    it("lists shared activity workflow records from the session owner account", async () => {
        const createdAt = new Date("2026-06-26T10:00:00.000Z");
        checkSessionAccess.mockResolvedValueOnce({ level: "view", isOwner: false });
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findMany.mockResolvedValue([
            {
                id: "rec-wf",
                accountId: "owner-account",
                sessionId: "s1",
                namespace: "activity",
                kind: "workflow_run.v1",
                localId: "activity:workflow_run:v1:wf_demo",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            },
        ]);

        const result = await listSessionSystemRecords({
            actorUserId: "shared-viewer",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
            limit: 50,
        });

        expect(result).toMatchObject({ ok: true, records: [{ id: "rec-wf" }] });
        expect(currentTx.sessionSystemRecord.findMany).toHaveBeenCalledWith({
            where: {
                accountId: "owner-account",
                sessionId: "s1",
                namespace: "activity",
                kind: "workflow_run.v1",
            },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            take: 51,
            select: expect.any(Object),
        });
    });

    it("returns the latest matching record owned by the authenticated account", async () => {
        const createdAt = new Date("2026-05-19T10:00:00.000Z");
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee" });
        currentTx.sessionSystemRecord.findFirst.mockResolvedValue({
            id: "rec-1",
            accountId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: "memory:synopsis:v1:2",
            content: { t: "encrypted", c: "cipher" },
            createdAt,
            updatedAt: createdAt,
        });

        const result = await getLatestSessionSystemRecord({
            actorUserId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
        });

        expect(result).toEqual({
            ok: true,
            record: {
                id: "rec-1",
                sessionId: "s1",
                namespace: "memory",
                kind: "synopsis.v1",
                localId: "memory:synopsis:v1:2",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            },
        });
        expect(currentTx.sessionSystemRecord.findFirst).toHaveBeenCalledWith({
            where: {
                accountId: "u1",
                sessionId: "s1",
                namespace: "memory",
                kind: "synopsis.v1",
            },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            select: expect.any(Object),
        });
    });

    it("returns a single record by namespace and localId without transcript side effects", async () => {
        const createdAt = new Date("2026-05-19T10:00:00.000Z");
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee" });
        currentTx.sessionSystemRecord.findUnique.mockResolvedValue({
            id: "rec-lookup",
            accountId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: "memory:synopsis:v1:2",
            content: { t: "encrypted", c: "cipher" },
            createdAt,
            updatedAt: createdAt,
        });

        const result = await getSessionSystemRecord({
            actorUserId: "u1",
            sessionId: "s1",
            namespace: "memory",
            localId: "memory:synopsis:v1:2",
        });

        expect(result).toEqual({
            ok: true,
            record: {
                id: "rec-lookup",
                sessionId: "s1",
                namespace: "memory",
                kind: "synopsis.v1",
                localId: "memory:synopsis:v1:2",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            },
        });
        expect(currentTx.sessionSystemRecord.findUnique).toHaveBeenCalledWith({
            where: {
                accountId_sessionId_namespace_localId: {
                    accountId: "u1",
                    sessionId: "s1",
                    namespace: "memory",
                    localId: "memory:synopsis:v1:2",
                },
            },
            select: expect.any(Object),
        });
        expect(currentTx.session.update).not.toHaveBeenCalled();
        expect(currentTx.sessionMessage.create).not.toHaveBeenCalled();
        expect(markSessionParticipantsChanged).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
    });

    it("returns shared activity workflow records from the session owner account", async () => {
        const createdAt = new Date("2026-06-26T10:00:00.000Z");
        checkSessionAccess.mockResolvedValueOnce({ level: "view", isOwner: false });
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findUnique.mockResolvedValue({
            id: "rec-wf",
            accountId: "owner-account",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
            localId: "activity:workflow_run:v1:wf_demo",
            content: { t: "encrypted", c: "cipher" },
            createdAt,
            updatedAt: createdAt,
        });

        const result = await getSessionSystemRecord({
            actorUserId: "shared-viewer",
            sessionId: "s1",
            namespace: "activity",
            localId: "activity:workflow_run:v1:wf_demo",
        });

        expect(result).toMatchObject({ ok: true, record: { id: "rec-wf" } });
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
    });
});
