import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Redis is the boundary. The test decides when each registration's reply arrives (or whether it is
// lost), hands out Redis-clock registration times, and every refresh answers 0 ("a newer
// registration owns this route"), the outcome that drops a claim.
const evalMock = vi.hoisted(() => vi.fn());
const timeMock = vi.hoisted(() => vi.fn());
vi.mock("@/storage/redis/redis", () => ({ getRedisClient: () => ({ eval: evalMock, time: timeMock }) }));
vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

import { createRpcRedisRegistryCoordinator } from "./rpcRedisRegistryCoordinator";

const REFRESH_INTERVAL_MS = 60_000;
const METHOD = "machine-1:spawn-happy-session";

type Reply = { resolve: (value: unknown) => void; reject: (error: unknown) => void };

function isRegisterScript(script: unknown): boolean {
    return typeof script === "string" && script.includes("'registeredBy'") && !script.includes("local owner = redis.call('HGET', KEYS[1], 'socketId') if owner == ARGV[1]");
}

describe("createRpcRedisRegistryCoordinator refresh claims", () => {
    let registrationReplies: Reply[];
    let clock: number;

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        registrationReplies = [];
        clock = 100;
        timeMock.mockReset();
        timeMock.mockImplementation(async () => [String(clock++), "000000"]);
        evalMock.mockReset();
        evalMock.mockImplementation((script: unknown) => {
            if (isRegisterScript(script)) {
                return new Promise((resolve, reject) => registrationReplies.push({ resolve, reject }));
            }
            return Promise.resolve(0);
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    async function settle(): Promise<void> {
        await new Promise((resolve) => setImmediate(resolve));
    }

    function refreshCalls(): Array<{ key: string; registeredAt: string }> {
        return evalMock.mock.calls
            .filter(([script]) => !isRegisterScript(script))
            .map((call) => ({ key: String(call[2]), registeredAt: String(call[call.length - 1]) }));
    }

    function registrationCalls(): unknown[][] {
        return evalMock.mock.calls.filter(([script]) => isRegisterScript(script));
    }

    function createCoordinator(ownedMethods: Set<string>) {
        return createRpcRedisRegistryCoordinator({
            config: { enabled: true, instanceId: "instance-1" },
            userId: "user-1",
            socketId: "socket-1",
            ownedMethods,
        });
    }

    async function registeredCoordinator(ownedMethods: Set<string>) {
        const coordinator = createCoordinator(ownedMethods);
        const first = coordinator.registerMethod(METHOD);
        await settle();
        registrationReplies[0]!.resolve("ok");
        await first;
        coordinator.startRefreshLoopIfNeeded();
        return coordinator;
    }

    async function nextRefresh(): Promise<Array<{ key: string; registeredAt: string }>> {
        evalMock.mockClear();
        vi.advanceTimersByTime(REFRESH_INTERVAL_MS);
        await settle();
        return refreshCalls();
    }

    it("keeps the claim when a refresh outcome lands while the method is being registered again", async () => {
        const coordinator = await registeredCoordinator(new Set([METHOD]));

        vi.advanceTimersByTime(REFRESH_INTERVAL_MS);
        const again = coordinator.registerMethod(METHOD);
        await settle();
        registrationReplies[1]!.resolve("ok");
        await again;

        expect((await nextRefresh()).map(({ key }) => key)).toEqual([`rpc:user-1:${METHOD}`]);
    });

    it("keeps the claim when a refresh starts after the method began registering again", async () => {
        const coordinator = await registeredCoordinator(new Set([METHOD]));

        const again = coordinator.registerMethod(METHOD);
        vi.advanceTimersByTime(REFRESH_INTERVAL_MS);
        await settle();
        registrationReplies[1]!.resolve("ok");
        await again;

        expect((await nextRefresh()).map(({ key }) => key)).toEqual([`rpc:user-1:${METHOD}`]);
    });

    it("compares with the time Redis committed when a registration's reply is lost", async () => {
        const coordinator = await registeredCoordinator(new Set([METHOD]));

        const again = coordinator.registerMethod(METHOD);
        await settle();
        registrationReplies[1]!.reject(new Error("connection reset after the write"));
        await expect(again).rejects.toThrow();

        expect(await nextRefresh()).toEqual([{ key: `rpc:user-1:${METHOD}`, registeredAt: "101000000" }]);
    });

    it("compares with the new registration time when the reply arrives", async () => {
        const coordinator = await registeredCoordinator(new Set([METHOD]));

        const again = coordinator.registerMethod(METHOD);
        await settle();
        registrationReplies[1]!.resolve("ok");
        await again;

        expect(await nextRefresh()).toEqual([{ key: `rpc:user-1:${METHOD}`, registeredAt: "101000000" }]);
    });

    it("retries, without taking another socket's route, a registration that never reached Redis", async () => {
        const ownedMethods = new Set([METHOD]);
        const coordinator = createCoordinator(ownedMethods);
        timeMock.mockRejectedValueOnce(new Error("redis down"));
        await expect(coordinator.registerMethod(METHOD)).rejects.toThrow();
        coordinator.startRefreshLoopIfNeeded();

        evalMock.mockClear();
        vi.advanceTimersByTime(REFRESH_INTERVAL_MS);
        await settle();

        const retries = registrationCalls();
        expect(retries).toHaveLength(1);
        // ARGV[5] = '1': write only if the mapping is missing or already this socket's.
        expect(retries[0]![7]).toBe("1");
    });
});
