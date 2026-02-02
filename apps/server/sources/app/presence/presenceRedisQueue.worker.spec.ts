import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let shutdownController: AbortController;

// Mocks
const xgroup = vi.fn(async () => "OK");
const xreadgroup: any = vi.fn(async () => null);
const xack = vi.fn(async () => 1);
const xautoclaim: any = vi.fn(async () => ["0-0", []]);

const getRedisClient = vi.fn(() => ({ xgroup, xreadgroup, xack, xautoclaim }));
vi.mock("@/storage/redis", () => ({ getRedisClient }));

const dbSessionUpdate = vi.fn(async () => ({}));
const dbMachineUpdate = vi.fn(async () => ({}));
vi.mock("@/storage/db", () => ({
    db: {
        session: { update: dbSessionUpdate },
        machine: { update: dbMachineUpdate },
    },
}));

vi.mock("@/utils/forever", () => ({
    forever: (_name: string, fn: () => Promise<void>) => {
        void fn();
    },
}));

vi.mock("@/utils/shutdown", async () => {
    const actual = await vi.importActual<any>("@/utils/shutdown");
    return {
        ...actual,
        get shutdownSignal() {
            return shutdownController.signal;
        },
    };
});

vi.mock("@/utils/log", () => ({ log: vi.fn() }));

describe("presenceRedisQueue worker", () => {
    const originalInstanceId = process.env.HAPPY_INSTANCE_ID;

    beforeEach(() => {
        vi.clearAllMocks();
        shutdownController = new AbortController();
        vi.resetModules();
    });

    afterEach(() => {
        if (originalInstanceId == null) {
            delete process.env.HAPPY_INSTANCE_ID;
        } else {
            process.env.HAPPY_INSTANCE_ID = originalInstanceId;
        }
    });

    it("uses HAPPY_INSTANCE_ID as consumer name and ACKs only after flush/stop", async () => {
        process.env.HAPPY_INSTANCE_ID = "inst-1";

        // Return one entry then abort.
        xreadgroup.mockImplementationOnce(async (...args: any[]) => {
            shutdownController.abort();
            return [["presence:alive:v1", [["1-0", ["kind", "session", "id", "s1", "ts", "10", "accountId", "u1"]]]]];
        });

        const { startPresenceRedisWorker } = await import("./presenceRedisQueue");
        const worker = startPresenceRedisWorker({ flushIntervalMs: 60_000, readBlockMs: 1, readCount: 1 });

        // Give the loop a tick.
        await new Promise((r) => setTimeout(r, 10));

        // Not ACKed yet (we only ACK after a successful flush).
        expect(xack).not.toHaveBeenCalled();
        expect(xautoclaim).toHaveBeenCalled();

        await worker.stop();

        // Consumer name derived from instance id
        expect((xreadgroup as any).mock.calls[0]?.[2]).toBe("inst-1");

        // Flush happened before ACK
        expect(dbSessionUpdate).toHaveBeenCalled();
        expect(xack).toHaveBeenCalled();
    });
});
