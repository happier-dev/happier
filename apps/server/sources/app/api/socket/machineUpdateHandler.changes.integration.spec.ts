import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDbMocks, installDbModuleMock } from "../testkit/dbMocks";
import { createInTxHarness } from "../testkit/txHarness";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

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

vi.mock("@/app/monitoring/metrics2", () => ({
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
const txDbMocks = createDbMocks({
    machine: ["findFirst", "updateMany"],
} as const);

installDbModuleMock(() => ({ db: txDbMocks.db }));

vi.mock("@/storage/inTx", () => {
    const { inTx, afterTx } = createInTxHarness(() => ({
            machine: txDbMocks.db.machine,
    }));

    return { afterTx, inTx };
});

describe("machineUpdateHandler (AccountChange integration)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        machineRevokedAt = null;
        txDbMocks.reset();
        txDbMocks.db.machine.findFirst.mockImplementation(async (args: any) => {
            if (args?.select?.metadataVersion) {
                return { metadataVersion: 1, metadata: "old-meta", revokedAt: machineRevokedAt };
            }
            if (args?.select?.daemonStateVersion) {
                return { daemonStateVersion: 2, daemonState: "old-state", revokedAt: machineRevokedAt };
            }
            return null;
        });
        txDbMocks.db.machine.updateMany.mockResolvedValue({ count: 1 });
    });

    it("marks machine metadata changes and emits updates using the returned cursor", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");

        const socket = createFakeSocket();
        machineUpdateHandler("u1", socket as any);
        const handler = getSocketHandler(socket, "machine-update-metadata");

        const callback = vi.fn();
        await handler({ machineId: "m1", metadata: "new-meta", expectedVersion: 1 }, callback);

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                accountId: "u1",
                kind: "machine",
                entityId: "m1",
            }),
        );

        expect(buildUpdateMachineUpdate).toHaveBeenCalledWith("m1", 321, expect.any(String), { value: "new-meta", version: 2 });
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith({ result: "success", version: 2, metadata: "new-meta" });
    });

    it("marks machine daemonState changes and emits updates using the returned cursor", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");

        const socket = createFakeSocket();
        machineUpdateHandler("u1", socket as any);
        const handler = getSocketHandler(socket, "machine-update-state");

        const callback = vi.fn();
        await handler({ machineId: "m2", daemonState: "new-state", expectedVersion: 2 }, callback);

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                accountId: "u1",
                kind: "machine",
                entityId: "m2",
            }),
        );

        expect(buildUpdateMachineUpdate).toHaveBeenCalledWith(
            "m2",
            321,
            expect.any(String),
            undefined,
            { value: "new-state", version: 3 },
        );
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith({ result: "success", version: 3, daemonState: "new-state" });
    });

    it("rejects metadata updates for revoked machines", async () => {
        machineRevokedAt = new Date("2026-02-19T00:00:00.000Z");

        const { machineUpdateHandler } = await import("./machineUpdateHandler");

        const socket = createFakeSocket();
        machineUpdateHandler("u1", socket as any);
        const handler = getSocketHandler(socket, "machine-update-metadata");

        const callback = vi.fn();
        await handler({ machineId: "m1", metadata: "new-meta", expectedVersion: 1 }, callback);

        expect(txDbMocks.db.machine.updateMany).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ result: "error" }));
    });

    it("rebroadcasts validated direct-session transcript delta ephemerals", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");

        const payload = {
            type: "direct-session-transcript-delta",
            sessionId: "sess-1",
            items: [
                {
                    id: "a2",
                    createdAtMs: 1_050,
                    localId: "direct-2",
                    raw: {
                        type: "assistant",
                        uuid: "a2",
                        message: { model: "m", content: [{ type: "text", text: "hello from push" }] },
                    },
                },
            ],
            nextCursor: "cursor-2",
            truncated: false,
            futureField: { preserved: true },
        };

        const socket = createFakeSocket({
            data: {
                clientType: "machine-scoped",
                machineId: "m1",
            },
        });
        machineUpdateHandler("u1", socket as any);
        const handler = socket.handlers.get("direct-session-transcript-delta");
        expect(handler).toEqual(expect.any(Function));
        if (!handler) return;

        await handler(payload);

        expect(emitEphemeral).toHaveBeenCalledWith(expect.objectContaining({
            userId: "u1",
            payload,
            recipientFilter: { type: "all-interested-in-session", sessionId: "sess-1" },
        }));
    });

    it("does not broadcast direct-session transcript deltas from non machine-scoped sockets", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");

        const socket = createFakeSocket({
            data: {
                clientType: "user-scoped",
            },
        });
        machineUpdateHandler("u1", socket as any);
        const handler = socket.handlers.get("direct-session-transcript-delta");
        expect(handler).toEqual(expect.any(Function));
        if (!handler) return;

        await handler({
            type: "direct-session-transcript-delta",
            sessionId: "sess-1",
            items: [],
            truncated: false,
        });

        expect(emitEphemeral).not.toHaveBeenCalled();
    });
});
