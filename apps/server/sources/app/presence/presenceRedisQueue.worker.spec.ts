import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEnvPatcher } from "@/testkit/env";
import { createDbMocks, installDbModuleMock } from "../api/testkit/dbMocks";

let shutdownController: AbortController;

// Mocks
const xgroup = vi.fn(async () => "OK");
const xreadgroup: any = vi.fn(async () => null);
const xack = vi.fn(async () => 1);
const xautoclaim: any = vi.fn(async () => ["0-0", []]);
const xpending = vi.fn(async () => [0, null, null, []]);

const getRedisClient = vi.fn(() => ({ xgroup, xreadgroup, xack, xautoclaim, xpending }));
vi.mock("@/storage/redis/redis", () => ({ getRedisClient }));

const dbMocks = createDbMocks({
    session: ["updateMany"],
    machine: ["updateMany"],
} as const);
installDbModuleMock({ db: dbMocks.db });

vi.mock("@/utils/runtime/forever", () => ({
    forever: (_name: string, fn: () => Promise<void>) => {
        void fn();
    },
}));

vi.mock("@/utils/process/shutdown", async () => {
    const actual = await vi.importActual<any>("@/utils/process/shutdown");
    return {
        ...actual,
        get shutdownSignal() {
            return shutdownController.signal;
        },
    };
});

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

describe("presenceRedisQueue worker", () => {
    const env = createEnvPatcher(["HAPPY_INSTANCE_ID"]);

    beforeEach(() => {
        vi.clearAllMocks();
        shutdownController = new AbortController();
        vi.resetModules();
        env.restore();
        dbMocks.reset();
        dbMocks.db.session.updateMany.mockResolvedValue({ count: 1 });
        dbMocks.db.machine.updateMany.mockResolvedValue({ count: 1 });
    });

    afterEach(() => {
        env.restore();
    });

    it("uses HAPPY_INSTANCE_ID as consumer name and ACKs only after flush/stop", async () => {
        env.set("HAPPY_INSTANCE_ID", "inst-1");

        // Return one entry then abort.
        xreadgroup.mockImplementationOnce(async (...args: any[]) => {
            shutdownController.abort();
            return [["presence:alive:v1", [["1-0", ["kind", "session", "id", "s1", "ts", "10", "accountId", "u1"]]]]];
        });

        const { startPresenceRedisWorker } = await import("./presenceRedisQueue");
        const worker = startPresenceRedisWorker({ flushIntervalMs: 60_000, readBlockMs: 1, readCount: 1 });

        await vi.waitFor(() => {
            expect(xautoclaim).toHaveBeenCalled();
        });

        // Not ACKed yet (we only ACK after a successful flush).
        expect(xack).not.toHaveBeenCalled();

        await worker.stop();

        // Consumer name derived from instance id
        expect((xreadgroup as any).mock.calls[0]?.[2]).toBe("inst-1");

        // Supported predecessor session entries are consumed, but only the exact socket publisher owner may write reachability.
        expect(dbMocks.db.session.updateMany).not.toHaveBeenCalled();
        expect(xpending).toHaveBeenCalled();
        expect(xack).toHaveBeenCalled();
    });

    it("flushes machine presence updates without concurrent DB fan-out by default", async () => {
        let maxConcurrentWrites = 0;
        let activeWrites = 0;

        dbMocks.db.machine.updateMany.mockImplementation(async () => {
            activeWrites += 1;
            maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
            await Promise.resolve();
            activeWrites -= 1;
            return { count: 1 };
        });

        xreadgroup.mockImplementationOnce(async () => {
            shutdownController.abort();
            return [[
                "presence:alive:v1",
                [
                    ["1-0", ["kind", "machine", "id", "m1", "ts", "10", "accountId", "u1"]],
                    ["2-0", ["kind", "machine", "id", "m2", "ts", "11", "accountId", "u1"]],
                    ["3-0", ["kind", "machine", "id", "m3", "ts", "12", "accountId", "u1"]],
                ],
            ]];
        });

        const { startPresenceRedisWorker } = await import("./presenceRedisQueue");
        const worker = startPresenceRedisWorker({ flushIntervalMs: 60_000, readBlockMs: 1, readCount: 3 });

        await vi.waitFor(() => {
            expect(xreadgroup).toHaveBeenCalled();
        });

        await worker.stop();

        expect(dbMocks.db.machine.updateMany).toHaveBeenCalledTimes(3);
        expect(maxConcurrentWrites).toBe(1);
    });
});
