import { readServerEnabledBit } from "@happier-dev/protocol";
import { describe, expect, it } from "vitest";

import { resolveServerFeaturePayload } from "./catalog/resolveServerFeaturePayload";
import { serverFeatureRegistry } from "./catalog/serverFeatureRegistry";

describe("local services server feature resolver", () => {
    it("defaults private preview on while public exposure stays disabled", () => {
        const payload = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "localServices.preview")).toBe(true);
        expect(readServerEnabledBit(payload, "localServices.publicPreview")).toBe(false);
        expect(payload.capabilities.localServices.preview.enabled).toBe(true);
        expect(payload.capabilities.localServices.publicPreview.enabled).toBe(false);
    });

    it("defaults the core local-services product gates to allow so the product is on by default", () => {
        const payload = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "localServices")).toBe(true);
        expect(readServerEnabledBit(payload, "localServices.inventory")).toBe(true);
        expect(readServerEnabledBit(payload, "localServices.managed")).toBe(true);
        expect(readServerEnabledBit(payload, "localServices.actions")).toBe(true);
    });

    it("keeps the destructive terminate action fail-closed by default", () => {
        const payload = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "localServices.actions.terminate")).toBe(false);
        // The rest of the local-services product stays on; only the destructive leaf is opt-in.
        expect(readServerEnabledBit(payload, "localServices.actions")).toBe(true);
    });

    it("enables terminate only when explicitly opted in", () => {
        const payload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_LOCAL_SERVICES_ACTIONS_TERMINATE__ENABLED: "1",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "localServices.actions.terminate")).toBe(true);
    });

    it("keeps the launcher enabled when private preview is explicitly disabled", () => {
        const payload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "0",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "localServices.launcher")).toBe(true);
        expect(readServerEnabledBit(payload, "localServices.preview")).toBe(false);
    });

    it("lets a server disable the whole local-services product for its users", () => {
        const payload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_LOCAL_SERVICES__ENABLED: "0",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "localServices")).toBe(false);
        // Dependency enforcement cascades the parent off-state to the children.
        expect(readServerEnabledBit(payload, "localServices.inventory")).toBe(false);
        expect(readServerEnabledBit(payload, "localServices.managed")).toBe(false);
        expect(readServerEnabledBit(payload, "localServices.actions")).toBe(false);
        expect(readServerEnabledBit(payload, "localServices.actions.terminate")).toBe(false);
    });

    it("lets a server disable just the inventory child while keeping the parent on", () => {
        const payload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_LOCAL_SERVICES_INVENTORY__ENABLED: "0",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "localServices")).toBe(true);
        expect(readServerEnabledBit(payload, "localServices.inventory")).toBe(false);
        // managed/actions depend on inventory and cascade off.
        expect(readServerEnabledBit(payload, "localServices.managed")).toBe(false);
        expect(readServerEnabledBit(payload, "localServices.actions")).toBe(false);
    });

    it("enables private preview without implicitly enabling public exposure", () => {
        const payload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__TOKEN_TTL_MS: "120000",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "localServices.inventory")).toBe(true);
        expect(readServerEnabledBit(payload, "localServices.preview")).toBe(true);
        expect(readServerEnabledBit(payload, "localServices.publicPreview")).toBe(false);
        expect(payload.capabilities.localServices.preview.tokenTtlMs).toBe(120_000);
        expect(payload.capabilities.localServices.publicPreview.enabled).toBe(false);
    });

    it("reports PMS relay and WebSocket preview support only when server-routed tunnels are enabled", () => {
        const disabledTunnelPayload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);
        expect(disabledTunnelPayload.capabilities.localServices.preview).toMatchObject({
            pmsRelayReady: false,
            pmsStreamingReady: false,
            webSocketSupport: false,
        });
        expect(disabledTunnelPayload.capabilities.localServices.preview.disabledReasons).toContain(
            "pms_server_relay_disabled",
        );

        const enabledTunnelPayload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
            HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED: "1",
            HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: "5173",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);
        expect(enabledTunnelPayload.capabilities.localServices.preview).toMatchObject({
            pmsRelayReady: true,
            pmsStreamingReady: true,
            webSocketSupport: true,
            streamingSseSupport: true,
            disabledReasons: [],
        });
    });

    it("enables public exposure only when preview and public exposure are explicitly enabled", () => {
        const payload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: "preview.example.test",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: "1",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: "secret_link",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: "300000",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: "0",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_AUDIT_SINK: "1",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: "default",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: "1",
            HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED: "1",
            HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: "5173",
            HAPPIER_PUBLIC_SERVER_URL: "https://app.example.test",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "localServices.publicPreview")).toBe(true);
        expect(payload.capabilities.localServices.publicPreview).toMatchObject({
            enabled: true,
            allowedModes: ["secret_link"],
            maxTtlMs: 300_000,
            dnsTlsHostModeAvailable: true,
            auditEnabled: true,
            webSocketSupport: true,
            disabledReasons: [],
        });
    });

    it("does not enable public exposure without configured deployment dependencies", () => {
        const payload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: "preview.example.test",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: "1",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: "secret_link",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: "300000",
            HAPPIER_PUBLIC_SERVER_URL: "http://app.example.test",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "localServices.publicPreview")).toBe(false);
        expect(payload.capabilities.localServices.publicPreview).toMatchObject({
            enabled: false,
            dnsTlsHostModeAvailable: false,
            auditEnabled: false,
        });
        expect(payload.capabilities.localServices.publicPreview.disabledReasons).toEqual(expect.arrayContaining([
            "dns_tls_unavailable",
            "audit_sink_unavailable",
        ]));
    });

    it("does not treat local test public audit and rate overrides as production readiness", () => {
        const payload = resolveServerFeaturePayload({
            NODE_ENV: "production",
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: "1",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: "secret_link",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: "300000",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: "0",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_AUDIT_SINK: "1",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: "default",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: "1",
            HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED: "1",
            HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: "5173",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "localServices.publicPreview")).toBe(false);
        expect(payload.capabilities.localServices.publicPreview).toMatchObject({
            enabled: false,
            auditEnabled: false,
            abuseControlsEnabled: false,
        });
        expect(payload.capabilities.localServices.publicPreview.disabledReasons).toEqual(expect.arrayContaining([
            "audit_sink_unavailable",
            "rate_limit_checker_unavailable",
        ]));
    });

    it("does not enable production public exposure without real audit and rate dependencies", () => {
        const payload = resolveServerFeaturePayload({
            NODE_ENV: "production",
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: "preview.example.test",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: "1",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: "secret_link",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: "300000",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: "default",
            HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED: "1",
            HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: "5173",
            HAPPIER_PUBLIC_SERVER_URL: "https://app.example.test",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "localServices.publicPreview")).toBe(false);
        expect(payload.capabilities.localServices.publicPreview).toMatchObject({
            enabled: false,
            auditEnabled: false,
            abuseControlsEnabled: false,
        });
        expect(payload.capabilities.localServices.publicPreview.disabledReasons).toEqual(expect.arrayContaining([
            "audit_sink_unavailable",
            "rate_limit_checker_unavailable",
        ]));
    });

    it("does not let production public exposure bypass DNS/TLS readiness", () => {
        const payload = resolveServerFeaturePayload({
            NODE_ENV: "production",
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: "1",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: "secret_link",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: "300000",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: "0",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_SINK: "jsonl_file",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_LOG_PATH: "/var/log/happier/public-preview-audit.jsonl",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: "default",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_CHECKER: "fixed_window",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_MAX_REQUESTS: "120",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_WINDOW_MS: "60000",
            HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED: "1",
            HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: "5173",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "localServices.publicPreview")).toBe(false);
        expect(payload.capabilities.localServices.publicPreview.disabledReasons).toContain("dns_tls_unavailable");
    });

    it.each([
        {
            name: "audit disabled",
            env: {
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_REQUIRED: "0",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: "default",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: "1",
            },
            reason: "audit_required_disabled",
        },
        {
            name: "maximum TTL missing",
            env: {
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_AUDIT_SINK: "1",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: "default",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: "1",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: undefined,
            },
            reason: "max_ttl_unconfigured",
        },
        {
            name: "rate limit profile missing",
            env: {
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_AUDIT_SINK: "1",
            },
            reason: "rate_limit_profile_unconfigured",
        },
        {
            name: "rate limit checker missing",
            env: {
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_AUDIT_SINK: "1",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: "default",
            },
            reason: "rate_limit_checker_unavailable",
        },
    ])("does not enable public exposure when the public readiness dependency is $name", ({ env, reason }) => {
        const payload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: "1",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: "secret_link",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: "300000",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: "0",
            HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED: "1",
            HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: "5173",
            ...env,
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "localServices.publicPreview")).toBe(false);
        expect(payload.capabilities.localServices.publicPreview).toMatchObject({
            enabled: false,
            webSocketSupport: false,
        });
        expect(payload.capabilities.localServices.publicPreview.disabledReasons).toContain(reason);
    });

    it("enables production self-hosted public exposure with the in-memory limiter when the canonical feature opt-in is enabled", () => {
        const baseEnv = {
            NODE_ENV: "production",
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: "preview.example.test",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: "secret_link",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: "300000",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_SINK: "jsonl_file",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_LOG_PATH: "/var/log/happier/public-preview-audit.jsonl",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: "default",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_CHECKER: "fixed_window",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_MAX_REQUESTS: "120",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_WINDOW_MS: "60000",
            HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED: "1",
            HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: "5173",
            HAPPIER_PUBLIC_SERVER_URL: "https://app.example.test",
        } as const;

        const enabledPayload = resolveServerFeaturePayload({
            ...baseEnv,
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: "1",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(enabledPayload, "localServices.publicPreview")).toBe(true);
        expect(enabledPayload.capabilities.localServices.publicPreview).toMatchObject({
            enabled: true,
            auditEnabled: true,
            abuseControlsEnabled: true,
            disabledReasons: [],
        });

        const disabledPayload = resolveServerFeaturePayload({
            ...baseEnv,
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(disabledPayload, "localServices.publicPreview")).toBe(false);
        expect(disabledPayload.capabilities.localServices.publicPreview).toMatchObject({
            enabled: false,
        });
        expect(disabledPayload.capabilities.localServices.publicPreview.disabledReasons).toEqual([
            "disabled_by_server_policy",
        ]);
    });

    it("keeps production self-hosted public exposure fail-closed when the audit sink is absent", () => {
        const payload = resolveServerFeaturePayload({
            NODE_ENV: "production",
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: "preview.example.test",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: "1",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: "secret_link",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: "300000",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: "default",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_CHECKER: "fixed_window",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_MAX_REQUESTS: "120",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_WINDOW_MS: "60000",
            HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED: "1",
            HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: "5173",
            HAPPIER_PUBLIC_SERVER_URL: "https://app.example.test",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "localServices.publicPreview")).toBe(false);
        expect(payload.capabilities.localServices.publicPreview.disabledReasons).toContain("audit_sink_unavailable");
    });

    it("reports public WebSocket exposure support only when public preview and PMS relay are ready", () => {
        const payload = resolveServerFeaturePayload({
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: "1",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: "secret_link",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: "300000",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: "0",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_AUDIT_SINK: "1",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: "default",
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: "1",
            HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED: "1",
            HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: "5173",
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(payload.capabilities.localServices.preview.webSocketSupport).toBe(true);
        expect(payload.capabilities.localServices.publicPreview).toMatchObject({
            enabled: true,
            webSocketSupport: true,
            disabledReasons: [],
        });
    });
});
