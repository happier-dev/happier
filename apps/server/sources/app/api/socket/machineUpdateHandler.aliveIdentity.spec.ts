import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

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

vi.mock("@/app/monitoring/metrics2", () => ({
    machineAliveEventsCounter: { inc: vi.fn() },
    websocketEventsCounter: { inc: vi.fn() },
}));

const isMachineValid = vi.fn(async () => true);
vi.mock("@/app/presence/sessionCache", () => ({
    activityCache: { isMachineValid },
}));

const recordMachineAlive = vi.fn(async () => {});
vi.mock("@/app/presence/presenceRecorder", () => ({ recordMachineAlive }));

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

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

describe("machineUpdateHandler machine-alive identity binding", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        isMachineValid.mockResolvedValue(true);
        machineFindFirst.mockResolvedValue({ revokedAt: null, replacedByMachineId: null });
    });

    it("ignores machine-alive events from user-scoped sockets", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");

        const socket = createFakeSocket({ data: { clientType: "user-scoped" } });
        machineUpdateHandler("u1", socket as any);

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
        machineUpdateHandler("u1", socket as any);

        await getSocketHandler(socket, "machine-alive")({ machineId: "m2", time: Date.now() });

        expect(recordMachineAlive).not.toHaveBeenCalled();
        expect(emitEphemeral).not.toHaveBeenCalled();
        expect(isMachineValid).not.toHaveBeenCalled();
    });

    it("records alive state for the authenticated socket machine and ignores client supplied identity", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");
        const now = Date.now();

        const socket = createFakeSocket({
            data: {
                clientType: "machine-scoped",
                machineId: "m1",
            },
        });
        machineUpdateHandler("u1", socket as any);

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

    it("does not record alive when the activity cache is stale and the authenticated machine was replaced", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");
        const now = Date.now();
        isMachineValid.mockResolvedValueOnce(true);
        machineFindFirst.mockResolvedValueOnce({ revokedAt: null, replacedByMachineId: "m2" });

        const socket = createFakeSocket({
            data: {
                clientType: "machine-scoped",
                machineId: "m1",
            },
        });
        machineUpdateHandler("u1", socket as any);

        await getSocketHandler(socket, "machine-alive")({ time: now });

        expect(isMachineValid).toHaveBeenCalledWith("m1", "u1");
        expect(machineFindFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { accountId: "u1", id: "m1" },
            select: { revokedAt: true, replacedByMachineId: true },
        }));
        expect(recordMachineAlive).not.toHaveBeenCalled();
        expect(buildMachineActivityEphemeral).not.toHaveBeenCalled();
        expect(emitEphemeral).not.toHaveBeenCalled();
    });

    it("rejects metadata updates from session-scoped sockets", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");

        const socket = createFakeSocket({ data: { clientType: "session-scoped", sessionId: "s1" } });
        machineUpdateHandler("u1", socket as any);

        const callback = vi.fn();
        await getSocketHandler(socket, "machine-update-metadata")(
            { machineId: "m1", metadata: "new-meta", expectedVersion: 1 },
            callback,
        );

        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ result: "error" }));
        expect(recordMachineAlive).not.toHaveBeenCalled();
    });

    it("rejects metadata updates whose payload machine differs from the authenticated socket machine", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");

        const socket = createFakeSocket({
            data: {
                clientType: "machine-scoped",
                machineId: "m1",
            },
        });
        machineUpdateHandler("u1", socket as any);

        const callback = vi.fn();
        await getSocketHandler(socket, "machine-update-metadata")(
            { machineId: "m2", metadata: "new-meta", expectedVersion: 1 },
            callback,
        );

        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ result: "error" }));
    });

    it("rejects daemon state updates from session-scoped sockets", async () => {
        const { machineUpdateHandler } = await import("./machineUpdateHandler");

        const socket = createFakeSocket({ data: { clientType: "session-scoped", sessionId: "s1" } });
        machineUpdateHandler("u1", socket as any);

        const callback = vi.fn();
        await getSocketHandler(socket, "machine-update-state")(
            { machineId: "m1", daemonState: "new-state", expectedVersion: 1 },
            callback,
        );

        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ result: "error" }));
    });
});
