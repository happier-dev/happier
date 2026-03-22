import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEnvPatcher } from "@/testkit/env";
import { createDbMocks, installDbModuleMock } from "../api/testkit/dbMocks";

let shutdownController: AbortController;

// Mocks
const xgroup = vi.fn(async () => "OK");
const xreadgroup: any = vi.fn(async () => null);
const xack = vi.fn(async () => 1);
const xautoclaim: any = vi.fn(async () => ["0-0", []]);

const getRedisClient = vi.fn(() => ({ xgroup, xreadgroup, xack, xautoclaim }));
vi.mock("@/storage/redis/redis", () => ({ getRedisClient }));

const dbMocks = createDbMocks({
    session: ["update"],
    machine: ["update"],
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
        dbMocks.db.session.update.mockResolvedValue({});
        dbMocks.db.machine.update.mockResolvedValue({});
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

        // Flush happened before ACK
        expect(dbMocks.db.session.update).toHaveBeenCalled();
        expect(xack).toHaveBeenCalled();
    });
});
