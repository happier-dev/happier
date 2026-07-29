import { readServerEnabledBit } from "@happier-dev/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEnvReset } from "../../testkit/env";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";
import {
    resolveCachedCanonicalPublicServerUrl,
    resetPublicServerUrlInferenceCacheForTests,
} from "@/app/integrations/publicUrl/publicServerUrlInference";

const resetEnv = createEnvReset({
    ...process.env,
    HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: undefined,
    HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: undefined,
    HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: undefined,
    HAPPIER_HOME_DIR: undefined,
    HAPPIER_STACK_CLI_HOME_DIR: undefined,
    HAPPY_HOME_DIR: undefined,
    HAPPIER_PUBLIC_SERVER_URL: undefined,
    HAPPIER_PUBLIC_SERVER_URL_INFER_TTL_MS: undefined,
    HAPPIER_PUBLIC_SERVER_URL_INFERRED: undefined,
    HAPPIER_WEBAPP_URL: undefined,
    HAPPY_WEBAPP_URL: undefined,
    HAPPIER_RELAY_ACCESS_INFER_PUBLIC_URL: "0",
    HAPPIER_TAILSCALE_INFER_PUBLIC_URL: "0",
    HAPPIER_BUILD_FEATURES_ALLOW: undefined,
    HAPPIER_BUILD_FEATURES_DENY: undefined,
});

type ServerIdentityRouteModuleMock = Readonly<{
    getOrCreateServerIdentityId: (env?: NodeJS.ProcessEnv) => Promise<string>;
    readPinnedServerIdentityId: (env?: NodeJS.ProcessEnv) => string | null;
    readCachedServerIdentityIdForHotPath: (env?: NodeJS.ProcessEnv) => string | null;
}>;

async function getFeaturesPayload(
    requestOverrides: Record<string, unknown> = {},
    serverIdentityMock?: ServerIdentityRouteModuleMock,
) {
    if (serverIdentityMock) {
        vi.doMock("@/app/serverIdentity/serverIdentity", () => serverIdentityMock);
    }
    const { featuresRoutes } = await import("./featuresRoutes");
    const route = createRouteTestBuilder({
        method: "GET",
        path: "/v1/features",
        registerRoutes(app) {
            featuresRoutes(app as any);
        },
    });
    const { response, reply } = await route.invoke(requestOverrides);
    return { payload: response as any, reply };
}

describe("featuresRoutes", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.doUnmock("@/app/serverIdentity/serverIdentity");
        resetPublicServerUrlInferenceCacheForTests();
        resetEnv();
    });

    afterEach(() => {
        vi.doUnmock("@/app/serverIdentity/serverIdentity");
        resetPublicServerUrlInferenceCacheForTests();
        resetEnv();
    });

    it("returns the browser sidecar feature branch enabled in the live feature payload", async () => {
        const { payload } = await getFeaturesPayload();

        expect(payload.features.browser).toBeDefined();
        expect(readServerEnabledBit(payload, "browser")).toBe(true);
        expect(readServerEnabledBit(payload, "browser.internal")).toBe(true);
        expect(readServerEnabledBit(payload, "browser.sidecar")).toBe(true);
        expect(readServerEnabledBit(payload, "browser.diagnostics")).toBe(true);
        expect(readServerEnabledBit(payload, "browser.automation")).toBe(true);
        expect(readServerEnabledBit(payload, "browser.context")).toBe(true);
        expect(readServerEnabledBit(payload, "browser.recording")).toBe(true);
    });

    it("publishes the external-session import publication fence in the live feature payload", async () => {
        const { payload } = await getFeaturesPayload();

        expect(payload.capabilities.compatibility.externalSessionImport).toEqual({
            currentPublicationFenceVersion: 3,
        });
    });

    describe("server identity", () => {
        it("returns a compatibility-safe server identity capability", async () => {
            resetEnv({
                HAPPIER_SERVER_IDENTITY_ID: "srv_routeIdentity123",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.capabilities.serverIdentity).toEqual({
                serverIdentityId: "srv_routeIdentity123",
            });
            expect(payload.capabilities.server).not.toHaveProperty("serverIdentityId");
        });

        it("keeps the route usable without initialized identity storage", async () => {
            const { payload } = await getFeaturesPayload();

            expect(payload.capabilities.serverIdentity).toEqual({
                serverIdentityId: null,
            });
        });

        it("reads from the process hot-path cache without invoking storage-backed resolution", async () => {
            const getOrCreateServerIdentityId = vi.fn(async () => "srv_storageResolver123");
            const readCachedServerIdentityIdForHotPath = vi.fn(() => "srv_hotCache123");

            const { payload } = await getFeaturesPayload({}, {
                getOrCreateServerIdentityId,
                readPinnedServerIdentityId: () => null,
                readCachedServerIdentityIdForHotPath,
            });

            expect(payload.capabilities.serverIdentity).toEqual({
                serverIdentityId: "srv_hotCache123",
            });
            expect(readCachedServerIdentityIdForHotPath).toHaveBeenCalledTimes(1);
            expect(getOrCreateServerIdentityId).not.toHaveBeenCalled();
        });
    });

    describe("friends", () => {
        it("returns friends=false when HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED is off", async () => {
            resetEnv({
                HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: "0",
                GITHUB_CLIENT_ID: "id",
                GITHUB_CLIENT_SECRET: "secret",
                GITHUB_REDIRECT_URL: "https://example.com/v1/oauth/github/callback",
            });

            const { payload } = await getFeaturesPayload();
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

            const { payload } = await getFeaturesPayload();
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

            const { payload } = await getFeaturesPayload();
            expect(payload.features.social.friends.enabled).toBe(false);
            expect(payload.capabilities.social.friends.allowUsername).toBe(false);
            expect(payload.capabilities.social.friends.requiredIdentityProviderId).toBe("github");
        });
    });

    describe("auth provisioning restrictions", () => {
        it("disables signup methods for matching public requests", async () => {
            resetEnv({
                AUTH_ANONYMOUS_SIGNUP_ENABLED: "1",
                AUTH_SIGNUP_PROVIDERS: "github",
                GITHUB_CLIENT_ID: "id",
                GITHUB_CLIENT_SECRET: "secret",
                GITHUB_REDIRECT_URL: "https://example.com/v1/oauth/github/callback",
                HAPPIER_AUTH_PUBLIC_PROVISION_DENY_METHODS: "key_challenge,github",
                HAPPIER_AUTH_PUBLIC_PROVISION_DENY_MODES: "keyed",
            });

            const { payload } = await getFeaturesPayload({ ip: "203.0.113.10" });
            expect(payload.capabilities.auth.signup.methods).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ id: "anonymous", enabled: false }),
                    expect.objectContaining({ id: "github", enabled: false }),
                ]),
            );
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

            const { payload } = await getFeaturesPayload();
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

            const { payload } = await getFeaturesPayload();
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

            const { payload } = await getFeaturesPayload();
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

            const { payload } = await getFeaturesPayload();
            expect(payload.features.voice.enabled).toBe(true);
            expect(payload.features.voice.happierVoice.enabled).toBe(true);
            expect(payload.capabilities.voice.configured).toBe(true);
            expect(payload.capabilities.voice.provider).toBe("elevenlabs");
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

            const { payload } = await getFeaturesPayload();
            expect(payload.capabilities.oauth.providers.github.enabled).toBe(true);
            expect(payload.capabilities.oauth.providers.github.configured).toBe(false);
        });

        it("marks github as configured=true when GitHub env is configured", async () => {
            resetEnv({
                GITHUB_CLIENT_ID: "client_id",
                GITHUB_CLIENT_SECRET: "client_secret",
                GITHUB_REDIRECT_URL: "https://example.com/v1/oauth/github/callback",
            });

            const { payload } = await getFeaturesPayload();
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

            const { payload } = await getFeaturesPayload();
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

            const { payload } = await getFeaturesPayload();
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

            const { payload } = await getFeaturesPayload();
            expect(payload.features.auth.recovery.providerReset.enabled).toBe(false);
            expect(payload.capabilities.auth.recovery.providerReset.providers).toEqual([]);
        });

        it("defaults recovery key reminder UI flag to enabled", async () => {
            const { payload } = await getFeaturesPayload();
            expect(payload.features.auth.ui.recoveryKeyReminder.enabled).toBe(true);
        });

        it("allows disabling recovery key reminder UI via HAPPIER_FEATURE_AUTH_UI__RECOVERY_KEY_REMINDER_ENABLED=0", async () => {
            resetEnv({
                HAPPIER_FEATURE_AUTH_UI__RECOVERY_KEY_REMINDER_ENABLED: "0",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.features.auth.ui.recoveryKeyReminder.enabled).toBe(false);
        });
    });

    describe("auth login", () => {
        it("reports key-challenge login enabled by default", async () => {
            const { payload } = await getFeaturesPayload();
            expect(payload.features.auth.login.keyChallenge.enabled).toBe(true);
            expect(payload.capabilities.auth.login.methods).toEqual(
                expect.arrayContaining([{ id: "key_challenge", enabled: true }]),
            );
        });

        it("reports key-challenge login disabled when HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED=0", async () => {
            resetEnv({
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.features.auth.login.keyChallenge.enabled).toBe(false);
            expect(payload.capabilities.auth.login.methods).toEqual(
                expect.arrayContaining([{ id: "key_challenge", enabled: false }]),
            );
        });

        it("disables provisioning actions for public requests and sets no-store", async () => {
            resetEnv({
                AUTH_ANONYMOUS_SIGNUP_ENABLED: "1",
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
                HAPPIER_AUTH_PUBLIC_PROVISION_DENY_METHODS: "key_challenge",
            });

            const { payload, reply } = await getFeaturesPayload({ ip: "203.0.113.10" });
            const methods = payload?.capabilities?.auth?.methods ?? [];
            const keyChallenge = methods.find((m: any) => String(m?.id ?? "").toLowerCase() === "key_challenge");
            const provision = Array.isArray(keyChallenge?.actions)
                ? keyChallenge.actions.find((a: any) => a?.id === "provision" && a?.mode === "keyed")
                : null;
            expect(provision).toEqual(expect.objectContaining({ enabled: false }));
            expect(reply.headers["Cache-Control"]).toBe("no-store");
        });

        it("keeps provisioning enabled for private requests", async () => {
            resetEnv({
                AUTH_ANONYMOUS_SIGNUP_ENABLED: "1",
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
                HAPPIER_AUTH_PUBLIC_PROVISION_DENY_METHODS: "key_challenge",
            });

            const { payload } = await getFeaturesPayload({ ip: "10.0.0.5" });
            const methods = payload?.capabilities?.auth?.methods ?? [];
            const keyChallenge = methods.find((m: any) => String(m?.id ?? "").toLowerCase() === "key_challenge");
            const provision = Array.isArray(keyChallenge?.actions)
                ? keyChallenge.actions.find((a: any) => a?.id === "provision" && a?.mode === "keyed")
                : null;
            expect(provision).toEqual(expect.objectContaining({ enabled: true }));
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

            const { payload } = await getFeaturesPayload();
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
            const { payload } = await getFeaturesPayload();
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

            const { payload } = await getFeaturesPayload();
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

            const { payload } = await getFeaturesPayload();
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

            const { payload } = await getFeaturesPayload();
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

            const { payload } = await getFeaturesPayload();
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

            const { payload } = await getFeaturesPayload();
            expect(payload.features.bugReports.enabled).toBe(false);
            expect(payload.capabilities.bugReports.providerUrl).toBe("https://reports.enterprise.local");
            expect(payload.capabilities.bugReports.defaultIncludeDiagnostics).toBe(false);
            expect(payload.capabilities.bugReports.contextWindowMs).toBe(60000);
        });

        it("fails closed when provider url env is invalid", async () => {
            resetEnv({
                HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL: "invalid-provider-url",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.features.bugReports.enabled).toBe(false);
            expect(payload.capabilities.bugReports.providerUrl).toBeNull();
        });
    });

    describe("automations", () => {
        it("returns automations enabled by default", async () => {
            resetEnv({
                HAPPIER_FEATURE_AUTOMATIONS__ENABLED: undefined,
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.features.automations.enabled).toBe(true);
        });
    });

    describe("connected services", () => {
        it("defaults connectedServices.enabled to true", async () => {
            const { payload } = await getFeaturesPayload();
            expect(payload.features.connectedServices.enabled).toBe(true);
        });

        it("keeps the compatibility-only connectedServices.enabled bit true when the retired env is off", async () => {
            resetEnv({
                HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: "0",
            });
            const { payload } = await getFeaturesPayload();
            expect(payload.features.connectedServices.enabled).toBe(true);
        });

        it("defaults connectedServices.quotas.enabled to true", async () => {
            const { payload } = await getFeaturesPayload();
            expect(payload.features.connectedServices.quotas.enabled).toBe(true);
        });

        it("returns connectedServices.quotas.enabled=false when HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED is off", async () => {
            resetEnv({
                HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "0",
            });
            const { payload } = await getFeaturesPayload();
            expect(payload.features.connectedServices.quotas.enabled).toBe(false);
        });

        it("prunes transitive dependents in the /v1/features payload when sessions are build-disabled", async () => {
            resetEnv({
                HAPPIER_BUILD_FEATURES_DENY: "sessions",
            });

            const { payload } = await getFeaturesPayload();

            expect(payload.features.sessions.enabled).toBe(false);
            expect(payload.features.sessions.usageLimitRecovery.enabled).toBe(false);
            expect(payload.features.connectedServices.accountFallback.enabled).toBe(false);
        });
    });

    describe("server url capabilities", () => {
        it("exposes canonicalServerUrl + webappUrl when configured via env", async () => {
            resetEnv({
                HAPPIER_PUBLIC_SERVER_URL: "https://stack.example.test/",
                HAPPIER_WEBAPP_URL: "https://ui.example.test/",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.capabilities.server.canonicalServerUrl).toBe("https://stack.example.test");
            expect(payload.capabilities.server.webappUrl).toBe("https://ui.example.test");
        });

        it("infers canonicalServerUrl via relay access tailscaleFunnel when the current port matches", async () => {
            const { chmod, mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
            const { tmpdir } = await import("node:os");
            const { join } = await import("node:path");

            const homeDir = await mkdtemp(join(tmpdir(), "happier-features-home-"));
            const binDir = await mkdtemp(join(tmpdir(), "happier-features-bin-"));
            try {
                const tailscaleBin = join(binDir, "tailscale");
                await writeFile(
                    tailscaleBin,
                    [
                        "#!/usr/bin/env bash",
                        "set -euo pipefail",
                        'if [[ "${1:-}" == "status" && "${2:-}" == "--json" ]]; then',
                        "  cat <<'JSON'",
                        '{"BackendState":"Running","HaveNodeKey":true,"Self":{"DNSName":"my-machine.tailnet.ts.net"}}',
                        "JSON",
                        "  exit 0",
                        "fi",
                        'if [[ "${1:-}" == "funnel" && "${2:-}" == "status" ]]; then',
                        "  cat <<'TXT'",
                        "https://my-machine.tailnet.ts.net",
                        "|-- / proxy http://127.0.0.1:3005",
                        "TXT",
                        "  exit 0",
                        "fi",
                        "echo \"unexpected args: $*\" >&2",
                        "exit 1",
                        "",
                    ].join("\n"),
                    "utf8",
                );
                await chmod(tailscaleBin, 0o755);
                await mkdir(join(homeDir, ".happier", "relay", "access"), { recursive: true });
                await writeFile(
                    join(homeDir, ".happier", "relay", "access", "local.json"),
                    JSON.stringify({ providerId: "tailscaleFunnel" }),
                    "utf8",
                );

                resetEnv({
                    HOME: homeDir,
                    HAPPIER_HOME_DIR: undefined,
                    HAPPIER_STACK_CLI_HOME_DIR: undefined,
                    HAPPIER_PUBLIC_SERVER_URL: undefined,
                    HAPPIER_PUBLIC_SERVER_URL_INFERRED: undefined,
                    HAPPIER_TAILSCALE_BIN: tailscaleBin,
                    HAPPIER_TAILSCALE_INFER_PUBLIC_URL: "0",
                    HAPPIER_RELAY_ACCESS_INFER_PUBLIC_URL: "1",
                    PORT: "3005",
                });

                await resolveCachedCanonicalPublicServerUrl(process.env);

                const { payload } = await getFeaturesPayload();
                expect(payload.capabilities.server.canonicalServerUrl).toBe("https://my-machine.tailnet.ts.net");
            } finally {
                await rm(homeDir, { recursive: true, force: true });
                await rm(binDir, { recursive: true, force: true });
            }
        });

        it("does not infer canonicalServerUrl during the request when startup cache is cold", async () => {
            const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
            const { tmpdir } = await import("node:os");
            const { join } = await import("node:path");

            const homeDir = await mkdtemp(join(tmpdir(), "happier-features-home-"));
            const previousHome = process.env.HOME;
            process.env.HOME = homeDir;
            try {
                await mkdir(join(homeDir, ".happier", "relay", "access"), { recursive: true });
                await writeFile(
                    join(homeDir, ".happier", "relay", "access", "local.json"),
                    JSON.stringify({ providerId: "cloudflareNamed", hostname: "relay.example.test", token: "secret" }),
                    "utf8",
                );

                resetEnv({
                    HOME: homeDir,
                    HAPPIER_PUBLIC_SERVER_URL: undefined,
                    HAPPIER_RELAY_ACCESS_INFER_PUBLIC_URL: "1",
                    HAPPIER_TAILSCALE_INFER_PUBLIC_URL: "0",
                });

                const { payload } = await getFeaturesPayload();
                expect(payload.capabilities.server.canonicalServerUrl).toBeUndefined();
            } finally {
                process.env.HOME = previousHome;
                await rm(homeDir, { recursive: true, force: true });
            }
        });

        it("exposes canonicalServerUrl when only HAPPIER_PUBLIC_SERVER_URL is set", async () => {
            resetEnv({
                HAPPIER_PUBLIC_SERVER_URL: "https://stack.example.test/",
                HAPPIER_WEBAPP_URL: undefined,
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.capabilities.server.canonicalServerUrl).toBe("https://stack.example.test");
            expect(payload.capabilities.server.webappUrl).toBeUndefined();
        });

        it("exposes webappUrl when only HAPPIER_WEBAPP_URL is set", async () => {
            resetEnv({
                HAPPIER_PUBLIC_SERVER_URL: undefined,
                HAPPIER_WEBAPP_URL: "https://ui.example.test/",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.capabilities.server.canonicalServerUrl).toBeUndefined();
            expect(payload.capabilities.server.webappUrl).toBe("https://ui.example.test");
        });

        it("derives webappUrl from canonicalServerUrl when the server is serving UI at root", async () => {
            resetEnv({
                HAPPIER_PUBLIC_SERVER_URL: "https://stack.example.test/",
                HAPPIER_WEBAPP_URL: undefined,
                HAPPIER_SERVER_UI_DIR: "/tmp/ui",
                HAPPIER_SERVER_UI_PREFIX: "/",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.capabilities.server.canonicalServerUrl).toBe("https://stack.example.test");
            expect(payload.capabilities.server.webappUrl).toBe("https://stack.example.test");
        });

        it("derives webappUrl from canonicalServerUrl plus the UI prefix when the server is serving UI below root", async () => {
            resetEnv({
                HAPPIER_PUBLIC_SERVER_URL: "https://stack.example.test/base/",
                HAPPIER_WEBAPP_URL: undefined,
                HAPPIER_SERVER_UI_DIR: "/tmp/ui",
                HAPPIER_SERVER_UI_PREFIX: "/ui/",
            });

            const { payload } = await getFeaturesPayload();
            expect(payload.capabilities.server.canonicalServerUrl).toBe("https://stack.example.test/base");
            expect(payload.capabilities.server.webappUrl).toBe("https://stack.example.test/base/ui");
        });

        it("strips userinfo/query/hash from advertised urls", async () => {
            resetEnv({
                HAPPIER_PUBLIC_SERVER_URL: "https://user:pass@stack.example.test/?q=1#frag",
                HAPPIER_WEBAPP_URL: "https://user:pass@ui.example.test/app/?q=1#frag",
            });

            const { payload } = await getFeaturesPayload();
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

            const { payload } = await getFeaturesPayload();

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

        it("omits retention capabilities when retention is not effectively enabled", async () => {
            resetEnv({
                HAPPIER_SERVER_RETENTION__ENABLED: "false",
                HAPPIER_SERVER_RETENTION__SESSIONS__MODE: "delete_inactive",
                HAPPIER_SERVER_RETENTION__SESSIONS__INACTIVITY_DAYS: "30",
                HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__MODE: "delete_older_than",
                HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__DAYS: "30",
            });

            const { payload } = await getFeaturesPayload();

            expect(payload.capabilities.server.retention).toBeUndefined();
        });
    });
});
