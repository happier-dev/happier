import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { restoreEnv, snapshotEnv } from "../../testkit/env";
import { createFakeRouteApp, createReplyStub, getRouteHandler } from "../../testkit/routeHarness";

const ENV_SNAPSHOT = snapshotEnv();

async function getFeaturesPayload() {
    const { featuresRoutes } = await import("./featuresRoutes");
    const app = createFakeRouteApp();
    featuresRoutes(app as any);

    const handler = getRouteHandler(app, "GET", "/v1/features");
    const reply = createReplyStub();
    const response = await handler({}, reply);
    return response as any;
}

describe("featuresRoutes", () => {
    beforeEach(() => {
        vi.resetModules();
        restoreEnv(ENV_SNAPSHOT);
    });

    afterEach(() => {
        restoreEnv(ENV_SNAPSHOT);
    });

    describe("friends", () => {
        it("returns friends=false when HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED is off", async () => {
            process.env.HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED = "0";
            process.env.GITHUB_CLIENT_ID = "id";
            process.env.GITHUB_CLIENT_SECRET = "secret";
            process.env.GITHUB_REDIRECT_URL = "https://example.com/v1/oauth/github/callback";

            const payload = await getFeaturesPayload();
            expect(payload.features.social.friends.enabled).toBe(false);
        });

        it("returns friends=true and allowUsername=true when HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME is on", async () => {
            process.env.HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED = "1";
            process.env.HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME = "1";
            delete process.env.GITHUB_CLIENT_ID;
            delete process.env.GITHUB_CLIENT_SECRET;
            delete process.env.GITHUB_REDIRECT_URL;
            delete process.env.GITHUB_REDIRECT_URI;

            const payload = await getFeaturesPayload();
            expect(payload.features.social.friends.enabled).toBe(true);
            expect(payload.features.social.friends.allowUsername).toBe(true);
            expect(payload.features.social.friends.requiredIdentityProviderId).toBeNull();
        });

        it("returns friends=false when identity provider is required but OAuth provider is not configured", async () => {
            process.env.HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED = "1";
            process.env.HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME = "0";
            delete process.env.GITHUB_CLIENT_ID;
            delete process.env.GITHUB_CLIENT_SECRET;
            delete process.env.GITHUB_REDIRECT_URL;
            delete process.env.GITHUB_REDIRECT_URI;

            const payload = await getFeaturesPayload();
            expect(payload.features.social.friends.enabled).toBe(false);
            expect(payload.features.social.friends.allowUsername).toBe(false);
            expect(payload.features.social.friends.requiredIdentityProviderId).toBe("github");
        });
    });

    describe("voice", () => {
        it("returns voice=false when ElevenLabs is not configured", async () => {
            process.env.NODE_ENV = "production";
            process.env.HAPPIER_FEATURE_VOICE__ENABLED = "1";
            delete process.env.ELEVENLABS_API_KEY;
            delete process.env.ELEVENLABS_AGENT_ID_PROD;

            const payload = await getFeaturesPayload();
            expect(payload.features.voice.enabled).toBe(false);
            expect(payload.features.voice.configured).toBe(false);
            expect(payload.features.voice.provider).toBe(null);
        });

        it("returns voice=true when voice is enabled and ElevenLabs is configured", async () => {
            process.env.NODE_ENV = "production";
            process.env.HAPPIER_FEATURE_VOICE__ENABLED = "1";
            process.env.ELEVENLABS_API_KEY = "el_key";
            process.env.ELEVENLABS_AGENT_ID_PROD = "agent_1";
            process.env.REVENUECAT_SECRET_KEY = "rc_secret";

            const payload = await getFeaturesPayload();
            expect(payload.features.voice.enabled).toBe(true);
            expect(payload.features.voice.configured).toBe(true);
            expect(payload.features.voice.provider).toBe("elevenlabs");
        });

        it("returns voice=false when subscription is required and RevenueCat is not configured", async () => {
            process.env.NODE_ENV = "production";
            process.env.HAPPIER_FEATURE_VOICE__ENABLED = "1";
            process.env.ELEVENLABS_API_KEY = "el_key";
            process.env.ELEVENLABS_AGENT_ID_PROD = "agent_1";
            delete process.env.HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION;
            delete process.env.REVENUECAT_SECRET_KEY;

            const payload = await getFeaturesPayload();
            expect(payload.features.voice.enabled).toBe(false);
            expect(payload.features.voice.configured).toBe(false);
            expect(payload.features.voice.provider).toBe(null);
        });

        it("returns voice=true when subscription is not required even without RevenueCat", async () => {
            process.env.NODE_ENV = "production";
            process.env.HAPPIER_FEATURE_VOICE__ENABLED = "1";
            process.env.ELEVENLABS_API_KEY = "el_key";
            process.env.ELEVENLABS_AGENT_ID_PROD = "agent_1";
            process.env.HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION = "0";
            delete process.env.REVENUECAT_SECRET_KEY;

            const payload = await getFeaturesPayload();
            expect(payload.features.voice.enabled).toBe(true);
            expect(payload.features.voice.configured).toBe(true);
            expect(payload.features.voice.provider).toBe("elevenlabs");
        });
    });

    describe("oauth providers", () => {
        it("marks github as configured=false when GitHub env is missing", async () => {
            delete process.env.GITHUB_CLIENT_ID;
            delete process.env.GITHUB_CLIENT_SECRET;
            delete process.env.GITHUB_REDIRECT_URL;
            delete process.env.GITHUB_REDIRECT_URI;

            const payload = await getFeaturesPayload();
            expect(payload.features.oauth.providers.github.enabled).toBe(true);
            expect(payload.features.oauth.providers.github.configured).toBe(false);
        });

        it("marks github as configured=true when GitHub env is configured", async () => {
            process.env.GITHUB_CLIENT_ID = "client_id";
            process.env.GITHUB_CLIENT_SECRET = "client_secret";
            process.env.GITHUB_REDIRECT_URL = "https://example.com/v1/oauth/github/callback";

            const payload = await getFeaturesPayload();
            expect(payload.features.oauth.providers.github.enabled).toBe(true);
            expect(payload.features.oauth.providers.github.configured).toBe(true);
        });

        it("includes configured OIDC providers from AUTH_PROVIDERS_CONFIG_JSON", async () => {
            process.env.AUTH_PROVIDERS_CONFIG_JSON = JSON.stringify([
                {
                    id: "Okta",
                    type: "oidc",
                    displayName: "Acme Okta",
                    issuer: "https://issuer.example.test",
                    clientId: "cid",
                    clientSecret: "secret",
                    redirectUrl: "https://api.example.test/v1/oauth/okta/callback",
                },
            ]);

            const payload = await getFeaturesPayload();
            expect(payload.features.oauth.providers.okta).toEqual(
                expect.objectContaining({
                    enabled: true,
                    configured: true,
                }),
            );
        });
    });

    describe("auth recovery + ui", () => {
        it("exposes provider reset as enabled when configured", async () => {
            process.env.AUTH_ANONYMOUS_SIGNUP_ENABLED = "0";
            process.env.AUTH_SIGNUP_PROVIDERS = "github";
            process.env.HAPPIER_FEATURE_AUTH_RECOVERY__PROVIDER_RESET_ENABLED = "1";
            process.env.GITHUB_CLIENT_ID = "id";
            process.env.GITHUB_CLIENT_SECRET = "secret";
            process.env.GITHUB_REDIRECT_URL = "https://example.com/oauth/github/callback";

            const payload = await getFeaturesPayload();
            expect(payload.features.auth.recovery.providerReset.enabled).toBe(true);
            expect(payload.features.auth.recovery.providerReset.providers).toContain("github");
        });

        it("exposes provider reset as disabled when HAPPIER_FEATURE_AUTH_RECOVERY__PROVIDER_RESET_ENABLED=0", async () => {
            process.env.AUTH_ANONYMOUS_SIGNUP_ENABLED = "0";
            process.env.AUTH_SIGNUP_PROVIDERS = "github";
            process.env.HAPPIER_FEATURE_AUTH_RECOVERY__PROVIDER_RESET_ENABLED = "0";
            process.env.GITHUB_CLIENT_ID = "id";
            process.env.GITHUB_CLIENT_SECRET = "secret";
            process.env.GITHUB_REDIRECT_URL = "https://example.com/oauth/github/callback";

            const payload = await getFeaturesPayload();
            expect(payload.features.auth.recovery.providerReset.enabled).toBe(false);
            expect(payload.features.auth.recovery.providerReset.providers).toEqual([]);
        });

        it("defaults recovery key reminder UI flag to enabled", async () => {
            const payload = await getFeaturesPayload();
            expect(payload.features.auth.ui.recoveryKeyReminder.enabled).toBe(true);
        });

        it("allows disabling recovery key reminder UI via HAPPIER_FEATURE_AUTH_UI__RECOVERY_KEY_REMINDER_ENABLED=0", async () => {
            process.env.HAPPIER_FEATURE_AUTH_UI__RECOVERY_KEY_REMINDER_ENABLED = "0";

            const payload = await getFeaturesPayload();
            expect(payload.features.auth.ui.recoveryKeyReminder.enabled).toBe(false);
        });
    });

    describe("auth misconfiguration", () => {
        it("surfaces misconfig when AUTH_PROVIDERS_CONFIG_JSON is invalid", async () => {
            process.env.AUTH_PROVIDERS_CONFIG_JSON = "{ definitely: not-json }";

            const payload = await getFeaturesPayload();
            expect(payload.features.auth.misconfig).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        code: "auth_providers_config_invalid",
                        kind: "auth-providers-config",
                        envVars: expect.arrayContaining(["AUTH_PROVIDERS_CONFIG_JSON"]),
                    }),
                ]),
            );
        });

        it("surfaces misconfig when required login providers reference unregistered provider", async () => {
            process.env.AUTH_REQUIRED_LOGIN_PROVIDERS = "okta";

            const payload = await getFeaturesPayload();
            expect(payload.features.auth.login.requiredProviders).toEqual(["okta"]);
            expect(payload.features.auth.misconfig).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        code: "auth_provider_unregistered_okta",
                        kind: "auth-provider-unregistered",
                        providerId: "okta",
                        envVars: expect.arrayContaining(["AUTH_PROVIDERS_CONFIG_PATH", "AUTH_PROVIDERS_CONFIG_JSON"]),
                    }),
                ]),
            );
        });
    });

    describe("bug reports", () => {
        it("returns bug report capability enabled by default", async () => {
            delete process.env.HAPPIER_FEATURE_BUG_REPORTS__ENABLED;
            delete process.env.HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL;
            delete process.env.HAPPIER_FEATURE_BUG_REPORTS__DEFAULT_INCLUDE_DIAGNOSTICS;

            const payload = await getFeaturesPayload();
            expect(payload.features.bugReports.enabled).toBe(true);
            expect(payload.features.bugReports.providerUrl).toBe("https://reports.happier.dev");
            expect(payload.features.bugReports.defaultIncludeDiagnostics).toBe(true);
            expect(payload.features.bugReports.contextWindowMs).toBe(30 * 60 * 1000);
        });

        it("allows disabling bug report capability via env", async () => {
            process.env.HAPPIER_FEATURE_BUG_REPORTS__ENABLED = "0";
            process.env.HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL = "https://reports.enterprise.local";
            process.env.HAPPIER_FEATURE_BUG_REPORTS__DEFAULT_INCLUDE_DIAGNOSTICS = "0";
            process.env.HAPPIER_FEATURE_BUG_REPORTS__CONTEXT_WINDOW_MS = "60000";

            const payload = await getFeaturesPayload();
            expect(payload.features.bugReports.enabled).toBe(false);
            expect(payload.features.bugReports.providerUrl).toBe("https://reports.enterprise.local");
            expect(payload.features.bugReports.defaultIncludeDiagnostics).toBe(false);
            expect(payload.features.bugReports.contextWindowMs).toBe(60000);
        });

        it("does not fail open when provider url env is invalid", async () => {
            process.env.HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL = "invalid-provider-url";

            const payload = await getFeaturesPayload();
            expect(payload.features.bugReports.enabled).toBe(true);
            expect(payload.features.bugReports.providerUrl).toBeNull();
        });
    });

    describe("automations", () => {
        it("returns automations enabled by default and existing-session target disabled", async () => {
            delete process.env.HAPPIER_FEATURE_AUTOMATIONS__ENABLED;
            delete process.env.HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET;

            const payload = await getFeaturesPayload();
            expect(payload.features.automations.enabled).toBe(true);
            expect(payload.features.automations.existingSessionTarget).toBe(false);
        });

        it("allows disabling automations and enabling existing-session target via env", async () => {
            process.env.HAPPIER_FEATURE_AUTOMATIONS__ENABLED = "0";
            process.env.HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET = "1";

            const payload = await getFeaturesPayload();
            expect(payload.features.automations.enabled).toBe(false);
            expect(payload.features.automations.existingSessionTarget).toBe(true);
        });
    });
});
