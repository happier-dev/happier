import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    deriveSessionPermissionMediationRecordLocatorV1,
    SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
    type SessionPermissionMediationRecordIdentityV1,
} from "@happier-dev/protocol";
import { createEnvPatcher } from "@/testkit/env";
import {
    deleteSessionSystemRecordV1,
    getLatestSessionSystemRecord,
    getSessionSystemRecord,
    listSessionSystemRecordsV1,
    listSessionSystemRecords,
    listPermissionMediationRecords,
    prunePermissionMediationRecord,
    readPermissionMediationRecord,
    readSessionSystemRecordV1,
    upsertSessionSystemRecordV1,
    upsertSessionSystemRecord,
    writePermissionMediationRecord,
} from "./sessionSystemRecordService";
import { deriveSessionSystemRecordAddressKeys } from "./sessionSystemRecordAddressKeys";
import {
    initializeSessionSystemRecordsProtocolV1Activation,
    resetSessionSystemRecordsProtocolV1ActivationForTests,
    SESSION_SYSTEM_RECORDS_CONTRACT_MIGRATION,
} from "./sessionSystemRecordProtocolContract";
import { encodeSessionSystemRecordRevision } from "./sessionSystemRecordRevision";

// Prisma is the system boundary; protocol-activation fixtures expose only its audited findMany operation.
type ProtocolActivationDatabase = Parameters<typeof initializeSessionSystemRecordsProtocolV1Activation>[0];

type TxMock = {
    session: {
        findUnique: ReturnType<typeof vi.fn>;
        findFirst: ReturnType<typeof vi.fn>;
    };
    sessionSystemRecord: {
        findUnique: ReturnType<typeof vi.fn>;
        findMany: ReturnType<typeof vi.fn>;
        findFirst: ReturnType<typeof vi.fn>;
        create: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
        updateMany: ReturnType<typeof vi.fn>;
        deleteMany: ReturnType<typeof vi.fn>;
    };
};

const testState = vi.hoisted(() => ({
    checkSessionAccess: vi.fn(),
    currentTx: null as TxMock | null,
}));

vi.mock("@/app/share/accessControl", async (importOriginal) => ({
    ...await importOriginal<typeof import("@/app/share/accessControl")>(),
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

const ACTIVITY_NAMESPACE_KEY = Uint8Array.from(Buffer.from(
    "f41076a2bcb5e029d45eacb7f39bb5c0770477a9b2c15be533aca78d9ec11cf2",
    "hex",
));
const ACTIVITY_WORKFLOW_RECORD_KEY = Uint8Array.from(Buffer.from(
    "eb24a1da14ef90199e4951fe70ffd8d37a9dcada923ea7d14ee5a982efe2e3ea",
    "hex",
));

function activityRecord(overrides: Record<string, unknown> = {}) {
    const createdAt = new Date("2026-06-26T10:00:00.000Z");
    return {
        id: "rec-wf",
        accountId: "owner-account",
        sessionId: "s1",
        namespace: "activity",
        kind: "workflow_run.v1",
        localId: "activity:workflow_run:v1:wf_demo",
        content: { t: "plain" as const, v: workflowRunPayload() },
        ownerKind: "host",
        pluginId: null,
        namespaceAddressKey: ACTIVITY_NAMESPACE_KEY,
        recordAddressKey: ACTIVITY_WORKFLOW_RECORD_KEY,
        version: 1,
        createdAt,
        updatedAt: createdAt,
        ...overrides,
    };
}

const permissionMediationIdentity = {
    sessionId: "s1",
    turnId: "permission-turn-1",
    requestId: "permission-request-1",
} as const satisfies SessionPermissionMediationRecordIdentityV1;

function permissionMediationRecord(overrides: Record<string, unknown> = {}) {
    const createdAt = new Date("2026-08-10T10:00:00.000Z");
    const identity = {
        sessionId: typeof overrides.sessionId === "string" ? overrides.sessionId : permissionMediationIdentity.sessionId,
        turnId: typeof overrides.turnId === "string" ? overrides.turnId : permissionMediationIdentity.turnId,
        requestId: typeof overrides.requestId === "string" ? overrides.requestId : permissionMediationIdentity.requestId,
    } satisfies SessionPermissionMediationRecordIdentityV1;
    const { sessionId: _sessionId, turnId: _turnId, requestId: _requestId, ...rowOverrides } = overrides;
    const localId = deriveSessionPermissionMediationRecordLocatorV1(identity);
    return {
        id: "permission-record-1",
        accountId: "owner-account",
        sessionId: identity.sessionId,
        namespace: "permission",
        kind: "remote_settlement.v1",
        localId,
        permissionTurnId: identity.turnId,
        permissionRequestId: identity.requestId,
        content: { t: "plain" as const, v: { opaque: "mediation" } },
        ownerKind: "host",
        pluginId: null,
        ...deriveSessionSystemRecordAddressKeys({
            ownerKind: "host",
            pluginId: null,
            namespace: "permission",
            localId,
        }),
        version: 1,
        createdAt,
        updatedAt: createdAt,
        ...rowOverrides,
    };
}

describe("sessionSystemRecordService account scoping", () => {
    const storagePolicyEnv = createEnvPatcher(["HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY"]);

    beforeEach(async () => {
        storagePolicyEnv.restore();
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
        vi.clearAllMocks();
        resetSessionSystemRecordsProtocolV1ActivationForTests();
        await initializeSessionSystemRecordsProtocolV1Activation({
            $queryRawUnsafe: async () => [{
                migration_name: SESSION_SYSTEM_RECORDS_CONTRACT_MIGRATION,
            }],
            sessionSystemRecord: {
                findMany: async () => [],
            },
        } as unknown as ProtocolActivationDatabase);
        testState.checkSessionAccess.mockResolvedValue({ level: "edit", isOwner: false });
        testState.currentTx = {
            session: {
                findUnique: vi.fn(),
                findFirst: vi.fn().mockResolvedValue({ id: "s1" }),
            },
            sessionSystemRecord: {
                findUnique: vi.fn(),
                findMany: vi.fn(),
                findFirst: vi.fn(),
                create: vi.fn(),
                update: vi.fn(),
                updateMany: vi.fn(),
                deleteMany: vi.fn(),
            },
        };
    });

    it("rejects direct v1 service calls before access or persistence while CONTRACT remains inactive", async () => {
        await initializeSessionSystemRecordsProtocolV1Activation({
            $queryRawUnsafe: async () => [],
            sessionSystemRecord: {
                findMany: async () => [],
            },
        } as unknown as ProtocolActivationDatabase);
        const currentTx = testState.currentTx as TxMock;

        await expect(listSessionSystemRecordsV1({
            actorUserId: "viewer-account",
            sessionId: "s1",
            pluginId: "acme.notes",
            query: { owner: "plugin", namespace: "notes", limit: 10 },
        })).resolves.toEqual({ ok: false, code: "plugin_session_records_unavailable" });

        expect(testState.checkSessionAccess).not.toHaveBeenCalled();
        expect(currentTx.session.findUnique).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.findMany).not.toHaveBeenCalled();
    });

    it("keeps typed permission mediation records fail-closed until CONTRACT activation", async () => {
        await initializeSessionSystemRecordsProtocolV1Activation({
            $queryRawUnsafe: async () => [],
            sessionSystemRecord: {
                findMany: async () => [],
            },
        } as unknown as ProtocolActivationDatabase);
        const currentTx = testState.currentTx as TxMock;

        await expect(readPermissionMediationRecord({
            actorUserId: "viewer-account",
            sessionId: "s1",
            identity: permissionMediationIdentity,
        })).resolves.toEqual({ ok: false, code: "permission_mediation_records_unavailable" });
        await expect(listPermissionMediationRecords({
            actorUserId: "viewer-account",
            sessionId: "s1",
            query: { limit: 10 },
        })).resolves.toEqual({ ok: false, code: "permission_mediation_records_unavailable" });
        await expect(writePermissionMediationRecord({
            actorUserId: "viewer-account",
            sessionId: "s1",
            identity: permissionMediationIdentity,
            request: {
                kind: "remote_settlement.v1",
                content: { t: "plain", v: { opaque: "mediation" } },
                expectedRevision: null,
            },
        })).resolves.toEqual({ ok: false, code: "permission_mediation_records_unavailable" });
        expect(testState.checkSessionAccess).not.toHaveBeenCalled();
        expect(currentTx.session.findUnique).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.create).not.toHaveBeenCalled();
    });

    it("keeps the owner-private typed permission ledger closed to shared editors", async () => {
        const currentTx = testState.currentTx as TxMock;
        testState.checkSessionAccess.mockResolvedValue({ level: "admin", isOwner: false });

        await expect(readPermissionMediationRecord({
            actorUserId: "shared-admin",
            sessionId: "s1",
            identity: permissionMediationIdentity,
        })).resolves.toEqual({ ok: false, code: "permission_mediation_record_forbidden" });
        await expect(prunePermissionMediationRecord({
            actorUserId: "shared-admin",
            sessionId: "s1",
            identity: permissionMediationIdentity,
            request: { expectedRevision: "ssr1.AAAACnJlY29yZC1vbmUAAAAB" },
        })).resolves.toEqual({ ok: false, code: "permission_mediation_record_forbidden" });
        await expect(listPermissionMediationRecords({
            actorUserId: "shared-admin",
            sessionId: "s1",
            query: { limit: 10 },
        })).resolves.toEqual({ ok: false, code: "permission_mediation_record_forbidden" });
        await expect(writePermissionMediationRecord({
            actorUserId: "shared-admin",
            sessionId: "s1",
            identity: permissionMediationIdentity,
            request: {
                kind: "remote_settlement.v1",
                content: { t: "plain", v: { opaque: "mediation" } },
                expectedRevision: null,
            },
        })).resolves.toEqual({ ok: false, code: "permission_mediation_record_forbidden" });

        expect(currentTx.session.findUnique).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.findFirst).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.findMany).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.create).not.toHaveBeenCalled();
    });

    it("prunes only a fixed permission row at the exact opened revision", async () => {
        const currentTx = testState.currentTx as TxMock;
        testState.checkSessionAccess.mockResolvedValue({ level: "owner", isOwner: true });
        const row = permissionMediationRecord();
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst.mockResolvedValue(row);
        currentTx.sessionSystemRecord.deleteMany.mockResolvedValue({ count: 1 });

        const opened = await readPermissionMediationRecord({
            actorUserId: "owner-account",
            sessionId: "s1",
            identity: permissionMediationIdentity,
        });
        if (!opened.ok || !opened.record) throw new Error("expected opened permission mediation row");

        await expect(prunePermissionMediationRecord({
            actorUserId: "owner-account",
            sessionId: "s1",
            identity: permissionMediationIdentity,
            request: { expectedRevision: opened.record.revision },
        })).resolves.toEqual({ ok: true });
        expect(currentTx.sessionSystemRecord.deleteMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                accountId: "owner-account",
                sessionId: "s1",
                id: "permission-record-1",
                version: 1,
            }),
        }));
    });

    it("uses a fixed host permission address for create and CAS updates", async () => {
        const currentTx = testState.currentTx as TxMock;
        testState.checkSessionAccess.mockResolvedValue({ level: "owner", isOwner: true });
        const first = permissionMediationRecord();
        const second = permissionMediationRecord({
            content: { t: "plain", v: { opaque: "revoked" } },
            version: 2,
            updatedAt: new Date("2026-08-10T10:01:00.000Z"),
        });
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(first)
            .mockResolvedValueOnce(second);
        currentTx.sessionSystemRecord.create.mockResolvedValue(first);
        currentTx.sessionSystemRecord.updateMany.mockResolvedValue({ count: 1 });

        const created = await writePermissionMediationRecord({
            actorUserId: "owner-account",
            sessionId: "s1",
            identity: permissionMediationIdentity,
            request: {
                kind: "remote_settlement.v1",
                content: { t: "plain", v: { opaque: "mediation" } },
                expectedRevision: null,
            },
        });
        expect(created).toMatchObject({
            ok: true,
            record: {
                ...permissionMediationIdentity,
                kind: "remote_settlement.v1",
                revision: expect.stringMatching(/^ssr1\./),
            },
        });
        if (!created.ok) throw new Error("expected created mediation record");
        expect(currentTx.sessionSystemRecord.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                accountId: "owner-account",
                ownerKind: "host",
                pluginId: null,
                namespace: "permission",
                kind: "remote_settlement.v1",
                localId: deriveSessionPermissionMediationRecordLocatorV1(permissionMediationIdentity),
            }),
        }));

        await expect(writePermissionMediationRecord({
            actorUserId: "owner-account",
            sessionId: "s1",
            identity: permissionMediationIdentity,
            request: {
                kind: "remote_settlement.v1",
                content: { t: "plain", v: { opaque: "revoked" } },
                expectedRevision: created.record.revision,
            },
        })).resolves.toMatchObject({
            ok: true,
            record: { revision: expect.stringMatching(/^ssr1\./) },
        });
        expect(currentTx.sessionSystemRecord.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ id: "permission-record-1", version: 1 }),
        }));
    });

    it("keeps equal request ids in different turns at independent bounded host addresses", async () => {
        const currentTx = testState.currentTx as TxMock;
        const nextIdentity = {
            ...permissionMediationIdentity,
            turnId: "permission-turn-2",
        } satisfies SessionPermissionMediationRecordIdentityV1;
        const first = permissionMediationRecord();
        const second = permissionMediationRecord({
            turnId: nextIdentity.turnId,
            id: "permission-record-2",
        });
        testState.checkSessionAccess.mockResolvedValue({ level: "owner", isOwner: true });
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst.mockResolvedValue(null);
        currentTx.sessionSystemRecord.create.mockImplementation(async ({ data }) => (
            data.localId === first.localId ? first : second
        ));

        const request = {
            kind: "remote_settlement.v1" as const,
            content: { t: "plain" as const, v: { opaque: "mediation" } },
            expectedRevision: null,
        };
        await expect(writePermissionMediationRecord({
            actorUserId: "owner-account",
            sessionId: "s1",
            identity: permissionMediationIdentity,
            request,
        })).resolves.toMatchObject({ ok: true, record: permissionMediationIdentity });
        await expect(writePermissionMediationRecord({
            actorUserId: "owner-account",
            sessionId: "s1",
            identity: nextIdentity,
            request,
        })).resolves.toMatchObject({ ok: true, record: nextIdentity });

        const locators = currentTx.sessionSystemRecord.create.mock.calls.map(([call]) => call.data.localId);
        expect(locators).toEqual([
            deriveSessionPermissionMediationRecordLocatorV1(permissionMediationIdentity),
            deriveSessionPermissionMediationRecordLocatorV1(nextIdentity),
        ]);
        expect(locators[0]).not.toBe(locators[1]);
    });

    it("persists a supported maximum tuple outside the MySQL local-id budget without opening its content", async () => {
        const currentTx = testState.currentTx as TxMock;
        const identity = {
            sessionId: "s1",
            turnId: "t".repeat(191),
            requestId: "r".repeat(256),
        } satisfies SessionPermissionMediationRecordIdentityV1;
        const row = permissionMediationRecord({
            turnId: identity.turnId,
            requestId: identity.requestId,
            content: { t: "encrypted", c: "opaque-ciphertext" },
        });
        testState.checkSessionAccess.mockResolvedValue({ level: "owner", isOwner: true });
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst.mockResolvedValue(null);
        currentTx.sessionSystemRecord.create.mockResolvedValue(row);

        await expect(writePermissionMediationRecord({
            actorUserId: "owner-account",
            sessionId: identity.sessionId,
            identity,
            request: {
                kind: "remote_settlement.v1",
                content: { t: "encrypted", c: "opaque-ciphertext" },
                expectedRevision: null,
            },
        })).resolves.toMatchObject({
            ok: true,
            record: {
                ...identity,
                content: { t: "encrypted", c: "opaque-ciphertext" },
            },
        });
        expect(row.localId).toHaveLength(48);
        expect(currentTx.sessionSystemRecord.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                localId: row.localId,
                permissionTurnId: identity.turnId,
                permissionRequestId: identity.requestId,
            }),
        }));
    });

    it("projects the exact persisted mediation identity without opening E2EE content", async () => {
        const currentTx = testState.currentTx as TxMock;
        const row = permissionMediationRecord({ content: { t: "encrypted", c: "opaque-ciphertext" } });
        testState.checkSessionAccess.mockResolvedValue({ level: "owner", isOwner: true });
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findMany.mockResolvedValue([row]);

        await expect(listPermissionMediationRecords({
            actorUserId: "owner-account",
            sessionId: "s1",
            query: { limit: 10 },
        })).resolves.toEqual({
            ok: true,
            page: {
                records: [{
                    ...permissionMediationIdentity,
                    kind: "remote_settlement.v1",
                    content: { t: "encrypted", c: "opaque-ciphertext" },
                    revision: encodeSessionSystemRecordRevision({ id: "permission-record-1", version: 1 }),
                }],
                nextCursor: null,
                hasNext: false,
            },
        });
    });

    it("fails closed when a canonical mediation locator resolves under another Session", async () => {
        const currentTx = testState.currentTx as TxMock;
        // The locator intentionally excludes Session scope, so the containing
        // row must still agree with the exact route identity without opening
        // an opaque E2EE payload.
        const crossSessionRow = permissionMediationRecord({
            sessionId: "s2",
            content: { t: "encrypted", c: "opaque-ciphertext" },
        });
        testState.checkSessionAccess.mockResolvedValue({ level: "owner", isOwner: true });
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst.mockResolvedValue(crossSessionRow);
        currentTx.sessionSystemRecord.findMany.mockResolvedValue([crossSessionRow]);

        await expect(readPermissionMediationRecord({
            actorUserId: "owner-account",
            sessionId: permissionMediationIdentity.sessionId,
            identity: permissionMediationIdentity,
        })).resolves.toEqual({ ok: false, code: "permission_mediation_record_internal" });
        await expect(listPermissionMediationRecords({
            actorUserId: "owner-account",
            sessionId: permissionMediationIdentity.sessionId,
            query: { limit: 10 },
        })).resolves.toEqual({ ok: false, code: "permission_mediation_record_internal" });
    });

    it("refetches the actual permission revision after a lost conditional write", async () => {
        const currentTx = testState.currentTx as TxMock;
        testState.checkSessionAccess.mockResolvedValue({ level: "owner", isOwner: true });
        const beforeRace = permissionMediationRecord();
        const raced = permissionMediationRecord({
            content: { t: "plain", v: { opaque: "winner" } },
            version: 2,
            updatedAt: new Date("2026-08-10T10:01:00.000Z"),
        });
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst
            .mockResolvedValueOnce(beforeRace)
            .mockResolvedValueOnce(raced);
        currentTx.sessionSystemRecord.updateMany.mockResolvedValue({ count: 0 });

        await expect(writePermissionMediationRecord({
            actorUserId: "owner-account",
            sessionId: "s1",
            identity: permissionMediationIdentity,
            request: {
                kind: "remote_settlement.v1",
                content: { t: "plain", v: { opaque: "requested" } },
                expectedRevision: encodeSessionSystemRecordRevision({ id: "permission-record-1", version: 1 }),
            },
        })).resolves.toEqual({
            ok: false,
            code: "permission_mediation_record_conflict",
            currentRevision: encodeSessionSystemRecordRevision({ id: "permission-record-1", version: 2 }),
        });
    });

    it("refetches the actual permission revision after a lost prune", async () => {
        const currentTx = testState.currentTx as TxMock;
        testState.checkSessionAccess.mockResolvedValue({ level: "owner", isOwner: true });
        const beforeRace = permissionMediationRecord();
        const raced = permissionMediationRecord({
            content: { t: "plain", v: { opaque: "winner" } },
            version: 2,
            updatedAt: new Date("2026-08-10T10:01:00.000Z"),
        });
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst
            .mockResolvedValueOnce(beforeRace)
            .mockResolvedValueOnce(raced);
        currentTx.sessionSystemRecord.deleteMany.mockResolvedValue({ count: 0 });

        await expect(prunePermissionMediationRecord({
            actorUserId: "owner-account",
            sessionId: "s1",
            identity: permissionMediationIdentity,
            request: {
                expectedRevision: encodeSessionSystemRecordRevision({ id: "permission-record-1", version: 1 }),
            },
        })).resolves.toEqual({
            ok: false,
            code: "permission_mediation_record_conflict",
            currentRevision: encodeSessionSystemRecordRevision({ id: "permission-record-1", version: 2 }),
        });
    });

    it("creates an account-private host-stamped plugin record and returns its opaque revision", async () => {
        const createdAt = new Date("2026-08-03T10:00:00.000Z");
        const currentTx = testState.currentTx as TxMock;
        testState.checkSessionAccess.mockResolvedValue({ level: "view", isOwner: false });
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst.mockResolvedValue(null);
        currentTx.sessionSystemRecord.create.mockResolvedValue({
            id: "record-one",
            accountId: "viewer-account",
            sessionId: "s1",
            ownerKind: "plugin",
            pluginId: "acme.notes",
            namespace: "notes",
            kind: "entry.v1",
            localId: "note:one",
            content: { t: "plain", v: { title: "One" } },
            namespaceAddressKey: new Uint8Array(32),
            recordAddressKey: new Uint8Array(32),
            version: 1,
            createdAt,
            updatedAt: createdAt,
        });

        const result = await upsertSessionSystemRecordV1({
            actorUserId: "viewer-account",
            sessionId: "s1",
            pluginId: "acme.notes",
            address: { owner: "plugin", namespace: "notes", kind: "entry.v1", localId: "note:one" },
            content: { t: "plain", v: { title: "One" } },
            expectedRevision: null,
        });

        expect(result).toMatchObject({
            ok: true,
            record: {
                id: "record-one",
                address: { owner: "plugin", namespace: "notes", kind: "entry.v1", localId: "note:one" },
                content: { t: "plain", v: { title: "One" } },
                revision: expect.stringMatching(/^ssr1\./),
            },
        });
        expect(currentTx.sessionSystemRecord.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                accountId: "viewer-account",
                sessionId: "s1",
                ownerKind: "plugin",
                pluginId: "acme.notes",
                namespace: "notes",
                kind: "entry.v1",
                localId: "note:one",
                version: 1,
            }),
        }));
    });

    it("applies catalog-owned session-owner/edit policy across host v1 CRUD", async () => {
        const currentTx = testState.currentTx as TxMock;
        const row = activityRecord();
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst.mockResolvedValue(row);
        currentTx.sessionSystemRecord.findMany.mockResolvedValue([row]);
        currentTx.sessionSystemRecord.deleteMany.mockResolvedValue({ count: 1 });
        const address = {
            owner: "host" as const,
            namespace: "activity" as const,
            kind: "workflow_run.v1" as const,
            localId: "activity:workflow_run:v1:wf_demo",
        };

        await expect(readSessionSystemRecordV1({
            actorUserId: "shared-editor",
            sessionId: "s1",
            address,
        })).resolves.toMatchObject({ ok: true, record: { address, revision: expect.stringMatching(/^ssr1\./) } });
        await expect(listSessionSystemRecordsV1({
            actorUserId: "shared-editor",
            sessionId: "s1",
            query: { owner: "host", namespace: "activity", limit: 20 },
        })).resolves.toMatchObject({ ok: true, page: { records: [{ address }], hasNext: false } });
        await expect(upsertSessionSystemRecordV1({
            actorUserId: "shared-editor",
            sessionId: "s1",
            address,
            content: row.content,
        })).resolves.toMatchObject({ ok: true, record: { address } });
        const revision = (await readSessionSystemRecordV1({
            actorUserId: "shared-editor",
            sessionId: "s1",
            address,
        }) as { ok: true; record: { revision: string } }).record.revision;
        await expect(deleteSessionSystemRecordV1({
            actorUserId: "shared-editor",
            sessionId: "s1",
            address,
            expectedRevision: revision,
        })).resolves.toEqual({ ok: true });

        expect(currentTx.sessionSystemRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ accountId: "owner-account", sessionId: "s1" }),
        }));
        expect(currentTx.sessionSystemRecord.deleteMany).toHaveBeenCalledWith({
            where: expect.objectContaining({ accountId: "owner-account", id: "rec-wf", version: 1 }),
        });
    });

    it("allows visible host activity reads but rejects writes and deletes without edit access", async () => {
        const currentTx = testState.currentTx as TxMock;
        const row = activityRecord();
        testState.checkSessionAccess.mockResolvedValue({ level: "view", isOwner: false });
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst.mockResolvedValue(row);
        const address = {
            owner: "host" as const,
            namespace: "activity" as const,
            kind: "workflow_run.v1" as const,
            localId: "activity:workflow_run:v1:wf_demo",
        };

        await expect(readSessionSystemRecordV1({
            actorUserId: "shared-viewer",
            sessionId: "s1",
            address,
        })).resolves.toMatchObject({ ok: true, record: { address } });
        await expect(upsertSessionSystemRecordV1({
            actorUserId: "shared-viewer",
            sessionId: "s1",
            address,
            content: row.content,
        })).resolves.toEqual({ ok: false, code: "plugin_session_record_forbidden" });
        await expect(deleteSessionSystemRecordV1({
            actorUserId: "shared-viewer",
            sessionId: "s1",
            address,
        })).resolves.toEqual({ ok: false, code: "plugin_session_record_forbidden" });
        expect(currentTx.sessionSystemRecord.updateMany).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.deleteMany).not.toHaveBeenCalled();
    });

    it("fences V1 record reads and lists at the deciding query after a share is revoked", async () => {
        const currentTx = testState.currentTx as TxMock;
        const row = activityRecord();
        let shareIsCurrent = true;
        testState.checkSessionAccess.mockImplementation(async () => {
            shareIsCurrent = false;
            return { level: "edit", isOwner: false };
        });
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.session.findFirst.mockImplementation(async () => (
            shareIsCurrent ? { id: "s1" } : null
        ));
        currentTx.sessionSystemRecord.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) => (
            args.where.session && !shareIsCurrent ? null : row
        ));
        currentTx.sessionSystemRecord.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) => (
            args.where.session && !shareIsCurrent ? [] : [row]
        ));
        const address = {
            owner: "host" as const,
            namespace: "activity" as const,
            kind: "workflow_run.v1" as const,
            localId: "activity:workflow_run:v1:wf_demo",
        };

        await expect(readSessionSystemRecordV1({
            actorUserId: "shared-editor",
            sessionId: "s1",
            address,
        })).resolves.toEqual({ ok: false, code: "plugin_session_record_forbidden" });
        await expect(listSessionSystemRecordsV1({
            actorUserId: "shared-editor",
            sessionId: "s1",
            query: { owner: "host", namespace: "activity", limit: 20 },
        })).resolves.toEqual({ ok: false, code: "plugin_session_record_forbidden" });
        await expect(deleteSessionSystemRecordV1({
            actorUserId: "shared-editor",
            sessionId: "s1",
            address,
        })).resolves.toEqual({ ok: false, code: "plugin_session_record_forbidden" });
        expect(currentTx.sessionSystemRecord.deleteMany).not.toHaveBeenCalled();
    });

    it("rejects a V1 delete when a participant share is revoked during its no-op settlement", async () => {
        const currentTx = testState.currentTx as TxMock;
        const row = activityRecord();
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.session.findFirst
            .mockResolvedValueOnce({ id: "s1" })
            .mockResolvedValueOnce(null);
        currentTx.sessionSystemRecord.findFirst
            .mockResolvedValueOnce(row)
            .mockResolvedValueOnce(null);
        currentTx.sessionSystemRecord.deleteMany.mockResolvedValue({ count: 0 });
        const address = {
            owner: "host" as const,
            namespace: "activity" as const,
            kind: "workflow_run.v1" as const,
            localId: "activity:workflow_run:v1:wf_demo",
        };

        await expect(deleteSessionSystemRecordV1({
            actorUserId: "shared-editor",
            sessionId: "s1",
            address,
        })).resolves.toEqual({ ok: false, code: "plugin_session_record_forbidden" });
        expect(currentTx.sessionSystemRecord.deleteMany).toHaveBeenCalledTimes(1);
    });

    it("rejects legacy host read, list, and latest requests after their participant share is revoked", async () => {
        const currentTx = testState.currentTx as TxMock;
        let shareIsCurrent = true;
        testState.checkSessionAccess.mockImplementation(async () => {
            shareIsCurrent = false;
            return { level: "edit", isOwner: false };
        });
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.session.findFirst.mockImplementation(async () => (
            shareIsCurrent ? { id: "s1" } : null
        ));
        currentTx.sessionSystemRecord.findFirst.mockResolvedValue(null);
        currentTx.sessionSystemRecord.findMany.mockResolvedValue([]);

        await expect(getSessionSystemRecord({
            actorUserId: "shared-editor",
            sessionId: "s1",
            namespace: "activity",
            localId: "activity:workflow_run:v1:wf_demo",
        })).resolves.toEqual({ ok: false, error: "forbidden" });
        await expect(listSessionSystemRecords({
            actorUserId: "shared-editor",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
        })).resolves.toEqual({ ok: false, error: "forbidden" });
        await expect(getLatestSessionSystemRecord({
            actorUserId: "shared-editor",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
        })).resolves.toEqual({ ok: false, error: "forbidden" });
    });

    it("fences V1 activity writes and deletes at a current editor predicate after a share downgrade", async () => {
        const currentTx = testState.currentTx as TxMock;
        const row = activityRecord();
        let shareHasEditAccess = true;
        testState.checkSessionAccess.mockImplementation(async () => {
            shareHasEditAccess = false;
            return { level: "edit", isOwner: false };
        });
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.session.findFirst.mockImplementation(async () => (
            shareHasEditAccess ? { id: "s1" } : null
        ));
        currentTx.sessionSystemRecord.findFirst.mockResolvedValue(row);
        const hasCurrentEditPredicate = (where: Record<string, unknown>) => (
            (where.session as { is?: { OR?: Array<{ AND?: Array<{ shares?: { some?: { accessLevel?: { in?: string[] } } } }> }> } } | undefined)
                ?.is
                ?.OR
                ?.some((branch) => branch.AND?.some((condition) => (
                    condition.shares?.some?.accessLevel?.in?.includes("edit") === true
                ))) === true
        );
        currentTx.sessionSystemRecord.updateMany.mockImplementation(async (args: { where: Record<string, unknown> }) => ({
            count: !shareHasEditAccess && hasCurrentEditPredicate(args.where) ? 0 : 1,
        }));
        currentTx.sessionSystemRecord.deleteMany.mockImplementation(async (args: { where: Record<string, unknown> }) => ({
            count: !shareHasEditAccess && hasCurrentEditPredicate(args.where) ? 0 : 1,
        }));
        const address = {
            owner: "host" as const,
            namespace: "activity" as const,
            kind: "workflow_run.v1" as const,
            localId: "activity:workflow_run:v1:wf_demo",
        };
        const nextContent = { t: "plain" as const, v: workflowRunPayload({ updatedAt: 1001 }) };

        await expect(upsertSessionSystemRecordV1({
            actorUserId: "shared-editor",
            sessionId: "s1",
            address,
            content: nextContent,
        })).resolves.toEqual({ ok: false, code: "plugin_session_record_forbidden" });
        await expect(deleteSessionSystemRecordV1({
            actorUserId: "shared-editor",
            sessionId: "s1",
            address,
        })).resolves.toEqual({ ok: false, code: "plugin_session_record_forbidden" });
        expect(currentTx.sessionSystemRecord.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                session: {
                    is: expect.objectContaining({
                        OR: expect.arrayContaining([
                            expect.objectContaining({
                                AND: expect.arrayContaining([
                                    expect.objectContaining({
                                        shares: {
                                            some: expect.objectContaining({
                                                accessLevel: { in: ["edit", "admin"] },
                                            }),
                                        },
                                    }),
                                ]),
                            }),
                        ]),
                    }),
                },
            }),
        }));
    });

    it("rejects same-envelope V1 and legacy activity upserts after an editor is downgraded to visible", async () => {
        const currentTx = testState.currentTx as TxMock;
        const row = activityRecord();
        let shareHasEditAccess = true;
        testState.checkSessionAccess.mockImplementation(async () => {
            shareHasEditAccess = false;
            return { level: "edit", isOwner: false };
        });
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.session.findFirst.mockImplementation(async () => (
            shareHasEditAccess ? { id: "s1" } : null
        ));
        const hasCurrentEditPredicate = (where: Record<string, unknown>) => (
            (where.session as { is?: { OR?: Array<{ AND?: Array<{ shares?: { some?: { accessLevel?: { in?: string[] } } } }> }> } } | undefined)
                ?.is
                ?.OR
                ?.some((branch) => branch.AND?.some((condition) => (
                    condition.shares?.some?.accessLevel?.in?.includes("edit") === true
                ))) === true
        );
        currentTx.sessionSystemRecord.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) => (
            hasCurrentEditPredicate(args.where) ? null : row
        ));
        const address = {
            owner: "host" as const,
            namespace: "activity" as const,
            kind: "workflow_run.v1" as const,
            localId: "activity:workflow_run:v1:wf_demo",
        };

        await expect(upsertSessionSystemRecordV1({
            actorUserId: "shared-editor",
            sessionId: "s1",
            address,
            content: row.content,
        })).resolves.toEqual({ ok: false, code: "plugin_session_record_forbidden" });
        await expect(upsertSessionSystemRecord({
            actorUserId: "shared-editor",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
            localId: address.localId,
            content: row.content,
        })).resolves.toEqual({ ok: false, error: "forbidden" });
        expect(currentTx.sessionSystemRecord.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                session: {
                    is: expect.objectContaining({
                        OR: expect.arrayContaining([
                            expect.objectContaining({
                                AND: expect.arrayContaining([
                                    expect.objectContaining({
                                        shares: {
                                            some: expect.objectContaining({
                                                accessLevel: { in: ["edit", "admin"] },
                                            }),
                                        },
                                    }),
                                ]),
                            }),
                        ]),
                    }),
                },
            }),
        }));
    });

    it("rejects malformed plaintext host workflow content before a V1 upsert can persist it", async () => {
        const currentTx = testState.currentTx as TxMock;

        await expect(upsertSessionSystemRecordV1({
            actorUserId: "shared-editor",
            sessionId: "s1",
            address: {
                owner: "host",
                namespace: "activity",
                kind: "workflow_run.v1",
                localId: "activity:workflow_run:v1:wf_demo",
            },
            content: { t: "plain", v: { v: 1, runId: "wf_demo" } },
        })).resolves.toEqual({ ok: false, code: "plugin_session_record_invalid_query" });
        expect(currentTx.sessionSystemRecord.create).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.updateMany).not.toHaveBeenCalled();
    });

    it("settles a create race only when the winning row is the exact stored-envelope replay", async () => {
        const createdAt = new Date("2026-08-03T10:00:00.000Z");
        const currentTx = testState.currentTx as TxMock;
        const content = { t: "encrypted" as const, c: "same-sealed-envelope" };
        const winningRow = {
            id: "record-one",
            accountId: "actor",
            sessionId: "s1",
            ownerKind: "plugin",
            pluginId: "acme.notes",
            namespace: "notes",
            kind: "entry.v1",
            localId: "note:one",
            content,
            namespaceAddressKey: new Uint8Array(32),
            recordAddressKey: new Uint8Array(32),
            version: 1,
            createdAt,
            updatedAt: createdAt,
        };
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(winningRow);
        currentTx.sessionSystemRecord.create.mockRejectedValue({ code: "P2002" });

        await expect(upsertSessionSystemRecordV1({
            actorUserId: "actor",
            sessionId: "s1",
            pluginId: "acme.notes",
            address: { owner: "plugin", namespace: "notes", kind: "entry.v1", localId: "note:one" },
            content,
            expectedRevision: null,
        })).resolves.toMatchObject({
            ok: true,
            record: { id: "record-one", content },
        });
        expect(currentTx.sessionSystemRecord.findFirst).toHaveBeenCalledTimes(2);
    });

    it("settles an omitted create race through the different winner while null remains create-only", async () => {
        const createdAt = new Date("2026-08-03T10:00:00.000Z");
        const currentTx = testState.currentTx as TxMock;
        const address = {
            owner: "plugin" as const,
            namespace: "notes",
            kind: "entry.v1",
            localId: "note:one",
        };
        const winner = {
            id: "record-one",
            accountId: "actor",
            sessionId: "s1",
            ownerKind: "plugin",
            pluginId: "acme.notes",
            namespace: "notes",
            kind: "entry.v1",
            localId: "note:one",
            content: { t: "plain" as const, v: { title: "Winner" } },
            namespaceAddressKey: new Uint8Array(32),
            recordAddressKey: new Uint8Array(32),
            version: 1,
            createdAt,
            updatedAt: createdAt,
        };
        const settled = {
            ...winner,
            content: { t: "plain" as const, v: { title: "Settled" } },
            version: 2,
            updatedAt: new Date("2026-08-03T10:01:00.000Z"),
        };
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(winner)
            .mockResolvedValueOnce(settled);
        currentTx.sessionSystemRecord.create.mockRejectedValueOnce({ code: "P2002" });
        currentTx.sessionSystemRecord.updateMany.mockResolvedValueOnce({ count: 1 });

        await expect(upsertSessionSystemRecordV1({
            actorUserId: "actor",
            sessionId: "s1",
            pluginId: "acme.notes",
            address,
            content: settled.content,
        })).resolves.toMatchObject({
            ok: true,
            record: {
                content: settled.content,
                revision: encodeSessionSystemRecordRevision({ id: "record-one", version: 2 }),
            },
        });

        currentTx.sessionSystemRecord.findFirst.mockReset();
        currentTx.sessionSystemRecord.findFirst.mockResolvedValue(winner);
        await expect(upsertSessionSystemRecordV1({
            actorUserId: "actor",
            sessionId: "s1",
            pluginId: "acme.notes",
            address,
            content: settled.content,
            expectedRevision: null,
        })).resolves.toEqual({
            ok: false,
            code: "plugin_session_record_revision_conflict",
            currentRevision: encodeSessionSystemRecordRevision({ id: "record-one", version: 1 }),
        });
    });

    it("settles a second omitted create collision without falling back to create-only conflict semantics", async () => {
        const createdAt = new Date("2026-08-03T10:00:00.000Z");
        const currentTx = testState.currentTx as TxMock;
        const address = {
            owner: "plugin" as const,
            namespace: "notes",
            kind: "entry.v1",
            localId: "note:one",
        };
        const winner = {
            id: "record-one",
            accountId: "actor",
            sessionId: "s1",
            ownerKind: "plugin",
            pluginId: "acme.notes",
            namespace: "notes",
            kind: "entry.v1",
            localId: "note:one",
            content: { t: "plain" as const, v: { title: "Winner" } },
            namespaceAddressKey: new Uint8Array(32),
            recordAddressKey: new Uint8Array(32),
            version: 1,
            createdAt,
            updatedAt: createdAt,
        };
        const settled = {
            ...winner,
            content: { t: "plain" as const, v: { title: "Settled" } },
            version: 2,
            updatedAt: new Date("2026-08-03T10:01:00.000Z"),
        };
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(winner)
            .mockResolvedValueOnce(settled);
        currentTx.sessionSystemRecord.create
            .mockRejectedValueOnce({ code: "P2002" })
            .mockRejectedValueOnce({ code: "P2002" });
        currentTx.sessionSystemRecord.updateMany.mockResolvedValueOnce({ count: 1 });

        await expect(upsertSessionSystemRecordV1({
            actorUserId: "actor",
            sessionId: "s1",
            pluginId: "acme.notes",
            address,
            content: settled.content,
        })).resolves.toMatchObject({
            ok: true,
            record: {
                content: settled.content,
                revision: encodeSessionSystemRecordRevision({ id: "record-one", version: 2 }),
            },
        });
    });

    it("settles an omitted update that races a version advance without using caller CAS", async () => {
        const createdAt = new Date("2026-08-03T10:00:00.000Z");
        const currentTx = testState.currentTx as TxMock;
        const address = {
            owner: "plugin" as const,
            namespace: "notes",
            kind: "entry.v1",
            localId: "note:one",
        };
        const beforeRace = {
            id: "record-one",
            accountId: "actor",
            sessionId: "s1",
            ownerKind: "plugin",
            pluginId: "acme.notes",
            namespace: "notes",
            kind: "entry.v1",
            localId: "note:one",
            content: { t: "plain" as const, v: { title: "Before" } },
            namespaceAddressKey: new Uint8Array(32),
            recordAddressKey: new Uint8Array(32),
            version: 1,
            createdAt,
            updatedAt: createdAt,
        };
        const settled = {
            ...beforeRace,
            content: { t: "plain" as const, v: { title: "Settled" } },
            version: 3,
            updatedAt: new Date("2026-08-03T10:02:00.000Z"),
        };
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst
            .mockResolvedValueOnce(beforeRace)
            .mockResolvedValueOnce(settled);
        currentTx.sessionSystemRecord.updateMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => ({
            count: "version" in where ? 0 : 1,
        }));

        await expect(upsertSessionSystemRecordV1({
            actorUserId: "actor",
            sessionId: "s1",
            pluginId: "acme.notes",
            address,
            content: settled.content,
        })).resolves.toMatchObject({
            ok: true,
            record: {
                content: settled.content,
                revision: encodeSessionSystemRecordRevision({ id: "record-one", version: 3 }),
            },
        });
        expect(currentTx.sessionSystemRecord.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.not.objectContaining({ version: expect.anything() }),
        }));
    });

    it("refetches the actual revision after a lost conditional plugin update", async () => {
        const createdAt = new Date("2026-08-03T10:00:00.000Z");
        const currentTx = testState.currentTx as TxMock;
        const address = {
            owner: "plugin" as const,
            namespace: "notes",
            kind: "entry.v1",
            localId: "note:one",
        };
        const beforeRace = {
            id: "record-one",
            accountId: "actor",
            sessionId: "s1",
            ownerKind: "plugin",
            pluginId: "acme.notes",
            namespace: "notes",
            kind: "entry.v1",
            localId: "note:one",
            content: { t: "plain" as const, v: { title: "Before" } },
            namespaceAddressKey: new Uint8Array(32),
            recordAddressKey: new Uint8Array(32),
            version: 1,
            createdAt,
            updatedAt: createdAt,
        };
        const raced = {
            ...beforeRace,
            content: { t: "plain" as const, v: { title: "Winner" } },
            version: 2,
            updatedAt: new Date("2026-08-03T10:01:00.000Z"),
        };
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst
            .mockResolvedValueOnce(beforeRace)
            .mockResolvedValueOnce(raced);
        currentTx.sessionSystemRecord.updateMany.mockResolvedValue({ count: 0 });

        await expect(upsertSessionSystemRecordV1({
            actorUserId: "actor",
            sessionId: "s1",
            pluginId: "acme.notes",
            address,
            content: { t: "plain", v: { title: "Requested" } },
            expectedRevision: encodeSessionSystemRecordRevision({ id: "record-one", version: 1 }),
        })).resolves.toEqual({
            ok: false,
            code: "plugin_session_record_revision_conflict",
            currentRevision: encodeSessionSystemRecordRevision({ id: "record-one", version: 2 }),
        });
    });

    it("refetches the actual revision after a lost conditional plugin delete", async () => {
        const createdAt = new Date("2026-08-03T10:00:00.000Z");
        const currentTx = testState.currentTx as TxMock;
        const address = {
            owner: "plugin" as const,
            namespace: "notes",
            kind: "entry.v1",
            localId: "note:one",
        };
        const beforeRace = {
            id: "record-one",
            accountId: "actor",
            sessionId: "s1",
            ownerKind: "plugin",
            pluginId: "acme.notes",
            namespace: "notes",
            kind: "entry.v1",
            localId: "note:one",
            content: { t: "plain" as const, v: { title: "Before" } },
            namespaceAddressKey: new Uint8Array(32),
            recordAddressKey: new Uint8Array(32),
            version: 1,
            createdAt,
            updatedAt: createdAt,
        };
        const raced = {
            ...beforeRace,
            content: { t: "plain" as const, v: { title: "Winner" } },
            version: 2,
            updatedAt: new Date("2026-08-03T10:01:00.000Z"),
        };
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst
            .mockResolvedValueOnce(beforeRace)
            .mockResolvedValueOnce(raced);
        currentTx.sessionSystemRecord.deleteMany.mockResolvedValue({ count: 0 });

        await expect(deleteSessionSystemRecordV1({
            actorUserId: "actor",
            sessionId: "s1",
            pluginId: "acme.notes",
            address,
            expectedRevision: encodeSessionSystemRecordRevision({ id: "record-one", version: 1 }),
        })).resolves.toEqual({
            ok: false,
            code: "plugin_session_record_revision_conflict",
            currentRevision: encodeSessionSystemRecordRevision({ id: "record-one", version: 2 }),
        });
    });

    it("settles an omitted delete after the addressed row is recreated", async () => {
        const createdAt = new Date("2026-08-03T10:00:00.000Z");
        const currentTx = testState.currentTx as TxMock;
        const address = {
            owner: "plugin" as const,
            namespace: "notes",
            kind: "entry.v1",
            localId: "note:one",
        };
        const beforeRace = {
            id: "record-one",
            accountId: "actor",
            sessionId: "s1",
            ownerKind: "plugin",
            pluginId: "acme.notes",
            namespace: "notes",
            kind: "entry.v1",
            localId: "note:one",
            content: { t: "plain" as const, v: { title: "Before" } },
            namespaceAddressKey: new Uint8Array(32),
            recordAddressKey: new Uint8Array(32),
            version: 1,
            createdAt,
            updatedAt: createdAt,
        };
        const recreated = {
            ...beforeRace,
            id: "record-two",
            content: { t: "plain" as const, v: { title: "Recreated" } },
            updatedAt: new Date("2026-08-03T10:01:00.000Z"),
        };
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst
            .mockResolvedValueOnce(beforeRace)
            .mockResolvedValueOnce(recreated);
        currentTx.sessionSystemRecord.deleteMany
            .mockResolvedValueOnce({ count: 0 })
            .mockResolvedValueOnce({ count: 1 });

        await expect(deleteSessionSystemRecordV1({
            actorUserId: "actor",
            sessionId: "s1",
            pluginId: "acme.notes",
            address,
        })).resolves.toEqual({ ok: true });
        expect(currentTx.sessionSystemRecord.deleteMany).toHaveBeenCalledTimes(2);
    });

    it("accepts a stale exact-envelope replay but rejects stale different content", async () => {
        const createdAt = new Date("2026-08-03T10:00:00.000Z");
        const currentTx = testState.currentTx as TxMock;
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee", accountId: "owner-account" });
        const row = {
            id: "record-one",
            accountId: "actor",
            sessionId: "s1",
            ownerKind: "plugin",
            pluginId: "acme.notes",
            namespace: "notes",
            kind: "entry.v1",
            localId: "note:one",
            content: { t: "encrypted" as const, c: "current-envelope" },
            namespaceAddressKey: new Uint8Array(32),
            recordAddressKey: new Uint8Array(32),
            version: 2,
            createdAt,
            updatedAt: createdAt,
        };
        currentTx.sessionSystemRecord.findFirst.mockResolvedValue(row);
        const staleRevision = "ssr1.AAAACnJlY29yZC1vbmUAAAAB";

        await expect(upsertSessionSystemRecordV1({
            actorUserId: "actor",
            sessionId: "s1",
            pluginId: "acme.notes",
            address: { owner: "plugin", namespace: "notes", kind: "entry.v1", localId: "note:one" },
            content: row.content,
            expectedRevision: staleRevision,
        })).resolves.toMatchObject({ ok: true, record: { revision: expect.stringMatching(/^ssr1\./) } });
        await expect(upsertSessionSystemRecordV1({
            actorUserId: "actor",
            sessionId: "s1",
            pluginId: "acme.notes",
            address: { owner: "plugin", namespace: "notes", kind: "entry.v1", localId: "note:one" },
            content: { t: "encrypted", c: "fresh-envelope" },
            expectedRevision: staleRevision,
        })).resolves.toEqual(expect.objectContaining({
            ok: false,
            code: "plugin_session_record_revision_conflict",
        }));
        expect(currentTx.sessionSystemRecord.updateMany).not.toHaveBeenCalled();
    });

    it("rejects revision tokens that match the public prefix but fail canonical decoding", async () => {
        const currentTx = testState.currentTx as TxMock;
        const address = {
            owner: "plugin" as const,
            namespace: "notes",
            kind: "entry.v1",
            localId: "note:one",
        };
        const malformedRevision = "ssr1.A";

        await expect(upsertSessionSystemRecordV1({
            actorUserId: "actor",
            sessionId: "s1",
            pluginId: "acme.notes",
            address,
            content: { t: "plain", v: { title: "Changed" } },
            expectedRevision: malformedRevision,
        })).resolves.toEqual({ ok: false, code: "plugin_session_record_invalid_query" });
        await expect(deleteSessionSystemRecordV1({
            actorUserId: "actor",
            sessionId: "s1",
            pluginId: "acme.notes",
            address,
            expectedRevision: malformedRevision,
        })).resolves.toEqual({ ok: false, code: "plugin_session_record_invalid_query" });

        expect(testState.checkSessionAccess).not.toHaveBeenCalled();
        expect(currentTx.session.findUnique).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.findFirst).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.updateMany).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.deleteMany).not.toHaveBeenCalled();
    });

    it("fails closed when a digest lookup resolves different raw address components", async () => {
        const currentTx = testState.currentTx as TxMock;
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst.mockResolvedValue({
            id: "collision",
            accountId: "actor",
            sessionId: "s1",
            ownerKind: "plugin",
            pluginId: "other.plugin",
            namespace: "notes",
            kind: "entry.v1",
            localId: "note:one",
            content: { t: "plain", v: null },
            namespaceAddressKey: new Uint8Array(32),
            recordAddressKey: new Uint8Array(32),
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        await expect(readSessionSystemRecordV1({
            actorUserId: "actor",
            sessionId: "s1",
            pluginId: "acme.notes",
            address: { owner: "plugin", namespace: "notes", kind: "entry.v1", localId: "note:one" },
        })).resolves.toEqual({ ok: false, code: "plugin_session_record_address_collision" });
    });

    it("fails closed when a plugin digest lookup resolves a row without an exact owner kind", async () => {
        const currentTx = testState.currentTx as TxMock;
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst.mockResolvedValue({
            id: "legacy-shaped-collision",
            accountId: "actor",
            sessionId: "s1",
            ownerKind: null,
            pluginId: "acme.notes",
            namespace: "notes",
            kind: "entry.v1",
            localId: "note:one",
            content: { t: "plain", v: null },
            namespaceAddressKey: new Uint8Array(32),
            recordAddressKey: new Uint8Array(32),
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        await expect(readSessionSystemRecordV1({
            actorUserId: "actor",
            sessionId: "s1",
            pluginId: "acme.notes",
            address: { owner: "plugin", namespace: "notes", kind: "entry.v1", localId: "note:one" },
        })).resolves.toEqual({ ok: false, code: "plugin_session_record_address_collision" });
    });

    it("reports an address collision before a kind conflict when reading a combined mismatch", async () => {
        const currentTx = testState.currentTx as TxMock;
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst.mockResolvedValue({
            id: "combined-collision",
            accountId: "actor",
            sessionId: "s1",
            ownerKind: "plugin",
            pluginId: "other.plugin",
            namespace: "notes",
            kind: "entry.v1",
            localId: "note:one",
            content: { t: "plain", v: null },
            namespaceAddressKey: new Uint8Array(32),
            recordAddressKey: new Uint8Array(32),
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        await expect(readSessionSystemRecordV1({
            actorUserId: "actor",
            sessionId: "s1",
            pluginId: "acme.notes",
            address: { owner: "plugin", namespace: "notes", kind: "other.v1", localId: "note:one" },
        })).resolves.toEqual({ ok: false, code: "plugin_session_record_address_collision" });
    });

    it("reports an address collision before a kind conflict when deleting a combined mismatch", async () => {
        const currentTx = testState.currentTx as TxMock;
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst.mockResolvedValue({
            id: "combined-collision",
            accountId: "actor",
            sessionId: "s1",
            ownerKind: "plugin",
            pluginId: "other.plugin",
            namespace: "notes",
            kind: "entry.v1",
            localId: "note:one",
            content: { t: "plain", v: null },
            namespaceAddressKey: new Uint8Array(32),
            recordAddressKey: new Uint8Array(32),
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        await expect(deleteSessionSystemRecordV1({
            actorUserId: "actor",
            sessionId: "s1",
            pluginId: "acme.notes",
            address: { owner: "plugin", namespace: "notes", kind: "other.v1", localId: "note:one" },
        })).resolves.toEqual({ ok: false, code: "plugin_session_record_address_collision" });
        expect(currentTx.sessionSystemRecord.deleteMany).not.toHaveBeenCalled();
    });

    it("does not read or delete a row through a different public kind", async () => {
        const currentTx = testState.currentTx as TxMock;
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst.mockResolvedValue({
            id: "record-one",
            accountId: "actor",
            sessionId: "s1",
            ownerKind: "plugin",
            pluginId: "acme.notes",
            namespace: "notes",
            kind: "entry.v1",
            localId: "note:one",
            content: { t: "plain", v: null },
            namespaceAddressKey: new Uint8Array(32),
            recordAddressKey: new Uint8Array(32),
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        const mismatchedAddress = {
            owner: "plugin" as const,
            namespace: "notes",
            kind: "other.v1",
            localId: "note:one",
        };

        await expect(readSessionSystemRecordV1({
            actorUserId: "actor",
            sessionId: "s1",
            pluginId: "acme.notes",
            address: mismatchedAddress,
        })).resolves.toEqual({ ok: false, code: "plugin_session_record_kind_conflict" });
        await expect(deleteSessionSystemRecordV1({
            actorUserId: "actor",
            sessionId: "s1",
            pluginId: "acme.notes",
            address: mismatchedAddress,
        })).resolves.toEqual({ ok: false, code: "plugin_session_record_kind_conflict" });
        expect(currentTx.sessionSystemRecord.deleteMany).not.toHaveBeenCalled();
    });

    it("uses the qualified namespace key for bounded listing and conditionally deletes by row id plus version", async () => {
        const currentTx = testState.currentTx as TxMock;
        const createdAt = new Date("2026-08-03T10:00:00.000Z");
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        const row = {
            id: "record-one",
            accountId: "actor",
            sessionId: "s1",
            ownerKind: "plugin",
            pluginId: "acme.notes",
            namespace: "notes",
            kind: "entry.v1",
            localId: "note:one",
            content: { t: "plain" as const, v: { title: "One" } },
            namespaceAddressKey: new Uint8Array(32),
            recordAddressKey: new Uint8Array(32),
            version: 1,
            createdAt,
            updatedAt: createdAt,
        };
        currentTx.sessionSystemRecord.findMany.mockResolvedValue([row]);
        currentTx.sessionSystemRecord.findFirst.mockResolvedValue(row);
        currentTx.sessionSystemRecord.deleteMany.mockResolvedValue({ count: 1 });

        const page = await listSessionSystemRecordsV1({
            actorUserId: "actor",
            sessionId: "s1",
            pluginId: "acme.notes",
            query: { owner: "plugin", namespace: "notes", limit: 20 },
        });
        expect(page).toMatchObject({ ok: true, page: { records: [{ id: "record-one" }], hasNext: false } });
        expect(currentTx.sessionSystemRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ accountId: "actor", sessionId: "s1", namespaceAddressKey: expect.any(Uint8Array) }),
            take: 21,
        }));

        const revision = (page as Extract<typeof page, { ok: true }>).page.records[0]!.revision;
        await expect(deleteSessionSystemRecordV1({
            actorUserId: "actor",
            sessionId: "s1",
            pluginId: "acme.notes",
            address: { owner: "plugin", namespace: "notes", kind: "entry.v1", localId: "note:one" },
            expectedRevision: revision,
        })).resolves.toEqual({ ok: true });
        expect(currentTx.sessionSystemRecord.deleteMany).toHaveBeenCalledWith({
            where: expect.objectContaining({ id: "record-one", version: 1 }),
        });
    });

    it("rejects a colliding v1 list lookahead row before deriving hasNext", async () => {
        const currentTx = testState.currentTx as TxMock;
        const createdAt = new Date("2026-08-03T10:00:00.000Z");
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        const row = {
            id: "record-one",
            accountId: "actor",
            sessionId: "s1",
            ownerKind: "plugin",
            pluginId: "acme.notes",
            namespace: "notes",
            kind: "entry.v1",
            localId: "note:one",
            content: { t: "plain" as const, v: { title: "One" } },
            namespaceAddressKey: new Uint8Array(32),
            recordAddressKey: new Uint8Array(32),
            version: 1,
            createdAt,
            updatedAt: createdAt,
        };
        currentTx.sessionSystemRecord.findMany.mockResolvedValue([
            row,
            { ...row, id: "colliding-lookahead", pluginId: "other.plugin" },
        ]);

        await expect(listSessionSystemRecordsV1({
            actorUserId: "actor",
            sessionId: "s1",
            pluginId: "acme.notes",
            query: { owner: "plugin", namespace: "notes", limit: 1 },
        })).resolves.toEqual({ ok: false, code: "plugin_session_record_address_collision" });
    });

    it("lists an exact local id by its byte-exact record key and rejects a collation-matched raw variant", async () => {
        const currentTx = testState.currentTx as TxMock;
        const createdAt = new Date("2026-08-03T10:00:00.000Z");
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findMany.mockResolvedValue([{
            id: "collation-match",
            accountId: "actor",
            sessionId: "s1",
            ownerKind: "plugin",
            pluginId: "acme.notes",
            namespace: "notes",
            kind: "entry.v1",
            localId: "case",
            content: { t: "plain", v: { title: "Wrong bytes" } },
            namespaceAddressKey: new Uint8Array(32),
            recordAddressKey: new Uint8Array(32),
            version: 1,
            createdAt,
            updatedAt: createdAt,
        }]);

        await expect(listSessionSystemRecordsV1({
            actorUserId: "actor",
            sessionId: "s1",
            pluginId: "acme.notes",
            query: { owner: "plugin", namespace: "notes", localId: "Case", limit: 20 },
        })).resolves.toEqual({ ok: false, code: "plugin_session_record_address_collision" });

        const where = currentTx.sessionSystemRecord.findMany.mock.calls[0]?.[0]?.where;
        expect(where).toEqual(expect.objectContaining({
            accountId: "actor",
            sessionId: "s1",
            recordAddressKey: expect.any(Uint8Array),
        }));
        expect(where).not.toHaveProperty("localId");
    });

    it("looks up a host record by its byte address key without consulting the legacy raw identity", async () => {
        const currentTx = testState.currentTx as TxMock;
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst.mockResolvedValue(activityRecord());

        await expect(getSessionSystemRecord({
            actorUserId: "shared-editor",
            sessionId: "s1",
            namespace: "activity",
            localId: "activity:workflow_run:v1:wf_demo",
        })).resolves.toMatchObject({ ok: true, record: { id: "rec-wf" } });

        expect(currentTx.sessionSystemRecord.findFirst).toHaveBeenCalledTimes(1);
        expect(currentTx.sessionSystemRecord.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                accountId: "owner-account",
                sessionId: "s1",
                recordAddressKey: ACTIVITY_WORKFLOW_RECORD_KEY,
                session: { is: expect.objectContaining({ id: "s1" }) },
            }),
            select: expect.any(Object),
        }));
        expect(currentTx.sessionSystemRecord.findUnique).not.toHaveBeenCalled();
    });

    it("does not consult null-key predecessor rows after the CONTRACT boundary", async () => {
        const currentTx = testState.currentTx as TxMock;
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst.mockResolvedValue(null);

        await expect(getSessionSystemRecord({
            actorUserId: "shared-editor",
            sessionId: "s1",
            namespace: "activity",
            localId: "activity:workflow_run:v1:wf_demo",
        })).resolves.toEqual({ ok: true, record: null });

        expect(currentTx.sessionSystemRecord.findFirst).toHaveBeenCalledTimes(1);
        expect(currentTx.sessionSystemRecord.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                accountId: "owner-account",
                sessionId: "s1",
                recordAddressKey: ACTIVITY_WORKFLOW_RECORD_KEY,
                session: { is: expect.objectContaining({ id: "s1" }) },
            }),
            select: expect.any(Object),
        }));
        expect(currentTx.sessionSystemRecord.update).not.toHaveBeenCalled();
    });

    it("settles a host create race through the canonical address key", async () => {
        const currentTx = testState.currentTx as TxMock;
        const canonicalWinner = activityRecord();
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(canonicalWinner);
        currentTx.sessionSystemRecord.create.mockRejectedValue({ code: "P2002" });

        await expect(upsertSessionSystemRecord({
            actorUserId: "shared-editor",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
            localId: "activity:workflow_run:v1:wf_demo",
            content: canonicalWinner.content,
        })).resolves.toMatchObject({
            ok: true,
            didCreate: false,
            didUpdate: false,
            record: { id: "rec-wf" },
        });

        expect(currentTx.sessionSystemRecord.create).toHaveBeenCalledTimes(1);
        expect(currentTx.sessionSystemRecord.findFirst).toHaveBeenNthCalledWith(2, expect.objectContaining({
            where: expect.objectContaining({
                accountId: "owner-account",
                sessionId: "s1",
                recordAddressKey: ACTIVITY_WORKFLOW_RECORD_KEY,
                session: { is: expect.objectContaining({ id: "s1" }) },
            }),
            select: expect.any(Object),
        }));
        expect(currentTx.sessionSystemRecord.findFirst).toHaveBeenCalledTimes(2);
        expect(currentTx.sessionSystemRecord.update).not.toHaveBeenCalled();
    });

    it("fails closed when the host create-race winner only matches the raw collation", async () => {
        const currentTx = testState.currentTx as TxMock;
        const collidingWinner = activityRecord({
            localId: "ACTIVITY:WORKFLOW_RUN:V1:WF_DEMO",
            ownerKind: null,
            namespaceAddressKey: null,
            recordAddressKey: null,
        });
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(collidingWinner);
        currentTx.sessionSystemRecord.create.mockRejectedValue({ code: "P2002" });

        await expect(upsertSessionSystemRecord({
            actorUserId: "shared-editor",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
            localId: "activity:workflow_run:v1:wf_demo",
            content: collidingWinner.content,
        })).resolves.toEqual({ ok: false, error: "internal" });

        expect(currentTx.sessionSystemRecord.create).toHaveBeenCalledTimes(1);
        expect(currentTx.sessionSystemRecord.findFirst).toHaveBeenCalledTimes(2);
        expect(currentTx.sessionSystemRecord.findFirst).toHaveBeenNthCalledWith(2, expect.objectContaining({
            where: expect.objectContaining({
                accountId: "owner-account",
                sessionId: "s1",
                recordAddressKey: ACTIVITY_WORKFLOW_RECORD_KEY,
                session: { is: expect.objectContaining({ id: "s1" }) },
            }),
            select: expect.any(Object),
        }));
        expect(currentTx.sessionSystemRecord.update).not.toHaveBeenCalled();
    });

    it("does not consult legacy raw identity when the current-version contract is not active", async () => {
        await initializeSessionSystemRecordsProtocolV1Activation({
            $queryRawUnsafe: async () => [],
            sessionSystemRecord: {
                findMany: async () => [],
            },
        } as unknown as ProtocolActivationDatabase);
        const currentTx = testState.currentTx as TxMock;
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst.mockResolvedValueOnce(null);

        await expect(getSessionSystemRecord({
            actorUserId: "shared-editor",
            sessionId: "s1",
            namespace: "activity",
            localId: "activity:workflow_run:v1:wf_demo",
        })).resolves.toEqual({ ok: true, record: null });

        expect(currentTx.sessionSystemRecord.findFirst).toHaveBeenNthCalledWith(1, expect.objectContaining({
            where: expect.objectContaining({
                accountId: "owner-account",
                sessionId: "s1",
                recordAddressKey: ACTIVITY_WORKFLOW_RECORD_KEY,
                session: { is: expect.objectContaining({ id: "s1" }) },
            }),
            select: expect.any(Object),
        }));
        expect(currentTx.sessionSystemRecord.findFirst).toHaveBeenCalledTimes(1);
    });

    it("keeps host list and latest exclusively on canonical key predicates", async () => {
        const currentTx = testState.currentTx as TxMock;
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findMany.mockResolvedValue([activityRecord()]);
        currentTx.sessionSystemRecord.findFirst.mockResolvedValue(activityRecord());

        await expect(listSessionSystemRecords({
            actorUserId: "shared-editor",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
            localId: "activity:workflow_run:v1:wf_demo",
        })).resolves.toMatchObject({ ok: true, records: [{ id: "rec-wf" }] });
        await expect(getLatestSessionSystemRecord({
            actorUserId: "shared-editor",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
        })).resolves.toMatchObject({ ok: true, record: { id: "rec-wf" } });

        expect(currentTx.sessionSystemRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                sessionId: "s1",
                OR: [{
                    accountId: "owner-account",
                    recordAddressKey: ACTIVITY_WORKFLOW_RECORD_KEY,
                    kind: { in: ["workflow_run.v1"] },
                }],
            }),
        }));
        expect(currentTx.sessionSystemRecord.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                accountId: "owner-account",
                sessionId: "s1",
                kind: "workflow_run.v1",
                namespaceAddressKey: ACTIVITY_NAMESPACE_KEY,
            }),
        }));
    });

    it("fails closed when a host key lookup returns collation-matched raw address bytes", async () => {
        const currentTx = testState.currentTx as TxMock;
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst
            .mockResolvedValueOnce(activityRecord({
                localId: "ACTIVITY:WORKFLOW_RUN:V1:WF_DEMO",
            }))
            .mockResolvedValueOnce(activityRecord({ namespace: "memory" }));

        await expect(getSessionSystemRecord({
            actorUserId: "shared-editor",
            sessionId: "s1",
            namespace: "activity",
            localId: "activity:workflow_run:v1:wf_demo",
        })).resolves.toEqual({ ok: false, error: "internal" });
        await expect(getLatestSessionSystemRecord({
            actorUserId: "shared-editor",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
        })).resolves.toEqual({ ok: false, error: "internal" });
    });

    it("fails closed when a host list key lookup returns collation-matched raw address bytes", async () => {
        const currentTx = testState.currentTx as TxMock;
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        const collidingRow = activityRecord({
            localId: "ACTIVITY:WORKFLOW_RUN:V1:WF_DEMO",
        });
        currentTx.sessionSystemRecord.findMany
            .mockResolvedValueOnce([collidingRow])
            .mockResolvedValueOnce([activityRecord(), collidingRow]);

        await expect(listSessionSystemRecords({
            actorUserId: "shared-editor",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
            localId: "activity:workflow_run:v1:wf_demo",
        })).resolves.toEqual({ ok: false, error: "internal" });
        await expect(listSessionSystemRecords({
            actorUserId: "shared-editor",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
            localId: "activity:workflow_run:v1:wf_demo",
            limit: 1,
        })).resolves.toEqual({ ok: false, error: "internal" });
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
        expect(currentTx.sessionSystemRecord.findFirst).toHaveBeenNthCalledWith(1, expect.objectContaining({
            where: expect.objectContaining({
                accountId: "owner-account",
                sessionId: "s1",
                recordAddressKey: ACTIVITY_WORKFLOW_RECORD_KEY,
                session: { is: expect.objectContaining({ id: "s1" }) },
            }),
            select: expect.any(Object),
        }));
        expect(currentTx.sessionSystemRecord.create).toHaveBeenCalledWith({
            data: {
                accountId: "owner-account",
                sessionId: "s1",
                namespace: "activity",
                kind: "workflow_run.v1",
                localId: "activity:workflow_run:v1:wf_demo",
                content: { t: "plain", v: workflowRunPayload() },
                ownerKind: "host",
                pluginId: null,
                namespaceAddressKey: Uint8Array.from(Buffer.from(
                    "f41076a2bcb5e029d45eacb7f39bb5c0770477a9b2c15be533aca78d9ec11cf2",
                    "hex",
                )),
                recordAddressKey: Uint8Array.from(Buffer.from(
                    "eb24a1da14ef90199e4951fe70ffd8d37a9dcada923ea7d14ee5a982efe2e3ea",
                    "hex",
                )),
                version: 1,
            },
            select: expect.any(Object),
        });
    });

    it("rejects a view-only participant before mutating session-owner activity records", async () => {
        testState.checkSessionAccess.mockResolvedValue({ level: "view", isOwner: false });
        const currentTx = testState.currentTx as TxMock;

        const result = await upsertSessionSystemRecord({
            actorUserId: "shared-viewer",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
            localId: "activity:workflow_run:v1:wf_demo",
            content: { t: "plain", v: workflowRunPayload() },
        });

        expect(result).toEqual({ ok: false, error: "forbidden" });
        expect(currentTx.session.findUnique).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.findUnique).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.findFirst).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.create).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.update).not.toHaveBeenCalled();
    });

    it("updates a canonical host record without consulting predecessor identity", async () => {
        const createdAt = new Date("2026-06-26T10:00:00.000Z");
        const updatedAt = new Date("2026-06-26T10:01:00.000Z");
        const currentTx = testState.currentTx as TxMock;
        const previousContent = { t: "plain" as const, v: workflowRunPayload({ updatedAt: 900 }) };
        const nextContent = { t: "plain" as const, v: workflowRunPayload({ updatedAt: 1000 }) };
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        currentTx.sessionSystemRecord.findFirst.mockResolvedValueOnce(activityRecord({
            content: previousContent,
            createdAt,
            updatedAt: createdAt,
        })).mockResolvedValueOnce(activityRecord({
            id: "rec-wf",
            accountId: "owner-account",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
            localId: "activity:workflow_run:v1:wf_demo",
            content: nextContent,
            ownerKind: "host",
            pluginId: null,
            namespaceAddressKey: Buffer.from(
                "f41076a2bcb5e029d45eacb7f39bb5c0770477a9b2c15be533aca78d9ec11cf2",
                "hex",
            ),
            recordAddressKey: Buffer.from(
                "eb24a1da14ef90199e4951fe70ffd8d37a9dcada923ea7d14ee5a982efe2e3ea",
                "hex",
            ),
            version: 2,
            createdAt,
            updatedAt,
        }));
        currentTx.sessionSystemRecord.updateMany.mockResolvedValue({ count: 1 });

        const result = await upsertSessionSystemRecord({
            actorUserId: "shared-editor",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
            localId: "activity:workflow_run:v1:wf_demo",
            content: nextContent,
        });

        expect(result).toMatchObject({ ok: true, didCreate: false, didUpdate: true });
        expect(currentTx.sessionSystemRecord.findFirst).toHaveBeenCalledTimes(2);
        expect(currentTx.sessionSystemRecord.updateMany).toHaveBeenCalledWith({
            where: expect.objectContaining({
                id: "rec-wf",
                sessionId: "s1",
                session: {
                    is: expect.objectContaining({
                        id: "s1",
                        OR: expect.arrayContaining([
                            { accountId: "shared-editor" },
                            expect.any(Object),
                        ]),
                    }),
                },
            }),
            data: {
                content: nextContent,
                ownerKind: "host",
                pluginId: null,
                namespaceAddressKey: Uint8Array.from(Buffer.from(
                    "f41076a2bcb5e029d45eacb7f39bb5c0770477a9b2c15be533aca78d9ec11cf2",
                    "hex",
                )),
                recordAddressKey: Uint8Array.from(Buffer.from(
                    "eb24a1da14ef90199e4951fe70ffd8d37a9dcada923ea7d14ee5a982efe2e3ea",
                    "hex",
                )),
                version: { increment: 1 },
            },
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
        const memoryKeys = deriveSessionSystemRecordAddressKeys({
            ownerKind: "host",
            pluginId: null,
            namespace: "memory",
            localId: "memory:synopsis:v1:2",
        });
        expect(currentTx.sessionSystemRecord.findFirst).toHaveBeenNthCalledWith(1, expect.objectContaining({
            where: expect.objectContaining({
                accountId: "shared-editor",
                sessionId: "s1",
                recordAddressKey: memoryKeys.recordAddressKey,
                session: { is: expect.objectContaining({ id: "s1" }) },
            }),
            select: expect.any(Object),
        }));
    });

    it("reads shared activity workflow records from the session owner account", async () => {
        const createdAt = new Date("2026-06-26T10:00:00.000Z");
        const ownerRecord = activityRecord({ createdAt, updatedAt: createdAt });
        const currentTx = testState.currentTx as TxMock;
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
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

        expect(currentTx.sessionSystemRecord.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                accountId: "owner-account",
                sessionId: "s1",
                recordAddressKey: ACTIVITY_WORKFLOW_RECORD_KEY,
                session: { is: expect.objectContaining({ id: "s1" }) },
            }),
            select: expect.any(Object),
        }));
        expect(currentTx.sessionSystemRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                sessionId: "s1",
                OR: [{
                    accountId: "owner-account",
                    namespaceAddressKey: ACTIVITY_NAMESPACE_KEY,
                    kind: { in: ["workflow_run.v1"] },
                }],
            }),
        }));
        expect(currentTx.sessionSystemRecord.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                accountId: "owner-account",
                sessionId: "s1",
                kind: "workflow_run.v1",
                namespaceAddressKey: ACTIVITY_NAMESPACE_KEY,
            }),
        }));
    });

    it("keeps permission mediation kinds closed to generic host record operations", async () => {
        const currentTx = testState.currentTx as TxMock;
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", accountId: "owner-account" });
        const address = {
            owner: "host" as const,
            namespace: "permission" as const,
            kind: "remote_settlement.v1" as const,
            localId: "permission:remote_settlement:v1:request-1",
        };
        const content = { t: "encrypted" as const, c: "sealed-permission-record" };

        await expect(readSessionSystemRecordV1({
            actorUserId: "owner-account",
            sessionId: "s1",
            address,
        })).resolves.toEqual({ ok: false, code: "plugin_session_record_forbidden" });
        await expect(listSessionSystemRecordsV1({
            actorUserId: "owner-account",
            sessionId: "s1",
            query: { owner: "host", namespace: "permission", kind: "remote_settlement.v1", limit: 1 },
        })).resolves.toEqual({ ok: false, code: "plugin_session_record_forbidden" });
        await expect(upsertSessionSystemRecordV1({
            actorUserId: "owner-account",
            sessionId: "s1",
            address,
            content,
            expectedRevision: null,
        })).resolves.toEqual({ ok: false, code: "plugin_session_record_forbidden" });
        await expect(deleteSessionSystemRecordV1({
            actorUserId: "owner-account",
            sessionId: "s1",
            address,
        })).resolves.toEqual({ ok: false, code: "plugin_session_record_forbidden" });

        await expect(listSessionSystemRecords({
            actorUserId: "owner-account",
            sessionId: "s1",
            namespace: "permission",
        })).resolves.toEqual({ ok: false, error: "forbidden" });
        await expect(getSessionSystemRecord({
            actorUserId: "owner-account",
            sessionId: "s1",
            namespace: "permission",
            localId: address.localId,
        })).resolves.toEqual({ ok: false, error: "forbidden" });
        await expect(upsertSessionSystemRecord({
            actorUserId: "owner-account",
            sessionId: "s1",
            namespace: "permission",
            kind: "remote_settlement.v1",
            localId: address.localId,
            content,
        })).resolves.toEqual({ ok: false, error: "forbidden" });

        expect(currentTx.sessionSystemRecord.findFirst).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.findMany).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.create).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.update).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.updateMany).not.toHaveBeenCalled();
        expect(currentTx.sessionSystemRecord.deleteMany).not.toHaveBeenCalled();
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
            ownerKind: "host",
            pluginId: null,
            ...deriveSessionSystemRecordAddressKeys({
                ownerKind: "host",
                pluginId: null,
                namespace: "memory",
                localId: "memory:synopsis:v1:2",
            }),
            version: 1,
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
            ownerKind: "host",
            pluginId: null,
            namespaceAddressKey: ACTIVITY_NAMESPACE_KEY,
            recordAddressKey: ACTIVITY_WORKFLOW_RECORD_KEY,
            version: 1,
            createdAt,
            updatedAt: new Date(createdAt.getTime() - 2),
        };
        const permissionNamespaceKey = deriveSessionSystemRecordAddressKeys({
            ownerKind: "host",
            pluginId: null,
            namespace: "permission",
            localId: "",
        }).namespaceAddressKey;
        currentTx.session.findUnique.mockResolvedValue({
            encryptionMode: "plain",
            accountId: "owner-account",
        });
        currentTx.sessionSystemRecord.findMany.mockImplementation(
            async ({ take }: { take: number }) => [publicMemoryRecord, publicActivityRecord].slice(0, take),
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
                        expect.objectContaining({ namespaceAddressKey: publicMemoryRecord.namespaceAddressKey }),
                        expect.objectContaining({ namespaceAddressKey: ACTIVITY_NAMESPACE_KEY }),
                    ]),
                }),
                take: 3,
            }),
        );
        const initialListWhere = currentTx.sessionSystemRecord.findMany.mock.calls[0]?.[0]?.where as {
            OR?: readonly unknown[];
        } | undefined;
        expect(initialListWhere?.OR).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ namespaceAddressKey: permissionNamespaceKey }),
        ]));

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
