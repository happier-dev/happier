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

const sharedRead = vi.fn((...args: unknown[]) => xreadgroup(...args));
const duplicate = vi.fn(() => ({ ...enrollmentRedis,
    xreadgroup: vi.fn((...args: unknown[]) => xreadgroup(...args)),
    disconnect: vi.fn(() => finishEnrollmentRead?.()),
}));
const getRedisClient = vi.fn(() => ({ xgroup, xreadgroup: sharedRead, xack, xautoclaim, xpending,
    duplicate }));
vi.mock("@/storage/redis/redis", () => ({ getRedisClient }));

const dbMocks = createDbMocks({
    session: ["updateMany", "findUnique"],
    machine: ["findUnique"],
} as const);
const executeRaw = vi.fn(async (_query: TemplateStringsArray, ..._values: unknown[]) => 1);
// Only the persistent transaction/driver boundary is replaced. Admission,
// monotonic persistence, deadline enrollment and flush custody stay real.
const database = { ...dbMocks.db, $executeRaw: executeRaw,
    $queryRaw: async (query: TemplateStringsArray, ...values: unknown[]) => {
        const sql = query.join('');
        if (sql.startsWith('SHOW')) return [{ statement_timeout: '0' }];
        // PostgreSQL admission now obtains its Machine row through a locking
        // read; preserve the same database fixture used by the SQLite delegate.
        if (sql.includes('FOR UPDATE')) return [await dbMocks.db.machine.findUnique({ where: { id: values[0] } })];
        return [];
    },
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

// Load the real owner graph with a real clock during collection, not inside
// the first timed fake-clock contract case. It took 36 s on the loaded worker.
await import('./presenceRedisQueue');

describe("presenceRedisQueue worker", () => {
    const env = createEnvPatcher(["HAPPY_INSTANCE_ID"]);
    let activeWorker: { stop: () => Promise<void> } | undefined;

    beforeEach(() => {
        vi.clearAllMocks();
        xreadgroup.mockReset().mockResolvedValue(null);
        xautoclaim.mockReset().mockResolvedValue(["0-0", []]);
        xack.mockReset().mockResolvedValue(1);
        activeWorker = undefined;
        shutdownController = new AbortController();
        env.restore();
        dbMocks.reset();
        dbMocks.db.session.updateMany.mockResolvedValue({ count: 1 });
        dbMocks.db.session.findUnique.mockResolvedValue(null);
        dbMocks.db.machine.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
            id: where.id, accountId: 'u1', active: true, kind: 'machine', installationId: null,
            lastActiveAt: new Date(0), revokedAt: null, replacedByMachineId: null,
        }));
        executeRaw.mockReset().mockResolvedValue(1);
    });

    afterEach(async () => {
        shutdownController.abort();
        await activeWorker?.stop();
        const { stopLocalMachinePresenceTimeout } = await import('./timeout');
        await stopLocalMachinePresenceTimeout();
        vi.restoreAllMocks();
        vi.useRealTimers();
        env.restore();
    });

    it("keeps its blocking enrollment read off the shared command connection and closes it on stop", async () => {
        const { startPresenceRedisWorker } = await import("./presenceRedisQueue");
        activeWorker = startPresenceRedisWorker();
        await activeWorker.ready;

        expect(duplicate).toHaveReturnedTimes(1);
        const [reader] = duplicate.mock.results.map(result => result.value);
        expect(reader.xread).toHaveBeenCalledOnce();
        await activeWorker.stop();
        expect(reader.disconnect).toHaveBeenCalled();
        expect(sharedRead).not.toHaveBeenCalled();
    });

    it("costs no consumer-group Redis command and no SQL write over an idle minute", async () => {
        // Redis BLOCK semantics at the boundary: an empty read returns after its block window.
        xreadgroup.mockImplementation((...args: unknown[]) => {
            const blockMs = Number(args[args.indexOf("BLOCK") + 1]);
            return new Promise(resolve => setTimeout(() => resolve(null), blockMs));
        });
        const { startPresenceRedisWorker } = await import("./presenceRedisQueue");
        vi.useFakeTimers();
        activeWorker = startPresenceRedisWorker();
        await activeWorker.ready;

        await vi.advanceTimersByTimeAsync(60_000);

        const groupCommands = xgroup.mock.calls.length + xreadgroup.mock.calls.length
            + xautoclaim.mock.calls.length + xpending.mock.calls.length + xack.mock.calls.length;
        expect(groupCommands).toBe(0);
        expect(executeRaw).not.toHaveBeenCalled();
        // The broadcast enrollment reader is the worker's only stream read.
        expect(enrollmentRedis.xrevrange).toHaveBeenCalledOnce();
    });
});
