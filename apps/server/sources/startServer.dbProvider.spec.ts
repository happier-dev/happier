import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const initDbPostgres = vi.fn(() => {});
const initDbPglite = vi.fn(async () => {});
const initDbMysql = vi.fn(() => {});
const initDbSqlite = vi.fn(() => {});
const shutdownDbPglite = vi.fn(async () => {});

vi.mock("@/storage/db", () => ({
    db: {
        $connect: vi.fn(async () => {}),
        $disconnect: vi.fn(async () => {}),
    },
    getDbProviderFromEnv: (env: any, fallback: any) => {
        const raw = (env?.HAPPIER_DB_PROVIDER ?? env?.HAPPY_DB_PROVIDER)?.toString().trim().toLowerCase();
        if (!raw) return fallback;
        if (raw === "postgresql" || raw === "postgres") return "postgres";
        if (raw === "pglite") return "pglite";
        if (raw === "sqlite") return "sqlite";
        if (raw === "mysql") return "mysql";
        return fallback;
    },
    initDbPostgres,
    initDbPglite,
    initDbMysql,
    initDbSqlite,
    shutdownDbPglite,
}));

vi.mock("@/app/api/api", () => ({ startApi: vi.fn(async () => {}) }));
vi.mock("@/app/monitoring/metrics", () => ({ startMetricsServer: vi.fn(async () => {}) }));
vi.mock("@/app/monitoring/metrics2", () => ({ startDatabaseMetricsUpdater: vi.fn(() => {}) }));
vi.mock("@/app/auth/auth", () => ({ auth: { init: vi.fn(async () => {}) } }));
vi.mock("@/app/presence/sessionCache", () => ({ activityCache: { shutdown: vi.fn(), enableDbFlush: vi.fn() } }));
vi.mock("@/app/presence/timeout", () => ({ startTimeout: vi.fn(() => {}) }));
vi.mock("@/modules/encrypt", () => ({ initEncrypt: vi.fn(async () => {}) }));
vi.mock("@/modules/github", () => ({ initGithub: vi.fn(async () => {}) }));
vi.mock("@/storage/files", () => ({
    loadFiles: vi.fn(async () => {}),
    initFilesLocalFromEnv: vi.fn(() => {}),
    initFilesS3FromEnv: vi.fn(() => {}),
}));
vi.mock("@/utils/log", () => ({ log: vi.fn() }));
vi.mock("@/flavors/light/env", () => ({
    applyLightDefaultEnv: vi.fn(),
    ensureHandyMasterSecret: vi.fn(async () => {}),
}));
vi.mock("@/app/changes/accountChangeCleanup", () => ({ startAccountChangeCleanupFromEnv: vi.fn(() => null) }));
vi.mock("@/app/presence/presenceMode", () => ({
    shouldConsumePresenceFromRedis: vi.fn(() => false),
    shouldEnableLocalPresenceDbFlush: vi.fn(() => false),
}));
vi.mock("@/app/presence/presenceRedisQueue", () => ({ startPresenceRedisWorker: vi.fn() }));

// Avoid hanging in tests: startServer calls awaitShutdown().
vi.mock("@/utils/shutdown", async () => {
    const actual = await vi.importActual<any>("@/utils/shutdown");
    return { ...actual, awaitShutdown: vi.fn(async () => {}) };
});

describe("startServer DB provider selection", () => {
    const originalEnv = process.env;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env = { ...originalEnv };
        delete process.env.HAPPY_DB_PROVIDER;
        delete process.env.HAPPIER_DB_PROVIDER;
        delete process.env.SERVER_ROLE;
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it("uses MySQL when HAPPIER_DB_PROVIDER=mysql (full flavor)", async () => {
        process.env.SERVER_ROLE = "api";
        process.env.HAPPIER_DB_PROVIDER = "mysql";

        vi.resetModules();
        const { startServer } = await import("./startServer");
        await startServer("full");

        expect(initDbMysql).toHaveBeenCalledTimes(1);
        expect(initDbPostgres).not.toHaveBeenCalled();
    });

    it("uses SQLite when HAPPY_DB_PROVIDER=sqlite (light flavor)", async () => {
        process.env.SERVER_ROLE = "api";
        process.env.HAPPY_DB_PROVIDER = "sqlite";
        process.env.HAPPY_SERVER_LIGHT_DATA_DIR = "/tmp/happy-server-light-test";

        vi.resetModules();
        const { startServer } = await import("./startServer");
        await startServer("light");

        expect(initDbSqlite).toHaveBeenCalledTimes(1);
        expect(initDbPglite).not.toHaveBeenCalled();
    });
});
