import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const serverCtor = vi.fn();
vi.mock("socket.io", () => ({
    Server: function ServerMock(this: any, ...args: any[]) {
        return serverCtor(...args);
    },
}));

vi.mock("@/utils/shutdown", () => ({
    onShutdown: vi.fn(),
}));

const createAdapter = vi.fn((_client: any) => ({ name: "adapter" }));
vi.mock("@socket.io/redis-streams-adapter", () => ({
    createAdapter: (arg: any) => createAdapter(arg),
}));

const getRedisClient = vi.fn(() => ({ name: "redis" }));
vi.mock("@/storage/redis", () => ({
    getRedisClient: () => getRedisClient(),
}));

describe("startSocket redis adapter config", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        vi.clearAllMocks();
        serverCtor.mockReturnValue({ on: vi.fn(), close: vi.fn(), to: vi.fn() });
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it("enables redis-streams adapter when explicitly configured in full flavor", async () => {
        process.env.HAPPY_SERVER_FLAVOR = "full";
        process.env.HAPPY_SOCKET_REDIS_ADAPTER = "true";
        process.env.REDIS_URL = "redis://localhost:6379";

        const { startSocket } = await import("./socket");
        startSocket({ server: {} } as any);

        expect(createAdapter).toHaveBeenCalledWith(expect.anything());
        expect(getRedisClient).toHaveBeenCalledTimes(1);
        expect(serverCtor).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ adapter: { name: "adapter" } }),
        );
    });

    it("does not enable adapter in lite flavor", async () => {
        process.env.HAPPY_SERVER_FLAVOR = "light";
        process.env.HAPPY_SOCKET_REDIS_ADAPTER = "true";
        process.env.REDIS_URL = "redis://localhost:6379";

        const { startSocket } = await import("./socket");
        startSocket({ server: {} } as any);

        expect(createAdapter).not.toHaveBeenCalled();
        expect(getRedisClient).not.toHaveBeenCalled();
        const options = serverCtor.mock.calls[0]?.[1];
        expect(options?.adapter).toBeUndefined();
    });
});
