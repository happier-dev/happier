import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { applyEnvValues, restoreEnv, snapshotEnv } from "@/testkit/env";

const dbAccountFindUniqueMock = vi.hoisted(() => vi.fn());
vi.mock("@/storage/db", () => ({
    db: {
        account: {
            findUnique: (...args: unknown[]) => dbAccountFindUniqueMock(...args),
        },
    },
}));

const envBackup = snapshotEnv();

describe("auth (token cache)", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        applyEnvValues({ HANDY_MASTER_SECRET: "test-master-secret" });
        dbAccountFindUniqueMock.mockReset();
        dbAccountFindUniqueMock.mockResolvedValue({ tokenEpoch: 0 });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.resetModules();
        restoreEnv(envBackup);
    });

    it("evicts expired token cache entries on insert", async () => {
        applyEnvValues({
            AUTH_TOKEN_CACHE_TTL_SECONDS: "1",
            AUTH_TOKEN_CACHE_MAX_ENTRIES: "10",
        });

        const { auth } = await import("./auth");
        await auth.init();

        const firstToken = await auth.createToken("user-1");
        await auth.verifyToken(firstToken);
        expect(auth.getCacheStats().size).toBe(1);

        vi.advanceTimersByTime(1500);

        const secondToken = await auth.createToken("user-2");
        await auth.verifyToken(secondToken);
        expect(auth.getCacheStats().size).toBe(1);
    });

    it("enforces a max entry limit for the token cache", async () => {
        applyEnvValues({
            AUTH_TOKEN_CACHE_TTL_SECONDS: "3600",
            AUTH_TOKEN_CACHE_MAX_ENTRIES: "2",
        });

        const { auth } = await import("./auth");
        await auth.init();

        const firstToken = await auth.createToken("user-1");
        const secondToken = await auth.createToken("user-2");
        const thirdToken = await auth.createToken("user-3");
        await auth.verifyToken(firstToken);
        await auth.verifyToken(secondToken);
        await auth.verifyToken(thirdToken);

        expect(auth.getCacheStats().size).toBe(2);
    });
});
