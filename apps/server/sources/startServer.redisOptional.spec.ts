import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ping = vi.fn(async () => "PONG");
vi.mock("@/storage/redis", () => ({
    getRedisClient: () => ({ ping }),
}));

vi.mock("@/storage/db", () => ({
    db: {
        $connect: vi.fn(async () => {}),
        $disconnect: vi.fn(async () => {}),
    },
    getDbProviderFromEnv: (_env: any, fallback: any) => fallback,
    initDbPostgres: vi.fn(() => {}),
    initDbPglite: vi.fn(async () => {}),
    initDbMysql: vi.fn(async () => {}),
    initDbSqlite: vi.fn(async () => {}),
    shutdownDbPglite: vi.fn(async () => {}),
}));

vi.mock("@/storage/files", () => ({
    loadFiles: vi.fn(async () => {}),
    initFilesLocalFromEnv: vi.fn(() => {}),
    initFilesS3FromEnv: vi.fn(() => {}),
}));

vi.mock("@/modules/encrypt", () => ({ initEncrypt: vi.fn(async () => {}) }));
vi.mock("@/modules/github", () => ({ initGithub: vi.fn(async () => {}) }));
vi.mock("@/app/auth/auth", () => ({ auth: { init: vi.fn(async () => {}) } }));

vi.mock("@/app/api/api", () => ({ startApi: vi.fn(async () => {}) }));
vi.mock("@/app/monitoring/metrics", () => ({ startMetricsServer: vi.fn(async () => {}) }));
vi.mock("@/app/monitoring/metrics2", () => ({ startDatabaseMetricsUpdater: vi.fn(() => {}) }));
vi.mock("@/app/presence/timeout", () => ({ startTimeout: vi.fn(() => {}) }));
vi.mock("@/app/changes/accountChangeCleanup", () => ({ startAccountChangeCleanupFromEnv: vi.fn(() => null) }));

vi.mock("@/app/presence/sessionCache", () => ({ activityCache: { shutdown: vi.fn() } }));
vi.mock("@/app/events/eventRouter", () => ({ eventRouter: { setIo: vi.fn(), addConnection: vi.fn() } }));
vi.mock("@/utils/log", () => ({ log: vi.fn() }));

vi.mock("@/app/presence/presenceMode", () => ({
    shouldConsumePresenceFromRedis: vi.fn(() => false),
    shouldEnableLocalPresenceDbFlush: vi.fn(() => false),
}));

vi.mock("@/app/presence/presenceRedisQueue", () => ({
    startPresenceRedisWorker: vi.fn(() => ({ stop: vi.fn(async () => {}) })),
}));

vi.mock("@/utils/shutdown", () => ({
    onShutdown: vi.fn(),
    awaitShutdown: vi.fn(async () => {}),
}));

describe("startServer Redis dependency (full flavor)", () => {
    const originalEnv = process.env;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env = { ...originalEnv };
        delete process.env.HAPPY_SERVER_FLAVOR;
        delete process.env.HAPPY_SOCKET_REDIS_ADAPTER;
        delete process.env.REDIS_URL;
        delete process.env.SERVER_ROLE;
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it("does not ping Redis when adapter is not enabled (even if REDIS_URL is set)", async () => {
        process.env.SERVER_ROLE = "api";
        process.env.REDIS_URL = "redis://localhost:6379";

        vi.resetModules();
        const { startServer } = await import("./startServer");

        await startServer("full");
        expect(ping).not.toHaveBeenCalled();
    });

    it("pings Redis when adapter is enabled", async () => {
        process.env.SERVER_ROLE = "api";
        process.env.REDIS_URL = "redis://localhost:6379";
        process.env.HAPPY_SOCKET_REDIS_ADAPTER = "1";

        vi.resetModules();
        const { startServer } = await import("./startServer");

        await startServer("full");
        expect(ping).toHaveBeenCalledTimes(1);
    });
});
