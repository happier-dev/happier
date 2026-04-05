import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEnvReset } from "../../testkit/env";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const resetEnv = createEnvReset();

const LegacyPreviewFeaturesResponseSchema = z.object({
    features: z.object({
        bugReports: z.object({
            enabled: z.boolean(),
            providerUrl: z.string().url().nullable(),
            defaultIncludeDiagnostics: z.boolean(),
            maxArtifactBytes: z.number().int().positive(),
            acceptedArtifactKinds: z.array(z.string().min(1)).min(1),
            uploadTimeoutMs: z.number().int().positive(),
            contextWindowMs: z.number().int().min(1000),
        }),
        automations: z.object({
            enabled: z.boolean(),
            existingSessionTarget: z.boolean(),
        }),
        sharing: z.object({
            session: z.object({ enabled: z.boolean() }),
            public: z.object({ enabled: z.boolean() }),
            contentKeys: z.object({ enabled: z.boolean() }),
            pendingQueueV2: z.object({ enabled: z.boolean() }),
        }),
        voice: z.object({
            enabled: z.boolean(),
            configured: z.boolean(),
            provider: z.enum(["elevenlabs"]).nullable(),
        }),
        social: z.object({
            friends: z.object({
                enabled: z.boolean(),
                allowUsername: z.boolean(),
                requiredIdentityProviderId: z.string().nullable(),
            }),
        }),
        oauth: z.object({
            providers: z.record(z.string(), z.object({ enabled: z.boolean(), configured: z.boolean() })),
        }),
        auth: z.object({
            signup: z.object({
                methods: z.array(z.object({ id: z.string(), enabled: z.boolean() })),
            }),
            login: z.object({
                requiredProviders: z.array(z.string()),
            }),
            recovery: z.object({
                providerReset: z.object({
                    enabled: z.boolean(),
                    providers: z.array(z.string()),
                }),
            }),
            ui: z.object({
                autoRedirect: z.object({
                    enabled: z.boolean(),
                    providerId: z.string().nullable(),
                }),
                recoveryKeyReminder: z.object({
                    enabled: z.boolean(),
                }),
            }),
            providers: z.record(
                z.string(),
                z.object({
                    enabled: z.boolean(),
                    configured: z.boolean(),
                    ui: z
                        .object({
                            displayName: z.string(),
                            iconHint: z.string().nullable().optional(),
                            connectButtonColor: z.string().nullable().optional(),
                            supportsProfileBadge: z.boolean().optional(),
                            badgeIconName: z.string().nullable().optional(),
                        })
                        .optional(),
                    restrictions: z.object({
                        usersAllowlist: z.boolean(),
                        orgsAllowlist: z.boolean(),
                        orgMatch: z.enum(["any", "all"]),
                    }),
                    offboarding: z.object({
                        enabled: z.boolean(),
                        intervalSeconds: z.number().int().min(1),
                        mode: z.enum(["per-request-cache"]),
                        source: z.string().min(1),
                    }),
                }),
            ),
            misconfig: z.array(
                z.object({
                    code: z.string(),
                    message: z.string(),
                    kind: z.string().optional(),
                    providerId: z.string().optional(),
                    envVars: z.array(z.string()).optional(),
                }),
            ),
        }),
    }),
});

async function getFeaturesPayload() {
    const { featuresRoutes } = await import("./featuresRoutes");
    const route = createRouteTestBuilder({
        method: "GET",
        path: "/v1/features",
        registerRoutes(app) {
            featuresRoutes(app as any);
        },
    });
    const { response } = await route.invoke();
    return response as any;
}

describe("featuresRoutes", () => {
    beforeEach(() => {
        vi.resetModules();
        resetEnv();
    });

    afterEach(() => {
        resetEnv();
    });

    describe("friends", () => {
        it("returns friends=false when HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED is off", async () => {
            resetEnv({
                HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: "0",
                GITHUB_CLIENT_ID: "id",
                GITHUB_CLIENT_SECRET: "secret",
                GITHUB_REDIRECT_URL: "https://example.com/v1/oauth/github/callback",
            });

            const payload = await getFeaturesPayload();
            expect(payload.features.social.friends.enabled).toBe(false);
        });

        it("returns friends=true and allowUsername=true when HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME is on", async () => {
            resetEnv({
                HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: "1",
                HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: "1",
                GITHUB_CLIENT_ID: undefined,
                GITHUB_CLIENT_SECRET: undefined,
                GITHUB_REDIRECT_URL: undefined,
                GITHUB_REDIRECT_URI: undefined,
            });

            const payload = await getFeaturesPayload();
            expect(payload.features.social.friends.enabled).toBe(true);
            expect(payload.capabilities.social.friends.allowUsername).toBe(true);
            expect(payload.capabilities.social.friends.requiredIdentityProviderId).toBeNull();
        });

        it("returns friends=false when identity provider is required but OAuth provider is not configured", async () => {
            resetEnv({
                HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: "1",
                HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: "0",
                GITHUB_CLIENT_ID: undefined,
                GITHUB_CLIENT_SECRET: undefined,
                GITHUB_REDIRECT_URL: undefined,
                GITHUB_REDIRECT_URI: undefined,
            });

            const payload = await getFeaturesPayload();
            expect(payload.features.social.friends.enabled).toBe(false);
            expect(payload.capabilities.social.friends.allowUsername).toBe(false);
            expect(payload.capabilities.social.friends.requiredIdentityProviderId).toBe("github");
        });
    });

    describe("voice", () => {
        it("returns voice=false when ElevenLabs is not configured", async () => {
            resetEnv({
                NODE_ENV: "production",
                HAPPIER_FEATURE_VOICE__ENABLED: "1",
                ELEVENLABS_API_KEY: undefined,
                ELEVENLABS_AGENT_ID_PROD: undefined,
            });

            const payload = await getFeaturesPayload();
            // Voice settings should remain available (local / BYO voice), even when Happier Voice is misconfigured.
            expect(payload.features.voice.enabled).toBe(true);
            expect(payload.features.voice.happierVoice.enabled).toBe(false);
            expect(payload.capabilities.voice.configured).toBe(false);
            expect(payload.capabilities.voice.provider).toBe(null);
        });

        it("returns voice=true when voice is enabled and ElevenLabs is configured", async () => {
            resetEnv({
                NODE_ENV: "production",
                HAPPIER_FEATURE_VOICE__ENABLED: "1",
                ELEVENLABS_API_KEY: "el_key",
                ELEVENLABS_AGENT_ID_PROD: "agent_1",
                REVENUECAT_SECRET_KEY: "rc_secret",
            });

            const payload = await getFeaturesPayload();
            expect(payload.features.voice.enabled).toBe(true);
            expect(payload.features.voice.happierVoice.enabled).toBe(true);
            expect(payload.capabilities.voice.configured).toBe(true);
            expect(payload.capabilities.voice.provider).toBe("elevenlabs");
        });

        it("returns voice=false when subscription is required and RevenueCat is not configured", async () => {
            resetEnv({
                NODE_ENV: "production",
                HAPPIER_FEATURE_VOICE__ENABLED: "1",
                ELEVENLABS_API_KEY: "el_key",
                ELEVENLABS_AGENT_ID_PROD: "agent_1",
                HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: undefined,
                REVENUECAT_SECRET_KEY: undefined,
            });

            const payload = await getFeaturesPayload();
            expect(payload.features.voice.enabled).toBe(true);
            expect(payload.features.voice.happierVoice.enabled).toBe(false);
            expect(payload.capabilities.voice.configured).toBe(false);
            expect(payload.capabilities.voice.provider).toBe(null);
        });

        it("returns voice=true when subscription is not required even without RevenueCat", async () => {
            resetEnv({
                NODE_ENV: "production",
                HAPPIER_FEATURE_VOICE__ENABLED: "1",
                ELEVENLABS_API_KEY: "el_key",
                ELEVENLABS_AGENT_ID_PROD: "agent_1",
                HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: "0",
                REVENUECAT_SECRET_KEY: undefined,
            });

            const payload = await getFeaturesPayload();
            expect(payload.features.voice.enabled).toBe(true);
            expect(payload.features.voice.happierVoice.enabled).toBe(true);
            expect(payload.capabilities.voice.configured).toBe(true);
            expect(payload.capabilities.voice.provider).toBe("elevenlabs");
        });
    });

    describe("legacy mobile compatibility", () => {
        it("aliases split capabilities back onto feature fields for older mobile clients", async () => {
            resetEnv({
                NODE_ENV: "production",
                HAPPIER_FEATURE_VOICE__ENABLED: "1",
                ELEVENLABS_API_KEY: "el_key",
                ELEVENLABS_AGENT_ID_PROD: "agent_1",
                REVENUECAT_SECRET_KEY: "rc_secret",
                HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: "1",
                HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: "1",
                AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
                AUTH_SIGNUP_PROVIDERS: "github",
                HAPPIER_FEATURE_AUTH_RECOVERY__PROVIDER_RESET_ENABLED: "1",
                GITHUB_CLIENT_ID: "id",
                GITHUB_CLIENT_SECRET: "secret",
                GITHUB_REDIRECT_URL: "https://example.com/v1/oauth/github/callback",
            });

            const payload = await getFeaturesPayload();
            const parsed = LegacyPreviewFeaturesResponseSchema.safeParse(payload);

            expect(parsed.success).toBe(true);
            if (!parsed.success) return;

            expect(parsed.data.features.voice.configured).toBe(true);
            expect(parsed.data.features.voice.provider).toBe("elevenlabs");
            expect(parsed.data.features.social.friends.allowUsername).toBe(true);
            expect(parsed.data.features.oauth.providers.github?.configured).toBe(true);
            expect(parsed.data.features.auth.recovery.providerReset.enabled).toBe(true);
            expect(parsed.data.features.automations.existingSessionTarget).toBe(false);
        });
    });

    describe("oauth providers", () => {
        it("marks github as configured=false when GitHub env is missing", async () => {
            resetEnv({
                GITHUB_CLIENT_ID: undefined,
                GITHUB_CLIENT_SECRET: undefined,
                GITHUB_REDIRECT_URL: undefined,
                GITHUB_REDIRECT_URI: undefined,
            });

            const payload = await getFeaturesPayload();
            expect(payload.capabilities.oauth.providers.github.enabled).toBe(true);
            expect(payload.capabilities.oauth.providers.github.configured).toBe(false);
        });

        it("marks github as configured=true when GitHub env is configured", async () => {
            resetEnv({
                GITHUB_CLIENT_ID: "client_id",
                GITHUB_CLIENT_SECRET: "client_secret",
                GITHUB_REDIRECT_URL: "https://example.com/v1/oauth/github/callback",
            });

            const payload = await getFeaturesPayload();
            expect(payload.capabilities.oauth.providers.github.enabled).toBe(true);
            expect(payload.capabilities.oauth.providers.github.configured).toBe(true);
        });

        it("includes configured OIDC providers from AUTH_PROVIDERS_CONFIG_JSON", async () => {
            resetEnv({
                AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([
                    {
                        id: "Okta",
                        type: "oidc",
                        displayName: "Acme Okta",
                        issuer: "https://issuer.example.test",
                        clientId: "cid",
                        clientSecret: "secret",
                        redirectUrl: "https://api.example.test/v1/oauth/okta/callback",
                    },
                ]),
            });

            const payload = await getFeaturesPayload();
            expect(payload.capabilities.oauth.providers.okta).toEqual(
                expect.objectContaining({
                    enabled: true,
                    configured: true,
                }),
            );
        });
    });

    describe("auth recovery + ui", () => {
        it("exposes provider reset as enabled when configured", async () => {
            resetEnv({
                AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
                AUTH_SIGNUP_PROVIDERS: "github",
                HAPPIER_FEATURE_AUTH_RECOVERY__PROVIDER_RESET_ENABLED: "1",
                GITHUB_CLIENT_ID: "id",
                GITHUB_CLIENT_SECRET: "secret",
                GITHUB_REDIRECT_URL: "https://example.com/oauth/github/callback",
            });

            const payload = await getFeaturesPayload();
            expect(payload.features.auth.recovery.providerReset.enabled).toBe(true);
            expect(payload.capabilities.auth.recovery.providerReset.providers).toContain("github");
        });

        it("exposes provider reset as disabled when HAPPIER_FEATURE_AUTH_RECOVERY__PROVIDER_RESET_ENABLED=0", async () => {
            resetEnv({
                AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
                AUTH_SIGNUP_PROVIDERS: "github",
                HAPPIER_FEATURE_AUTH_RECOVERY__PROVIDER_RESET_ENABLED: "0",
                GITHUB_CLIENT_ID: "id",
                GITHUB_CLIENT_SECRET: "secret",
                GITHUB_REDIRECT_URL: "https://example.com/oauth/github/callback",
            });

            const payload = await getFeaturesPayload();
            expect(payload.features.auth.recovery.providerReset.enabled).toBe(false);
            expect(payload.capabilities.auth.recovery.providerReset.providers).toEqual([]);
        });

        it("defaults recovery key reminder UI flag to enabled", async () => {
            const payload = await getFeaturesPayload();
            expect(payload.features.auth.ui.recoveryKeyReminder.enabled).toBe(true);
        });

        it("allows disabling recovery key reminder UI via HAPPIER_FEATURE_AUTH_UI__RECOVERY_KEY_REMINDER_ENABLED=0", async () => {
            resetEnv({
                HAPPIER_FEATURE_AUTH_UI__RECOVERY_KEY_REMINDER_ENABLED: "0",
            });

            const payload = await getFeaturesPayload();
            expect(payload.features.auth.ui.recoveryKeyReminder.enabled).toBe(false);
        });
    });

    describe("auth login", () => {
        it("reports key-challenge login enabled by default", async () => {
            const payload = await getFeaturesPayload();
            expect(payload.features.auth.login.keyChallenge.enabled).toBe(true);
            expect(payload.capabilities.auth.login.methods).toEqual(
                expect.arrayContaining([{ id: "key_challenge", enabled: true }]),
            );
        });

        it("reports key-challenge login disabled when HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED=0", async () => {
            resetEnv({
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            });

            const payload = await getFeaturesPayload();
            expect(payload.features.auth.login.keyChallenge.enabled).toBe(false);
            expect(payload.capabilities.auth.login.methods).toEqual(
                expect.arrayContaining([{ id: "key_challenge", enabled: false }]),
            );
        });
    });

    describe("auth mtls", () => {
        it("exposes mtls policy details under capabilities.auth.mtls.policy", async () => {
            resetEnv({
                HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
                HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
                HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
                HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: "CN=Example Root CA\ncn=Example Intermediate CA",
                HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com, example.org",
            });

            const payload = await getFeaturesPayload();
            expect(payload.capabilities.auth.mtls).toEqual(
                expect.objectContaining({
                    policy: {
                        trustForwardedHeaders: true,
                        issuerAllowlist: { enabled: true, count: 2 },
                        emailDomainAllowlist: { enabled: true, count: 2 },
                    },
                }),
            );
        });
    });

    describe("encryption", () => {
        it("reports required_e2ee by default", async () => {
            const payload = await getFeaturesPayload();
            expect(payload.features.encryption.plaintextStorage.enabled).toBe(false);
            expect(payload.features.encryption.accountOptOut.enabled).toBe(false);
            expect(payload.capabilities.encryption).toMatchObject({
                storagePolicy: "required_e2ee",
                allowAccountOptOut: false,
                defaultAccountMode: "e2ee",
                plainAccountSettingsAtRest: "server_sealed",
                plainAccountCredentialsAtRest: "server_sealed",
            });
        });

        it("reports plaintext storage enabled when policy is optional", async () => {
            resetEnv({
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
                HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
                HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            });

            const payload = await getFeaturesPayload();
            expect(payload.features.encryption.plaintextStorage.enabled).toBe(true);
            expect(payload.features.encryption.accountOptOut.enabled).toBe(true);
            expect(payload.capabilities.encryption).toMatchObject({
                storagePolicy: "optional",
                allowAccountOptOut: true,
                defaultAccountMode: "plain",
                plainAccountSettingsAtRest: "server_sealed",
                plainAccountCredentialsAtRest: "server_sealed",
            });
        });
    });

    describe("auth misconfiguration", () => {
        it("surfaces misconfig when AUTH_PROVIDERS_CONFIG_JSON is invalid", async () => {
            resetEnv({
                AUTH_PROVIDERS_CONFIG_JSON: "{ definitely: not-json }",
            });

            const payload = await getFeaturesPayload();
            expect(payload.capabilities.auth.misconfig).toEqual(
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
            resetEnv({
                AUTH_REQUIRED_LOGIN_PROVIDERS: "okta",
            });

            const payload = await getFeaturesPayload();
            expect(payload.capabilities.auth.login.requiredProviders).toEqual(["okta"]);
            expect(payload.capabilities.auth.misconfig).toEqual(
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
            resetEnv({
                HAPPIER_FEATURE_BUG_REPORTS__ENABLED: undefined,
                HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL: undefined,
                HAPPIER_FEATURE_BUG_REPORTS__DEFAULT_INCLUDE_DIAGNOSTICS: undefined,
            });

            const payload = await getFeaturesPayload();
            expect(payload.features.bugReports.enabled).toBe(true);
            expect(payload.capabilities.bugReports.providerUrl).toBe("https://reports.happier.dev");
            expect(payload.capabilities.bugReports.defaultIncludeDiagnostics).toBe(true);
            expect(payload.capabilities.bugReports.contextWindowMs).toBe(30 * 60 * 1000);
        });

        it("allows disabling bug report capability via env", async () => {
            resetEnv({
                HAPPIER_FEATURE_BUG_REPORTS__ENABLED: "0",
                HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL: "https://reports.enterprise.local",
                HAPPIER_FEATURE_BUG_REPORTS__DEFAULT_INCLUDE_DIAGNOSTICS: "0",
                HAPPIER_FEATURE_BUG_REPORTS__CONTEXT_WINDOW_MS: "60000",
            });

            const payload = await getFeaturesPayload();
            expect(payload.features.bugReports.enabled).toBe(false);
            expect(payload.capabilities.bugReports.providerUrl).toBe("https://reports.enterprise.local");
            expect(payload.capabilities.bugReports.defaultIncludeDiagnostics).toBe(false);
            expect(payload.capabilities.bugReports.contextWindowMs).toBe(60000);
        });

        it("fails closed when provider url env is invalid", async () => {
            resetEnv({
                HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL: "invalid-provider-url",
            });

            const payload = await getFeaturesPayload();
            expect(payload.features.bugReports.enabled).toBe(false);
            expect(payload.capabilities.bugReports.providerUrl).toBeNull();
        });
    });

    describe("automations", () => {
        it("returns automations enabled by default", async () => {
            resetEnv({
                HAPPIER_FEATURE_AUTOMATIONS__ENABLED: undefined,
            });

            const payload = await getFeaturesPayload();
            expect(payload.features.automations.enabled).toBe(true);
        });
    });

    describe("connected services", () => {
        it("defaults connectedServices.enabled to true", async () => {
            const payload = await getFeaturesPayload();
            expect(payload.features.connectedServices.enabled).toBe(true);
        });

        it("returns connectedServices.enabled=false when HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED is off", async () => {
            resetEnv({
                HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: "0",
            });
            const payload = await getFeaturesPayload();
            expect(payload.features.connectedServices.enabled).toBe(false);
        });

        it("defaults connectedServices.quotas.enabled to true", async () => {
            const payload = await getFeaturesPayload();
            expect(payload.features.connectedServices.quotas.enabled).toBe(true);
        });

        it("returns connectedServices.quotas.enabled=false when HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED is off", async () => {
            resetEnv({
                HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "0",
            });
            const payload = await getFeaturesPayload();
            expect(payload.features.connectedServices.quotas.enabled).toBe(false);
        });
    });

    describe("server url capabilities", () => {
        it("exposes canonicalServerUrl + webappUrl when configured via env", async () => {
            resetEnv({
                HAPPIER_PUBLIC_SERVER_URL: "https://stack.example.test/",
                HAPPIER_WEBAPP_URL: "https://ui.example.test/",
            });

            const payload = await getFeaturesPayload();
            expect(payload.capabilities.server.canonicalServerUrl).toBe("https://stack.example.test");
            expect(payload.capabilities.server.webappUrl).toBe("https://ui.example.test");
        });

        it("exposes canonicalServerUrl when only HAPPIER_PUBLIC_SERVER_URL is set", async () => {
            resetEnv({
                HAPPIER_PUBLIC_SERVER_URL: "https://stack.example.test/",
                HAPPIER_WEBAPP_URL: undefined,
            });

            const payload = await getFeaturesPayload();
            expect(payload.capabilities.server.canonicalServerUrl).toBe("https://stack.example.test");
            expect(payload.capabilities.server.webappUrl).toBeUndefined();
        });

        it("exposes webappUrl when only HAPPIER_WEBAPP_URL is set", async () => {
            resetEnv({
                HAPPIER_PUBLIC_SERVER_URL: undefined,
                HAPPIER_WEBAPP_URL: "https://ui.example.test/",
            });

            const payload = await getFeaturesPayload();
            expect(payload.capabilities.server.canonicalServerUrl).toBeUndefined();
            expect(payload.capabilities.server.webappUrl).toBe("https://ui.example.test");
        });

        it("strips userinfo/query/hash from advertised urls", async () => {
            resetEnv({
                HAPPIER_PUBLIC_SERVER_URL: "https://user:pass@stack.example.test/?q=1#frag",
                HAPPIER_WEBAPP_URL: "https://user:pass@ui.example.test/app/?q=1#frag",
            });

            const payload = await getFeaturesPayload();
            expect(payload.capabilities.server.canonicalServerUrl).toBe("https://stack.example.test");
            expect(payload.capabilities.server.webappUrl).toBe("https://ui.example.test/app");
        });

        it("exposes retention capabilities when retention env is configured", async () => {
            resetEnv({
                HAPPIER_SERVER_RETENTION__ENABLED: "true",
                HAPPIER_SERVER_RETENTION__SESSIONS__MODE: "delete_inactive",
                HAPPIER_SERVER_RETENTION__SESSIONS__INACTIVITY_DAYS: "30",
                HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__MODE: "delete_older_than",
                HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__DAYS: "30",
            });

            const payload = await getFeaturesPayload();

            expect(payload.capabilities.server.retention).toMatchObject({
                policyVersion: 1,
                enabled: true,
                sessions: {
                    mode: "delete_inactive",
                    inactivityDays: 30,
                    requires: ["updatedAt", "lastActiveAt"],
                },
                accountChanges: {
                    mode: "delete_older_than",
                    days: 30,
                },
                voiceSessionLeases: {
                    mode: "keep_forever",
                },
            });
        });
    });
});
