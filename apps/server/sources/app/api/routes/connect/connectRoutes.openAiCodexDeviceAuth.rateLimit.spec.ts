import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createFakeRouteApp, getRouteEntry } from "../../testkit/routeHarness";
import { registerConnectedServiceOpenAiCodexDeviceAuthRoutes } from "./connectedServicesV2/registerConnectedServiceOpenAiCodexDeviceAuthRoutes";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));
// Exercise real token issuance and route admission against the canonical storage harness.
let harness: LightSqliteHarness;
let token: string;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: "happier-connect-rate-auth-", initAuth: true });
    await db.account.create({ data: { id: "user-1", publicKey: "connect-rate-auth-user" } });
    token = await auth.createToken("user-1", undefined, { kind: "account", authority: "present_user" });
}, 120_000);
afterAll(async () => { await harness?.close(); });

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
                headers: { authorization: `Bearer ${token}` },
                ip: "203.0.113.9",
            })).resolves.toBe("uid:user-1");
        }
    });
});
