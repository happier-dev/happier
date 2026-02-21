import { describe, expect, it } from "vitest";

import { resolvePresenceTimeoutConfig } from "./timeout";

describe("presence timeout config", () => {
    it("uses default timeouts when env unset", () => {
        const config = resolvePresenceTimeoutConfig({});
        expect(config).toEqual({
            sessionTimeoutMs: 10 * 60 * 1000,
            machineTimeoutMs: 10 * 60 * 1000,
            tickMs: 60 * 1000,
        });
    });

    it("accepts env overrides", () => {
        const config = resolvePresenceTimeoutConfig({
            HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: "35000",
            HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: "45000",
            HAPPIER_PRESENCE_TIMEOUT_TICK_MS: "1000",
        });
        expect(config).toEqual({ sessionTimeoutMs: 35_000, machineTimeoutMs: 45_000, tickMs: 1_000 });
    });

    it("falls back when env is invalid", () => {
        const config = resolvePresenceTimeoutConfig({
            HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: "nope",
            HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: "0",
            HAPPIER_PRESENCE_TIMEOUT_TICK_MS: "-1",
        });
        expect(config).toEqual({
            sessionTimeoutMs: 10 * 60 * 1000,
            machineTimeoutMs: 10 * 60 * 1000,
            tickMs: 60 * 1000,
        });
    });
});

