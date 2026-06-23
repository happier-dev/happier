import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    createStartServerDbMocks,
    installStartServerDbModuleMock,
    installStartServerCommonWiringMocks,
} from "@/testkit/startServerMocks";
import { createStartServerHarness } from "@/testkit/startServerHarness";

const sqliteWalCheckpointMocks = vi.hoisted(() => {
    const stop = vi.fn(async () => {});
    return {
        resolveBusyTimeout: vi.fn(() => 5000),
        resolveInterval: vi.fn(() => 1000),
        startWorker: vi.fn(() => ({ stop })),
        stop,
    };
});

const callOrder: string[] = [];

const dbDisconnect = vi.fn(async () => {
    callOrder.push("db.$disconnect");
});

const startServerDbMocks = createStartServerDbMocks({
    getDbProviderFromEnv: () => "sqlite",
});
startServerDbMocks.dbDisconnect.mockImplementation(dbDisconnect);

installStartServerDbModuleMock(startServerDbMocks);

installStartServerCommonWiringMocks();

vi.mock("@/storage/sqliteWalCheckpoint", () => ({
    resolveSqliteWalCheckpointBusyTimeoutMsFromEnv: sqliteWalCheckpointMocks.resolveBusyTimeout,
    resolveSqliteWalCheckpointIntervalMsFromEnv: sqliteWalCheckpointMocks.resolveInterval,
    startSqliteWalCheckpointWorker: sqliteWalCheckpointMocks.startWorker,
}));

// Avoid hanging in tests: startServer calls awaitShutdown().
vi.mock("@/utils/process/shutdown", async () => {
    const actual = await vi.importActual<any>("@/utils/process/shutdown");
    return { ...actual, awaitShutdown: vi.fn(async () => {}) };
});

describe("startServer sqlite WAL checkpoint shutdown ordering", () => {
    const startServerHarness = createStartServerHarness();

    beforeEach(() => {
        callOrder.length = 0;
        startServerDbMocks.reset();
        startServerDbMocks.dbDisconnect.mockImplementation(dbDisconnect);
        startServerDbMocks.sqliteMaintenanceClientDisconnect.mockImplementation(async () => {
            callOrder.push("sqliteMaintenanceClient.$disconnect");
        });
        sqliteWalCheckpointMocks.resolveBusyTimeout.mockReset().mockReturnValue(5000);
        sqliteWalCheckpointMocks.resolveInterval.mockReset().mockReturnValue(1000);
        sqliteWalCheckpointMocks.startWorker
            .mockReset()
            .mockImplementation(() => ({ stop: sqliteWalCheckpointMocks.stop }));
        sqliteWalCheckpointMocks.stop.mockReset().mockImplementation(async () => {
            callOrder.push("sqliteWalCheckpoint.stop");
        });
        startServerHarness.reset();
    });

    afterEach(() => {
        startServerHarness.restore();
    });

    it("stops the sqlite WAL checkpoint worker before disconnecting Prisma", async () => {
        startServerHarness.prepareImport({
            SERVER_ROLE: "api",
            REDIS_URL: undefined,
            HAPPY_DB_PROVIDER: "sqlite",
            HAPPIER_DB_PROVIDER: "sqlite",
            DATABASE_URL: "file:/tmp/happier-start-server-sqlite-shutdown-order.sqlite",
            HAPPY_SERVER_LIGHT_DATA_DIR: undefined,
            HAPPIER_SERVER_LIGHT_DATA_DIR: undefined,
        });

        const { startServer } = await import("./startServer");
        const { initiateShutdown } = await import("@/utils/process/shutdown");

        await startServer("light");
        await initiateShutdown("test");

        expect(sqliteWalCheckpointMocks.startWorker).toHaveBeenCalledTimes(1);
        expect(sqliteWalCheckpointMocks.startWorker).toHaveBeenCalledWith(expect.objectContaining({
            client: startServerDbMocks.sqliteMaintenanceClient,
        }));
        expect(startServerDbMocks.applySqliteRuntimePragmas).toHaveBeenCalledWith(
            startServerDbMocks.sqliteMaintenanceClient,
            expect.objectContaining({
                HAPPIER_SQLITE_BUSY_TIMEOUT_MS: "5000",
                HAPPY_SQLITE_BUSY_TIMEOUT_MS: "5000",
            }),
        );
        expect(callOrder).toEqual([
            "sqliteWalCheckpoint.stop",
            "sqliteMaintenanceClient.$disconnect",
            "db.$disconnect",
        ]);
    });

    it("does not open a sqlite maintenance client when WAL checkpointing is disabled", async () => {
        sqliteWalCheckpointMocks.resolveInterval.mockReturnValue(0);
        startServerHarness.prepareImport({
            SERVER_ROLE: "api",
            REDIS_URL: undefined,
            HAPPY_DB_PROVIDER: "sqlite",
            HAPPIER_DB_PROVIDER: "sqlite",
            DATABASE_URL: "file:/tmp/happier-start-server-sqlite-shutdown-disabled.sqlite",
            HAPPY_SERVER_LIGHT_DATA_DIR: undefined,
            HAPPIER_SERVER_LIGHT_DATA_DIR: undefined,
        });

        const { startServer } = await import("./startServer");
        const { initiateShutdown } = await import("@/utils/process/shutdown");

        await startServer("light");
        await initiateShutdown("test");

        expect(startServerDbMocks.createDbSqliteMaintenanceClient).not.toHaveBeenCalled();
        expect(sqliteWalCheckpointMocks.resolveBusyTimeout).not.toHaveBeenCalled();
        expect(sqliteWalCheckpointMocks.startWorker).not.toHaveBeenCalled();
        expect(callOrder).toEqual(["db.$disconnect"]);
    });
});
