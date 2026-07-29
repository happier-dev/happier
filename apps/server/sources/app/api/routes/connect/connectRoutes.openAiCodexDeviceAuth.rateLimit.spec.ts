import { describe, expect, it, vi } from "vitest";

import { createFakeRouteApp, getRouteEntry } from "../../testkit/routeHarness";
import { registerConnectedServiceOpenAiCodexDeviceAuthRoutes } from "./connectedServicesV2/registerConnectedServiceOpenAiCodexDeviceAuthRoutes";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));
vi.mock("@/app/auth/auth", () => ({
    auth: {
        verifyToken: vi.fn(async (token: string) => (token === "token_1" ? { userId: "user-1" } : null)),
    },
}));

describe("OpenAI Codex device-auth route rate limits", () => {
    it("rate-limits provider start and poll work per authenticated account", async () => {
        const app = createFakeRouteApp();
        registerConnectedServiceOpenAiCodexDeviceAuthRoutes(app as any);

        for (const path of [
            "/v2/connect/openai-codex/oauth/device/start",
            "/v2/connect/openai-codex/oauth/device/poll",
        ]) {
            const rateLimit = getRouteEntry(app, "POST", path).opts.config?.rateLimit;
            expect(rateLimit).toEqual(expect.objectContaining({
                max: expect.any(Number),
                timeWindow: expect.any(String),
            }));
            expect(rateLimit?.keyGenerator).toEqual(expect.any(Function));
            await expect(rateLimit?.keyGenerator?.({
                headers: { authorization: "Bearer token_1" },
                ip: "203.0.113.9",
            })).resolves.toBe("uid:user-1");
        }
    });
});
