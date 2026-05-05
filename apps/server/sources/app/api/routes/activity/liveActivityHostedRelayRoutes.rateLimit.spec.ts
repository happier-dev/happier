import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFakeRouteApp, getRouteEntry } from "../../testkit/routeHarness";

function relayKeyFingerprint(token: string): string {
    return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

describe("liveActivityHostedRelayRoutes rate limits", () => {
    const originalAccessKeys = process.env.HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEYS;

    beforeEach(() => {
        process.env.HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEYS = "relay-access-key,secondary-key";
    });

    afterEach(() => {
        if (typeof originalAccessKeys === "string") {
            process.env.HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEYS = originalAccessKeys;
        } else {
            delete process.env.HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEYS;
        }
    });

    it("registers the hosted relay route with a relay-keyed hot endpoint rate limit", async () => {
        const { liveActivityHostedRelayRoutes } = await import("./liveActivityHostedRelayRoutes");
        const app = createFakeRouteApp();
        liveActivityHostedRelayRoutes(app as any);

        const opts = getRouteEntry(app, "POST", "/v1/live-activity-hosted-relay").opts;
        expect(opts.config?.rateLimit).toEqual(
            expect.objectContaining({
                max: 120,
                timeWindow: "1 minute",
            }),
        );
        expect(opts.config?.rateLimit?.keyGenerator).toEqual(expect.any(Function));
        expect(await opts.config?.rateLimit?.keyGenerator?.({ headers: { authorization: "Bearer relay-access-key" }, ip: "203.0.113.9" }))
            .toBe(`relay:${relayKeyFingerprint("relay-access-key")}`);
        expect(await opts.config?.rateLimit?.keyGenerator?.({ headers: { authorization: "Bearer attacker-rotated-key" }, ip: "203.0.113.9" }))
            .toBe("ip:203.0.113.9");
        expect(await opts.config?.rateLimit?.keyGenerator?.({ headers: {}, ip: "203.0.113.9" }))
            .toBe("ip:203.0.113.9");
    });
});
