import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { applyEnvValues, restoreEnv, snapshotEnv } from "@/testkit/env";

const envBackup = snapshotEnv();

describe("auth (token cache)", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        applyEnvValues({ HANDY_MASTER_SECRET: "test-master-secret" });
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

        await auth.createToken("user-1");
        expect(auth.getCacheStats().size).toBe(1);

        vi.advanceTimersByTime(1500);

        await auth.createToken("user-2");
        expect(auth.getCacheStats().size).toBe(1);
    });

    it("enforces a max entry limit for the token cache", async () => {
        applyEnvValues({
            AUTH_TOKEN_CACHE_TTL_SECONDS: "3600",
            AUTH_TOKEN_CACHE_MAX_ENTRIES: "2",
        });

        const { auth } = await import("./auth");
        await auth.init();

        await auth.createToken("user-1");
        await auth.createToken("user-2");
        await auth.createToken("user-3");

        expect(auth.getCacheStats().size).toBe(2);
    });
});
