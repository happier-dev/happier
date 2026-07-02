import type { LocalServicePreviewResourceV1 } from "@happier-dev/protocol";
import { describe, expect, it } from "vitest";

type PublicRuntimeModule = typeof import("./runtime");

async function loadPublicRuntimeModule(): Promise<PublicRuntimeModule | null> {
    return import("./runtime.js").catch(() => null) as Promise<PublicRuntimeModule | null>;
}

const preview: LocalServicePreviewResourceV1 = {
    previewId: "preview_1",
    sessionId: "session_1",
    machineId: "machine_1",
    owner: { kind: "session", id: "session_1" },
    target: { scheme: "http", host: "127.0.0.1", port: 5173 },
    initialPath: { pathname: "/", search: "" },
    display: {
        title: "Vite App",
        addressLabel: "127.0.0.1:5173",
    },
    originMode: "path",
};

describe("local service public exposure runtime", () => {
    it("creates a TTL-bound secret-link exposure with an audit event and access token", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            tokenSecret: "public-secret",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 60_000,
                dnsTlsRequired: true,
                auditRequired: true,
                rateLimitProfileIds: ["default"],
            },
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => "audit_create_1",
        });

        const result = runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 120_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        });

        expect(result).toEqual({
            ok: true,
            exposure: {
                exposureId: "public_preview_1",
                previewId: "preview_1",
                sessionId: "session_1",
                machineId: "machine_1",
                mode: "secret_link",
                state: "active",
                publicUrl: "https://preview.happier.test/v1/local-services/public/public_preview_1?publicToken=secret_token_1",
                issuedAt: 1_000,
                expiresAt: 61_000,
                auditEventIds: ["audit_create_1"],
                rateLimitProfileId: "default",
            },
        });
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            authenticated: false,
        })).toEqual({ ok: true, preview });
    });

    it("fails closed by default and does not create exposure state", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            policy: {},
            nowMs: () => 1_000,
        });

        const result = runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        });

        expect(result).toEqual({ ok: false, reasonCode: "public_preview_disabled" });
        expect(runtime.resolveExposure("public_preview_1")).toBeNull();
    });

    it("enforces the configured maximum number of active exposures", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        let exposureIndex = 0;
        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            tokenSecret: "public-secret",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 60_000,
                maxConcurrentExposures: 1,
                dnsTlsRequired: false,
                auditRequired: true,
            },
            nowMs: () => 1_000,
            generateExposureId: () => {
                exposureIndex += 1;
                return `public_preview_${exposureIndex}`;
            },
            generateSecretToken: () => `secret_token_${exposureIndex + 1}`,
            generateAuditEventId: () => `audit_create_${exposureIndex}`,
        });

        expect(runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        }).ok).toBe(true);
        expect(runtime.createExposure({
            preview: {
                ...preview,
                previewId: "preview_2",
            },
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        })).toEqual({ ok: false, reasonCode: "too_many_public_exposures" });
        expect(runtime.resolveExposure("public_preview_2")).toBeNull();
    });

    it("revokes active exposures immediately", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        let now = 1_000;
        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            tokenSecret: "public-secret",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 60_000,
                dnsTlsRequired: false,
                auditRequired: true,
            },
            nowMs: () => now,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => (now === 1_000 ? "audit_create_1" : "audit_revoke_1"),
        });

        expect(runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        }).ok).toBe(true);
        now = 2_000;
        expect(runtime.revokeExposure("public_preview_1", { actorId: "user_1" })).toEqual({ ok: true });
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            authenticated: false,
        })).toEqual({ ok: false, reasonCode: "revoked" });
        expect(runtime.resolveExposure("public_preview_1")).toEqual(expect.objectContaining({
            state: "revoked",
            revokedAt: 2_000,
            auditEventIds: ["audit_create_1", "audit_revoke_1"],
        }));
    });
});
