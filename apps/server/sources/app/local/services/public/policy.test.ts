import { describe, expect, it } from "vitest";

import {
    isLocalServicePublicExposureAccessible,
    resolveLocalServicePublicExposureDecision,
} from "./policy";

const publicPolicyModule = {
    isLocalServicePublicExposureAccessible,
    resolveLocalServicePublicExposureDecision,
};

async function loadPublicPolicyModule(): Promise<typeof publicPolicyModule> {
    return publicPolicyModule;
}

describe("local service public exposure policy", () => {
    it("fails closed when public preview is disabled", async () => {
        const mod = await loadPublicPolicyModule();

        const decision = mod?.resolveLocalServicePublicExposureDecision({
            policy: {},
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            nowMs: 1_000,
            previewEligible: true,
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        });

        expect(decision).toEqual({ ok: false, reasonCode: "public_preview_disabled" });
    });

    it("requires an eligible private preview and authorized session access", async () => {
        const mod = await loadPublicPolicyModule();

        const previewDecision = mod?.resolveLocalServicePublicExposureDecision({
            policy: { enabled: true, allowedModes: ["secret_link"], dnsTlsRequired: false },
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            nowMs: 1_000,
            previewEligible: false,
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        });
        expect(previewDecision).toEqual({ ok: false, reasonCode: "preview_not_eligible" });

        const authDecision = mod?.resolveLocalServicePublicExposureDecision({
            policy: { enabled: true, allowedModes: ["secret_link"], dnsTlsRequired: false },
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            nowMs: 1_000,
            previewEligible: true,
            sessionAuthorized: false,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        });
        expect(authDecision).toEqual({ ok: false, reasonCode: "session_not_authorized" });
    });

    it("rejects modes not allowed by server policy and validates DNS/TLS readiness", async () => {
        const mod = await loadPublicPolicyModule();

        const modeDecision = mod?.resolveLocalServicePublicExposureDecision({
            policy: { enabled: true, allowedModes: ["authenticated"], dnsTlsRequired: false },
            requestedMode: "public",
            requestedTtlMs: 60_000,
            nowMs: 1_000,
            previewEligible: true,
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        });
        expect(modeDecision).toEqual({ ok: false, reasonCode: "mode_not_allowed" });

        const dnsDecision = mod?.resolveLocalServicePublicExposureDecision({
            policy: { enabled: true, allowedModes: ["secret_link"], dnsTlsRequired: true },
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            nowMs: 1_000,
            previewEligible: true,
            sessionAuthorized: true,
            dnsTlsValid: false,
            rateLimitProfileId: "default",
        });
        expect(dnsDecision).toEqual({ ok: false, reasonCode: "dns_tls_unavailable" });
    });

    it("clamps TTL to server maximum for accepted exposures", async () => {
        const mod = await loadPublicPolicyModule();

        const decision = mod?.resolveLocalServicePublicExposureDecision({
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 30_000,
                dnsTlsRequired: false,
                rateLimitProfileIds: ["default"],
            },
            requestedMode: "secret_link",
            requestedTtlMs: 120_000,
            nowMs: 1_000,
            previewEligible: true,
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        });

        expect(decision).toEqual({
            ok: true,
            mode: "secret_link",
            ttlMs: 30_000,
            expiresAt: 31_000,
            rateLimitProfileId: "default",
        });
    });

    it("rejects enabled public exposure policy without a maximum TTL", async () => {
        const mod = await loadPublicPolicyModule();

        const decision = mod?.resolveLocalServicePublicExposureDecision({
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                dnsTlsRequired: false,
                rateLimitProfileIds: ["default"],
            },
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            nowMs: 1_000,
            previewEligible: true,
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        });

        expect(decision).toEqual({ ok: false, reasonCode: "invalid_policy" });
    });

    it("treats revoked, expired, and rate-limited exposures as inaccessible", async () => {
        const mod = await loadPublicPolicyModule();

        expect(mod?.isLocalServicePublicExposureAccessible({
            exposure: {
                exposureId: "public_preview_1",
                previewId: "preview_1",
                sessionId: "session_1",
                machineId: "machine_1",
                mode: "secret_link",
                state: "active",
                publicUrl: "https://preview.example.test/s/public_preview_1",
                issuedAt: 1_000,
                expiresAt: 31_000,
                auditEventIds: [],
                rateLimitProfileId: "default",
            },
            nowMs: 2_000,
        })).toBe(true);

        for (const state of ["revoked", "expired", "rate_limited"] as const) {
            expect(mod?.isLocalServicePublicExposureAccessible({
                exposure: {
                    exposureId: `public_preview_${state}`,
                    previewId: "preview_1",
                    sessionId: "session_1",
                    machineId: "machine_1",
                    mode: "secret_link",
                    state,
                    publicUrl: "https://preview.example.test/s/public_preview_1",
                    issuedAt: 1_000,
                    expiresAt: 31_000,
                    auditEventIds: [],
                    rateLimitProfileId: "default",
                },
                nowMs: 2_000,
            })).toBe(false);
        }

        expect(mod?.isLocalServicePublicExposureAccessible({
            exposure: {
                exposureId: "public_preview_revoked_at",
                previewId: "preview_1",
                sessionId: "session_1",
                machineId: "machine_1",
                mode: "secret_link",
                state: "active",
                publicUrl: "https://preview.example.test/s/public_preview_1",
                issuedAt: 1_000,
                expiresAt: 31_000,
                revokedAt: 1_500,
                auditEventIds: [],
                rateLimitProfileId: "default",
            },
            nowMs: 2_000,
        })).toBe(false);
    });
});
