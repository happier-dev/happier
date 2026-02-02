import { describe, expect, it, vi } from "vitest";

const callOrder: string[] = [];

const dbDisconnect = vi.fn(async () => {
    callOrder.push("db.$disconnect");
});

const shutdownDbPglite = vi.fn(async () => {
    callOrder.push("shutdownDbPglite");
});

vi.mock("@/storage/db", () => ({
    db: {
        $connect: vi.fn(async () => {}),
        $disconnect: dbDisconnect as any,
    },
    getDbProviderFromEnv: (_env: any, fallback: any) => fallback,
    initDbPostgres: vi.fn(),
    initDbPglite: vi.fn(async () => {}),
    initDbMysql: vi.fn(async () => {}),
    initDbSqlite: vi.fn(async () => {}),
    shutdownDbPglite: shutdownDbPglite as any,
}));

vi.mock("@/app/api/api", () => ({ startApi: vi.fn(async () => {}) }));
vi.mock("@/app/monitoring/metrics", () => ({ startMetricsServer: vi.fn(async () => {}) }));
vi.mock("@/app/monitoring/metrics2", () => ({ startDatabaseMetricsUpdater: vi.fn() }));
vi.mock("@/app/auth/auth", () => ({ auth: { init: vi.fn(async () => {}), verifyToken: vi.fn() } }));
vi.mock("@/app/presence/sessionCache", () => ({ activityCache: { enableDbFlush: vi.fn(), shutdown: vi.fn() } }));
vi.mock("@/app/presence/timeout", () => ({ startTimeout: vi.fn() }));
vi.mock("@/modules/encrypt", () => ({ initEncrypt: vi.fn(async () => {}) }));
vi.mock("@/modules/github", () => ({ initGithub: vi.fn(async () => {}) }));
vi.mock("@/storage/files", () => ({
    loadFiles: vi.fn(async () => {}),
    initFilesLocalFromEnv: vi.fn(),
    initFilesS3FromEnv: vi.fn(),
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

describe("startServer light shutdown ordering", () => {
    it("disconnects Prisma before stopping pglite", async () => {
        callOrder.length = 0;
        process.env.SERVER_ROLE = "all";
        process.env.HAPPY_SOCKET_REDIS_ADAPTER = "0";
        delete process.env.REDIS_URL;

        const { startServer } = await import("./startServer");
        const { initiateShutdown } = await import("@/utils/shutdown");

        await startServer("light");
        await initiateShutdown("test");

        expect(callOrder).toEqual(["db.$disconnect", "shutdownDbPglite"]);
    });
});
