import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    createStartServerDbMocks,
    installStartServerDbModuleMock,
    installStartServerCommonWiringMocks,
} from "@/testkit/startServerMocks";
import { createStartServerHarness } from "@/testkit/startServerHarness";

const ping = vi.fn(async () => "PONG");
vi.mock("@/storage/redis/redis", () => ({
    getRedisClient: () => ({ ping }),
}));

const startServerDbMocks = createStartServerDbMocks();

installStartServerDbModuleMock(startServerDbMocks);

installStartServerCommonWiringMocks();

vi.mock("@/utils/process/shutdown", () => ({
    onShutdown: vi.fn(),
    awaitShutdown: vi.fn(async () => {}),
}));

describe("startServer Redis dependency (full flavor)", () => {
    const startServerHarness = createStartServerHarness({
        HAPPY_SERVER_FLAVOR: undefined,
        HAPPIER_SERVER_FLAVOR: undefined,
        HAPPY_SOCKET_REDIS_ADAPTER: undefined,
        HAPPIER_SOCKET_REDIS_ADAPTER: undefined,
        HAPPY_SOCKET_ADAPTER: undefined,
        HAPPIER_SOCKET_ADAPTER: undefined,
        REDIS_URL: undefined,
        SERVER_ROLE: undefined,
    });

    beforeEach(() => {
        startServerDbMocks.reset();
        startServerHarness.reset();
    });

    afterEach(() => {
        startServerHarness.restore();
    });

    it("does not ping Redis when adapter is not enabled (even if REDIS_URL is set)", async () => {
        await startServerHarness.start("full", {
            SERVER_ROLE: "api",
            REDIS_URL: "redis://localhost:6379",
        });
        expect(ping).not.toHaveBeenCalled();
    });

    it("pings Redis when adapter is enabled", async () => {
        await startServerHarness.start("full", {
            SERVER_ROLE: "api",
            REDIS_URL: "redis://localhost:6379",
            HAPPIER_SOCKET_ADAPTER: "redis-streams",
        });
        expect(ping).toHaveBeenCalledTimes(1);
    });
});
