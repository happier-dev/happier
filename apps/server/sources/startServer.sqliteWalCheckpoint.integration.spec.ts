import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
    createStartServerDbMocks,
    installStartServerDbModuleMock,
    installStartServerCommonWiringMocks,
} from "@/testkit/startServerMocks";
import { createStartServerHarness } from "@/testkit/startServerHarness";

const sqliteWalCheckpointMocks = vi.hoisted(() => {
    const stop = vi.fn(async () => {});
    const stopVacuum = vi.fn(async () => {});
    return {
        resolveBusyTimeout: vi.fn(() => 5000),
        resolveInterval: vi.fn(() => 1000),
        resolveVacuumInterval: vi.fn(() => 6 * 60 * 60 * 1000),
        resolveVacuumPages: vi.fn(() => 1000),
        startWorker: vi.fn(() => ({ stop })),
        startVacuumWorker: vi.fn(() => ({ stop: stopVacuum })),
        stop,
        stopVacuum,
    };
});

const shutdownMocks = vi.hoisted(() => {
    const handlers = new Map<string, Array<() => Promise<void>>>();
    const runPhase = async (phase: Array<[string, Array<() => Promise<void>>]>) => {
        await Promise.all(phase.flatMap(([, callbacks]) => callbacks.map((callback) => callback())));
    };
    return {
        reset: () => {
            handlers.clear();
        },
        onShutdown: vi.fn((name: string, callback: () => Promise<void>) => {
            const callbacks = handlers.get(name) ?? [];
            callbacks.push(callback);
            handlers.set(name, callbacks);
            return () => {
                const index = callbacks.indexOf(callback);
                if (index >= 0) callbacks.splice(index, 1);
            };
        }),
        initiateShutdown: vi.fn(async () => {
            const snapshot = Array.from(handlers.entries()).map(
                ([name, callbacks]) => [name, [...callbacks]] as [string, Array<() => Promise<void>>],
            );
            await runPhase(snapshot.filter(([name]) => name.startsWith("keepAlive:")));
            await runPhase(snapshot.filter(([name]) => !name.startsWith("keepAlive:")));
        }),
        awaitShutdown: vi.fn(async () => {}),
        keepAlive: vi.fn(async (_name: string, callback: () => Promise<unknown>) => await callback()),
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

const initializeServerIdentityCache = vi.fn(async () => "srv_startupCache123");
vi.mock("@/app/serverIdentity/serverIdentity", () => ({
    initializeServerIdentityCache,
}));

const applySqliteMigrationsIfNeeded = vi.fn(async () => {});
vi.mock("@/flavors/light/sqliteMigrations", async () => {
    const actual = await vi.importActual<typeof import("@/flavors/light/sqliteMigrations")>(
        "@/flavors/light/sqliteMigrations",
    );
    return {
        ...actual,
        applySqliteMigrationsIfNeeded,
    };
});

vi.mock("@/storage/sqliteWalCheckpoint", () => ({
    resolveSqliteWalCheckpointBusyTimeoutMsFromEnv: sqliteWalCheckpointMocks.resolveBusyTimeout,
    resolveSqliteWalCheckpointIntervalMsFromEnv: sqliteWalCheckpointMocks.resolveInterval,
    resolveSqliteIncrementalVacuumIntervalMsFromEnv: sqliteWalCheckpointMocks.resolveVacuumInterval,
    resolveSqliteIncrementalVacuumPagesFromEnv: sqliteWalCheckpointMocks.resolveVacuumPages,
    startSqliteWalCheckpointWorker: sqliteWalCheckpointMocks.startWorker,
    startSqliteIncrementalVacuumWorker: sqliteWalCheckpointMocks.startVacuumWorker,
}));

vi.mock("@/utils/process/shutdown", () => ({
    awaitShutdown: shutdownMocks.awaitShutdown,
    initiateShutdown: shutdownMocks.initiateShutdown,
    isShutdown: vi.fn(() => false),
    keepAlive: shutdownMocks.keepAlive,
    onShutdown: shutdownMocks.onShutdown,
    shutdownSignal: new AbortController().signal,
}));

describe("startServer sqlite WAL checkpoint shutdown ordering", () => {
    const startServerHarness = createStartServerHarness();
    const originalDbSizeWarnBytes = process.env.HAPPIER_SERVER_DB_SIZE_WARN_BYTES;

    beforeEach(() => {
        callOrder.length = 0;
        startServerDbMocks.reset();
        startServerDbMocks.dbDisconnect.mockImplementation(dbDisconnect);
        startServerDbMocks.sqliteMaintenanceClientDisconnect.mockImplementation(async () => {
            callOrder.push("sqliteMaintenanceClient.$disconnect");
        });
        initializeServerIdentityCache.mockReset().mockResolvedValue("srv_startupCache123");
        applySqliteMigrationsIfNeeded.mockReset().mockImplementation(async () => {});
        sqliteWalCheckpointMocks.resolveBusyTimeout.mockReset().mockReturnValue(5000);
        sqliteWalCheckpointMocks.resolveInterval.mockReset().mockReturnValue(1000);
        sqliteWalCheckpointMocks.resolveVacuumInterval.mockReset().mockReturnValue(6 * 60 * 60 * 1000);
        sqliteWalCheckpointMocks.resolveVacuumPages.mockReset().mockReturnValue(1000);
        sqliteWalCheckpointMocks.startWorker
            .mockReset()
            .mockImplementation(() => ({ stop: sqliteWalCheckpointMocks.stop }));
        sqliteWalCheckpointMocks.stop.mockReset().mockImplementation(async () => {
            callOrder.push("sqliteWalCheckpoint.stop");
        });
        sqliteWalCheckpointMocks.startVacuumWorker
            .mockReset()
            .mockImplementation(() => ({ stop: sqliteWalCheckpointMocks.stopVacuum }));
        sqliteWalCheckpointMocks.stopVacuum.mockReset().mockImplementation(async () => {
            callOrder.push("sqliteIncrementalVacuum.stop");
        });
        startServerHarness.reset();
        shutdownMocks.reset();
    });

    afterEach(() => {
        startServerHarness.restore();
        if (originalDbSizeWarnBytes === undefined) {
            delete process.env.HAPPIER_SERVER_DB_SIZE_WARN_BYTES;
        } else {
            process.env.HAPPIER_SERVER_DB_SIZE_WARN_BYTES = originalDbSizeWarnBytes;
        }
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
        expect(sqliteWalCheckpointMocks.startVacuumWorker).toHaveBeenCalledWith(expect.objectContaining({
            client: startServerDbMocks.sqliteMaintenanceClient,
            intervalMs: 6 * 60 * 60 * 1000,
            pages: 1000,
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
            "sqliteIncrementalVacuum.stop",
            "sqliteMaintenanceClient.$disconnect",
            "db.$disconnect",
        ]);
    }, 120_000);

    it("does not open a sqlite maintenance client when WAL checkpointing is disabled", async () => {
        sqliteWalCheckpointMocks.resolveInterval.mockReturnValue(0);
        sqliteWalCheckpointMocks.resolveVacuumInterval.mockReturnValue(0);
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
        expect(sqliteWalCheckpointMocks.startVacuumWorker).not.toHaveBeenCalled();
        expect(callOrder).toEqual(["db.$disconnect"]);
    }, 120_000);

    it("cleans up sqlite WAL resources before rejecting when later startup work fails", async () => {
        const startupFailure = new Error("startup failed after sqlite wal setup");
        initializeServerIdentityCache.mockRejectedValueOnce(startupFailure);
        startServerHarness.prepareImport({
            SERVER_ROLE: "api",
            REDIS_URL: undefined,
            HAPPY_DB_PROVIDER: "sqlite",
            HAPPIER_DB_PROVIDER: "sqlite",
            DATABASE_URL: "file:/tmp/happier-start-server-sqlite-startup-failure.sqlite",
            HAPPY_SERVER_LIGHT_DATA_DIR: undefined,
            HAPPIER_SERVER_LIGHT_DATA_DIR: undefined,
        });

        const { startServer } = await import("./startServer");

        await expect(startServer("light")).rejects.toThrow(startupFailure);

        expect(sqliteWalCheckpointMocks.startWorker).toHaveBeenCalledTimes(1);
        expect(callOrder).toEqual([
            "sqliteWalCheckpoint.stop",
            "sqliteIncrementalVacuum.stop",
            "sqliteMaintenanceClient.$disconnect",
            "db.$disconnect",
        ]);
    }, 120_000);

    it("warns when the sqlite database file exceeds the configured boot threshold", async () => {
        const tmpDir = await mkdtemp(join(tmpdir(), "happier-sqlite-size-"));
        try {
            const dbPath = join(tmpDir, "happier.sqlite");
            await writeFile(dbPath, "12345", "utf8");
            startServerHarness.prepareImport({
                SERVER_ROLE: "api",
                REDIS_URL: undefined,
                HAPPY_DB_PROVIDER: "sqlite",
                HAPPIER_DB_PROVIDER: "sqlite",
                HAPPIER_SERVER_DB_SIZE_WARN_BYTES: "4",
                DATABASE_URL: `file:${dbPath}`,
                HAPPY_SERVER_LIGHT_DATA_DIR: undefined,
                HAPPIER_SERVER_LIGHT_DATA_DIR: undefined,
            });

            const { startServer } = await import("./startServer");
            const { log } = await import("@/utils/logging/log");

            await startServer("light");

            expect(log).toHaveBeenCalledWith(
                expect.objectContaining({
                    module: "sqlite",
                    level: "warn",
                    path: dbPath,
                    sizeBytes: 5,
                    thresholdBytes: 4,
                }),
                expect.stringContaining("SQLite database file is larger than the configured warning threshold"),
            );
        } finally {
            await rm(tmpDir, { recursive: true, force: true });
        }
    }, 120_000);

    it("warns when the sqlite WAL file exceeds the configured boot threshold", async () => {
        const tmpDir = await mkdtemp(join(tmpdir(), "happier-sqlite-wal-size-"));
        try {
            const dbPath = join(tmpDir, "happier.sqlite");
            await writeFile(dbPath, "1", "utf8");
            await writeFile(`${dbPath}-wal`, "12345", "utf8");
            startServerHarness.prepareImport({
                SERVER_ROLE: "api",
                REDIS_URL: undefined,
                HAPPY_DB_PROVIDER: "sqlite",
                HAPPIER_DB_PROVIDER: "sqlite",
                HAPPIER_SERVER_DB_SIZE_WARN_BYTES: "4",
                DATABASE_URL: `file:${dbPath}`,
                HAPPY_SERVER_LIGHT_DATA_DIR: undefined,
                HAPPIER_SERVER_LIGHT_DATA_DIR: undefined,
            });

            const { startServer } = await import("./startServer");
            const { log } = await import("@/utils/logging/log");

            await startServer("light");

            expect(log).toHaveBeenCalledWith(
                expect.objectContaining({
                    module: "sqlite",
                    level: "warn",
                    path: `${dbPath}-wal`,
                    sizeBytes: 5,
                    thresholdBytes: 4,
                }),
                expect.stringContaining("SQLite WAL file is larger than the configured warning threshold"),
            );
        } finally {
            await rm(tmpDir, { recursive: true, force: true });
        }
    }, 120_000);

    it("does not inspect sqlite size thresholds for non-sqlite providers", async () => {
        startServerHarness.prepareImport({
            SERVER_ROLE: "api",
            REDIS_URL: undefined,
            HAPPY_DB_PROVIDER: "pglite",
            HAPPIER_DB_PROVIDER: "pglite",
            HAPPIER_SERVER_DB_SIZE_WARN_BYTES: "1",
        });
        startServerDbMocks.getDbProviderFromEnv.mockReturnValue("pglite");

        const { startServer } = await import("./startServer");
        const { log } = await import("@/utils/logging/log");

        await startServer("light");

        expect(log).not.toHaveBeenCalledWith(
            expect.objectContaining({ module: "sqlite", level: "warn" }),
            expect.any(String),
        );
    }, 120_000);
});
