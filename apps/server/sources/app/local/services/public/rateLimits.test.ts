import type { LocalServicePublicExposureV1 } from "@happier-dev/protocol";
import { describe, expect, it } from "vitest";

import { createLocalServicePublicRateLimitChecker } from "./rateLimits";

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
});
