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

const createRedisStreamsRoomEmitter = vi.fn((_params?: unknown) => ({
    to: vi.fn(() => ({
        emit: vi.fn(),
        except: vi.fn(() => ({
            emit: vi.fn(),
        })),
    })),
}));
vi.mock("@/app/events/createRedisStreamsRoomEmitter", () => ({
    createRedisStreamsRoomEmitter: (params: unknown) => createRedisStreamsRoomEmitter(params),
}));

const serverCtor = vi.fn();
vi.mock("socket.io", () => ({
    Server: function ServerMock(this: unknown, ...args: unknown[]) {
        return serverCtor(...args);
    },
}));

const startServerDbMocks = createStartServerDbMocks();

installStartServerDbModuleMock(startServerDbMocks);
installStartServerCommonWiringMocks();

vi.mock("@/utils/process/shutdown", () => ({
    onShutdown: vi.fn(),
    awaitShutdown: vi.fn(async () => {}),
}));

describe("startServer adapter tuning", () => {
    const startServerHarness = createStartServerHarness({
        REDIS_URL: undefined,
        SERVER_ROLE: undefined,
        HAPPIER_SOCKET_ADAPTER: undefined,
        HAPPIER_SOCKET_ADAPTER_MAXLEN: undefined,
        HAPPIER_SOCKET_ADAPTER_READ_COUNT: undefined,
    });

    beforeEach(() => {
        startServerDbMocks.reset();
        startServerHarness.reset();
        serverCtor.mockReturnValue({ close: vi.fn() });
        createRedisStreamsRoomEmitter.mockReset();
    });

    afterEach(() => {
        startServerHarness.restore();
    });

    it("uses the redis-streams emitter for worker fanout mode instead of creating a socket server peer", async () => {
        await startServerHarness.start("full", {
            SERVER_ROLE: "worker",
            REDIS_URL: "redis://localhost:6379",
            HAPPIER_SOCKET_ADAPTER: "redis-streams",
            HAPPIER_SOCKET_ADAPTER_MAXLEN: "1234",
            HAPPIER_SOCKET_ADAPTER_READ_COUNT: "55",
        });

        expect(createRedisStreamsRoomEmitter).toHaveBeenCalledWith(
            expect.objectContaining({
                maxLen: 1234,
            }),
        );
        expect(serverCtor).not.toHaveBeenCalled();
    });
});
