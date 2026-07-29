import type { LocalServicePreviewResourceV1 } from "@happier-dev/protocol";
import { describe, expect, it } from "vitest";

import { createLocalServicePublicRuntime } from "./runtime";

const publicRuntimeModule = { createLocalServicePublicRuntime };

async function loadPublicRuntimeModule(): Promise<typeof publicRuntimeModule> {
    return publicRuntimeModule;
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
            allowTestDevAuditSink: true,
            recordAuditEvent: () => undefined,
            checkRateLimit: () => true,
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
        })).toEqual({ ok: false, reasonCode: "public_token_exchange_required" });

        expect(runtime.exchangeAccessToken({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
        })).toEqual({
            ok: true,
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            expiresAt: 61_000,
        });
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            authenticated: false,
        })).toEqual({ ok: true, preview });
    });

    it("returns a scoped public preview snapshot without leaking public tokens", async () => {
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
            allowTestDevAuditSink: true,
            recordAuditEvent: () => undefined,
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
        }).ok).toBe(true);

        const snapshot = runtime.getSnapshot({
            machineId: "machine_1",
            sessionId: "session_1",
            previewId: "preview_1",
        });

        expect(snapshot).toEqual({
            v: 1,
            machineId: "machine_1",
            sessionId: "session_1",
            previewId: "preview_1",
            generatedAt: 1_000,
            refreshState: "idle",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 60_000,
                dnsTlsRequired: false,
                auditRequired: true,
                rateLimitProfileIds: [],
            },
            exposures: [
                expect.objectContaining({
                    exposureId: "public_preview_1",
                    previewId: "preview_1",
                    publicUrl: "https://preview.happier.test/v1/local-services/public/public_preview_1?publicToken=secret_token_1",
                }),
            ],
            diagnostics: [],
        });
        expect(JSON.stringify(snapshot)).not.toContain("secret_token_2");
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

    it("fails closed when policy requires audit but no audit sink is available", async () => {
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
                dnsTlsRequired: false,
                auditRequired: true,
            },
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
        });

        expect(runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        })).toEqual({ ok: false, reasonCode: "audit_sink_unavailable" });
        expect(runtime.resolveExposure("public_preview_1")).toBeNull();
    });

    it("fails closed when policy requires audit but the sink is not durable or explicitly test/dev", async () => {
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
                dnsTlsRequired: false,
                auditRequired: true,
            },
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            recordAuditEvent: () => undefined,
        });

        expect(runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        })).toEqual({ ok: false, reasonCode: "audit_sink_unavailable" });
        expect(runtime.resolveExposure("public_preview_1")).toBeNull();
    });

    it("fails closed when a rate-limit profile is advertised but no checker is available", async () => {
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
                dnsTlsRequired: false,
                auditRequired: true,
                rateLimitProfileIds: ["default"],
            },
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => "audit_create_1",
            allowTestDevAuditSink: true,
            recordAuditEvent: () => undefined,
        });

        expect(runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        })).toEqual({ ok: false, reasonCode: "rate_limit_checker_unavailable" });
        expect(runtime.resolveExposure("public_preview_1")).toBeNull();
    });

    it("fails closed on access when the durable audit sink rejects the access audit write", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        let auditWrites = 0;
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
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => auditWrites === 0 ? "audit_create_1" : "audit_access_1",
            auditSinkDurable: true,
            recordAuditEvent: () => {
                auditWrites += 1;
                if (auditWrites > 1) {
                    throw new Error("durable audit unavailable");
                }
            },
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
        expect(runtime.exchangeAccessToken({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
        }).ok).toBe(true);

        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            authenticated: false,
        })).toEqual({ ok: false, reasonCode: "audit_sink_unavailable" });
        expect(runtime.resolveExposure("public_preview_1")).toEqual(expect.objectContaining({
            auditEventIds: ["audit_create_1"],
        }));
    });

    it("fails closed without revoking when the durable audit sink rejects the revoke audit write", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        let auditWrites = 0;
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
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => auditWrites === 0 ? "audit_create_1" : "audit_revoke_1",
            auditSinkDurable: true,
            recordAuditEvent: () => {
                auditWrites += 1;
                if (auditWrites > 1) {
                    throw new Error("durable audit unavailable");
                }
            },
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

        expect(runtime.revokeExposure("public_preview_1", { actorId: "user_1" })).toEqual({
            ok: false,
            reasonCode: "audit_sink_unavailable",
        });
        expect(runtime.resolveExposure("public_preview_1")).toEqual(expect.objectContaining({
            state: "active",
            auditEventIds: ["audit_create_1"],
        }));
    });

    it("fails closed on access when the configured rate-limit checker is unavailable", async () => {
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
                dnsTlsRequired: false,
                auditRequired: true,
                rateLimitProfileIds: ["default"],
            },
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => "audit_create_1",
            auditSinkDurable: true,
            recordAuditEvent: () => undefined,
            checkRateLimit: () => {
                throw new Error("rate checker unavailable");
            },
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
        expect(runtime.exchangeAccessToken({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
        }).ok).toBe(true);

        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            authenticated: false,
        })).toEqual({ ok: false, reasonCode: "rate_limit_checker_unavailable" });
    });

    it("validates secret-link tokens before applying rate-limit state changes", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        const auditEvents: unknown[] = [];
        let rateLimitChecks = 0;
        const auditIds = ["audit_create_1", "audit_denied_1", "audit_rate_limit_1", "audit_denied_2"];
        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            tokenSecret: "public-secret",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 60_000,
                dnsTlsRequired: false,
                auditRequired: true,
                rateLimitProfileIds: ["default"],
            },
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => auditIds.shift() ?? "audit_extra",
            allowTestDevAuditSink: true,
            recordAuditEvent: (event) => auditEvents.push(event),
            checkRateLimit: () => {
                rateLimitChecks += 1;
                return false;
            },
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
        expect(runtime.exchangeAccessToken({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
        }).ok).toBe(true);

        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "wrong_token",
            authenticated: false,
        })).toEqual({ ok: false, reasonCode: "public_token_mismatch" });
        expect(rateLimitChecks).toBe(0);
        expect(runtime.resolveExposure("public_preview_1")).toEqual(expect.objectContaining({
            state: "active",
        }));

        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            authenticated: false,
        })).toEqual({ ok: false, reasonCode: "rate_limited" });
        expect(rateLimitChecks).toBe(1);
        expect(runtime.resolveExposure("public_preview_1")).toEqual(expect.objectContaining({
            state: "rate_limited",
        }));
        expect(auditEvents).toEqual([
            expect.objectContaining({ eventId: "audit_create_1", action: "create" }),
            expect.objectContaining({
                eventId: "audit_denied_1",
                action: "access_denied",
                reasonCode: "public_token_mismatch",
            }),
            expect.objectContaining({ eventId: "audit_rate_limit_1", action: "rate_limit" }),
            expect.objectContaining({
                eventId: "audit_denied_2",
                action: "access_denied",
                reasonCode: "rate_limited",
            }),
        ]);
    });

    it("exchanges a secret-link URL token once and rejects the consumed original token", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        const secretTokens = ["secret_token_1", "secret_token_2"];
        let rateLimitChecks = 0;
        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            tokenSecret: "public-secret",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 60_000,
                dnsTlsRequired: false,
                auditRequired: true,
                rateLimitProfileIds: ["default"],
            },
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => secretTokens.shift() ?? "secret_token_extra",
            generateAuditEventId: () => "audit_create_1",
            allowTestDevAuditSink: true,
            recordAuditEvent: () => undefined,
            checkRateLimit: () => {
                rateLimitChecks += 1;
                return true;
            },
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

        const exchange = runtime.exchangeAccessToken({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
        });
        expect(exchange).toEqual({
            ok: true,
            exposureId: "public_preview_1",
            rawToken: "secret_token_2",
            expiresAt: 61_000,
        });
        // The exchange consumes/rotates the URL token without consulting the rate-limit checker.
        expect(rateLimitChecks).toBe(0);

        // The original URL token is consumed and no longer validates.
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            authenticated: false,
        })).toEqual({ ok: false, reasonCode: "public_token_mismatch" });
        // Token validation precedes the rate-limit check (checker still not consulted on rejection).
        expect(rateLimitChecks).toBe(0);

        // The rotated follow-up token validates and only then is the rate-limit checker consulted.
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_2",
            authenticated: false,
        })).toEqual({ ok: true, preview });
        expect(rateLimitChecks).toBe(1);
    });

    it("rejects exchanging an unknown exposure or a mismatched token", async () => {
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
                dnsTlsRequired: false,
                auditRequired: true,
            },
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => "audit_create_1",
            allowTestDevAuditSink: true,
            recordAuditEvent: () => undefined,
        });

        expect(runtime.exchangeAccessToken({
            exposureId: "missing_exposure",
            rawToken: "secret_token_1",
        })).toEqual({ ok: false, reasonCode: "exposure_not_found" });

        expect(runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        }).ok).toBe(true);

        expect(runtime.exchangeAccessToken({
            exposureId: "public_preview_1",
            rawToken: "wrong_token",
        })).toEqual({ ok: false, reasonCode: "public_token_mismatch" });

        // The original URL token still cannot be used as a proxy credential after a failed exchange.
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            authenticated: false,
        })).toEqual({ ok: false, reasonCode: "public_token_exchange_required" });
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
            allowTestDevAuditSink: true,
            recordAuditEvent: () => undefined,
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
        const auditEvents: unknown[] = [];
        const auditIds = ["audit_create_1", "audit_revoke_1", "audit_denied_1"];
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
            generateAuditEventId: () => auditIds.shift() ?? "audit_extra",
            allowTestDevAuditSink: true,
            recordAuditEvent: (event) => auditEvents.push(event),
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
        expect(auditEvents).toEqual([
            expect.objectContaining({ eventId: "audit_create_1", action: "create" }),
            expect.objectContaining({ eventId: "audit_revoke_1", action: "revoke" }),
            expect.objectContaining({
                eventId: "audit_denied_1",
                action: "access_denied",
                reasonCode: "revoked",
            }),
        ]);
        expect(runtime.resolveExposure("public_preview_1")).toEqual(expect.objectContaining({
            state: "revoked",
            revokedAt: 2_000,
            auditEventIds: ["audit_create_1", "audit_revoke_1", "audit_denied_1"],
        }));
    });

    it("records successful and denied access audit events without storing raw public tokens", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        const auditEvents: unknown[] = [];
        const auditIds = ["audit_create_1", "audit_access_1", "audit_denied_1"];
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
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => auditIds.shift() ?? "audit_extra",
            allowTestDevAuditSink: true,
            recordAuditEvent: (event) => auditEvents.push(event),
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
        expect(runtime.exchangeAccessToken({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
        }).ok).toBe(true);

        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            authenticated: false,
        })).toEqual({ ok: true, preview });
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "wrong_token",
            authenticated: false,
        })).toEqual({ ok: false, reasonCode: "public_token_mismatch" });

        expect(auditEvents).toEqual([
            expect.objectContaining({ eventId: "audit_create_1", action: "create" }),
            expect.objectContaining({ eventId: "audit_access_1", action: "access" }),
            expect.objectContaining({
                eventId: "audit_denied_1",
                action: "access_denied",
                reasonCode: "public_token_mismatch",
            }),
        ]);
        expect(runtime.resolveExposure("public_preview_1")).toEqual(expect.objectContaining({
            auditEventIds: ["audit_create_1", "audit_access_1", "audit_denied_1"],
        }));
        expect(JSON.stringify(auditEvents)).not.toContain("secret_token_1");
        expect(JSON.stringify(auditEvents)).not.toContain("wrong_token");
    });

    it("revalidates the underlying preview mapping before allowing continued public access", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        const auditEvents: unknown[] = [];
        const auditIds = ["audit_create_1", "audit_denied_1", "audit_denied_2"];
        let resolvedPreview: LocalServicePreviewResourceV1 | null = preview;
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
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => auditIds.shift() ?? "audit_extra",
            allowTestDevAuditSink: true,
            recordAuditEvent: (event) => auditEvents.push(event),
            resolvePreview: () => resolvedPreview,
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
        expect(runtime.exchangeAccessToken({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
        }).ok).toBe(true);

        resolvedPreview = null;
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            authenticated: false,
        })).toEqual({ ok: false, reasonCode: "preview_not_found" });

        resolvedPreview = {
            ...preview,
            machineId: "machine_2",
        };
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            authenticated: false,
        })).toEqual({ ok: false, reasonCode: "preview_mismatch" });

        expect(auditEvents).toEqual([
            expect.objectContaining({ eventId: "audit_create_1", action: "create" }),
            expect.objectContaining({
                eventId: "audit_denied_1",
                action: "access_denied",
                reasonCode: "preview_not_found",
            }),
            expect.objectContaining({
                eventId: "audit_denied_2",
                action: "access_denied",
                reasonCode: "preview_mismatch",
            }),
        ]);
    });

    it("marks an active exposure expired and records every expired access denial", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        let now = 1_000;
        const auditEvents: unknown[] = [];
        const auditIds = ["audit_create_1", "audit_expire_1", "audit_denied_1", "audit_denied_2"];
        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            tokenSecret: "public-secret",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 1_000,
                dnsTlsRequired: false,
                auditRequired: true,
            },
            nowMs: () => now,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => auditIds.shift() ?? "audit_extra",
            allowTestDevAuditSink: true,
            recordAuditEvent: (event) => auditEvents.push(event),
        });

        expect(runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 1_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        }).ok).toBe(true);

        now = 2_000;
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            authenticated: false,
        })).toEqual({ ok: false, reasonCode: "expired" });
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            authenticated: false,
        })).toEqual({ ok: false, reasonCode: "expired" });

        expect(auditEvents).toEqual([
            expect.objectContaining({ eventId: "audit_create_1", action: "create" }),
            expect.objectContaining({ eventId: "audit_expire_1", action: "expire" }),
            expect.objectContaining({
                eventId: "audit_denied_1",
                action: "access_denied",
                reasonCode: "expired",
            }),
            expect.objectContaining({
                eventId: "audit_denied_2",
                action: "access_denied",
                reasonCode: "expired",
            }),
        ]);
        expect(runtime.resolveExposure("public_preview_1")).toEqual(expect.objectContaining({
            state: "expired",
            auditEventIds: ["audit_create_1", "audit_expire_1", "audit_denied_1", "audit_denied_2"],
        }));
    });

    it("emits a rate-limit audit event and records every rate-limited access denial", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        const auditEvents: unknown[] = [];
        const auditIds = ["audit_create_1", "audit_rate_limit_1", "audit_denied_1", "audit_denied_2"];
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
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => auditIds.shift() ?? "audit_extra",
            allowTestDevAuditSink: true,
            recordAuditEvent: (event) => auditEvents.push(event),
            checkRateLimit: () => false,
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
        expect(runtime.exchangeAccessToken({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
        }).ok).toBe(true);

        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            authenticated: false,
        })).toEqual({ ok: false, reasonCode: "rate_limited" });
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            authenticated: false,
        })).toEqual({ ok: false, reasonCode: "rate_limited" });

        expect(auditEvents).toEqual([
            expect.objectContaining({ eventId: "audit_create_1", action: "create" }),
            expect.objectContaining({ eventId: "audit_rate_limit_1", action: "rate_limit" }),
            expect.objectContaining({
                eventId: "audit_denied_1",
                action: "access_denied",
                reasonCode: "rate_limited",
            }),
            expect.objectContaining({
                eventId: "audit_denied_2",
                action: "access_denied",
                reasonCode: "rate_limited",
            }),
        ]);
        expect(runtime.resolveExposure("public_preview_1")).toEqual(expect.objectContaining({
            state: "rate_limited",
            auditEventIds: ["audit_create_1", "audit_rate_limit_1", "audit_denied_1", "audit_denied_2"],
        }));
    });

    it("bounds exposure audit event ids while recording every audit event", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        let auditIndex = 0;
        const auditEvents: unknown[] = [];
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
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => {
                auditIndex += 1;
                return `audit_${auditIndex}`;
            },
            allowTestDevAuditSink: true,
            recordAuditEvent: (event) => auditEvents.push(event),
            maxExposureAuditEventIds: 2,
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
        expect(runtime.exchangeAccessToken({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
        }).ok).toBe(true);
        for (let index = 0; index < 3; index += 1) {
            expect(runtime.validateAccess({
                exposureId: "public_preview_1",
                rawToken: "secret_token_1",
                authenticated: false,
            }).ok).toBe(true);
        }

        expect(auditEvents).toHaveLength(4);
        expect(runtime.resolveExposure("public_preview_1")).toEqual(expect.objectContaining({
            auditEventIds: ["audit_3", "audit_4"],
        }));
    });
});
