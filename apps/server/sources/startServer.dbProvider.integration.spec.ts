import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import {
    createStartServerDbMocks,
    installStartServerDbModuleMock,
    installStartServerCommonWiringMocks,
    startVoiceProviderIdentityBackfillWorkerMock,
} from "@/testkit/startServerMocks";
import { createStartServerHarness } from "@/testkit/startServerHarness";

const startServerDbMocks = createStartServerDbMocks({
    getDbProviderFromEnv: (env: any, fallback: any) => {
        const raw = (env?.HAPPIER_DB_PROVIDER ?? env?.HAPPY_DB_PROVIDER)?.toString().trim().toLowerCase();
        if (!raw) return fallback;
        if (raw === "postgresql" || raw === "postgres") return "postgres";
        if (raw === "pglite") return "pglite";
        if (raw === "sqlite") return "sqlite";
        if (raw === "mysql") return "mysql";
        return fallback;
    },
});
const { initDbPostgres, initDbPglite, initDbMysql, initDbSqlite } = startServerDbMocks;
const initializeServerIdentityCache = vi.fn(async () => "srv_startupCache123");

vi.mock("@/storage/redis/redis", () => ({
    getRedisClient: () => ({ ping: vi.fn(async () => "PONG") }),
}));
vi.mock("@/app/events/createRedisStreamsRoomEmitter", () => ({
    createRedisStreamsRoomEmitter: vi.fn(() => ({})),
}));
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { setIo: vi.fn() },
}));

installStartServerDbModuleMock(startServerDbMocks);

installStartServerCommonWiringMocks();

vi.mock("@/app/serverIdentity/serverIdentity", () => ({
    initializeServerIdentityCache,
}));

const applySqliteMigrationsIfNeeded = vi.fn(async () => {});
vi.mock("@/flavors/light/sqliteMigrations", () => ({
    applySqliteMigrationsIfNeeded,
}));

// Avoid hanging in tests: startServer calls awaitShutdown().
vi.mock("@/utils/process/shutdown", async () => {
    const actual = await vi.importActual<any>("@/utils/process/shutdown");
    return { ...actual, awaitShutdown: vi.fn(async () => {}) };
});

describe("startServer DB provider selection", () => {
    const startServerHarness = createStartServerHarness({
        HAPPY_DB_PROVIDER: undefined,
        HAPPIER_DB_PROVIDER: undefined,
        SERVER_ROLE: undefined,
        HAPPY_SERVER_LIGHT_DATA_DIR: undefined,
        HAPPIER_SERVER_LIGHT_DATA_DIR: undefined,
        HAPPY_SQLITE_CONNECTION_LIMIT: undefined,
        HAPPIER_SQLITE_CONNECTION_LIMIT: undefined,
        DATABASE_URL: undefined,
    });

    beforeEach(() => {
        startServerDbMocks.reset();
        initializeServerIdentityCache.mockReset().mockResolvedValue("srv_startupCache123");
        startServerHarness.reset();
        applySqliteMigrationsIfNeeded.mockReset().mockImplementation(async () => {});
        startVoiceProviderIdentityBackfillWorkerMock.mockReset().mockReturnValue(null);
    });

    afterEach(() => {
        startServerHarness.restore();
    });

    it("uses MySQL when HAPPIER_DB_PROVIDER=mysql (full flavor)", async () => {
        await startServerHarness.start("full", {
            SERVER_ROLE: "api",
            HAPPIER_DB_PROVIDER: "mysql",
        });

        expect(initDbMysql).toHaveBeenCalledTimes(1);
        expect(initDbPostgres).not.toHaveBeenCalled();
    });

    it("starts the identity backfill worker only for an all/worker role and passes the selected provider", async () => {
        await startServerHarness.start("full", {
            SERVER_ROLE: "all",
            HAPPIER_DB_PROVIDER: "postgres",
        });

        expect(startVoiceProviderIdentityBackfillWorkerMock).toHaveBeenCalledWith({
            provider: "postgres",
            env: process.env,
        });

        startVoiceProviderIdentityBackfillWorkerMock.mockClear();
        await startServerHarness.start("full", {
            SERVER_ROLE: "worker",
            HAPPIER_DB_PROVIDER: "postgres",
            REDIS_URL: "redis://localhost:6379",
            HAPPIER_SOCKET_ADAPTER: "redis-streams",
        });
        expect(startVoiceProviderIdentityBackfillWorkerMock).toHaveBeenCalledWith({
            provider: "postgres",
            env: process.env,
        });

        startVoiceProviderIdentityBackfillWorkerMock.mockClear();
        await startServerHarness.start("full", {
            SERVER_ROLE: "api",
            HAPPIER_DB_PROVIDER: "postgres",
        });
        expect(startVoiceProviderIdentityBackfillWorkerMock).not.toHaveBeenCalled();
    });

    it("uses SQLite when HAPPY_DB_PROVIDER=sqlite (light flavor)", async () => {
        await startServerHarness.start("light", {
            SERVER_ROLE: "api",
            HAPPY_DB_PROVIDER: "sqlite",
            HAPPY_SERVER_LIGHT_DATA_DIR: "/tmp/happy-server-light-test",
        });

        expect(initDbSqlite).toHaveBeenCalledTimes(1);
        expect(initDbPglite).not.toHaveBeenCalled();
    });

    it("defaults to SQLite when light flavor provider is unset", async () => {
        await startServerHarness.start("light", {
            SERVER_ROLE: "api",
            HAPPY_SERVER_LIGHT_DATA_DIR: "/tmp/happy-server-light-default",
        });

        expect(initDbSqlite).toHaveBeenCalledTimes(1);
        expect(initDbPglite).not.toHaveBeenCalled();
    });

    it("initializes the server identity cache after connecting to the database", async () => {
        await startServerHarness.start("full", {
            SERVER_ROLE: "api",
            HAPPIER_DB_PROVIDER: "mysql",
        });

        expect(initializeServerIdentityCache).toHaveBeenCalledTimes(1);
        expect(initializeServerIdentityCache.mock.invocationCallOrder[0]).toBeGreaterThan(
            startServerDbMocks.dbConnect.mock.invocationCallOrder[0],
        );
    });

    it("refuses startup when Session System Records remains on the expanded-only database shape", async () => {
        startServerDbMocks.dbQueryRawUnsafe.mockResolvedValue([]);

        await expect(startServerHarness.start("full", {
            SERVER_ROLE: "api",
            HAPPIER_DB_PROVIDER: "postgres",
        })).rejects.toThrow("20260810120000_contract_session_system_record_addresses");

        expect(initializeServerIdentityCache).not.toHaveBeenCalled();
    });

    it("encodes sqlite DATABASE_URL as a safe file URI when data dir contains special characters", async () => {
        await startServerHarness.start("light", {
            SERVER_ROLE: "api",
            HAPPY_DB_PROVIDER: "sqlite",
            HAPPY_SERVER_LIGHT_DATA_DIR: "/tmp/happy server #light",
            DATABASE_URL: undefined,
        });

        expect(process.env.DATABASE_URL).toBe(
            `${pathToFileURL(join("/tmp/happy server #light", "happier-server-light.sqlite")).href}?socket_timeout=30&connection_limit=4`,
        );
    });

    it("expands ~ in the sqlite light data dir before building DATABASE_URL", async () => {
        await startServerHarness.start("light", {
            SERVER_ROLE: "api",
            HAPPY_DB_PROVIDER: "sqlite",
            HAPPY_SERVER_LIGHT_DATA_DIR: "~/happy-server-light",
            HOME: "/Users/tester",
            DATABASE_URL: undefined,
        });

        expect(process.env.DATABASE_URL).toBe(
            `${pathToFileURL(join("/Users/tester/happy-server-light", "happier-server-light.sqlite")).href}?socket_timeout=30&connection_limit=4`,
        );
    });

    it("uses the same preferred light data dir for DATABASE_URL and sqlite migrations", async () => {
        await startServerHarness.start("light", {
            SERVER_ROLE: "api",
            HAPPY_DB_PROVIDER: "sqlite",
            HAPPIER_SERVER_LIGHT_DATA_DIR: "/tmp/happier-preferred-dir",
            HAPPY_SERVER_LIGHT_DATA_DIR: "/tmp/happy-legacy-dir",
            DATABASE_URL: undefined,
        });

        expect(process.env.DATABASE_URL).toBe(
            `${pathToFileURL(join("/tmp/happier-preferred-dir", "happier-server-light.sqlite")).href}?socket_timeout=30&connection_limit=4`,
        );
        expect(applySqliteMigrationsIfNeeded).toHaveBeenCalledWith(expect.objectContaining({
            dataDir: "/tmp/happier-preferred-dir",
        }));
    });

    it("falls back to the OS home directory when expanding ~ without HOME or USERPROFILE", async () => {
        const expectedDataDir = join(homedir(), "happy-server-light");

        await startServerHarness.start("light", {
            SERVER_ROLE: "api",
            HAPPY_DB_PROVIDER: "sqlite",
            HAPPY_SERVER_LIGHT_DATA_DIR: "~/happy-server-light",
            HOME: undefined,
            USERPROFILE: undefined,
            DATABASE_URL: undefined,
        });

        expect(process.env.DATABASE_URL).toBe(
            `${pathToFileURL(join(expectedDataDir, "happier-server-light.sqlite")).href}?socket_timeout=30&connection_limit=4`,
        );
        expect(applySqliteMigrationsIfNeeded).toHaveBeenCalledWith(expect.objectContaining({
            dataDir: expectedDataDir,
        }));
    });
});
