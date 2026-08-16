import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1,
    MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1,
} from "@happier-dev/protocol";

import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

const log = vi.fn();
const emitEphemeral = vi.fn();
const buildMachineActivityEphemeral = vi.fn((machineId: string, active: boolean, activeAt: number) => ({
    type: "machine-activity",
    id: machineId,
    active,
    activeAt,
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitEphemeral },
    buildMachineActivityEphemeral,
    buildUpdateMachineUpdate: vi.fn(),
}));

vi.mock("@/app/monitoring/metrics/index", () => ({
    machineAliveEventsCounter: { inc: vi.fn() },
    websocketEventsCounter: { inc: vi.fn() },
}));

const isMachineValid = vi.fn(async () => true);
const invalidateMachine = vi.fn();
vi.mock("@/app/presence/sessionCache", () => ({
    activityCache: { isMachineValid, invalidateMachine },
}));

const recordMachineAlive = vi.fn(async () => {});
vi.mock("@/app/presence/presenceRecorder", () => ({ recordMachineAlive }));

const captureMachineSessionTerminal = vi.fn();
const finalizeMachineSessionTerminal = vi.fn();
const publishSessionPublisherClose = vi.fn(async () => {});
vi.mock("@/app/presence/publishSessionPublisherClose", () => ({ publishSessionPublisherClose }));

const machineFindFirst = vi.fn(async (): Promise<{ revokedAt: Date | null; replacedByMachineId: string | null }> => ({
    revokedAt: null,
    replacedByMachineId: null,
}));
vi.mock("@/storage/db", () => ({
    db: {
        machine: {
            findFirst: machineFindFirst,
        },
    },
}));

vi.mock("@/storage/inTx", () => ({
    afterTx: vi.fn((_tx: unknown, fn: () => void) => fn()),
    inTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ machine: { findFirst: machineFindFirst, updateMany: vi.fn() } })),
}));

vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged: vi.fn() }));
vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked: vi.fn(() => "upd") }));
vi.mock("@/utils/logging/log", () => ({ log }));

const executeExternalSessionHistoricalImportCommand = vi.fn(async (
    params: Readonly<{
        limits: Readonly<{ maxItems: number; maxSerializedBytes: number }>;
    }>,
) => ({
    v: 1,
    kind: "ready",
    claim: {
        sessionId: "s1",
        operationId: "op1",
        operationClaimId: "claim1",
    },
    revision: 0,
    historicalImportJobId: "job1",
    limits: params.limits,
}));
vi.mock("@/app/session/externalSessionHistoricalImportCommand", () => ({
    executeExternalSessionHistoricalImportCommand,
}));

const defaultMachineUpdateHandlerOptions = {
    operationSocketBatchLimits: {
        ok: true as const,
        limits: { maxItems: 200, maxSerializedBytes: 524_288 },
    },
    sessionPublisherPresence: {
        captureMachineSessionTerminal,
        finalizeMachineSessionTerminal,
    },
};

describe("machineUpdateHandler authenticated machine identity binding", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        isMachineValid.mockResolvedValue(true);
        machineFindFirst.mockResolvedValue({ revokedAt: null, replacedByMachineId: null });
    });

    it("ignores machine-alive events from user-scoped sockets", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");

        const socket = createFakeSocket({ data: { clientType: "user-scoped" } });
        machineUpdateHandler("u1", socket as any, defaultMachineUpdateHandlerOptions);

        await getSocketHandler(socket, "machine-alive")({ machineId: "m1", time: Date.now() });

        expect(recordMachineAlive).not.toHaveBeenCalled();
        expect(emitEphemeral).not.toHaveBeenCalled();
        expect(isMachineValid).not.toHaveBeenCalled();
    });

    it("ignores machine-alive events whose payload machine differs from the authenticated socket machine", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");

        const socket = createFakeSocket({
            data: {
                clientType: "machine-scoped",
                machineId: "m1",
            },
        });
        machineUpdateHandler("u1", socket as any, defaultMachineUpdateHandlerOptions);

        await getSocketHandler(socket, "machine-alive")({ machineId: "m2", time: Date.now() });

        expect(recordMachineAlive).not.toHaveBeenCalled();
        expect(emitEphemeral).not.toHaveBeenCalled();
        expect(isMachineValid).not.toHaveBeenCalled();
    });

    it("records alive state for the authenticated socket machine when the payload omits machineId", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");
        const now = Date.now();

        const socket = createFakeSocket({
            data: {
                clientType: "machine-scoped",
                machineId: "m1",
            },
        });
        machineUpdateHandler("u1", socket as any, defaultMachineUpdateHandlerOptions);

        await getSocketHandler(socket, "machine-alive")({ time: now });

        expect(isMachineValid).toHaveBeenCalledWith("m1", "u1");
        expect(recordMachineAlive).toHaveBeenCalledWith({ accountId: "u1", machineId: "m1", timestamp: now });
        expect(buildMachineActivityEphemeral).toHaveBeenCalledWith("m1", true, now);
        expect(emitEphemeral).toHaveBeenCalledWith(expect.objectContaining({
            userId: "u1",
            payload: expect.objectContaining({ id: "m1" }),
            recipientFilter: { type: "user-scoped-only" },
        }));
    });

    it("captures and finalizes only the authenticated machine session terminal fence", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");
        const committedFence = new Date(1_234);
        captureMachineSessionTerminal.mockResolvedValueOnce({
            status: "captured",
            target: {
                binding: { accountId: "u1", machineId: "m1", sessionId: "s1" },
                committedFence,
            },
        });
        finalizeMachineSessionTerminal.mockResolvedValueOnce({
            status: "closed",
            activeAt: committedFence,
            participantCursors: [],
            badgeAttentionChanged: false,
        });
        const socket = createFakeSocket({
            data: {
                clientType: "machine-scoped",
                machineId: "m1",
            },
        });
        machineUpdateHandler("u1", socket as any, defaultMachineUpdateHandlerOptions as any);

        const captureCallback = vi.fn();
        await getSocketHandler(socket, MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1)({
            v: 1,
            sessionId: "s1",
        }, captureCallback);
        expect(captureMachineSessionTerminal).toHaveBeenCalledWith({
            binding: { accountId: "u1", machineId: "m1", sessionId: "s1" },
        });
        expect(captureCallback).toHaveBeenCalledWith({
            v: 1,
            status: "captured",
            sessionId: "s1",
            committedFenceMs: 1_234,
        });

        const finalizeCallback = vi.fn();
        await getSocketHandler(socket, MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1)({
            v: 1,
            sessionId: "s1",
            committedFenceMs: 1_234,
        }, finalizeCallback);
        expect(finalizeMachineSessionTerminal).toHaveBeenCalledWith({
            target: {
                binding: { accountId: "u1", machineId: "m1", sessionId: "s1" },
                committedFence,
            },
        });
        expect(publishSessionPublisherClose).toHaveBeenCalledWith({
            sessionId: "s1",
            publisherAccountId: "u1",
            closed: expect.objectContaining({ status: "closed" }),
        });
        expect(finalizeCallback).toHaveBeenCalledWith({
            v: 1,
            status: "closed",
            sessionId: "s1",
        });
    });

    it("makes a replayed machine terminal finalize a no-op", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");
        finalizeMachineSessionTerminal.mockResolvedValueOnce({ status: "already_inactive" });
        const socket = createFakeSocket({
            data: {
                clientType: "machine-scoped",
                machineId: "m1",
            },
        });
        machineUpdateHandler("u1", socket as any, defaultMachineUpdateHandlerOptions as any);

        const callback = vi.fn();
        await getSocketHandler(socket, MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1)({
            v: 1,
            sessionId: "s1",
            committedFenceMs: 1_234,
        }, callback);

        expect(publishSessionPublisherClose).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            v: 1,
            status: "already_inactive",
            sessionId: "s1",
        });
    });

    it.each([
        {
            name: "user-scoped",
            data: { clientType: "user-scoped" },
            machine: { revokedAt: null, replacedByMachineId: null },
        },
        {
            name: "revoked",
            data: { clientType: "machine-scoped", machineId: "m1" },
            machine: { revokedAt: new Date(1), replacedByMachineId: null },
        },
        {
            name: "replaced",
            data: { clientType: "machine-scoped", machineId: "m1" },
            machine: { revokedAt: null, replacedByMachineId: "m2" },
        },
    ])("rejects machine terminal capture and finalize from $name sockets before presence", async ({
        data,
        machine,
    }) => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");
        machineFindFirst.mockResolvedValue(machine);
        const socket = createFakeSocket({ data });
        machineUpdateHandler("u1", socket as any, defaultMachineUpdateHandlerOptions);

        const captureCallback = vi.fn();
        await getSocketHandler(socket, MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1)(
            { v: 1, sessionId: "s1" },
            captureCallback,
        );
        const finalizeCallback = vi.fn();
        await getSocketHandler(socket, MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1)(
            { v: 1, sessionId: "s1", committedFenceMs: 1_234 },
            finalizeCallback,
        );

        expect(captureMachineSessionTerminal).not.toHaveBeenCalled();
        expect(finalizeMachineSessionTerminal).not.toHaveBeenCalled();
        expect(captureCallback).toHaveBeenCalledWith(expect.objectContaining({
            status: "rejected",
            reason: "wrong_machine_socket",
        }));
        expect(finalizeCallback).toHaveBeenCalledWith(expect.objectContaining({
            status: "rejected",
            reason: "wrong_machine_socket",
        }));
    });

    it("keeps machine-alive failures structural in logs", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");
        const sentinel = "/var/private/machine.db TOKEN_SECRET transcript-secret";
        recordMachineAlive.mockRejectedValueOnce(new Error(sentinel));
        const socket = createFakeSocket({
            data: {
                clientType: "machine-scoped",
                machineId: "m1",
            },
        });
        machineUpdateHandler("u1", socket as any, defaultMachineUpdateHandlerOptions);

        await getSocketHandler(socket, "machine-alive")({ time: Date.now() });

        expect(log).toHaveBeenCalledWith(
            {
                module: "websocket",
                level: "error",
                event: "machine-alive",
                errorCode: "internal_error",
            },
            "Machine alive handling failed.",
        );
        expect(JSON.stringify(log.mock.calls)).not.toContain(sentinel);
    });

    it("does not record alive when the authenticated machine has been replaced", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");
        const now = Date.now();
        machineFindFirst.mockResolvedValueOnce({ revokedAt: null, replacedByMachineId: "m2" });

        const socket = createFakeSocket({
            data: {
                clientType: "machine-scoped",
                machineId: "m1",
            },
        });
        machineUpdateHandler("u1", socket as any, defaultMachineUpdateHandlerOptions);

        await getSocketHandler(socket, "machine-alive")({ time: now });

        expect(machineFindFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { accountId: "u1", id: "m1" },
            select: { revokedAt: true, replacedByMachineId: true },
        }));
        expect(recordMachineAlive).not.toHaveBeenCalled();
        expect(emitEphemeral).not.toHaveBeenCalled();
    });

    it("rejects metadata updates from session-scoped sockets", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");

        const socket = createFakeSocket({ data: { clientType: "session-scoped", sessionId: "s1" } });
        machineUpdateHandler("u1", socket as any, defaultMachineUpdateHandlerOptions);

        const callback = vi.fn();
        await getSocketHandler(socket, "machine-update-metadata")(
            { machineId: "m1", metadata: "new-meta", expectedVersion: 1 },
            callback,
        );

        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ result: "error" }));
    });

    it("rejects daemon state updates from replaced machine sockets", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");
        machineFindFirst.mockResolvedValueOnce({ revokedAt: null, replacedByMachineId: "m2" });

        const socket = createFakeSocket({
            data: {
                clientType: "machine-scoped",
                machineId: "m1",
            },
        });
        machineUpdateHandler("u1", socket as any, defaultMachineUpdateHandlerOptions);

        const callback = vi.fn();
        await getSocketHandler(socket, "machine-update-state")(
            { machineId: "m1", daemonState: "new-state", expectedVersion: 1 },
            callback,
        );

        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ result: "error" }));
    });

    it.each([
        {
            event: "machine-update-metadata",
            data: { metadata: "new-meta", expectedVersion: 1 },
            message: "Machine metadata update failed.",
        },
        {
            event: "machine-update-state",
            data: { daemonState: "new-state", expectedVersion: 1 },
            message: "Machine state update failed.",
        },
    ])("keeps $event database failures structural in logs and responses", async ({ event, data, message }) => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");
        const sentinel = {
            message: "database-secret-message",
            cause: { path: "/Users/alice/private/machine.db" },
            request: { token: "TOKEN_SECRET" },
            source: { transcript: "transcript-secret" },
        };
        machineFindFirst.mockRejectedValueOnce(sentinel);
        const socket = createFakeSocket({
            data: {
                clientType: "machine-scoped",
                machineId: "m1",
            },
        });
        machineUpdateHandler("u1", socket as any, defaultMachineUpdateHandlerOptions);
        const callback = vi.fn();

        await getSocketHandler(socket, event)({ machineId: "m1", ...data }, callback);

        expect(log).toHaveBeenCalledWith(
            {
                module: "websocket",
                level: "error",
                event,
                errorCode: "internal_error",
            },
            message,
        );
        expect(callback).toHaveBeenCalledWith({ result: "error", message: "Internal error" });
        const outward = JSON.stringify({ logs: log.mock.calls, responses: callback.mock.calls });
        expect(outward).not.toContain("database-secret-message");
        expect(outward).not.toContain("/Users/alice");
        expect(outward).not.toContain("TOKEN_SECRET");
        expect(outward).not.toContain("transcript-secret");
    });

    it("binds historical import commands to the authenticated machine socket", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");
        const socket = createFakeSocket({
            data: {
                clientType: "machine-scoped",
                machineId: "m1",
            },
        });
        machineUpdateHandler("u1", socket as any, {
            operationSocketBatchLimits: {
                ok: true,
                limits: { maxItems: 200, maxSerializedBytes: 484_464 },
            },
        });
        const callback = vi.fn();
        const command = {
            v: 1,
            kind: "begin",
            claim: {
                sessionId: "s1",
                operationId: "op1",
                operationClaimId: "claim1",
            },
            expectedRevision: 0,
            expectedPriorStableStorage: { state: "machine_only" },
        };

        await getSocketHandler(socket, "externalSessions.operation.v1")(command, callback);

        expect(executeExternalSessionHistoricalImportCommand).toHaveBeenCalledWith({
            actorUserId: "u1",
            transportMachineId: "m1",
            command,
            limits: { maxItems: 200, maxSerializedBytes: 484_464 },
        });
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({
            kind: "ready",
            limits: { maxItems: 200, maxSerializedBytes: 484_464 },
        }));
    }, 60_000);

    it.each([
        new Error("/var/private/external-session.db TOKEN_SECRET transcript-secret"),
        {
            message: "provider-secret-message",
            cause: { path: "/Users/alice/private/session.jsonl" },
            request: { token: "TOKEN_SECRET" },
            source: { transcript: "transcript-secret" },
            link: { claim: "claim-secret" },
        },
    ])("keeps historical-import failures structural in logs and outward diagnostics", async (failure) => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");
        executeExternalSessionHistoricalImportCommand.mockRejectedValueOnce(failure);
        const socket = createFakeSocket({
            data: {
                clientType: "machine-scoped",
                machineId: "m1",
            },
        });
        machineUpdateHandler("u1", socket as any, defaultMachineUpdateHandlerOptions);
        const callback = vi.fn();

        await getSocketHandler(socket, "externalSessions.operation.v1")({
            v: 1,
            kind: "begin",
            claim: {
                sessionId: "s1",
                operationId: "op1",
                operationClaimId: "claim-secret",
            },
            expectedRevision: 0,
            expectedPriorStableStorage: { state: "machine_only" },
        }, callback);

        expect(log).toHaveBeenCalledWith(
            {
                module: "websocket",
                level: "error",
                event: "externalSessions.operation.v1",
                errorCode: "internal_error",
            },
            "External Session historical import command failed.",
        );
        expect(callback).toHaveBeenCalledWith({
            v: 1,
            kind: "error",
            errorCode: "internal_error",
            message: "Historical import command failed.",
        });
        const outward = JSON.stringify({ logs: log.mock.calls, responses: callback.mock.calls });
        expect(outward).not.toContain("/var/private");
        expect(outward).not.toContain("/Users/alice");
        expect(outward).not.toContain("TOKEN_SECRET");
        expect(outward).not.toContain("provider-secret-message");
        expect(outward).not.toContain("transcript-secret");
        expect(outward).not.toContain("claim-secret");
    });

    it("keeps transcript-invalidation failures structural in logs", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");
        const sentinel = "/Users/alice/private/session.jsonl TOKEN_SECRET transcript-secret";
        machineFindFirst.mockRejectedValueOnce(new Error(sentinel));
        const socket = createFakeSocket({
            data: {
                clientType: "machine-scoped",
                machineId: "m1",
            },
        });
        machineUpdateHandler("u1", socket as any, defaultMachineUpdateHandlerOptions);

        await getSocketHandler(socket, "external-session-transcript-invalidated")({
            v: 1,
            type: "external-session-transcript-invalidated",
            binding: {
                v: 1,
                machineId: "m1",
                sessionId: "s1",
                link: {
                    generation: "link-generation-1",
                    remoteSessionId: "remote-session-1",
                },
                source: {
                    qualifiedIdentity: {
                        v: 1,
                        agent: {
                            pluginId: "happier.codex",
                            localId: "codex",
                        },
                        source: {
                            kind: "codexHome",
                            contractVersion: 1,
                        },
                    },
                    generation: "source-generation-1",
                },
                contributionGeneration: "contribution-generation-1",
                cursorIdentity: `external_session_cursor_binding_v1:${"a".repeat(64)}`,
            },
        });

        expect(log).toHaveBeenCalledWith(
            {
                module: "websocket",
                level: "error",
                event: "external-session-transcript-invalidated",
                errorCode: "internal_error",
            },
            "External Session transcript invalidation handling failed.",
        );
        expect(JSON.stringify(log.mock.calls)).not.toContain(sentinel);
    });

    it("rejects historical import before command execution when live socket capacity is insufficient", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");
        const socket = createFakeSocket({
            data: {
                clientType: "machine-scoped",
                machineId: "m1",
            },
        });
        machineUpdateHandler("u1", socket as any, {
            operationSocketBatchLimits: {
                ok: false,
                errorCode: "socket_capacity_insufficient",
            },
        });
        const callback = vi.fn();

        await getSocketHandler(socket, "externalSessions.operation.v1")({
            v: 1,
            kind: "begin",
            claim: {
                sessionId: "s1",
                operationId: "op1",
                operationClaimId: "claim1",
            },
            expectedRevision: 0,
            expectedPriorStableStorage: { state: "machine_only" },
        }, callback);

        expect(executeExternalSessionHistoricalImportCommand).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({
            v: 1,
            kind: "error",
            errorCode: "socket_capacity_insufficient",
        }));
    });

    it("rejects historical import commands from a replaced authenticated machine", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");
        machineFindFirst.mockResolvedValueOnce({ revokedAt: null, replacedByMachineId: "m2" });
        const socket = createFakeSocket({
            data: {
                clientType: "machine-scoped",
                machineId: "m1",
            },
        });
        machineUpdateHandler("u1", socket as any, defaultMachineUpdateHandlerOptions);
        const callback = vi.fn();

        await getSocketHandler(socket, "externalSessions.operation.v1")({
            v: 1,
            kind: "begin",
            claim: {
                sessionId: "s1",
                operationId: "op1",
                operationClaimId: "claim1",
            },
            expectedRevision: 0,
            expectedPriorStableStorage: { state: "machine_only" },
        }, callback);

        expect(executeExternalSessionHistoricalImportCommand).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            v: 1,
            kind: "error",
            errorCode: "wrong_machine_socket",
            message: "Historical import requires a current machine socket.",
        });
    }, 60_000);
});
