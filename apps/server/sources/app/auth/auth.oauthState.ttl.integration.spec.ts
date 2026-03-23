import { afterEach, describe, expect, it, vi } from "vitest";

import { applyEnvValues, restoreEnv, snapshotEnv } from "@/app/api/testkit/env";
import { applyLightAuthTestEnv } from "@/testkit/applyLightAuthTestEnv";

describe("auth (oauth state tokens) ttl", () => {
    const envBackup = snapshotEnv();

    afterEach(() => {
        vi.useRealTimers();
        restoreEnv(envBackup);
    });

    it("expires oauth state tokens after OAUTH_STATE_TTL_SECONDS", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        await applyLightAuthTestEnv({ OAUTH_STATE_TTL_SECONDS: "60" });

        vi.resetModules();
        const { auth } = await import("./auth");
        await auth.init();

        const token = await auth.createOauthStateToken({
            flow: "connect",
            provider: "github",
            sid: "sid_1",
            userId: "u1",
        });

        expect(await auth.verifyOauthStateToken(token)).not.toBeNull();

        vi.advanceTimersByTime(61_000);
        expect(await auth.verifyOauthStateToken(token)).toBeNull();
    });
});
