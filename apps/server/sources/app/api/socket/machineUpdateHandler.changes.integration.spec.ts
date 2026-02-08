import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInTxHarness } from "../testkit/txHarness";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

const emitUpdate = vi.fn();
const buildUpdateMachineUpdate = vi.fn((_machineId: string, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "update-machine" },
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate, emitEphemeral: vi.fn() },
    buildUpdateMachineUpdate,
    buildMachineActivityEphemeral: vi.fn(() => ({ t: "machine-activity" })),
}));

const randomKeyNaked = vi.fn(() => "upd-id");
vi.mock("@/utils/randomKeyNaked", () => ({ randomKeyNaked }));

const markAccountChanged = vi.fn(async () => 321);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

vi.mock("@/app/monitoring/metrics2", () => ({
    machineAliveEventsCounter: { inc: vi.fn() },
    websocketEventsCounter: { inc: vi.fn() },
}));

vi.mock("@/utils/log", () => ({ log: vi.fn() }));

vi.mock("@/app/presence/sessionCache", () => ({
    activityCache: {
        isMachineValid: vi.fn(async () => true),
        queueMachineUpdate: vi.fn(),
    },
}));

vi.mock("@/storage/db", () => ({ db: {} }));

vi.mock("@/storage/inTx", () => {
    const { inTx, afterTx } = createInTxHarness(() => ({
            machine: {
                findFirst: async (args: any) => {
                    if (args?.select?.metadataVersion) {
                        return { metadataVersion: 1, metadata: "old-meta" };
                    }
                    if (args?.select?.daemonStateVersion) {
                        return { daemonStateVersion: 2, daemonState: "old-state" };
                    }
                    return null;
                },
                updateMany: async () => ({ count: 1 }),
            },
    }));

    return { afterTx, inTx };
});

describe("machineUpdateHandler (AccountChange integration)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
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
});
