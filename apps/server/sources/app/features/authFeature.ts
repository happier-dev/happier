import type { FeaturesPayloadDelta, FeaturesResponse } from "./types";
import { resolveAuthPolicyFromEnv } from "@/app/auth/authPolicy";
import { resolveAuthProviderRegistryResult } from "@/app/auth/providers/registry";
import { readAuthFeatureEnv, readAuthMtlsFeatureEnv } from "./catalog/readFeatureEnv";
import { readAuthOauthKeylessFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolveAuthMethodRegistry } from "@/app/auth/methods/registry";
import { resolveKeylessAccountsEnabled } from "@/app/features/e2ee/resolveKeylessAccountsEnabled";
import { resolveKeylessAutoProvisionEligibility } from "@/app/auth/keyless/resolveKeylessAutoProvisionEligibility";
import { resolveKeylessAccountsAvailability } from "@/app/features/e2ee/resolveKeylessAccountsEnabled";

function uniqueStrings(values: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of values) {
        const id = v.toLowerCase();
        if (!id) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

export function resolveAuthFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const featureEnv = readAuthFeatureEnv(env);
    const mtlsEnv = readAuthMtlsFeatureEnv(env);
    const policy = resolveAuthPolicyFromEnv(env);
    const authProviderRegistryResult = resolveAuthProviderRegistryResult(env);
    const authProviderRegistry = authProviderRegistryResult.providers;
    const oauthKeylessEnv = readAuthOauthKeylessFeatureEnv(env);
    const keylessAccountsEnabled = resolveKeylessAccountsEnabled(env);
    const keylessAutoProvisionEligible = resolveKeylessAutoProvisionEligibility(env).ok;

    const methodRegistry = resolveAuthMethodRegistry(env);
    const coreAuthMethods = methodRegistry.map((m) => m.resolveAuthMethod({ env, policy }));
    const keyChallengeMethod =
        coreAuthMethods.find((m) => String(m?.id ?? "").trim().toLowerCase() === "key_challenge") ?? null;
    const keyChallengeLoginEnabled =
        keyChallengeMethod?.actions?.some((a: any) => a?.id === "login" && a?.enabled === true) === true;
    const keyChallengeProvisionEnabled =
        keyChallengeMethod?.actions?.some((a: any) => a?.id === "provision" && a?.enabled === true) === true;

    const mtlsMethod = coreAuthMethods.find((m) => String(m?.id ?? "").trim().toLowerCase() === "mtls") ?? null;
    const mtlsGateEnabled = mtlsMethod?.actions?.some((a: any) => a?.id === "login" && a?.enabled === true) === true;

    const signupProviders = uniqueStrings(policy.signupProviders);
    const requiredLoginProviders = uniqueStrings(policy.requiredLoginProviders);

    const misconfig: FeaturesResponse["capabilities"]["auth"]["misconfig"] = [];
    for (const err of authProviderRegistryResult.errors) {
        misconfig.push({
            code: "auth_providers_config_invalid",
            message: err,
            kind: "auth-providers-config",
            envVars: ["AUTH_PROVIDERS_CONFIG_PATH", "AUTH_PROVIDERS_CONFIG_JSON"],
        });
    }
    for (const providerId of new Set([...signupProviders, ...requiredLoginProviders])) {
        const resolver = authProviderRegistry.find((p) => p.id === providerId);
        if (!resolver) {
            misconfig.push({
                code: `auth_provider_unregistered_${providerId}`,
                message: `Provider "${providerId}" is referenced by server auth policy but is not registered. Configure it via AUTH_PROVIDERS_CONFIG_PATH/AUTH_PROVIDERS_CONFIG_JSON (OIDC) or enable the built-in provider.`,
                kind: "auth-provider-unregistered",
                providerId,
                envVars: ["AUTH_PROVIDERS_CONFIG_PATH", "AUTH_PROVIDERS_CONFIG_JSON"],
            });
            continue;
        }
        if (resolver.requiresOAuth && !resolver.isConfigured(env)) {
            misconfig.push({
                code: `${resolver.id}_oauth_not_configured`,
                message: `${resolver.id} OAuth is required by server auth policy but is not configured.`,
                kind: "oauth-not-configured",
                providerId: resolver.id,
            });
        }
    }

    if (mtlsEnv.enabled && !mtlsGateEnabled) {
        if (mtlsEnv.mode === "direct") {
            misconfig.push({
                code: "auth_mtls_not_configured",
                message:
                    "mTLS is enabled but direct mode is not supported yet. Use forwarded mode with trusted identity headers.",
                kind: "auth-mtls-config",
                envVars: ["HAPPIER_FEATURE_AUTH_MTLS__ENABLED", "HAPPIER_FEATURE_AUTH_MTLS__MODE"],
            });
        } else if (!mtlsEnv.trustForwardedHeaders) {
            misconfig.push({
                code: "auth_mtls_not_configured",
                message:
                    "mTLS is enabled but forwarded mode is not configured. Set HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS=1 and configure forwarded identity headers at the edge.",
                kind: "auth-mtls-config",
                envVars: [
                    "HAPPIER_FEATURE_AUTH_MTLS__ENABLED",
                    "HAPPIER_FEATURE_AUTH_MTLS__MODE",
                    "HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS",
                ],
            });
        } else {
            const availability = resolveKeylessAccountsAvailability(env);
            if (!availability.ok) {
                misconfig.push({
                    code: "auth_mtls_keyless_unavailable",
                    message:
                        availability.reason === "e2ee-required"
                            ? "mTLS is enabled, but keyless accounts are unavailable because the server storage policy requires E2EE. Set HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY=optional|plaintext_only and HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE=plain."
                            : "mTLS is enabled, but keyless accounts are disabled. Enable HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED=1 and ensure plaintext storage is allowed.",
                    kind: "auth-mtls-keyless",
                    envVars: [
                        "HAPPIER_FEATURE_AUTH_MTLS__ENABLED",
                        "HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED",
                        "HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY",
                        "HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE",
                    ],
                });
            }
        }
    }

    const providers: FeaturesResponse["capabilities"]["auth"]["providers"] = {};
    for (const provider of authProviderRegistry) {
        providers[provider.id] = provider.resolveFeatures({ env, policy });
    }

    const authMethods: FeaturesResponse["capabilities"]["auth"]["methods"] = [
        ...coreAuthMethods,
        ...Object.entries(providers)
            .map(([id, details]) => ({
                id,
                actions: ((): Array<{ id: "login" | "provision" | "connect"; enabled: boolean; mode: "keyed" | "keyless" | "either" }> => {
                    const configured = details.configured === true;
                    const connectEnabled = Boolean(details.enabled) && configured;
                    const keyedProvisionEnabled = Boolean(details.enabled) && configured && signupProviders.includes(id);
                    const keylessLoginEnabled =
                        keylessAccountsEnabled &&
                        configured &&
                        oauthKeylessEnv.enabled &&
                        oauthKeylessEnv.providers.includes(id.toLowerCase());
                    const keylessProvisionEnabled =
                        keylessLoginEnabled && oauthKeylessEnv.autoProvision && keylessAutoProvisionEligible;
                    return [
                        { id: "connect", enabled: connectEnabled, mode: "either" },
                        { id: "provision", enabled: keyedProvisionEnabled, mode: "keyed" },
                        { id: "login", enabled: keylessLoginEnabled, mode: "keyless" },
                        { id: "provision", enabled: keylessProvisionEnabled, mode: "keyless" },
                    ];
                })(),
                ui: details.ui?.displayName ? { displayName: details.ui.displayName, iconHint: details.ui.iconHint ?? null } : undefined,
            }))
            .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    ];

    const signupMethods: Array<{ id: string; enabled: boolean }> = [
        // Back-compat: "anonymous" maps to key_challenge provisioning.
        { id: "anonymous", enabled: keyChallengeProvisionEnabled },
        ...authMethods
            .filter((m) => {
                const id = String(m?.id ?? "").trim().toLowerCase();
                if (!id || id === "key_challenge") return false;
                const actions = Array.isArray(m?.actions) ? m.actions : [];
                return actions.some((a: any) => a?.id === "provision" && a?.enabled === true && (a?.mode === "keyed" || a?.mode === "either"));
            })
            .map((m) => ({ id: String(m.id).trim().toLowerCase(), enabled: true })),
    ];

    const loginMethods: Array<{ id: string; enabled: boolean }> = [
        { id: "key_challenge", enabled: keyChallengeLoginEnabled },
        { id: "mtls", enabled: mtlsGateEnabled },
    ];

    const autoRedirectEnabled = featureEnv.uiAutoRedirectEnabled;
    const recoveryKeyReminderEnabled = featureEnv.uiRecoveryKeyReminderEnabled;
    const explicitAutoRedirectProviderId = featureEnv.uiAutoRedirectProviderId;
    const enabledExternalSignupProviders = signupMethods
        .filter((m) => m.enabled && m.id !== "anonymous")
        .map((m) => String(m.id).trim().toLowerCase())
        .filter(Boolean);

    const providerResetFlag = featureEnv.recoveryProviderResetEnabled;
    const providerResetProviders = providerResetFlag
        ? enabledExternalSignupProviders.filter((id) => {
              const resolver = authProviderRegistry.find((p) => p.id === id);
              if (!resolver) return false;
              if (!resolver.requiresOAuth) return true;
              return resolver.isConfigured(env);
          })
        : [];
    const providerResetEnabled = providerResetFlag && providerResetProviders.length > 0;

    let autoRedirectProviderId: string | null = null;
    if (autoRedirectEnabled && !keyChallengeProvisionEnabled) {
        const authMethodCandidates = authMethods
            .filter((m) => {
                const id = String(m.id ?? "").trim().toLowerCase();
                if (!id) return false;
                if (id === "key_challenge") return false;
                return Array.isArray(m.actions) && m.actions.some((a) => a?.enabled === true && (a?.id === "login" || a?.id === "provision"));
            })
            .map((m) => String(m.id).trim().toLowerCase());

        const candidate =
            explicitAutoRedirectProviderId ||
            (enabledExternalSignupProviders.length === 1
                ? enabledExternalSignupProviders[0]
                : enabledExternalSignupProviders.length === 0 && authMethodCandidates.length === 1
                  ? authMethodCandidates[0]!
                  : "");

        if (candidate) {
            const method = authMethods.find((m) => String(m?.id ?? "").trim().toLowerCase() === candidate) ?? null;
            const hasEnabledAuthAction =
                method?.actions?.some((a: any) => a?.enabled === true && (a?.id === "login" || a?.id === "provision")) === true;
            if (!hasEnabledAuthAction) {
                autoRedirectProviderId = null;
            } else {
                autoRedirectProviderId = candidate;
            }
        }
    }

    return {
        features: {
            auth: {
                mtls: {
                    enabled: mtlsGateEnabled,
                },
                recovery: {
                    providerReset: {
                        enabled: providerResetEnabled,
                    },
                },
                login: {
                    keyChallenge: {
                        enabled: keyChallengeLoginEnabled,
                    },
                },
                ui: {
                    recoveryKeyReminder: {
                        enabled: recoveryKeyReminderEnabled,
                    },
                },
            },
        },
        capabilities: {
            auth: {
                methods: authMethods,
                signup: { methods: signupMethods },
                login: { methods: loginMethods, requiredProviders: requiredLoginProviders },
                recovery: {
                    providerReset: {
                        providers: providerResetEnabled ? providerResetProviders : [],
                    },
                },
                mtls: {
                    mode: mtlsEnv.mode,
                    autoProvision: mtlsEnv.autoProvision,
                    identitySource: mtlsEnv.identitySource,
                    policy: {
                        trustForwardedHeaders: mtlsEnv.trustForwardedHeaders,
                        issuerAllowlist: {
                            enabled: mtlsEnv.allowedIssuers.length > 0,
                            count: mtlsEnv.allowedIssuers.length,
                        },
                        emailDomainAllowlist: {
                            enabled: mtlsEnv.allowedEmailDomains.length > 0,
                            count: mtlsEnv.allowedEmailDomains.length,
                        },
                    },
                },
                ui: {
                    autoRedirect: {
                        enabled: autoRedirectEnabled,
                        providerId: autoRedirectProviderId,
                    },
                },
                providers,
                misconfig,
            },
        },
    };
}
