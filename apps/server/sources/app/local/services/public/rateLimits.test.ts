import type { LocalServicePublicExposureV1 } from "@happier-dev/protocol";
import { describe, expect, it } from "vitest";

import {
    LOCAL_SERVICE_PUBLIC_MAX_TRACKED_RATE_LIMIT_BUCKETS,
    createLocalServicePublicRateLimitChecker,
} from "./rateLimits";

const exposure: LocalServicePublicExposureV1 = {
    exposureId: "public_preview_1",
    previewId: "preview_1",
    sessionId: "session_1",
    machineId: "machine_1",
    mode: "secret_link",
    state: "active",
    publicUrl: "https://public-preview-1.preview.example.test/v1/local-services/public/public_preview_1",
    issuedAt: 1_000,
    expiresAt: 61_000,
    auditEventIds: [],
    rateLimitProfileId: "default",
};

describe("local service public exposure rate limits", () => {
    it("keeps fixed-window buckets isolated by requesting client", () => {
        const checkRateLimit = createLocalServicePublicRateLimitChecker({
            kind: "fixed_window",
            maxRequests: 1,
            windowMs: 60_000,
        });

        expect(checkRateLimit).toBeTypeOf("function");
        if (!checkRateLimit) return;

        expect(checkRateLimit({ exposure, clientKey: "client_a", nowMs: 1_000 })).toBe(true);
        expect(checkRateLimit({ exposure, clientKey: "client_a", nowMs: 1_000 })).toBe(false);
        expect(checkRateLimit({ exposure, clientKey: "client_b", nowMs: 1_000 })).toBe(true);
    });

    // F-3 (review gate R1, MEDIUM): the bucket map only ever grew. `clientKey` is `request.ip`,
    // which honours `trustProxy`, so behind the common reverse proxy an UNAUTHENTICATED visitor
    // to a public exposure controls the key through `X-Forwarded-For` and could allocate buckets
    // without bound — on precisely the surface DEC-7 turns on.
    it("bounds the tracked buckets and reclaims them once the window passes", () => {
        const windowMs = 60_000;
        const checkRateLimit = createLocalServicePublicRateLimitChecker({
            kind: "fixed_window",
            maxRequests: 1,
            windowMs,
        });

        expect(checkRateLimit).toBeTypeOf("function");
        if (!checkRateLimit) return;

        const floodAtMs = 1_000;
        for (let index = 0; index < LOCAL_SERVICE_PUBLIC_MAX_TRACKED_RATE_LIMIT_BUCKETS; index += 1) {
            checkRateLimit({ exposure, clientKey: `flood_${index}`, nowMs: floodAtMs });
        }

        // Past the ceiling, further distinct clients SHARE one overflow bucket, so a brand-new
        // client is refused inside the same window. Without a ceiling every new key would get its
        // own fresh bucket and this would always be `true` — which is the unbounded growth.
        checkRateLimit({ exposure, clientKey: "overflow_a", nowMs: floodAtMs });
        expect(checkRateLimit({ exposure, clientKey: "overflow_b", nowMs: floodAtMs })).toBe(false);
        expect(checkRateLimit({ exposure, clientKey: "overflow_c", nowMs: floodAtMs })).toBe(false);

        // Once the window the limiter already reasons about has passed, the map is reclaimed, so
        // two distinct new clients each get their own bucket again. Without reclamation both would
        // still land in the shared overflow bucket and the second would be refused.
        const afterWindowMs = floodAtMs + windowMs;
        expect(checkRateLimit({ exposure, clientKey: "after_window_a", nowMs: afterWindowMs })).toBe(true);
        expect(checkRateLimit({ exposure, clientKey: "after_window_b", nowMs: afterWindowMs })).toBe(true);
    });
});
