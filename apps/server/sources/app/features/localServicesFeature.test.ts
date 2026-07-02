import { readServerEnabledBit } from "@happier-dev/protocol";
import { describe, expect, it } from "vitest";

import { resolveServerFeaturePayload } from "./catalog/resolveServerFeaturePayload";
import { serverFeatureRegistry } from "./catalog/serverFeatureRegistry";

describe("local services server feature resolver", () => {
    it("keeps preview and public exposure disabled by default", () => {
        const payload = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "localServices.preview")).toBe(false);
        expect(readServerEnabledBit(payload, "localServices.publicPreview")).toBe(false);
        expect(payload.capabilities.localServices.preview.enabled).toBe(false);
        expect(payload.capabilities.localServices.publicPreview.enabled).toBe(false);
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
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        expect(readServerEnabledBit(payload, "localServices.publicPreview")).toBe(true);
        expect(payload.capabilities.localServices.publicPreview).toMatchObject({
            enabled: true,
            allowedModes: ["secret_link"],
            maxTtlMs: 300_000,
            dnsTlsHostModeAvailable: true,
            auditEnabled: true,
        });
    });
});
