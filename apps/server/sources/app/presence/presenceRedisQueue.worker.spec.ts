import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEnvPatcher } from "@/testkit/env";
import { createDbMocks, createDbTransactionMock, installDbModuleMock } from "../api/testkit/dbMocks";

let shutdownController = new AbortController();

// Mocks
const xgroup = vi.fn(async () => "OK");
const xreadgroup: any = vi.fn(async () => null);
const xack = vi.fn(async () => 1);
const xautoclaim: any = vi.fn(async () => ["0-0", []]);
const xpending = vi.fn(async () => [0, null, null, []]);
let finishEnrollmentRead: (() => void) | undefined;
const enrollmentRedis = {
    xrevrange: vi.fn(async () => []),
    xread: vi.fn(() => new Promise<null>(resolve => { finishEnrollmentRead = () => resolve(null); })),
    disconnect: vi.fn(() => finishEnrollmentRead?.()),
};

const getRedisClient = vi.fn(() => ({ xgroup, xreadgroup, xack, xautoclaim, xpending,
    duplicate: () => enrollmentRedis }));
vi.mock("@/storage/redis/redis", () => ({ getRedisClient }));

const dbMocks = createDbMocks({
    session: ["updateMany", "findUnique"],
    machine: ["findUnique"],
} as const);
const executeRaw = vi.fn(async (_query: TemplateStringsArray, ..._values: unknown[]) => 1);
// Only the persistent transaction/driver boundary is replaced. Admission,
// monotonic persistence, deadline enrollment and flush custody stay real.
const database = { ...dbMocks.db, $executeRaw: executeRaw,
    $queryRaw: async (query: TemplateStringsArray) => query.join('').startsWith('SHOW') ? [{ statement_timeout: '0' }] : [],
    $executeRawUnsafe: async () => 0,
};
const transactions = createDbTransactionMock(() => ({ ...database }));
installDbModuleMock({ db: transactions.wrapDb(database) });

vi.mock("@/utils/process/shutdown", async () => {
    const actual = await vi.importActual<any>("@/utils/process/shutdown");
    return {
        ...actual,
        get shutdownSignal() {
            return shutdownController.signal;
        },
    };
});

vi.mock("@/utils/logging/log", () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn() }));

type StreamReply = [string, [string, string[]][]][] | null;

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((complete) => { resolve = complete; });
    return { promise, resolve };
}

let lastObservation = 0;
function machineEntry(id: string, offset: number): [string, string[]] {
    lastObservation = Date.now() + offset;
    return [id, ["kind", "machine", "id", "m1", "ts", String(lastObservation), "accountId", "u1"]];
}

// Load the real owner graph with a real clock during collection, not inside
// the first timed fake-clock contract case. It took 36 s on the loaded worker.
await import('./presenceRedisQueue');

describe("presenceRedisQueue worker", () => {
    const env = createEnvPatcher(["HAPPY_INSTANCE_ID"]);
    let finishRead: ((reply: StreamReply) => void) | undefined;
    let activeWorker: { stop: () => Promise<void> } | undefined;
    let releaseWrites: (() => void)[];

    async function startReading(entries: [string, string[]][] = []) {
        const { startPresenceRedisWorker } = await import("./presenceRedisQueue");
        const { presenceStreamLastFlushDurationGauge } = await import("../monitoring/metrics/presenceMetrics");
        vi.useFakeTimers();
        let readStarted = deferred<void>();
        xreadgroup.mockImplementation(() => {
            const read = deferred<StreamReply>();
            finishRead = read.resolve;
            readStarted.resolve();
            return read.promise;
        });
        xautoclaim.mockResolvedValue(["0-0", entries]);
        const flushes = vi.spyOn(presenceStreamLastFlushDurationGauge, "set");
        activeWorker = startPresenceRedisWorker({ flushIntervalMs: 5_000 });
        await readStarted.promise;
        return {
            worker: activeWorker,
            flushes,
            async deliver(nextEntries: [string, string[]][]) {
                readStarted = deferred<void>();
                finishRead!([["presence:alive:v1", nextEntries]]);
                await readStarted.promise;
            },
        };
    }

    beforeEach(() => {
        vi.clearAllMocks();
        xreadgroup.mockReset().mockResolvedValue(null);
        xautoclaim.mockReset().mockResolvedValue(["0-0", []]);
        xack.mockReset().mockResolvedValue(1);
        finishRead = undefined;
        activeWorker = undefined;
        releaseWrites = [];
        shutdownController = new AbortController();
        env.restore();
        dbMocks.reset();
        dbMocks.db.session.updateMany.mockResolvedValue({ count: 1 });
        dbMocks.db.session.findUnique.mockResolvedValue(null);
        dbMocks.db.machine.findUnique.mockResolvedValue({ accountId: 'u1', active: false,
            lastActiveAt: new Date(0), revokedAt: null, replacedByMachineId: null });
        executeRaw.mockReset().mockResolvedValue(1);
    });

    afterEach(async () => {
        shutdownController.abort();
        finishRead?.(null);
        for (const release of releaseWrites) release();
        await activeWorker?.stop();
        const { stopLocalMachinePresenceTimeout } = await import('./timeout');
        await stopLocalMachinePresenceTimeout();
        vi.restoreAllMocks();
        vi.useRealTimers();
        env.restore();
    });

    it("parks an empty worker for 300 seconds with zero flush wakes", async () => {
        const { deliver, flushes } = await startReading();
        const idleDeadlineCount = vi.getTimerCount();

        await vi.advanceTimersByTimeAsync(300_000);

        expect(flushes).not.toHaveBeenCalled();
        expect(idleDeadlineCount).toBe(0);
        expect(executeRaw).not.toHaveBeenCalled();
        expect(xack).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);

        await deliver([machineEntry("1-0", 10)]);
        await vi.advanceTimersByTimeAsync(4_999);
        expect(flushes).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(flushes).toHaveBeenCalledOnce();
        expect(xack).toHaveBeenCalledExactlyOnceWith("presence:alive:v1", "presence-worker", "1-0");
        expect(vi.getTimerCount()).toBe(1); // The admitted Machine's real offline deadline.
    });

    it("flushes one arrival at the existing deadline without sliding it for later arrivals", async () => {
        const { deliver, flushes } = await startReading();

        await vi.advanceTimersByTimeAsync(2_000);
        await deliver([machineEntry("1-0", 10)]);
        await vi.advanceTimersByTimeAsync(4_000);
        expect(executeRaw).not.toHaveBeenCalled();
        await deliver([machineEntry("2-0", 20)]);
        await vi.advanceTimersByTimeAsync(999);
        expect(xack).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        expect(executeRaw).toHaveBeenCalledOnce();
        expect(executeRaw).toHaveBeenLastCalledWith(expect.any(Array), new Date(lastObservation).toISOString(), "u1", "m1", new Date(lastObservation).toISOString());
        expect(xack).toHaveBeenCalledExactlyOnceWith("presence:alive:v1", "presence-worker", "1-0", "2-0");
        expect(flushes).toHaveBeenCalledOnce();
        const { stopLocalMachinePresenceTimeout } = await import('./timeout');
        await stopLocalMachinePresenceTimeout();
        await vi.advanceTimersByTimeAsync(300_000);
        expect(flushes).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("serializes a later arrival behind its in-flight batch and shutdown joins both writes", async () => {
        const firstWrite = deferred<number>();
        const secondWrite = deferred<number>();
        releaseWrites.push(() => firstWrite.resolve(1), () => secondWrite.resolve(1));
        executeRaw
            .mockImplementationOnce(() => firstWrite.promise)
            .mockImplementationOnce(() => secondWrite.promise);
        const { worker, deliver } = await startReading();
        await deliver([machineEntry("1-0", 10)]);
        await vi.advanceTimersByTimeAsync(5_000);
        await deliver([machineEntry("2-0", 20)]);
        await vi.advanceTimersByTimeAsync(5_000);

        expect(executeRaw).toHaveBeenCalledOnce();
        expect(xack).not.toHaveBeenCalled();
        shutdownController.abort();
        finishRead?.(null);
        let stopped = false;
        const stop = worker.stop().then(() => { stopped = true; });
        await vi.advanceTimersByTimeAsync(0);
        expect(stopped).toBe(false);

        firstWrite.resolve(1);
        await vi.advanceTimersByTimeAsync(0);
        expect(xack).toHaveBeenCalledExactlyOnceWith("presence:alive:v1", "presence-worker", "1-0");
        expect(executeRaw).toHaveBeenCalledTimes(2);
        expect(executeRaw).toHaveBeenLastCalledWith(expect.any(Array), new Date(lastObservation).toISOString(), "u1", "m1", new Date(lastObservation).toISOString());
        expect(stopped).toBe(false);

        secondWrite.resolve(1);
        await stop;
        expect(xack).toHaveBeenLastCalledWith("presence:alive:v1", "presence-worker", "2-0");
        expect(vi.getTimerCount()).toBe(0); // Shutdown forbids enrolling a new Machine timer.
    });

    it("retains a failed persistence batch and recovers at the existing deadline without another arrival", async () => {
        executeRaw.mockRejectedValueOnce(new Error("database unavailable"));
        const { deliver } = await startReading();
        await deliver([machineEntry("1-0", 10)]);

        await vi.advanceTimersByTimeAsync(5_000);
        expect(xack).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(5_000);

        expect(executeRaw).toHaveBeenCalledTimes(2);
        expect(xack).toHaveBeenCalledExactlyOnceWith("presence:alive:v1", "presence-worker", "1-0");
        expect(vi.getTimerCount()).toBe(1);
    });

    it("retains a failed ACK and recovers without another arrival", async () => {
        xack.mockRejectedValueOnce(new Error("redis unavailable"));
        const { deliver } = await startReading();
        await deliver([machineEntry("1-0", 10)]);

        await vi.advanceTimersByTimeAsync(5_000);
        expect(xack).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(5_000);

        expect(xack).toHaveBeenCalledTimes(2);
        expect(xack).toHaveBeenLastCalledWith("presence:alive:v1", "presence-worker", "1-0");
        expect(vi.getTimerCount()).toBe(1);
    });

    it("arms a deadline for reclaimed invalid entries and parks after acknowledging them", async () => {
        await startReading([["1-0", ["kind", "machine"]]]);

        await vi.advanceTimersByTimeAsync(5_000);

        expect(executeRaw).not.toHaveBeenCalled();
        expect(xack).toHaveBeenCalledExactlyOnceWith("presence:alive:v1", "presence-worker", "1-0");
        expect(vi.getTimerCount()).toBe(0);
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
        expect(executeRaw).not.toHaveBeenCalled();
        expect(xpending).toHaveBeenCalled();
        expect(xack).toHaveBeenCalled();
    });

    it("flushes machine presence updates without concurrent DB fan-out by default", async () => {
        let maxConcurrentWrites = 0;
        let activeWrites = 0;

        executeRaw.mockImplementation(async () => {
            activeWrites += 1;
            maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
            await Promise.resolve();
            activeWrites -= 1;
            return 1;
        });

        xreadgroup.mockImplementationOnce(async () => {
            shutdownController.abort();
            return [[
                "presence:alive:v1",
                [
                    ["1-0", ["kind", "machine", "id", "m1", "ts", String(Date.now()), "accountId", "u1"]],
                    ["2-0", ["kind", "machine", "id", "m2", "ts", String(Date.now()), "accountId", "u1"]],
                    ["3-0", ["kind", "machine", "id", "m3", "ts", String(Date.now()), "accountId", "u1"]],
                ],
            ]];
        });

        const { startPresenceRedisWorker } = await import("./presenceRedisQueue");
        const worker = startPresenceRedisWorker({ flushIntervalMs: 60_000, readBlockMs: 1, readCount: 3 });

        await vi.waitFor(() => {
            expect(xreadgroup).toHaveBeenCalled();
        });

        await worker.stop();

        expect(executeRaw).toHaveBeenCalledTimes(3);
        expect(maxConcurrentWrites).toBe(1);
    });
});
