import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDbMocks, installDbModuleMock } from "../testkit/dbMocks";
import { createInTxHarness } from "../testkit/txHarness";
import { createFakeSocket as createSocketBoundary, getSocketHandler } from "../testkit/socketHarness";
import type { EphemeralPayload } from "@/app/events/eventPayloadTypes";
import { ExternalSessionTranscriptInvalidationV1Schema, sealAccountScopedBlobCiphertext } from "@happier-dev/protocol";
import { VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from "./machineSocketInstallationProof";

const emitUpdate = vi.fn();
const emitEphemeral = vi.fn();
const buildUpdateMachineUpdate = vi.fn((_machineId: string, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "update-machine" },
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate, emitEphemeral },
    buildUpdateMachineUpdate,
    buildMachineActivityEphemeral: vi.fn(() => ({ t: "machine-activity" })),
}));

const randomKeyNaked = vi.fn(() => "upd-id");
vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked }));

const markAccountChanged = vi.fn(async () => 321);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

vi.mock("@/app/monitoring/metrics/index", () => ({
    machineAliveEventsCounter: { inc: vi.fn() },
    websocketEventsCounter: { inc: vi.fn() },
}));

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

vi.mock("@/app/presence/sessionCache", () => ({
    activityCache: {
        isMachineValid: vi.fn(async () => true),
        queueMachineUpdate: vi.fn(),
    },
}));

let machineRevokedAt: Date | null = null;
let accountMode: 'plain' | 'e2ee' = 'e2ee';
let tokenEpoch = 0;
let signedToken = '';
let retireDuringModeRead = false;
// Socket transport is external; signed credential verification and Account mode stay real.
const createFakeSocket = (overrides: Parameters<typeof createSocketBoundary>[0] = {}) => ({
    ...createSocketBoundary(overrides), handshake: { auth: { token: signedToken } }, disconnect: vi.fn(),
});
const txDbMocks = createDbMocks({
    machine: ["findFirst", "findUnique", "updateMany"],
    account: ["findUnique"],
} as const);

installDbModuleMock(() => ({ db: txDbMocks.db }));

vi.mock("@/storage/inTx", () => {
    const { inTx, afterTx } = createInTxHarness(() => ({
            machine: txDbMocks.db.machine,
    }));

    return { afterTx, inTx };
});

const machineUpdateHandlerOptions = {
    operationSocketBatchLimits: {
        ok: true as const,
        limits: { maxItems: 200, maxSerializedBytes: 524_288 },
    },
};

describe("machineUpdateHandler (AccountChange integration)", () => {
    afterEach(() => vi.unstubAllEnvs());
    beforeEach(async () => {
        vi.clearAllMocks();
        machineRevokedAt = null;
        accountMode = 'e2ee'; tokenEpoch = 0; retireDuringModeRead = false;
        txDbMocks.reset();
        txDbMocks.db.account.findUnique.mockImplementation(async (args: {
            where: { id: string }; select?: { encryptionMode?: boolean };
        }) => {
            if (args.where.id !== 'u1') return null;
            const row = { id: 'u1', status: 'active', tokenEpoch, encryptionMode: accountMode };
            if (args.select?.encryptionMode && retireDuringModeRead) tokenEpoch += 1;
            return row;
        });
        vi.stubEnv('HANDY_MASTER_SECRET', 'operation-publication-signed-test-secret');
        const { auth } = await import('@/app/auth/auth');
        await auth.init();
        signedToken = await auth.createToken('u1', undefined, { kind: 'account', authority: 'present_user' });
        txDbMocks.db.machine.findFirst.mockImplementation(async (args: any) => {
            if (args?.select?.metadataVersion) {
                return { metadataVersion: 1, metadata: "old-meta", revokedAt: machineRevokedAt };
            }
            if (args?.select?.daemonStateVersion) {
                return { daemonStateVersion: 2, daemonState: "old-state", revokedAt: machineRevokedAt };
            }
            if (args?.select?.revokedAt && args?.select?.replacedByMachineId) {
                return { revokedAt: machineRevokedAt, replacedByMachineId: null };
            }
            return null;
        });
        txDbMocks.db.machine.updateMany.mockResolvedValue({ count: 1 });
    });

    it("publishes keyless Plain Script observations only for the current signed requester Account", async () => {
        const { machineUpdateHandler } = await import('./machineUpdateHandler');
        accountMode = 'plain';
        const socket = createFakeSocket({ data: { clientType: 'machine-scoped', machineId: 'm1' } });
        // Socket.IO is the substituted network boundary, not credential or mode admission.
        machineUpdateHandler('u1', socket as any, machineUpdateHandlerOptions);
        const snapshot = { version: 1, operationId: 'script', revision: 1, actionId: 'projects.script.run',
            state: 'accepted', scope: { accountId: 'u1', machineId: 'm1' }, title: 'Run Script', createdAt: 1,
            cancellation: 'supported', domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
                machineId: 'worker', workspaceRefId: 'copied-target', cwd: '/target',
                sourceWorkspace: { serverId: 'home', machineId: 'source', workspaceId: 'selected-source', rootPath: '/source' },
                script: { name: 'check', source: { kind: 'command', command: 'check' } } } };
        const raw = { type: 'action-operation-updated', machineId: 'm1', content: { t: 'plain', v: snapshot } };
        const push = getSocketHandler(socket, 'action-operation-updated');
        await push(raw);
        expect(emitEphemeral).toHaveBeenCalledWith({ userId: 'u1', payload: raw,
            recipientFilter: { type: 'user-scoped-only' } });
        emitEphemeral.mockClear();
        accountMode = 'e2ee';
        await push(raw);
        accountMode = 'plain';
        await push({ ...raw, content: { t: 'plain', v: { ...snapshot, scope: { accountId: 'custodian', machineId: 'm1' } } } });
        retireDuringModeRead = true;
        await push(raw);
        expect(emitEphemeral).not.toHaveBeenCalled();
        expect(tokenEpoch).toBeGreaterThan(0);
    });

    it("accepts and rebroadcasts the immutable released 0.2.11 Action operation envelope", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");
        const ciphertext = sealAccountScopedBlobCiphertext({
            kind: "action_operation_snapshot",
            material: { type: "legacy", secret: new Uint8Array(32).fill(7) },
            payload: { operationId: "operation-1" },
            randomBytes: (length) => new Uint8Array(length).fill(3),
        });
        const socket = createFakeSocket({
            data: { clientType: "machine-scoped", machineId: "m1" },
        });
        machineUpdateHandler("u1", socket as any, machineUpdateHandlerOptions);

        await getSocketHandler(socket, "action-operation-updated")({
            type: "action-operation-updated",
            machineId: "m1",
            content: { t: "encrypted", c: ciphertext },
        });

        expect(emitEphemeral).toHaveBeenCalledWith({
            userId: "u1",
            payload: {
                type: "action-operation-updated",
                machineId: "m1",
                content: { t: "encrypted", c: ciphertext },
            },
            recipientFilter: { type: "user-scoped-only" },
        });
    });

    it("drains pre-release current-dev Action operation ingress into only the released 0.2.11 broadcast", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");
        const ciphertext = sealAccountScopedBlobCiphertext({
            kind: "action_operation_snapshot",
            material: { type: "legacy", secret: new Uint8Array(32).fill(7) },
            payload: { operationId: "operation-1" },
            randomBytes: (length) => new Uint8Array(length).fill(3),
        });
        const socket = createFakeSocket({
            data: { clientType: "machine-scoped", machineId: "m1" },
        });
        machineUpdateHandler("u1", socket as any, machineUpdateHandlerOptions);

        await getSocketHandler(socket, "action-operation-snapshot.v1")({
            v: 1,
            machineId: "m1",
            ciphertext,
        });

        expect(emitEphemeral).toHaveBeenCalledTimes(1);
        expect(emitEphemeral).toHaveBeenCalledWith({
            userId: "u1",
            payload: {
                type: "action-operation-updated",
                machineId: "m1",
                content: { t: "encrypted", c: ciphertext },
            },
            recipientFilter: { type: "user-scoped-only" },
        });
    });

    it("returns machine-not-found when the machine disappears during a metadata compare-and-swap", async () => {
        // Storage boundary models deletion between read and CAS; canonical
        // admission and caller-envelope logic execute against the retained owner fixture.
        txDbMocks.db.machine.findUnique.mockResolvedValue({
            id: "m1", kind: "persistent", accountId: "u1", metadata: "old-meta", metadataVersion: 1,
            daemonState: "old-state", daemonStateVersion: 0, dataEncryptionKey: null,
            installationId: "installation-1", active: false, revokedAt: null, replacedByMachineId: null,
            account: { status: "active", encryptionMode: "e2ee" },
            accountGrants: [], teamGrants: [], groupGrants: [],
        });
        txDbMocks.db.machine.findFirst
            .mockResolvedValueOnce({
                metadataVersion: 1,
                metadata: "old-meta",
                dataEncryptionKey: null,
                installationId: "installation-1",
                revokedAt: null,
                replacedByMachineId: null,
            })
            .mockResolvedValueOnce(null);
        txDbMocks.db.machine.updateMany.mockResolvedValueOnce({ count: 0 });

        const { machineUpdateHandler } = await import("./machineUpdateHandler");
        const socket = createFakeSocket({
            data: {
                clientType: "machine-scoped",
                machineId: "m1",
                [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: "installation-1",
            },
        });
        machineUpdateHandler("u1", socket as any, machineUpdateHandlerOptions);

        const callback = vi.fn();
        await getSocketHandler(socket, "machine-update-metadata")(
            { machineId: "m1", metadata: "new-meta", expectedVersion: 1, expectedDataEncryptionKey: null },
            callback,
        );

        expect(callback).toHaveBeenCalledWith({ result: "error", message: "Machine not found" });
        expect(markAccountChanged).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("rebroadcasts only content-free qualified external-session invalidations", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");

        const payload = {
            v: 1,
            type: "external-session-transcript-invalidated",
            binding: {
                v: 1,
                machineId: "m1",
                sessionId: "sess-1",
                link: { generation: "link-1", remoteSessionId: "remote-1" },
                source: {
                    qualifiedIdentity: {
                        v: 1,
                        agent: { pluginId: "happier.claude", localId: "claude" },
                        source: { kind: "claudeConfig", contractVersion: 1 },
                    },
                    generation: "source-1",
                },
                sourceCustody: { kind: "managed", immutableGenerationId: "contribution-1", installSource: "localPath" },
                cursorIdentity: `external_session_cursor_binding_v1:${"a".repeat(64)}`,
            },
        } satisfies EphemeralPayload;
        ExternalSessionTranscriptInvalidationV1Schema.parse(payload);

        const socket = createFakeSocket({
            data: {
                clientType: "machine-scoped",
                machineId: "m1",
            },
        });
        machineUpdateHandler("u1", socket as any, machineUpdateHandlerOptions);
        const handler = getSocketHandler(socket, "external-session-transcript-invalidated");

        await handler(payload);

        expect(JSON.stringify(payload)).not.toContain("happier_external_cursor_v1:");
        expect(JSON.stringify(payload)).not.toContain("cursor-1");
        expect(emitEphemeral).toHaveBeenCalledWith(expect.objectContaining({
            userId: "u1",
            payload,
            recipientFilter: { type: "all-interested-in-session", sessionId: "sess-1" },
        }));
        expect(socket.handlers.has("direct-session-transcript-delta")).toBe(false);
    });

    it("rejects transcript-bearing or cross-machine external-session invalidations", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");
        const payload = {
            v: 1,
            type: "external-session-transcript-invalidated",
            binding: {
                v: 1,
                machineId: "m1",
                sessionId: "sess-1",
                link: { generation: "link-1", remoteSessionId: "remote-1" },
                source: {
                    qualifiedIdentity: {
                        v: 1,
                        agent: { pluginId: "happier.claude", localId: "claude" },
                        source: { kind: "claudeConfig", contractVersion: 1 },
                    },
                    generation: "source-1",
                },
                sourceCustody: { kind: "managed", immutableGenerationId: "contribution-1", installSource: "localPath" },
                cursorIdentity: `external_session_cursor_binding_v1:${"a".repeat(64)}`,
            },
        };
        ExternalSessionTranscriptInvalidationV1Schema.parse(payload);
        const socket = createFakeSocket({
            data: {
                clientType: "machine-scoped",
                machineId: "m1",
            },
        });
        machineUpdateHandler("u1", socket as any, machineUpdateHandlerOptions);
        const handler = getSocketHandler(socket, "external-session-transcript-invalidated");

        await handler({
            ...payload,
            items: [{ id: "secret", raw: { text: "server-readable transcript" } }],
        });
        await handler({
            ...payload,
            binding: { ...payload.binding, machineId: "m2" },
        });

        expect(emitEphemeral).not.toHaveBeenCalled();
    });

    it("rejects external-session invalidations from a machine revoked after socket authentication", async () => {
        machineRevokedAt = new Date("2026-07-23T00:00:00.000Z");
        const { machineUpdateHandler } = await import("./machineUpdateHandler");
        const payload = {
            v: 1,
            type: "external-session-transcript-invalidated",
            binding: {
                v: 1,
                machineId: "m1",
                sessionId: "sess-1",
                link: { generation: "link-1", remoteSessionId: "remote-1" },
                source: {
                    qualifiedIdentity: {
                        v: 1,
                        agent: { pluginId: "happier.claude", localId: "claude" },
                        source: { kind: "claudeConfig", contractVersion: 1 },
                    },
                    generation: "source-1",
                },
                sourceCustody: { kind: "managed", immutableGenerationId: "contribution-1", installSource: "localPath" },
                cursorIdentity: `external_session_cursor_binding_v1:${"a".repeat(64)}`,
            },
        };
        ExternalSessionTranscriptInvalidationV1Schema.parse(payload);
        const socket = createFakeSocket({
            data: {
                clientType: "machine-scoped",
                machineId: "m1",
            },
        });
        machineUpdateHandler("u1", socket as any, machineUpdateHandlerOptions);
        const handler = getSocketHandler(socket, "external-session-transcript-invalidated");

        await handler(payload);

        expect(emitEphemeral).not.toHaveBeenCalled();
    });
});
