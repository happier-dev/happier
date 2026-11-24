import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Redis is the boundary: the test decides when each registration's reply arrives, and every
// refresh answers 0 ("a newer registration owns this route"), the outcome that drops a claim.
const evalMock = vi.hoisted(() => vi.fn());
vi.mock("@/storage/redis/redis", () => ({ getRedisClient: () => ({ eval: evalMock }) }));
vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

import { createRpcRedisRegistryCoordinator } from "./rpcRedisRegistryCoordinator";

const REFRESH_INTERVAL_MS = 60_000;

function isRegisterScript(script: unknown): boolean {
    return typeof script === "string" && script.includes("redis.call('TIME')");
}

describe("createRpcRedisRegistryCoordinator refresh claims", () => {
    let releaseRegistrations: Array<(registeredAt: string) => void>;

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        releaseRegistrations = [];
        evalMock.mockReset();
        evalMock.mockImplementation((script: unknown) => {
            if (isRegisterScript(script)) {
                return new Promise<string>((resolve) => releaseRegistrations.push(resolve));
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

    function refreshedKeys(): string[] {
        return evalMock.mock.calls.filter(([script]) => !isRegisterScript(script)).map(([, , key]) => String(key));
    }

    async function registeredCoordinator(ownedMethods: Set<string>) {
        const coordinator = createRpcRedisRegistryCoordinator({
            config: { enabled: true, instanceId: "instance-1" },
            userId: "user-1",
            socketId: "socket-1",
            ownedMethods,
        });
        const first = coordinator.registerMethod("machine-1:spawn-happy-session");
        releaseRegistrations[0]!("100");
        await first;
        coordinator.startRefreshLoopIfNeeded();
        return coordinator;
    }

    it("keeps the claim when a refresh outcome lands while the method is being registered again", async () => {
        const ownedMethods = new Set(["machine-1:spawn-happy-session"]);
        const coordinator = await registeredCoordinator(ownedMethods);

        vi.advanceTimersByTime(REFRESH_INTERVAL_MS);
        const again = coordinator.registerMethod("machine-1:spawn-happy-session");
        await settle();
        releaseRegistrations[1]!("200");
        await again;

        evalMock.mockClear();
        vi.advanceTimersByTime(REFRESH_INTERVAL_MS);
        await settle();
        expect(refreshedKeys()).toEqual(["rpc:user-1:machine-1:spawn-happy-session"]);
    });

    it("keeps the claim when a refresh starts after the method began registering again", async () => {
        const ownedMethods = new Set(["machine-1:spawn-happy-session"]);
        const coordinator = await registeredCoordinator(ownedMethods);

        const again = coordinator.registerMethod("machine-1:spawn-happy-session");
        vi.advanceTimersByTime(REFRESH_INTERVAL_MS);
        await settle();
        releaseRegistrations[1]!("200");
        await again;

        evalMock.mockClear();
        vi.advanceTimersByTime(REFRESH_INTERVAL_MS);
        await settle();
        expect(refreshedKeys()).toEqual(["rpc:user-1:machine-1:spawn-happy-session"]);
    });
});
