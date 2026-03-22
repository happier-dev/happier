import { afterEach, describe, expect, it, vi } from "vitest";

import { createStartServerHarness } from "./startServerHarness";

const startServer = vi.fn(async () => {});

vi.mock("@/startServer", () => ({
    startServer,
}));

describe("startServerHarness", () => {
    const harness = createStartServerHarness({
        SERVER_ROLE: undefined,
        REDIS_URL: undefined,
        HAPPY_SERVER_LIGHT_DATA_DIR: undefined,
    });

    afterEach(() => {
        harness.restore();
    });

    it("restores the startServer env baseline and starts with the requested patch", async () => {
        harness.reset({
            SERVER_ROLE: "stale-role",
            REDIS_URL: "redis://stale",
        });

        await harness.start("full", {
            SERVER_ROLE: "api",
            REDIS_URL: "redis://fresh",
        });

        expect(startServer).toHaveBeenCalledWith("full");
        expect(process.env.SERVER_ROLE).toBe("api");
        expect(process.env.REDIS_URL).toBe("redis://fresh");

        harness.restore();

        expect(process.env.SERVER_ROLE).toBeUndefined();
        expect(process.env.REDIS_URL).toBeUndefined();
    });
});
