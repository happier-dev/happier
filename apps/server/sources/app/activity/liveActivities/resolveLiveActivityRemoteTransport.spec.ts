import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadModule() {
    return import("./resolveLiveActivityRemoteTransport").catch(() => null);
}

describe("resolveLiveActivityRemoteTransport", () => {
    it("fails closed for direct APNs until every token-auth credential is configured", async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const resolved = mod.resolveLiveActivityRemoteTransportConfig({
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: "1",
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: "direct_apns",
            HAPPIER_LIVE_ACTIVITY_APNS_TEAM_ID: "TEAMID1234",
            HAPPIER_LIVE_ACTIVITY_APNS_KEY_ID: "KEYID1234",
            HAPPIER_LIVE_ACTIVITY_APNS_BUNDLE_IDS: "dev.happier.custom",
            HAPPIER_LIVE_ACTIVITY_APNS_ENVIRONMENT: "sandbox",
        } as NodeJS.ProcessEnv);

        expect(resolved.modeResolution).toEqual({
            mode: "local_only",
            reason: "preferred_unavailable",
        });
        expect(resolved.capabilityDiagnostics.modes.direct_apns.reasons).toContain("direct_apns_not_configured");
    });

    it("rejects certificate-only APNs material for ActivityKit direct APNs", async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const resolved = mod.resolveLiveActivityRemoteTransportConfig({
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: "1",
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: "direct_apns",
            HAPPIER_LIVE_ACTIVITY_APNS_TEAM_ID: "TEAMID1234",
            HAPPIER_LIVE_ACTIVITY_APNS_KEY_ID: "KEYID1234",
            HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY: "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----",
            HAPPIER_LIVE_ACTIVITY_APNS_BUNDLE_IDS: "dev.happier.custom",
            HAPPIER_LIVE_ACTIVITY_APNS_ENVIRONMENT: "production",
        } as NodeJS.ProcessEnv);

        expect(resolved.directApns.configured).toBe(false);
        expect(resolved.directApns.diagnostics).toContain("apns_private_key_must_be_p8_token_key");
    });

    it("rejects malformed token-auth private keys even when PEM markers are present", async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const resolved = mod.resolveLiveActivityRemoteTransportConfig({
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: "1",
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: "direct_apns",
            HAPPIER_LIVE_ACTIVITY_APNS_TEAM_ID: "TEAMID1234",
            HAPPIER_LIVE_ACTIVITY_APNS_KEY_ID: "KEYID1234",
            HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nnot-a-p8-key\n-----END PRIVATE KEY-----",
            HAPPIER_LIVE_ACTIVITY_APNS_BUNDLE_IDS: "dev.happier.custom",
            HAPPIER_LIVE_ACTIVITY_APNS_ENVIRONMENT: "sandbox",
        } as NodeJS.ProcessEnv);

        expect(resolved.directApns.configured).toBe(false);
        expect(resolved.directApns.diagnostics).toContain("apns_private_key_must_be_p8_token_key");
        expect(resolved.modeResolution).toEqual({
            mode: "local_only",
            reason: "preferred_unavailable",
        });
    });

    it("does not expose advisory hosted relay identity models in the resolved transport config", async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const resolved = mod.resolveLiveActivityRemoteTransportConfig({
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: "1",
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: "hosted_happier_relay",
            HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ALLOWED: "1",
            HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_BASE_URL: "https://relay.happier.dev",
            HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEY: "relay-access-key",
            HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_IDENTITY_MODEL: "app_attest_bound",
        } as NodeJS.ProcessEnv);

        expect(resolved.hostedRelay).not.toHaveProperty("identityModel");
        expect(resolved.modeResolution).toEqual({
            mode: "hosted_happier_relay",
            reason: "selected",
        });
        expect(resolved.capabilityDiagnostics.modes.hosted_happier_relay.available).toBe(true);
        expect(resolved.capabilityDiagnostics.modes.hosted_happier_relay.reasons).not.toContain("hosted_relay_identity_model_undecided");
    });

    it("selects hosted relay when the selected-server update-token relay is configured", async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const resolved = mod.resolveLiveActivityRemoteTransportConfig({
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: "1",
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: "hosted_happier_relay",
            HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ALLOWED: "1",
            HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_BASE_URL: "https://relay.happier.dev",
            HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEY: "relay-access-key",
        } as NodeJS.ProcessEnv);

        expect(resolved.modeResolution).toEqual({
            mode: "hosted_happier_relay",
            reason: "selected",
        });
        expect(resolved.capabilityDiagnostics.modes.hosted_happier_relay.available).toBe(true);
        expect(resolved.hostedRelay.providerImplemented).toBe(true);
    });

    it("falls back explicitly when hosted relay access credentials are missing", async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const resolved = mod.resolveLiveActivityRemoteTransportConfig({
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: "1",
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: "hosted_happier_relay",
            HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ALLOWED: "1",
            HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_BASE_URL: "https://relay.happier.dev",
            HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_ENABLED: "1",
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_ALLOW_FALLBACK: "1",
        } as NodeJS.ProcessEnv);

        expect(resolved.hostedRelay.capabilityAvailable).toBe(false);
        expect(resolved.capabilityDiagnostics.modes.hosted_happier_relay).toMatchObject({
            available: false,
            reasons: ["hosted_relay_capability_missing"],
        });
        expect(resolved.modeResolution).toEqual({
            mode: "background_wake_best_effort",
            reason: "fallback",
        });
    });

    it("ignores removed live-activity settings-file overrides when env allows hosted relay", async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const dir = mkdtempSync(join(tmpdir(), "happier-live-activity-admin-settings-"));
        const settingsPath = join(dir, "live-activity-remote-updates.json");
        writeFileSync(settingsPath, JSON.stringify({
            schemaVersion: 1,
            hostedRelayAllowed: false,
        }), "utf8");

        try {
            const resolved = mod.resolveLiveActivityRemoteTransportConfig({
                HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: "1",
                HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: "hosted_happier_relay",
                HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ALLOWED: "1",
                HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_BASE_URL: "https://relay.happier.dev",
                HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEY: "relay-access-key",
                HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_SETTINGS_FILE: settingsPath,
            } as NodeJS.ProcessEnv);

            expect(resolved.hostedRelay.allowed).toBe(true);
            expect(resolved.modeResolution).toEqual({
                mode: "hosted_happier_relay",
                reason: "selected",
            });
            expect(resolved.capabilityDiagnostics.modes.hosted_happier_relay.reasons)
                .not.toContain("hosted_relay_not_allowed");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("does not enable fallback or background wake from removed live-activity settings files", async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const dir = mkdtempSync(join(tmpdir(), "happier-live-activity-admin-fallback-"));
        const settingsPath = join(dir, "live-activity-remote-updates.json");
        writeFileSync(settingsPath, JSON.stringify({
            schemaVersion: 1,
            hostedRelayAllowed: false,
            backgroundWakeEnabled: true,
            allowFallback: true,
        }), "utf8");

        try {
            const resolved = mod.resolveLiveActivityRemoteTransportConfig({
                HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: "1",
                HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: "hosted_happier_relay",
                HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ALLOWED: "1",
                HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_BASE_URL: "https://relay.happier.dev",
                HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEY: "relay-access-key",
                HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_ENABLED: "0",
                HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_ALLOW_FALLBACK: "0",
                HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_SETTINGS_FILE: settingsPath,
            } as NodeJS.ProcessEnv);

            expect(resolved.backgroundWake.enabled).toBe(false);
            expect(resolved.modeResolution).toEqual({
                mode: "hosted_happier_relay",
                reason: "selected",
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
