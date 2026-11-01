import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    createStartServerDbMocks,
    installStartServerDbModuleMock,
    installStartServerCommonWiringMocks,
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

installStartServerDbModuleMock(startServerDbMocks);

installStartServerCommonWiringMocks();

vi.mock("@/app/serverIdentity/serverIdentity", () => ({
    initializeServerIdentityCache,
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
        DATABASE_URL: undefined,
    });

    beforeEach(() => {
        startServerDbMocks.reset();
        initializeServerIdentityCache.mockReset().mockResolvedValue("srv_startupCache123");
        startServerHarness.reset();
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

    it("preserves the native SQLite path when data dir contains spaces and hashes", async () => {
        const homeDir = join(tmpdir(), `happier-server-light-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await startServerHarness.start("light", {
            SERVER_ROLE: "api",
            HOME: homeDir,
            USERPROFILE: homeDir,
            HAPPY_DB_PROVIDER: "sqlite",
            HAPPY_SERVER_LIGHT_DATA_DIR: "~/happy server #light",
            DATABASE_URL: undefined,
        });

        expect(process.env.DATABASE_URL).toBe(
            `file:${join(homeDir, "happy server #light", "happier-server-light.sqlite")}?socket_timeout=30&connection_limit=1`,
        );
    });
});
