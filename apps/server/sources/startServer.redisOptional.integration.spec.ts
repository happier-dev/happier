import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    applyEnvValues,
    installStartServerCommonWiringMocks,
    restoreEnvValues,
    snapshotStartServerEnv,
} from "@/testkit/startServerMocks";

const ping = vi.fn(async () => "PONG");
vi.mock("@/storage/redis/redis", () => ({
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

installStartServerCommonWiringMocks();

vi.mock("@/utils/process/shutdown", () => ({
    onShutdown: vi.fn(),
    awaitShutdown: vi.fn(async () => {}),
}));

describe("startServer Redis dependency (full flavor)", () => {
    const envBackup = snapshotStartServerEnv();

    beforeEach(() => {
        vi.clearAllMocks();
        restoreEnvValues(envBackup);
        applyEnvValues({
            HAPPY_SERVER_FLAVOR: undefined,
            HAPPIER_SERVER_FLAVOR: undefined,
            HAPPY_SOCKET_REDIS_ADAPTER: undefined,
            HAPPIER_SOCKET_REDIS_ADAPTER: undefined,
            HAPPY_SOCKET_ADAPTER: undefined,
            HAPPIER_SOCKET_ADAPTER: undefined,
            REDIS_URL: undefined,
            SERVER_ROLE: undefined,
        });
    });

    afterEach(() => {
        restoreEnvValues(envBackup);
    });

    it("does not ping Redis when adapter is not enabled (even if REDIS_URL is set)", async () => {
        applyEnvValues({
            SERVER_ROLE: "api",
            REDIS_URL: "redis://localhost:6379",
        });

        vi.resetModules();
        const { startServer } = await import("./startServer");

        await startServer("full");
        expect(ping).not.toHaveBeenCalled();
    });

    it("pings Redis when adapter is enabled", async () => {
        applyEnvValues({
            SERVER_ROLE: "api",
            REDIS_URL: "redis://localhost:6379",
            HAPPIER_SOCKET_ADAPTER: "redis-streams",
        });

        vi.resetModules();
        const { startServer } = await import("./startServer");

        await startServer("full");
        expect(ping).toHaveBeenCalledTimes(1);
    });
});
